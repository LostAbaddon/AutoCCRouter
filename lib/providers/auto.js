const { log, logClientStage } = require('../logger');
const { proxyRequest } = require('../proxy-agent');
const { resolveMaxTokens } = require('../config');
const { acquireKey, releaseKey } = require('../key-state-manager');
const { recordUsage } = require('../usage-tracker');
const { getPrompt } = require('../prompt-store');
const { classifyResponse } = require('../error-detector');
const { convertAnthropicToolsToOpenAI, convertAnthropicMessagesToOpenAI } = require('./openai-compat');
const { filterMessagesWithoutThoughtSignature, cleanGeminiSchema } = require('./gemini');
const { getThinking } = require('../thinking-store');
const modelRouter = require('../model-router');

/* ----------------- Provider 相关，以后要换地方 ----------------- */

const DEFAULT_THINKING_LEVEL = 'medium';
const DEFAULT_TEMPERATURE = 0.9;

// 生成 Anthropic 协议的请求体
const assembleAnthropicRequest = (provider, model, messages, sp, options) => {
	const requestBody = {
		model,
		system: sp,
		max_tokens: options.maxTokens,
		stream: options.stream || false,
	};
	requestBody.messages = JSON.parse(JSON.stringify(messages)); // 复制一份，避免污染
	for (const msg of requestBody.messages) {
		if (msg.role !== 'assistant') {
			continue;
		}
		const blocks = Array.isArray(msg.content) ? msg.content : [];
		const hasToolUse = blocks.some((b) => b.type === 'tool_use');
		const hasThinking = blocks.some((b) => b.type === 'thinking');

		if (hasToolUse && !hasThinking) {
			const restored = [];
			const seenIds = new Set();

			// First try to restore real thinking blocks from the store
			for (const block of blocks) {
				if (block.type === 'tool_use' && block.id && !seenIds.has(block.id)) {
					seenIds.add(block.id);
					const saved = getThinking(block.id);
					if (saved) {
						for (const tb of saved) {
							if (!restored.some((r) => r.type === 'thinking' && r.signature === tb.signature)) {
								restored.push({ ...tb });
							}
						}
					}
				}
			}

			if (restored.length > 0) {
				msg.content = [...restored, ...blocks];
			}
			else {
				// try-inject strategy: Inject a synthetic thinking block before the first tool_use
				const firstToolUseIndex = msg.content.findIndex((b) => b.type === 'tool_use');
				if (firstToolUseIndex !== -1) {
					const firstToolUse = msg.content[firstToolUseIndex];
					msg.content.splice(firstToolUseIndex, 0, {
						type: 'thinking',
						thinking: '(Synthetic thinking block for protocol compliance)',
						signature: 'synthetic:' + firstToolUse.id
					});
				}
			}
		}
	}
	if (options.useCache) {
		requestBody.cache_control = { type: "ephemeral" };
		if (provider._name !== 'minimax') {
			requestBody.system = [{
				type: 'text',
				text: sp,
				cache_control: { type: "ephemeral" },
			}];
		}
	}
	if (options.thinking) {
		if (provider._name === 'anthropic') {
			requestBody.thinking = {
				type: "adaptive",
			};
			requestBody.output_config = requestBody.output_config || {};
			let thinking = options.thinking;
			if (typeof thinking === 'string') {
				thinking = thinking.toLowerCase();
				if (!['low', 'medium', 'high'].includes(thinking)) thinking = DEFAULT_THINKING_LEVEL;
			}
			else {
				thinking = DEFAULT_THINKING_LEVEL;
			}
			requestBody.output_config.effort = thinking;
		}
		else if (provider._name === 'minimax') {
			requestBody.thinking = {
				type: "adaptive",
			};
		}
		else {
			requestBody.thinking = {
				type: "enabled",
			};
			if (options.maxTokens > 0) {
				requestBody.thinking.budget_tokens = Math.ceil(options.maxTokens * 0.4); // 最多使用40%用于思考
			}
		}
	}
	else {
		requestBody.thinking = {
			type: "disabled",
		};
	}
	if (provider._name !== 'anthropic') {
		requestBody.temperature = options.temperature || DEFAULT_TEMPERATURE;
		// MiniMax 不支持且不能传入 budget_tokens
		if (provider._name === 'minimax') {
			if (!requestBody.thinking?.budget_tokens) delete requestBody.thinking.budget_tokens;
		}
	}
	if (options.json_schema) {
		requestBody.output_config = requestBody.output_config || {};
		requestBody.output_config.format = {
			type: 'json_schema',
			schema: options.json_schema,
		};
	}
	if (options.tools?.length) requestBody.tools = options.tools; // 以后需要调整 [todo]

	return requestBody;
};
// 发送 Anthropic 协议的非流式请求
const sendAnthropicRequestUnStreamly = (provider, model, messages, sp, options) => new Promise((res, rej) => {
	// APIKey 控制
	const acquired = acquireKey(provider._name, provider.apiKey);
	const key = acquired.key;
	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) return;
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};

	// 组装请求
	const requestBody = assembleAnthropicRequest(provider, model, messages, sp, {...options, stream: false});
	const targetUrl = new URL(provider.baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const path = pathPrefix.match(/v\d+\/(chat|messages?|responses?)\//) ? pathPrefix : `${pathPrefix}/v1/messages`;
	const bodyStr = JSON.stringify(requestBody);
	const request = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${key}`,
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
			'Content-Length': Buffer.byteLength(bodyStr),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const onDone = (err, isProviderDown=true, isKeyFailure=false) => {
		if (err) {
			log('error', `[CallLLM:Anthropic] Classification Error: ${err.message}`);
			console.error(err.stack);
			settleKey({ isKeyFailure, isProviderDown });
			Object.defineProperty(err, 'isProviderDown', {
				value: isProviderDown,
				enumerable: false,
				configurable: false,
				writable: false,
			});
			rej(err);
		}
		else {
			settleKey({ isSuccess: true });
		}
	};

	let settled = false;
	const callback = (err, proxyRes) => {
		if (settled) return;
		settled = true;

		if (err) return onDone(err);

		let data = '';
		proxyRes.on('data', (chunk) => {
			data += chunk;
		});
		proxyRes.on('end', () => {
			if (proxyRes.statusCode !== 200) {
				const err = new Error(`Classification HTTP ${proxyRes.statusCode}`);
				const cr = classifyResponse(proxyRes.statusCode, data);
				return onDone(err, cr.isProviderDown, cr.isKeyFailure);
			}

			try {
				const resp = JSON.parse(data);
				const finishReason = resp.stop_reason || 'unknown';
				log('debug', `[CallLLM:Anthropic] finishReason=${finishReason}, usage=${JSON.stringify(resp.usage)}`);
				onDone();
				const usage = {};
				if (resp.usage) {
					usage.input_tokens = resp.usage.input_tokens || 0;
					usage.output_tokens = resp.usage.output_tokens || 0;
					usage.cache_read_tokens = resp.usage.cache_read_tokens || resp.usage.cache_read_input_tokens || 0;
					recordUsage(provider._name, model, usage, 'auto', resp.usage);
				}
				res({
					usage,
					content: resp.content,
				});
			}
			catch (e) {
				const err = new Error('Invalid classification response');
				onDone(err, false, true);
			}
		});
		proxyRes.on('error', (e) => {
			onDone(e);
		});
	};

	log('debug', `[CallLLM:Anthropic] POST ${request.hostname}${path}`);
	const proxyReq = proxyRequest(provider.proxy, request, bodyStr, callback);
	proxyReq.setTimeout(CLASSIFICATION_TIMEOUT);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		onDone(new Error('Classification timeout'));
	});
});

// 生成 OpenAI 协议的请求体
const assembleOpenAICompletionRequest = (provider, model, messages, sp, options) => {
	const requestBody = {
		model: model,
		max_completion_tokens: options.maxTokens,
		stream: options.stream || false,
	};
	requestBody.messages = convertAnthropicMessagesToOpenAI(sp, messages);
	if (options.stream) {
		requestBody.stream_options = requestBody.stream_options || {};
		requestBody.stream_options.include_usage = true;
	}
	if (options.useCache) {
		if (options.sessionId) requestBody.prompt_cache_key = options.sessionId;
		requestBody.prompt_cache_retention = "24h";
	}
	if (options.thinking) {
		if (provider._name === 'agnes') {
			if (thinking === 'none' || thinking === 'low') {
				requestBody.chat_template_kwargs = {
					enable_thinking: false
				};
			}
			else {
				requestBody.chat_template_kwargs = {
					enable_thinking: true
				};
			}
		}
		else if (provider._name === 'moonshot') {
			if (thinking === 'none' || thinking === 'low') {
				if (!model.match(/k(2\.7|3)/i)) {
					requestBody.thinking = {
						type: "disabled"
					};
				}
			}
			else {
				if (model.match(/k3/i)) {
					requestBody.reasoning_effort = 'max';
				}
				else {
					requestBody.thinking = {
						type: "enabled"
					};
				}
			}
		}
		else {
			let thinking = options.thinking;
			if (typeof thinking === 'string') {
				thinking = thinking.toLowerCase();
				if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) thinking = DEFAULT_THINKING_LEVEL;
			}
			else {
				thinking = DEFAULT_THINKING_LEVEL;
			}
			requestBody.reasoning_effort = thinking;
		}
	}
	else {
		if (provider._name === 'agnes') {
			requestBody.chat_template_kwargs = {
				enable_thinking: false
			};
		}
		else if (provider._name === 'moonshot') {
			if (!model.match(/k(2\.7|3)/i)) {
				requestBody.thinking = {
					type: "disabled"
				};
			}
		}
		else {
			if (model.match(/gpt\-[34]/i)) requestBody.reasoning_effort = 'low';
			requestBody.reasoning_effort = 'none';
		}
	}
	if (provider._name === 'openrouter') {
		delete requestBody.max_completion_tokens;
	}
	requestBody.temperature = options.temperature || DEFAULT_TEMPERATURE;
	if (options.json_schema) {
		requestBody.response_format = {
			type: 'json_schema',
			schema: options.json_schema,
		};
	}
	else {
		requestBody.response_format = {
			type: "text"
		};
	}
	if (options.tools?.length) {
		requestBody.tools = convertAnthropicToolsToOpenAI(options.tools); // 以后需要调整 [todo]
		if (!requestBody.tools?.length) delete requestBody.tools;
	}

	return requestBody;
};
// 发送 OpenAI 格式的分类请求
const sendOpenAICompletionRequestUnStreamly = (provider, model, messages, sp, options) => new Promise((res, rej) => {
	// APIKey 控制
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;
	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) return;
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};

	// 组装请求
	const requestBody = assembleOpenAICompletionRequest(provider, model, messages, sp, {...options, stream: false});
	const targetUrl = new URL(provider.baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const path = pathPrefix.match(/v\d+\/(chat|messages?|responses?)\//) ? pathPrefix : `${pathPrefix}/chat/completions`;
	const bodyStr = JSON.stringify(requestBody);
	const request = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${key}`,
			'Content-Length': Buffer.byteLength(bodyStr),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const onDone = (err, isProviderDown=true, isKeyFailure=false) => {
		if (err) {
			log('error', `[CallLLM:OpenAI] Classification Error: ${err.message}`);
			console.error(err.stack);
			settleKey({ isKeyFailure, isProviderDown });
			Object.defineProperty(err, 'isProviderDown', {
				value: isProviderDown,
				enumerable: false,
				configurable: false,
				writable: false,
			});
			rej(err);
		}
		else {
			settleKey({ isSuccess: true });
		}
	};

	let settled = false;
	const callback = (err, proxyRes) => {
		if (settled) return;
		settled = true;

		if (err) return onDone(err);

		let data = '';
		proxyRes.on('data', (chunk) => {
			data += chunk;
		});
		proxyRes.on('end', () => {
			if (proxyRes.statusCode !== 200) {
				const err = new Error(`Classification HTTP ${proxyRes.statusCode}`);
				const cr = classifyResponse(proxyRes.statusCode, data);
				return onDone(err, cr.isProviderDown, cr.isKeyFailure);
			}

			try {
				const resp = JSON.parse(data);
				const finishReason = resp.choices?.[0]?.finish_reason || 'unknown';
				log('debug', `[CallLLM:OpenAI] finishReason=${finishReason}, usage=${JSON.stringify(resp.usage)}`);
				onDone();
				const usage = {};
				if (resp.usage) {
					usage.input_tokens = resp.usage.prompt_tokens || 0;
					usage.output_tokens = resp.usage.completion_tokens || 0;
					usage.cache_read_tokens = resp.usage.prompt_tokens_details?.cached_tokens || 0;
					recordUsage(provider._name, model, usage, 'auto', resp.usage);
				}
				res({
					usage,
					content: resp.choices[0].message,
				});
			}
			catch (e) {
				const err = new Error('Invalid classification response');
				onDone(err, false, true);
			}
		});
		proxyRes.on('error', (e) => {
			onDone(e);
		});
	};

	log('debug', `[CallLLM:OpenAI] POST ${request.hostname}${path}`);
	const proxyReq = proxyRequest(provider.proxy, request, bodyStr, callback);
	proxyReq.setTimeout(CLASSIFICATION_TIMEOUT);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		onDone(new Error('Classification timeout'));
	});
});

// 生成 OpenAI 协议的请求体
const assembleGeminiRequest = (provider, model, messages, sp, options) => {
	const requestBody = {
		contents: [],
		generationConfig: {},
	};
	if (sp) {
		const systemText = typeof sp === 'string'
			? sp.trim()
			: (Array.isArray(sp)
				? sp.map((b) => (b.text || '').trim()).join('\n\n')
				: '');
		if (systemText) requestBody.systemInstruction = {
			parts: [{ text: systemText }],
		};
	}
	messages = filterMessagesWithoutThoughtSignature(messages);
	if (Array.isArray(messages)) {
		for (const msg of messages) {
			const role = msg.role === 'assistant' ? 'model' : 'user';
			const parts = [];

			if (typeof msg.content === 'string') {
				parts.push({ text: msg.content });
			}
			else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === 'text' && block.text) {
						parts.push({ text: block.text });
					}
					else if (block.type === 'tool_use') {
						const part = {
							functionCall: {
								name: block.name,
								args: block.input || {},
							},
						};
						const sig = thoughtSignatures.get(block.id);
						if (sig && !sig.startsWith('gemini:')) {
							part.thought_signature = sig;
						}
						parts.push(part);
					}
					else if (block.type === 'image' && block.source) {
							parts.push({
								inlineData: {
									mimeType: block.source.media_type || 'image/png',
									data: block.source.data,
								},
							});
						}
						else if (block.type === 'tool_result') {
						parts.push({
							functionResponse: {
								name: block.tool_use_id || 'tool',
								response: { content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) },
							},
						});
					}
				}
			}

			if (parts.length > 0) {
				requestBody.contents.push({ role, parts });
			}
		}
	}
	if (options.maxTokens > 0) {
		requestBody.generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (options.temperature > 0) {
		requestBody.generationConfig.temperature = options.temperature;
	}
	let thinking = options.thinking || false;
	if (thinking) {
		if (typeof thinking === 'string') thinking = thinking.toLocaleLowerCase();
		else thinking = DEFAULT_THINKING_LEVEL;
	}
	else {
		if (model.match(/3\.1\-pro/i)) thinking = 'low';
		else thinking = 'minimal';
	}
	requestBody.generationConfig.thinkingConfig = {
		thinkingLevel: thinking,
		include_thoughts: true,
	};
	if (options.json_schema) {
		requestBody.generationConfig.responseMimeType = 'application/json';
		requestBody.generationConfig.responseSchema = cleanGeminiSchema(options.json_schema.schema);
	}
	if (Array.isArray(options.tools)) {
		const builtinTools = [];
		const functionTools = [];
		for (const tool of options.tools) {
			if (tool.googleSearch || tool.urlContext || tool.codeExecution) {
				builtinTools.push(tool);
			}
			else if (tool.type === 'web_search_20250305') {
				builtinTools.push({ googleSearch: {} });
			}
			else if (tool.type === 'web_fetch_20250929') {
				builtinTools.push({ urlContext: {} });
			}
			else if (Array.isArray(tool.functionDeclarations)) {
				// tool-translator 已预处理为 Gemini functionDeclarations 格式 → 解开透传
				for (const fd of tool.functionDeclarations) {
					functionTools.push({
						name: fd.name || tool.name || '',
						description: fd.description || tool.description || '',
						parameters: cleanGeminiSchema(fd.parameters || tool.parameters || {}),
					});
				}
			}
			else {
				functionTools.push({
					name: tool.name || '',
					description: tool.description || '',
					parameters: cleanGeminiSchema(tool.input_schema || {}),
				});
			}
		}
		const toolsOut = [];
		if (builtinTools.length > 0) toolsOut.push(...builtinTools);
		if (functionTools.length > 0) {
			toolsOut.push({ functionDeclarations: functionTools });
		}
		if (toolsOut.length > 0) requestBody.tools = toolsOut;
	}

	return requestBody;
};
// 发送 Gemini 格式的分类请求
const sendGeminiRequestUnStreamly = (provider, model, messages, sp, options) => new Promise((res, rej) => {
	// APIKey 控制
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;
	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) return;
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};

	// 组装请求
	const requestBody = assembleGeminiRequest(provider, model, messages, sp, {...options, stream: false});
	const targetUrl = new URL(provider.baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const path = `${pathPrefix}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
	const bodyStr = JSON.stringify(requestBody);
	const request = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(bodyStr),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const onDone = (err, isProviderDown=true, isKeyFailure=false) => {
		if (err) {
			log('error', `[CallLLM:Gemini] Classification Error: ${err.message}`);
			console.error(err.stack);
			settleKey({ isKeyFailure, isProviderDown });
			Object.defineProperty(err, 'isProviderDown', {
				value: isProviderDown,
				enumerable: false,
				configurable: false,
				writable: false,
			});
			rej(err);
		}
		else {
			settleKey({ isSuccess: true });
		}
	};

	let settled = false;
	const callback = (err, proxyRes) => {
		if (settled) return;
		settled = true;

		if (err) return onDone(err);

		let data = '';
		proxyRes.on('data', (chunk) => {
			data += chunk;
		});
		proxyRes.on('end', () => {
			if (proxyRes.statusCode !== 200) {
				const err = new Error(`Classification HTTP ${proxyRes.statusCode}`);
				const cr = classifyResponse(proxyRes.statusCode, data);
				return onDone(err, cr.isProviderDown, cr.isKeyFailure);
			}

			try {
				const resp = JSON.parse(data);
				const finishReason = resp.candidates?.[0]?.finishReason || 'unknown';
				log('debug', `[CallLLM:Gemini] finishReason=${finishReason}, usage=${JSON.stringify(resp.usageMetadata)}`);
				onDone();
				const usage = {};
				if (resp.usageMetadata) {
					usage.input_tokens = resp.usageMetadata.promptTokenCount || 0;
					usage.output_tokens = resp.usageMetadata.candidatesTokenCount || 0;
					usage.cache_read_tokens = resp.usageMetadata.cachedContentTokenCount || 0;
					recordUsage(provider._name, model, usage, 'auto', resp.usageMetadata);
				}
				res({
					usage,
					content: resp.candidates[0].content,
				});
			}
			catch (e) {
				onDone(e, false, true);
			}
		});
		proxyRes.on('error', (e) => {
			onDone(e);
		});
	};

	log('debug', `[CallLLM:Gemini] POST ${request.hostname}${path}`);
	const proxyReq = proxyRequest(provider.proxy, request, bodyStr, callback);
	proxyReq.setTimeout(CLASSIFICATION_TIMEOUT);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		onDone(new Error('Classification timeout'));
	});
});

/* ----------------- Auto Model Router ----------------- */

const CLASSIFICATION_TIMEOUT = 10 * 1000;
const SESSIONWORKINGMODE = new Map();         // SessionID - WorkingMode
const CACHEDCLASSIFIERRESULT = new Map();     // 最近对话组 - WorkingMode
const CLASSIFIERCACHEEXPIRE = 10 * 60 * 1000; // 缓存10分钟
const SESSIONPLOTCACHE = new Map();           // 最近话题节点
const SESSIONPLOTLIMIT = 2;
const SESSIONMESSAGELIMIT = 10;
let classifierIndex = 0;

// 自动清除过期缓存
const clearExpiredClassifierCache = () => {
	const now = Date.now();
	for (const [key, cached] of CACHEDCLASSIFIERRESULT) {
		if (now - cached.timestamp >= CLASSIFIERCACHEEXPIRE) {
			CACHEDCLASSIFIERRESULT.delete(key);
		}
	}
	for (const [key, cached] of SESSIONPLOTCACHE) {
		for (let i = cached.length - 1; i >= 0; i --) {
			if (now - cached[i][0] >= CLASSIFIERCACHEEXPIRE) {
				cached.splice(i, 1);
			}
		}
		if (cached.length === 0) {
			SESSIONPLOTCACHE.delete(key);
		}
	}
};
setInterval(clearExpiredClassifierCache, CLASSIFIERCACHEEXPIRE);

// 过滤系统快
const isSystemBlock = content => {
	if (!content) return true;
	let match = content.match(/^<(legal_and_financial_advice|tone_and_formatting|lists_and_bullets|user_wellbeing|evenhandedness|responding_to_mistakes_and_criticism|tool_result_safety|instructions|system\-reminder|\w+[ \-_](instruction|context|mode|hook|list|cutoff|tool|detail|handling|behavior|information|entry|entries)s?)>/i);
	if (match) return true;
	match = content.match(/^(Analyze this rollout and produce JSON with|## Memory\n\nYou have access to a memory folder with guidance from prior runs|# AGENTS.md instructions|You are a helpful assistant|You are a Claude agent|## Memory Writing Agent)/);
	if (match) return true;
	return false;
};
// 整理 ModelList 输出
const normalizeModelList = (modelList) => {
	if (Array.isArray(modelList)) return modelList;
	if (!modelList) return [];
	if (typeof modelList === 'string') return [modelList];
	modelList = modelList.models;
	if (Array.isArray(modelList)) return modelList;
	if (modelList && (typeof modelList === 'string')) return [modelList];
	return [];
};
// 匹配 Plot，注意 Copilot 可能会压缩内容，所以这里使用了贪婪匹配模式
const matchHistoricPlot = (message, plots) => {
	let matched = false;
	plots.some((plot, i) => {
		if ((message.role === 'user') !== plot[1]) return;
		if (Array.isArray(message.content)) {
			const matched = message.content.some(content => {
				if (content.type !== 'text') return;
				const ctx = content.text.trim();
				return plot[2] === ctx;
			});
			if (!matched) return;
		}
		else if (typeof message.content === 'string') {
			const ctx = message.content.trim();
			if (plot[2] !== ctx) return;
		}

		matched = true;
		plots.splice(i, 1);
		plot[0] = Date.now();
		return true;
	});

	return matched;
};
// 动态构建分类 prompt，包含可用 mode 列表
// 如果 prompt 文件不存在或为空，返回 null，调用方应直接使用 default mode
const buildClassificationPrompt = (availableModes, currentMode, isUser) => {
	const template = getPrompt(isUser ? 'classifier-forUser' : 'classifier-forAssistant');
	if (!template || !template.trim()) {
		return null;
	}
	const modeList = availableModes
		.map((m) => `- name: ${m.name}\n  description: ${m.description}`)
		.join('\n');
	return template
		.replace('{{availableModes}}', modeList)
		.replace('{{currentMode}}', currentMode || 'default');
};
// 解析分类结果 JSON
const parseClassificationResult = (text) => {
	if (!text) {
		return null;
	}
	// 去除可能的 markdown 代码块包裹
	let cleaned = text.trim();
	const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenceMatch) {
		cleaned = fenceMatch[1].trim();
	}
	try {
		const result = JSON.parse(cleaned);
		if (typeof result.is_new_topic === 'boolean') {
			return {
				isNewTopic: result.is_new_topic,
				mode: typeof result.mode === 'string' ? result.mode.trim() : '',
			};
		}
	}
	catch (e) {
		log('debug', `[Classifier] Failed to parse JSON: ${cleaned.substring(0, 200)}`);
	}
	return null;
};

const autoModelRouter = async (strategy, sessionId, originalRequest, copilotType) => {
	// 获取模型列表
	const config = getConfig();
	const modelMap = config.agents?.[strategy] || config.agents?.default;
	if (!modelMap) throw new Error('No model for current working strategy');

	// 对于 max_tokens 设置明显过小的，直接使用 quick 模型
	if (copilotType.isClaude && !(originalRequest.max_tokens > 10)) {
		log('debug', '[AutoModelRouter] Claude mode: max_tokens missing or <10, forcing quick mode');
		return normalizeModelList(modelMap.quick || modelMap.default);
	}

	// 提取有效信息记录
	let cleanMessages = [];
	if (copilotType.isClaude) {
		cleanMessages = JSON.parse(JSON.stringify(originalRequest.messages))
		.map((msg) => {
			if (msg.role !== 'user' && msg.role !== 'assistant') return null;
			if (typeof msg.content === 'string') {
				let ctx = msg.content.trim();
				const isSB = isSystemBlock(ctx);
				if (isSB) return null;
				return {
					role: msg.role,
					content: msg.content,
				};
			}
			if (!Array.isArray(msg.content)) {
				return null;
			}
			const textBlocks = msg.content.map((b) => {
				if (b.type !== 'text') return null;
				let msg = b.text;
				if (!msg?.trim) return null;
				msg = msg.trim();
				const isSB = isSystemBlock(msg);
				if (isSB) return null;
				return {
					type: 'text',
					text: msg,
				};
			}).filter(Boolean);
			if (textBlocks.length === 0) {
				return null;
			}
			return {
				role: msg.role,
				content: textBlocks,
			};
		})
		.filter(Boolean);
	}
	else if (copilotType.isOpenAI) {
		cleanMessages = JSON.parse(JSON.stringify(originalRequest.input))
		.map((msg) => {
			if (msg.role !== 'user' && msg.role !== 'assistant') return null;
			if (typeof msg.content === 'string') {
				let ctx = msg.content.trim();
				const isSB = isSystemBlock(ctx);
				if (isSB) return null;
				return {
					role: msg.role,
					content: msg.content,
				};
			}
			if (!Array.isArray(msg.content)) {
				return null;
			}
			const textBlocks = msg.content.map((b) => {
				if (b.type !== 'text' && b.type !== 'input_text') return null;
				let msg = b.text;
				if (!msg?.trim) return null;
				msg = msg.trim();
				const isSB = isSystemBlock(msg);
				if (isSB) return null;
				return {
					type: 'text',
					text: msg,
				};
			}).filter(Boolean);
			if (textBlocks.length === 0) {
				return null;
			}
			return {
				role: msg.role,
				content: textBlocks,
			};
		})
		.filter(Boolean);
	}
	else if (copilotType.isGemini) {
		cleanMessages = JSON.parse(JSON.stringify(originalRequest.contents))
		.map((msg) => {
			if (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'model') return null;
			if (!Array.isArray(msg.parts)) {
				return null;
			}
			const textBlocks = msg.parts.map((b) => {
				let msg = b.text;
				if (!msg?.trim) return null;
				msg = msg.trim();
				const isSB = isSystemBlock(msg);
				if (isSB) return null;
				return {
					type: 'text',
					text: msg,
				};
			}).filter(Boolean);
			if (textBlocks.length === 0) {
				return null;
			}
			return {
				role: msg.role,
				content: textBlocks,
			};
		})
		.filter(Boolean);
	}
	if (!cleanMessages.length) return normalizeModelList(modelMap.default);

	// 限制对话组数
	const plots = SESSIONPLOTCACHE.get(sessionId);
	if (plots?.length) {
		const filted = [], pts = [...plots];
		let count = 0;
		for (let i = cleanMessages.length - 1; i >= 0; i--) {
			const item = cleanMessages[i];
			filted.unshift(item);
			const matched = matchHistoricPlot(item, pts);
			if (matched) {
				count ++;
				if (count >= SESSIONPLOTLIMIT) break;
			}
		}
		cleanMessages = filted;
	}
	const maxGroupCount = config.conversationGroups > 0 ? config.conversationGroups : SESSIONMESSAGELIMIT;
	if (cleanMessages.length > 0) {
		const filteredMessages = [];
		let isAI = false, convGroupIdx = 0;
		cleanMessages.reverse().some(item => {
			if (item.role === 'user') {
				if (isAI) {
					convGroupIdx ++;
					if (convGroupIdx >= maxGroupCount) {
						return true;
					}
				}
				isAI = false;
			}
			else {
				isAI = true;
			}
			filteredMessages.push(item);
		});
		cleanMessages.reverse();
	}
	if (!cleanMessages.length) return normalizeModelList(modelMap.default);

	// 判断是否继续之前的工作模式
	const now = Date.now();
	const sessionCache = SESSIONWORKINGMODE.get(sessionId) || {};
	const currentMode = sessionCache.mode || 'default';
	const lastClassifyTimestamp = sessionCache.timestamp || now;
	const modeCacheTtlSec = config.modeCacheTtl > 0 ? config.modeCacheTtl : 60;
	const modeCacheTtlMs = modeCacheTtlSec * 1000 * (!!currentMode && !["default", "quick"].includes(currentMode) ? 1 : 0);
	if (now - lastClassifyTimestamp < modeCacheTtlMs) {
		log('debug', '[Auto] Use current working mode');
		return normalizeModelList(modelMap[currentMode] || modelMap.default);
	}

	// 生成去重查询
	let cacheKey = [];
	cacheKey.push(currentMode);
	cleanMessages.forEach(msg => {
		if (Array.isArray(msg.content)) {
			msg.content.forEach(item => {
				if (item.type === 'text') {
					cacheKey.push(item.text.substring(0, 50));
				}
			});
		}
		else if (typeof msg.content === 'string') {
			cacheKey.push(msg.content.substring(0, 50));
		}
	});
	cacheKey = cacheKey.join('\n');
	// 检查缓存
	const cached = CACHEDCLASSIFIERRESULT.get(cacheKey);
	if (cached) {
		const duration = Date.now() - cached.timestamp;
		if (duration >= CLASSIFIERCACHEEXPIRE || !cached.cache) {
			CACHEDCLASSIFIERRESULT.delete(cacheKey);
		}
		else {
			log('debug', `[AutoModelRouter] Cache hit: isNewTopic=${cached.cache.isNewTopic}, mode="${cached.cache.mode}"`);
			cached.timestamp = Date.now(); // 更新时间戳，延迟过期
			return normalizeModelList(modelMap[cached.cache.mode] || modelMap.default);
		}
	}

	// 对最后一组对话进行修饰
	let last = cleanMessages[cleanMessages.length - 1];
	const isUser = last?.role === 'user';
	if (isUser) {
		if (Array.isArray(last.content)) {
			last = last.content[last.content.length - 1];
			const ctx = last.text.trim();
			last.text = getPrompt('classifier-prefix') + '\n\n' + ctx;
			last = ctx;
		}
		else {
			const ctx = last.content.trim();
			last.content = getPrompt('classifier-prefix') + '\n\n' + ctx;
			last = ctx;
		}
	}

	// 生成判断工作模式的提示词
	const availableModes = Object.entries(modelMap)
	.filter(([name]) => name !== 'default' && name !== 'quick')
	.map(([name, entry]) => ({ name, description: entry.description }));
	const classificationPrompt = buildClassificationPrompt(availableModes, currentMode, isUser);
	if (!classificationPrompt) {
		log('warn', '[AutoModelRouter] No classification prompt available, falling back to default mode');
		return normalizeModelList(modelMap.default);
	}
	cleanMessages.push({
		role: 'user',
		content: [{ type: 'text', text: classificationPrompt }],
	});
	const systemPrompt = getPrompt('classifier-system') || 'You are a request router. Always respond with valid JSON only.';
	const options = {
		sessionId,
		tools: null,
		temperature: DEFAULT_TEMPERATURE,
		thinking: false,
		useCache: true,
		json_schema: null
	};

	const quickModels = normalizeModelList(modelMap.quick || modelMap.default);
	if (quickModels.length === 0) {
		log('debug', '[AutoModelRouter] No quick model available');
		return normalizeModelList(modelMap.default);
	}
	const classifyWorkingMode = async () => {
		const config = getConfig();
		// 根据算法挑选 Provider/Model
		const quickModelConfig = modelRouter.selectModel(quickModels);
		const provider = config.providers?.[quickModelConfig.providerName];
		if (!provider || provider.type === 'auto') {
			log('warn', `[Auto] Quick provider invalid: ${quickSelected.providerName}, retrying`);
			throw new Error("Invalid quick provider");
		}
		const model = quickModelConfig.model;
		const maxTokens = resolveMaxTokens(provider, model);
		options.maxTokens = maxTokens;
		classifierIndex ++;
		const cid = classifierIndex;
		const startTime = Date.now();
		log('debug', `[AutoModelRouter] Sending to ${quickModelConfig.providerName}:${model}, modes=[${availableModes.map((m) => m.name).join(',')}]`);
		logClientStage('AUTO', cid, '0', 'classifyTopic', {
			provider: provider._name,
			model,
			system: systemPrompt,
			messages: cleanMessages,
			maxTokens,
		}, true);

		let classifyResult;
		modelRouter.startTask(quickModelConfig.providerName, model);
		try {
			if (provider.type === 'anthropic') {
				const result = await sendAnthropicRequestUnStreamly(provider, model, cleanMessages, systemPrompt, options);
				if (Array.isArray(result.content)) {
					classifyResult = result.content.map(item => (item.text || '').trim()).filter(Boolean).join('\n\n');
				}
				else if (typeof result.content === 'string') {
					classifyResult = result.content.trim();
				}
				else {
					log('warn', `[AutoModelRouter] Received invalid response:`);
					console.warn(result);
					throw new Error('Invalid Response');
				}
			}
			else if (provider.type === 'openai') {
				const result = await sendOpenAICompletionRequestUnStreamly(provider, model, cleanMessages, systemPrompt, options);
				if (Array.isArray(result.content?.content)) {
					classifyResult = result.content.content.map(item => (item.text || '').trim()).filter(Boolean).join('\n\n');
				}
				else if (typeof result.content?.content === 'string') {
					classifyResult = result.content.content.trim();
				}
				else {
					log('warn', `[AutoModelRouter] Received invalid response:`);
					console.warn(result);
					throw new Error('Invalid Response');
				}
			}
			else if (provider.type === 'gemini') {
				const result = await sendGeminiRequestUnStreamly(provider, model, cleanMessages, systemPrompt, options);
				if (Array.isArray(result.content?.parts)) {
					classifyResult = result.content.parts.map(item => (item.text || '').trim()).filter(Boolean).join('\n\n');
				}
				else if (typeof result.content?.parts === 'string') {
					classifyResult = result.content.parts.trim();
				}
				else {
					log('warn', `[AutoModelRouter] Received invalid response:`);
					console.warn(result);
					throw new Error('Invalid Response');
				}
			}
			modelRouter.finishTask(quickModelConfig.providerName, model, true, false);
		}
		catch (err) {
			modelRouter.finishTask(quickModelConfig.providerName, model, false, err.isProviderDown);

			const elapsed = Date.now() - startTime;
			log('error', `[AutoModelRouter] Request failed after ${elapsed}ms: ${err.message}`);
			console.error(err);
			throw err;
		}
		if (!classifyResult) throw new Error('Result empty response');

		const now = Date.now();
		const elapsed = now - startTime;
		logClientStage('AUTO', cid, '0', 'classifyTopic', '\n------\n', true);
		logClientStage('AUTO', cid, '0', 'classifyTopic', 'TimeSpent: ' + elapsed + 'ms\n', true);
		logClientStage('AUTO', cid, '0', 'classifyTopic', classifyResult, true);
		const result = parseClassificationResult(classifyResult);
		if (!result) {
			log('warn', `[AutoModelRouter] Failed to parse result (${elapsed}ms)`);
			throw new Error('Failed to parse classification result');
		}

		log('info', `[AutoModelRouter] Result (${elapsed}ms): isNewTopic=${result.isNewTopic}, mode=${result.mode}, IsUserTurn=${isUser}`);
		// 记录新对话点
		if (result.isNewTopic) {
			let plots = SESSIONPLOTCACHE.get(sessionId);
			if (!plots) {
				plots = [];
				SESSIONPLOTCACHE.set(sessionId, plots);
			}
			const has = plots.some(p => {
				if (p[1] !== isUser || p[2] !== last) return false;
				p[0] = now;
			});
			if (!has) plots.push([now, isUser, last]);
		}
		// 缓存分析结果
		const cache = {
			timestamp: now,
			cache: {...result}
		};
		CACHEDCLASSIFIERRESULT.set(cacheKey, cache);
		return normalizeModelList(modelMap[result.mode] || modelMap.default);
	};

	return await executeWithRetry(classifyWorkingMode, 3)();
};

module.exports = {
	autoModelRouter,
};
