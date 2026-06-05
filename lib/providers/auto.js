const { handleAnthropicRequest } = require('./anthropic-compat');
const { handleOpenAIRequest } = require('./openai-compat');
const { handleGeminiRequest } = require('./gemini');
const { log } = require('../logger');
const { resolveMaxTokens } = require('../config');
const { recordModeActivation } = require('../usage-tracker');
const { getSession, setSession, getCachedMode, deriveSessionKey } = require('../session-store');
const { classifyTopic } = require('../classifier');

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

const getAgentSet = (config, targetModel) => {
	const agents = config.agents || {};
	if (targetModel && targetModel !== 'auto' && agents[targetModel]) {
		return agents[targetModel];
	}
	return agents.defaults || {};
};

const resolveAgent = (config, mode, agentSet) => {
	if (!agentSet || !agentSet[mode]) {
		log('warn', `[Auto] No agent config for mode: ${mode}`);
		if (mode !== 'default' && agentSet && agentSet.default) {
			log('info', `[Auto] Falling back to default mode`);
			return resolveAgent(config, 'default', agentSet);
		}
		return null;
	}

	let specValue = agentSet[mode];
	if (Array.isArray(specValue)) {
		specValue = specValue[Math.floor(Math.random() * specValue.length)];
		log('debug', `[Auto] Random pick from array for mode=${mode}: ${specValue}`);
	}

	const spec = parseAgentSpec(specValue);
	if (!spec) {
		log('warn', `[Auto] Invalid agent spec for mode ${mode}: ${specValue}`);
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
	provider._name = provider._name || spec.providerName;
	return { provider, model: spec.model };
};

const isUserTextInput = (messages) => {
	if (!Array.isArray(messages) || messages.length === 0) {
		return false;
	}
	const lastMsg = messages[messages.length - 1];
	if (lastMsg?.role !== 'user') return false;

	const blocks = Array.isArray(lastMsg.content) ? lastMsg.content : [];
	if (blocks.length === 0) return false;

	const hasNonTextBlock = blocks.some((b) => b.type !== 'text');
	if (hasNonTextBlock) return false;

	return true;
};

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

const handleContinuation = (config, agentSet, sessionKey, originalModel, req, body, res) => {
	const currentMode = getSession(sessionKey) || 'default';
	log('debug', `[Auto] Continuation: session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, mode=${currentMode}`);

	const agent = resolveAgent(config, currentMode, agentSet);
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
	if (parsedBody.max_tokens > 10) {
		parsedBody.max_tokens = resolveMaxTokens(config, agent.provider, agent.model);
	}
	log('info', `[Auto] Continuation: ${originalModel} → ${agent.model} (session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, mode=${currentMode}, type=${agent.provider.type})`);

	dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
};

const handleUserInput = (config, agentSet, sessionKey, originalModel, req, body, res, clientSource) => {
	const currentMode = getSession(sessionKey) || 'default';
	log('debug', `[Auto] UserInput: session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, currentMode=${currentMode}`);

	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
		return;
	}

	let quickAgent = agentSet && agentSet.quick;
	if (!quickAgent) {
		log('warn', '[Auto] No quick agent configured, skipping classification');
		const agent = resolveAgent(config, 'default', agentSet);
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: { type: 'server_error', message: 'No agent configured' },
			}));
			return;
		}
		parsedBody.model = agent.model;
		if (parsedBody.max_tokens > 10) {
			parsedBody.max_tokens = resolveMaxTokens(config, agent.provider, agent.model);
		}
		log('info', `[Auto] No quick → default: ${originalModel} → ${agent.model}`);
		dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
		return;
	}
	if (Array.isArray(quickAgent)) {
		quickAgent = quickAgent[Math.floor(Math.random() * quickAgent.length)];
		log('debug', `[Auto] Random pick from quick array: ${quickAgent}`);
	}

	const quickSpec = parseAgentSpec(quickAgent);
	if (!quickSpec) {
		log('warn', `[Auto] Invalid quick agent spec: ${quickAgent}`);
		const agent = resolveAgent(config, 'default', agentSet);
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'server_error', message: 'No agent configured' } }));
			return;
		}
		parsedBody.model = agent.model;
		if (parsedBody.max_tokens > 10) {
			parsedBody.max_tokens = resolveMaxTokens(config, agent.provider, agent.model);
		}
		dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
		return;
	}
	const quickProvider = config.providers && config.providers[quickSpec.providerName];
	if (!quickProvider) {
		log('warn', `[Auto] Quick provider not found: ${quickSpec.providerName}`);
		const agent = resolveAgent(config, 'default', agentSet);
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'server_error', message: 'Quick provider not found' } }));
			return;
		}
		parsedBody.model = agent.model;
		if (parsedBody.max_tokens > 10) {
			parsedBody.max_tokens = resolveMaxTokens(config, agent.provider, agent.model);
		}
		dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
		return;
	}

	// Claude 模式下，max_tokens 缺失或 <10 时直接走 quick，不做分类
	if (clientSource === 'claudecode' && (parsedBody.max_tokens == null || parsedBody.max_tokens < 10)) {
		log('info', '[Auto] Claude mode: max_tokens missing or <10, forcing quick mode');
		parsedBody.model = quickSpec.model;
		parsedBody.max_tokens = resolveMaxTokens(config, quickProvider, quickSpec.model);
		log('info', `[Auto] Claude→quick: ${originalModel} → ${quickSpec.model}`);
		setSession(sessionKey, 'quick');
		dispatchToHandler(quickProvider, quickSpec.model, originalModel, req, JSON.stringify(parsedBody), res);
		return;
	}

	const availableModes = Object.keys(agentSet).filter((m) => m !== 'default' && m !== 'quick');
	const maxTokens = resolveMaxTokens(config, quickProvider, quickSpec.model);
	const conversationGroups = config.conversationGroups != null ? config.conversationGroups : 5;

	const modeCacheTtlSec = config.modeCacheTtl != null ? config.modeCacheTtl : 60;
	const modeCacheTtlMs = modeCacheTtlSec * 1000;
	const cachedMode = getCachedMode(sessionKey, modeCacheTtlMs);
	if (cachedMode) {
		log('info', `[Auto] Mode cache hit: ${cachedMode} (ttl=${modeCacheTtlSec}s)`);
		const agent = resolveAgent(config, cachedMode, agentSet);
		if (agent) {
			parsedBody.model = agent.model;
			if (parsedBody.max_tokens > 10) {
				parsedBody.max_tokens = resolveMaxTokens(config, agent.provider, agent.model);
			}
			log('info', `[Auto] UserInput(cached): ${originalModel} → ${agent.model} (session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, mode=${cachedMode}, type=${agent.provider.type})`);
			dispatchToHandler(agent.provider, agent.model, originalModel, req, JSON.stringify(parsedBody), res);
			return;
		}
		log('warn', `[Auto] Cached mode ${cachedMode} cannot be resolved, falling through to classification`);
	}

	// classifier 内部会自己做深拷贝和裁剪，这里传原始消息
	classifyTopic(quickProvider, quickSpec.model, parsedBody.messages, availableModes, maxTokens, currentMode, conversationGroups, (err, result) => {
		let newMode;
		if (err || !result) {
			log('warn', `[Auto] Classification failed, keeping mode=${currentMode}`);
			newMode = currentMode;
		}
		else if (result.isNewTopic && result.mode) {
			if (agentSet[result.mode]) {
				newMode = result.mode;
			}
			else {
				log('warn', `[Auto] Classifier returned unknown mode "${result.mode}", using default`);
				newMode = 'default';
			}
		}
		else if (result.isNewTopic && !result.mode) {
			newMode = 'default';
		}
		else {
			newMode = currentMode;
		}

		setSession(sessionKey, newMode);
		recordModeActivation(newMode);

		const agent = resolveAgent(config, newMode, agentSet);
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: { type: 'server_error', message: `Cannot resolve agent for mode: ${newMode}` },
			}));
			return;
		}

		parsedBody.model = agent.model;
		if (parsedBody.max_tokens > 10) {
			parsedBody.max_tokens = resolveMaxTokens(config, agent.provider, agent.model);
		}
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

	const sessionKey = sessionId || deriveSessionKey(parsedBody.messages);
	const userInput = isUserTextInput(parsedBody.messages);
	const currentMode = getSession(sessionKey) || 'default';
	const agentSet = getAgentSet(config, targetModel);

	log('debug', `[Auto] session=${sessionKey != null ? String(sessionKey).substring(0, 40) : 'null'} | mode=${currentMode} | userInput=${userInput} | target=${targetModel}`);

	if (!userInput) {
		handleContinuation(config, agentSet, sessionKey, originalModel, req, body, res);
	}
	else {
		handleUserInput(config, agentSet, sessionKey, originalModel, req, body, res, req.clientSource);
	}
};

module.exports = {
	handleAutoRequest,
	parseAgentSpec,
	resolveAgent,
};
