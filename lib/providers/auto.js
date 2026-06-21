const { handleAnthropicRequest } = require('./anthropic-compat');
const { handleOpenAIRequest } = require('./openai-compat');
const { handleGeminiRequest } = require('./gemini');
const { log } = require('../logger');
const { resolveMaxTokens } = require('../config');
const { recordModeActivation } = require('../usage-tracker');
const { getSession, setSession, getCachedMode, deriveSessionKey } = require('../session-store');
const { classifyTopic } = require('../classifier');
const modelRouter = require('../model-router');

// 将 agent set 中的一个 key-value 归一化为 { name, description, models[] }
// 返回 null 表示该 entry 应被忽略
const normalizeAgentEntry = (name, value) => {
	if (typeof value === 'string') {
		return { name, description: name, models: [value] };
	}
	if (Array.isArray(value)) {
		return { name, description: name, models: value };
	}
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		if (typeof value.models === 'string') {
			return { name, description: (typeof value.description === 'string' ? value.description : null) || name, models: [value.models] };
		}
		if (Array.isArray(value.models)) {
			return { name, description: (typeof value.description === 'string' ? value.description : null) || name, models: value.models };
		}
		return null;
	}
	return null;
};

// 将整个 agentSet（raw 格式）归一化
const normalizeAgentSet = (rawAgentSet) => {
	const normalized = {};
	for (const [mode, value] of Object.entries(rawAgentSet || {})) {
		const entry = normalizeAgentEntry(mode, value);
		if (entry) {
			normalized[mode] = entry;
		}
		else {
			log('warn', `[Auto] Ignoring agent entry "${mode}": invalid format`);
		}
	}
	return normalized;
};

const getAgentSet = (config, targetModel) => {
	const agents = config.agents || {};
	let rawAgentSet;
	if (targetModel && targetModel !== 'auto' && agents[targetModel]) {
		rawAgentSet = agents[targetModel];
	}
	else {
		rawAgentSet = agents.defaults || {};
	}
	return normalizeAgentSet(rawAgentSet);
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

	const entry = agentSet[mode];
	const models = entry.models || [];
	if (models.length === 0) {
		log('warn', `[Auto] No models for mode: ${mode}`);
		return null;
	}
	const selected = modelRouter.selectModel(models);

	const provider = config.providers && config.providers[selected.providerName];
	if (!provider) {
		log('warn', `[Auto] Provider not found: ${selected.providerName} (mode=${mode})`);
		return null;
	}

	if (provider.type === 'auto') {
		log('warn', `[Auto] Circular reference: agent ${mode} points to auto provider`);
		return null;
	}

	log('debug', `[Auto] Resolved mode=${mode} → ${selected.providerName}/${selected.model} (type=${provider.type})`);
	if (!provider._name) {
		Object.defineProperty(provider, '_name', { value: selected.providerName, writable: true, enumerable: false, configurable: true });
	}
	return { provider, model: selected.model, providerName: selected.providerName };
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

// 通用 dispatch:根据 provider.type 把请求转给对应的 forward 函数
// 用于 executeWithRetry 的 dispatch 回调
const dispatchByProviderType = (req, res, originalModel) => (provider, model, providerName, body, onAttemptDone) => {
	const providerType = provider.type || 'anthropic';
	if (providerType === 'anthropic') {
		handleAnthropicRequest(provider, model, originalModel, req, body, res, onAttemptDone);
	}
	else if (providerType === 'openai') {
		handleOpenAIRequest(provider, model, originalModel, req, body, res, onAttemptDone);
	}
	else if (providerType === 'gemini') {
		handleGeminiRequest(provider, model, originalModel, req, body, res, onAttemptDone);
	}
	else {
		onAttemptDone(new Error(`Unknown provider type: ${providerType}`));
	}
};

// 通用 buildBody:JSON.parse → 设 model → 设 max_tokens → JSON.stringify
// 每次重试都重新解析,避免上次的 body 被污染
const makeBuildBody = (rawBody, setMaxTokens, config) => (selected, provider) => {
	const obj = JSON.parse(rawBody);
	obj.model = selected.model;
	if (setMaxTokens && obj.max_tokens > 10) {
		obj.max_tokens = resolveMaxTokens(config, provider, selected.model);
	}
	return JSON.stringify(obj);
};

const handleContinuation = (config, agentSet, sessionKey, originalModel, req, body, res) => {
	const currentMode = getSession(sessionKey) || 'default';
	log('debug', `[Auto] Continuation: session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, mode=${currentMode}`);

	const modeName = (agentSet && agentSet[currentMode]) ? currentMode : 'default';
	if (!agentSet || !agentSet[modeName]) {
		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				type: 'server_error',
				message: `No agent config for mode: ${currentMode}`,
			},
		}));
		return;
	}

	const modelsArray = agentSet[modeName].models || [];
	const buildBody = makeBuildBody(body, true, config);
	const dispatch = dispatchByProviderType(req, res, originalModel);

	modelRouter.executeWithRetry({
		modelsArray,
		config,
		buildBody,
		dispatch,
		onDone: (err) => {
			if (err) {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: {
						type: 'server_error',
						message: err.message,
					},
				}));
			}
		},
	});
};

const handleUserInput = (config, agentSet, sessionKey, originalModel, req, body, res, clientSource) => {
	const currentMode = getSession(sessionKey) || 'default';
	log('info', `[Auto] UserInput: session=${sessionKey ? sessionKey.substring(0, 40) : 'null'}, currentMode=${currentMode}`);

	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
		return;
	}

	const dispatch = dispatchByProviderType(req, res, originalModel);

	// 1) quick 模式未配置 → 直接 dispatch 到 default mode
	let quickEntry = agentSet && agentSet.quick;
	if (!quickEntry) {
		log('warn', '[Auto] No quick agent configured, skipping classification');
		const modelsArray = (agentSet && agentSet.default && agentSet.default.models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(body, true, config),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						error: { type: 'server_error', message: 'No agent configured' },
					}));
				}
			},
		});
		return;
	}
	const quickModels = quickEntry.models || [];
	if (quickModels.length === 0) {
		log('warn', '[Auto] Quick entry has no models, using default');
		const modelsArray = (agentSet && agentSet.default && agentSet.default.models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(body, true, config),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						error: { type: 'server_error', message: 'No agent configured' },
					}));
				}
			},
		});
		return;
	}

	const availableModes = Object.entries(agentSet)
		.filter(([name]) => name !== 'default' && name !== 'quick')
		.map(([name, entry]) => ({ name, description: entry.description }));
	const modeCacheTtlSec = config.modeCacheTtl != null ? config.modeCacheTtl : 60;
	const modeCacheTtlMs = modeCacheTtlSec * 1000 * (!!currentMode && !["default", "quick"].includes(currentMode) ? 1 : 0);
	const cachedMode = getCachedMode(sessionKey, modeCacheTtlMs);
	if (cachedMode) {
		log('info', `[Auto] Mode cache hit: ${cachedMode} (ttl=${modeCacheTtlSec}s)`);
		const modelsArray = (agentSet && agentSet[cachedMode] && agentSet[cachedMode].models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(body, true, config),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({
						error: { type: 'server_error', message: `Cannot resolve agent for mode: ${cachedMode}` },
					}));
				}
			},
		});
		return;
	}

	// 2) Quick 模式: weighted random pick + classifier retry
	const conversationGroups = config.conversationGroups != null ? config.conversationGroups : 5;
	const MAX_RETRY_ATTEMPTS = modelRouter._LIMITS.MAX_RETRY_ATTEMPTS;

	const classifyWithRetry = (attemptNum) => {
		if (attemptNum >= MAX_RETRY_ATTEMPTS) {
			log('error', `[Auto] Classifier all ${MAX_RETRY_ATTEMPTS} attempts failed, falling back to current mode=${currentMode}`);
			const modeName = (agentSet && agentSet[currentMode]) ? currentMode : 'default';
			const modelsArray = (agentSet && agentSet[modeName] && agentSet[modeName].models) || [];
			modelRouter.executeWithRetry({
				modelsArray,
				config,
				buildBody: makeBuildBody(body, true, config),
				dispatch,
				onDone: (err) => {
					if (err) {
						res.writeHead(502, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({
							error: { type: 'server_error', message: err.message },
						}));
					}
				},
			});
			return;
		}

		const quickSelected = modelRouter.selectModel(quickModels);
		const quickProvider = config.providers && config.providers[quickSelected.providerName];
		if (!quickProvider || quickProvider.type === 'auto') {
			log('warn', `[Auto] Quick provider invalid: ${quickSelected.providerName}, retrying`);
			classifyWithRetry(attemptNum + 1);
			return;
		}
		if (!quickProvider._name) {
			Object.defineProperty(quickProvider, '_name', { value: quickSelected.providerName, writable: true, enumerable: false, configurable: true });
		}

		// Claude quick 模式：max_tokens 缺失或 <10 时直接走 quick,不做分类
		if (clientSource === 'claudecode' && (parsedBody.max_tokens == null || parsedBody.max_tokens < 10)) {
			log('info', '[Auto] Claude mode: max_tokens missing or <10, forcing quick mode');
			setSession(sessionKey, 'quick');

			// 用 executeWithRetry 包装 quick,使其也走统一的 num_done/num_doing 统计与重试
			const quickBuildBody = (selected, provider) => {
				const obj = JSON.parse(JSON.stringify(parsedBody));
				obj.model = selected.model;
				obj.max_tokens = resolveMaxTokens(config, provider, selected.model);
				return JSON.stringify(obj);
			};
			modelRouter.executeWithRetry({
				modelsArray: [quickSelected.spec],
				config,
				buildBody: quickBuildBody,
				dispatch,
				onDone: (err) => {
					if (err) {
						log('warn', `[Auto] Claude quick failed: ${err.message}, retrying classifier`);
						classifyWithRetry(attemptNum + 1);
					}
				},
			});
			return;
		}

		const maxTokens = resolveMaxTokens(config, quickProvider, quickSelected.model);

		modelRouter.startTask(quickSelected.providerName, quickSelected.model);

		classifyTopic(quickProvider, quickSelected.model, parsedBody.messages, sessionKey, availableModes, maxTokens, currentMode, conversationGroups, (err, result) => {
			if (err) {
				modelRouter.finishTask(quickSelected.providerName, quickSelected.model, false, true);
				log('warn', `[Auto] Classifier attempt ${attemptNum + 1} failed: ${err.message}, retrying`);
				classifyWithRetry(attemptNum + 1);
				return;
			}

			modelRouter.finishTask(quickSelected.providerName, quickSelected.model, true, false);

			let newMode;
			if (!result) {
				log('warn', `[Auto] Classification returned null, keeping mode=${currentMode}`);
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

			log('info', `[Auto] UserInput: ${originalModel} → mode=${newMode} (session=${sessionKey ? sessionKey.substring(0, 40) : 'null'})`);

			const modeName = (agentSet && agentSet[newMode]) ? newMode : 'default';
			const modelsArray = (agentSet && agentSet[modeName] && agentSet[modeName].models) || [];
			modelRouter.executeWithRetry({
				modelsArray,
				config,
				buildBody: makeBuildBody(body, true, config),
				dispatch,
				onDone: (err) => {
					if (err) {
						res.writeHead(502, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({
							error: { type: 'server_error', message: err.message },
						}));
					}
				},
			});
		});
	};

	classifyWithRetry(0);
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
	normalizeAgentSet,
};
