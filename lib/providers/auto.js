const { handleAnthropicRequest } = require('./anthropic-compat');
const { handleOpenAIRequest } = require('./openai-compat');
const { handleGeminiRequest } = require('./gemini');
const { log } = require('../logger');
const { getSession, setSession, deriveSessionKey } = require('../session-store');
const { classifyTopic } = require('../classifier');

// 解析 "providerName/modelName" 字符串，在第一个 "/" 处分割
// model 中可能包含 "/"（如 "models/gemini-2.5-flash"），所以要小心处理
const parseAgentSpec = (spec) => {
	if (!spec || typeof spec !== 'string') {
		return null;
	}
	const idx = spec.indexOf('/');
	if (idx <= 0 || idx >= spec.length - 1) {
		return null;
	}
	return {
		providerName: spec.substring(0, idx),
		model: spec.substring(idx + 1),
	};
};

// 根据 mode 从 config 中找到对应的 provider 和 model
// 返回 { provider, model } 或 null
const resolveAgent = (config, mode) => {
	const agents = config.agents;
	if (!agents || !agents[mode]) {
		log('warn', `[Auto] No agent config for mode: ${mode}`);
		// fallback 到 default
		if (mode !== 'default' && agents && agents.default) {
			log('info', `[Auto] Falling back to default mode`);
			return resolveAgent(config, 'default');
		}
		return null;
	}

	const spec = parseAgentSpec(agents[mode]);
	if (!spec) {
		log('warn', `[Auto] Invalid agent spec for mode ${mode}: ${agents[mode]}`);
		return null;
	}

	const provider = config.providers && config.providers[spec.providerName];
	if (!provider) {
		log('warn', `[Auto] Provider not found: ${spec.providerName} (mode=${mode})`);
		return null;
	}

	if (provider.type === 'auto') {
		log('warn', `[Auto] Circular reference: agent ${mode} points to auto provider`);
		return null;
	}

	log('debug', `[Auto] Resolved mode=${mode} → ${spec.providerName}/${spec.model} (type=${provider.type})`);
	return { provider, model: spec.model };
};

// 判断最后一条消息是否为用户文本输入（非工具调用结果）
const isUserTextInput = (messages) => {
	if (!Array.isArray(messages) || messages.length === 0) {
		return false;
	}
	const lastMsg = messages[messages.length - 1];
	if (lastMsg?.role !== 'user') return false;

	const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
	if (blocks.length === 0) return false;

	// 如果所有内容块都是 tool_result，则不是用户输入
	const hasNonTextBlock = blocks.some((b) => b.type !== 'text');
	if (hasNonTextBlock) return false;

	// 如果不空且都是文本块
	return true;
};

// 根据 provider.type 分派到对应的 handler
const dispatchToHandler = (resolvedProvider, resolvedModel, originalModel, req, body, res) => {
	const providerType = resolvedProvider.type || 'anthropic';

	if (providerType === 'anthropic') {
		handleAnthropicRequest(resolvedProvider, resolvedModel, originalModel, req, body, res);
	}
	else if (providerType === 'openai') {
		handleOpenAIRequest(resolvedProvider, resolvedModel, originalModel, req, body, res);
	}
	else if (providerType === 'gemini') {
		handleGeminiRequest(resolvedProvider, resolvedModel, originalModel, req, body, res);
	}
	else {
		log('warn', `[Auto] Unknown provider type: ${providerType}`);
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				type: 'invalid_request_error',
				message: `Unknown provider type: ${providerType}`,
			},
		}));
	}
};

// 处理非用户输入（工具调用续接等）：直接使用当前 session 的 working mode 转发
const handleContinuation = (config, sessionKey, originalModel, req, body, res) => {
	const currentMode = getSession(sessionKey) || 'default';
	log('debug', `[Auto] Continuation: session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, mode=${currentMode}`);

	const agent = resolveAgent(config, currentMode);
	if (!agent) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				type: 'server_error',
				message: `Cannot resolve agent for mode: ${currentMode}`,
			},
		}));
		return;
	}

	// 更新 body 中的 model 为实际转发的 model
	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
		return;
	}
	parsedBody.model = agent.model;
	log('info', `[Auto] Continuation: ${originalModel} → ${agent.model} (session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, mode=${currentMode}, type=${agent.provider.type})`);

	dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
};

// 处理用户输入：先分类，再转发
const handleUserInput = (config, sessionKey, originalModel, req, body, res) => {
	const currentMode = getSession(sessionKey) || 'default';
	log('debug', `[Auto] UserInput: session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, currentMode=${currentMode}`);

	// 检查 quick agent 是否存在
	const agents = config.agents;
	const quickAgent = agents && agents.quick;
	if (!quickAgent) {
		log('warn', '[Auto] No quick agent configured, skipping classification');
		// 直接用 default mode 转发
		const agent = resolveAgent(config, 'default');
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: { type: 'server_error', message: 'No agent configured' },
			}));
			return;
		}
		let parsedBody;
		try {
			parsedBody = JSON.parse(body);
		}
		catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
			return;
		}
		parsedBody.model = agent.model;
		log('info', `[Auto] No quick → default: ${originalModel} → ${agent.model}`);
		dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
		return;
	}

	const quickSpec = parseAgentSpec(quickAgent);
	if (!quickSpec) {
		log('warn', `[Auto] Invalid quick agent spec: ${quickAgent}`);
		const agent = resolveAgent(config, 'default');
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'server_error', message: 'No agent configured' } }));
			return;
		}
		let parsedBody;
		try {
			parsedBody = JSON.parse(body);
		}
		catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
			return;
		}
		parsedBody.model = agent.model;
		dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
		return;
	}

	const quickProvider = config.providers && config.providers[quickSpec.providerName];
	if (!quickProvider) {
		log('warn', `[Auto] Quick provider not found: ${quickSpec.providerName}`);
		const agent = resolveAgent(config, 'default');
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'server_error', message: 'Quick provider not found' } }));
			return;
		}
		let parsedBody;
		try {
			parsedBody = JSON.parse(body);
		}
		catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
			return;
		}
		parsedBody.model = agent.model;
		dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
		return;
	}

	// 构建可用 mode 列表（排除 default 和 quick）
	const availableModes = Object.keys(agents).filter((m) => m !== 'default' && m !== 'quick');

	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
		return;
	}

	// 发送分类请求
	// 三层查找: 模型级 → provider 默认 → 全局默认
	const modelEntry = Array.isArray(quickProvider.models)
		? quickProvider.models.find((m) => m.name === quickSpec.model)
		: null;
	const maxTokens = (modelEntry && modelEntry.maxTokens)
		|| quickProvider.defaultMaxTokens
		|| config.defaultMaxTokens
		|| 131072;
	classifyTopic(quickProvider, quickSpec.model, parsedBody.messages, availableModes, maxTokens, currentMode, (err, result) => {
		let newMode;
		if (err || !result) {
			// 分类失败 → 保持当前 mode
			log('warn', `[Auto] Classification failed, keeping mode=${currentMode}`);
			newMode = currentMode;
		}
		else if (result.isNewTopic && result.mode) {
			// 新话题 + 指定了 mode
			if (agents[result.mode]) {
				newMode = result.mode;
			}
			else {
				log('warn', `[Auto] Classifier returned unknown mode "${result.mode}", using default`);
				newMode = 'default';
			}
		}
		else if (result.isNewTopic && !result.mode) {
			// 新话题但没指定 mode → default
			newMode = 'default';
		}
		else {
			// 非新话题 → 保持
			newMode = currentMode;
		}

		// 更新 session
		setSession(sessionKey, newMode);

		// 解析 agent 并转发
		const agent = resolveAgent(config, newMode);
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: { type: 'server_error', message: `Cannot resolve agent for mode: ${newMode}` },
			}));
			return;
		}

		parsedBody.model = agent.model;
		log('info', `[Auto] UserInput: ${originalModel} → ${agent.model} (session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, mode=${newMode}, type=${agent.provider.type})`);

		dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
	});
};

const handleAutoRequest = (provider, targetModel, originalModel, req, body, res, config, sessionId) => {
	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
		return;
	}

	// 优先使用 proxy-server 提取的 sessionId，fallback 到从消息内容派生
	const sessionKey = sessionId || deriveSessionKey(parsedBody.messages);
	const userInput = isUserTextInput(parsedBody.messages);
	const currentMode = getSession(sessionKey) || 'default';

	log('debug', `[Auto] session=${sessionKey != null ? String(sessionKey).substring(0, 40) : 'null'} | mode=${currentMode} | userInput=${userInput}`);

	if (!userInput) {
		handleContinuation(config, sessionKey, originalModel, req, body, res);
	}
	else {
		handleUserInput(config, sessionKey, originalModel, req, body, res);
	}
};

module.exports = {
	handleAutoRequest,
};
