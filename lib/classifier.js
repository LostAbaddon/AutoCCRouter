const { log, logClientStage } = require('./logger');
const { proxyRequest } = require('./proxy-agent');
const { convertAnthropicToGemini } = require('./providers/gemini');
const { buildOpenAIRequest } = require('./providers/openai-compat');
const { getPrompt } = require('./prompt-store');
const { recordUsage } = require('./usage-tracker');
const { acquireKey, releaseKey } = require('./key-state-manager');
const { classifyResponse } = require('./error-detector');

const CLASSIFICATION_TIMEOUT = 10000;
const CACHEDCLASSIFIERRESULT = new Map();
const CLASSIFIERCACHEEXPIRE = 10 * 60 * 1000; // 缓存10分钟
let classifierIndex = 0;

// 自动清除过期缓存
const clearExpiredClassifierCache = () => {
	const now = Date.now();
	for (const [key, cached] of CACHEDCLASSIFIERRESULT) {
		if (now - cached.timestamp >= CLASSIFIERCACHEEXPIRE) {
			CACHEDCLASSIFIERRESULT.delete(key);
		}
	}
};
setInterval(clearExpiredClassifierCache, CLASSIFIERCACHEEXPIRE);

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

// 从 Anthropic 格式响应中提取 text
const extractTextFromAnthropicResponse = (resp) => {
	if (!resp || !Array.isArray(resp.content)) {
		return null;
	}
	const texts = resp.content
		.filter((b) => b.type === 'text' && b.text)
		.map((b) => b.text);
	return texts.join('') || null;
};

// 从 Gemini 格式响应中提取 text
const extractTextFromGeminiResponse = (resp) => {
	if (!resp || !Array.isArray(resp.candidates)) {
		return null;
	}
	const texts = [];
	for (const c of resp.candidates) {
		const parts = (c.content && c.content.parts) || [];
		for (const p of parts) {
			if (p.text) {
				texts.push(p.text);
			}
		}
	}
	return texts.join('') || null;
};

// 从 OpenAI 格式响应中提取 text
const extractTextFromOpenAIResponse = (resp) => {
	if (!resp || !Array.isArray(resp.choices)) {
		return null;
	}
	const choice = resp.choices[0];
	if (!choice || !choice.message) {
		return null;
	}
	return choice.message.content || null;
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

// 发送 Anthropic 格式的分类请求
const sendAnthropicClassification = (provider, body, maxTokens, callback) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};
	// Anthropic API requires max_tokens
	body.max_tokens = maxTokens;
	const targetUrl = new URL(provider.baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const path = `${pathPrefix}/v1/messages`;
	const bodyStr = JSON.stringify(body);

	const options = {
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

	log('debug', `[Classifier] POST ${options.hostname}${path}`);

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			return;
		}
		settled = true;
		if (err) {
			settleKey({ isProviderDown: true });
			callback(err);
			return;
		}

		let data = '';
		proxyRes.on('data', (chunk) => {
			data += chunk;
		});
		proxyRes.on('end', () => {
			if (proxyRes.statusCode !== 200) {
			const cr = classifyResponse(proxyRes.statusCode, data);
			settleKey({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
			log('warn', `[Classifier] HTTP ${proxyRes.statusCode}: ${data.substring(0, 300)}`);
				callback(new Error(`Classification HTTP ${proxyRes.statusCode}`));
				return;
			}
			try {
				const resp = JSON.parse(data);
				const finishReason = resp.stop_reason || 'unknown';
				log('debug', `[Classifier] Anthropic finishReason=${finishReason}, usage=${JSON.stringify(resp.usage)}`);
				const text = extractTextFromAnthropicResponse(resp);
				settleKey({ isSuccess: true });
				if (resp.usage) {
					recordUsage(provider._name, body.model, {
						input_tokens: resp.usage.input_tokens || 0,
						output_tokens: resp.usage.output_tokens || 0,
						cache_read_tokens: resp.usage.cache_read_tokens || resp.usage.cache_read_input_tokens || 0,
					}, 'auto');
				}
				callback(null, text);
			}
			catch (e) {
				log('warn', `[Classifier] Failed to parse response: ${e.message}`);
				settleKey({ isKeyFailure: true });
				callback(new Error('Invalid classification response'));
			}
		});
		proxyRes.on('error', (e) => {
			settleKey({ isProviderDown: true });
			callback(e);
		});
	};

	const proxyReq = proxyRequest(provider.proxy, options, bodyStr, once);
	proxyReq.setTimeout(CLASSIFICATION_TIMEOUT);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		settleKey({ isProviderDown: true });
		once(new Error('Classification timeout'));
	});
};

// 发送 Gemini 格式的分类请求
const sendGeminiClassification = (provider, model, body, callback) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};
	const geminiBody = convertAnthropicToGemini(body);
	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const path = `${pathPrefix}/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
	const bodyStr = JSON.stringify(geminiBody);

	const options = {
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

	log('debug', `[Classifier] Gemini POST ${options.hostname}${path}`);

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			return;
		}
		settled = true;
		if (err) {
			settleKey({ isProviderDown: true });
			callback(err);
			return;
		}

		let data = '';
		proxyRes.on('data', (chunk) => {
			data += chunk;
		});
		proxyRes.on('end', () => {
			if (proxyRes.statusCode !== 200) {
				log('warn', `[Classifier] Gemini HTTP ${proxyRes.statusCode}: ${data.substring(0, 300)}`);
				callback(new Error(`Classification HTTP ${proxyRes.statusCode}`));
				return;
			}
			try {
				const resp = JSON.parse(data);
				const finishReason = (resp.candidates && resp.candidates[0] && resp.candidates[0].finishReason) || 'unknown';
				log('debug', `[Classifier] Gemini finishReason=${finishReason}`);
				const text = extractTextFromGeminiResponse(resp);
				settleKey({ isSuccess: true });
				if (resp.usageMetadata) {
					recordUsage(provider._name, model, {
						input_tokens: resp.usageMetadata.promptTokenCount || 0,
						output_tokens: resp.usageMetadata.candidatesTokenCount || 0,
						cache_read_tokens: resp.usageMetadata.cachedContentTokenCount || 0,
					}, 'auto');
				}
				callback(null, text);
			}
			catch (e) {
				log('warn', `[Classifier] Failed to parse Gemini response: ${e.message}`);
				settleKey({ isKeyFailure: true });
				callback(new Error('Invalid classification response'));
			}
		});
		proxyRes.on('error', (e) => {
			settleKey({ isProviderDown: true });
			callback(e);
		});
	};

	const proxyReq = proxyRequest(provider.proxy, options, bodyStr, once);
	proxyReq.setTimeout(CLASSIFICATION_TIMEOUT);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		settleKey({ isProviderDown: true });
		once(new Error('Classification timeout'));
	});
};

// 发送 OpenAI 格式的分类请求
const sendOpenAIClassification = (provider, body, callback) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};
	const openaiBody = buildOpenAIRequest(body);
	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);
	const path = `${targetUrl.pathname}/chat/completions`;
	const bodyStr = JSON.stringify(openaiBody);

	const options = {
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

	log('debug', `[Classifier] OpenAI POST ${options.hostname}${path}`);

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			return;
		}
		settled = true;
		if (err) {
			settleKey({ isProviderDown: true });
			callback(err);
			return;
		}

		let data = '';
		proxyRes.on('data', (chunk) => {
			data += chunk;
		});
		proxyRes.on('end', () => {
			if (proxyRes.statusCode !== 200) {
				log('warn', `[Classifier] OpenAI HTTP ${proxyRes.statusCode}: ${data.substring(0, 300)}`);
				callback(new Error(`Classification HTTP ${proxyRes.statusCode}`));
				return;
			}
			try {
				const resp = JSON.parse(data);
				const finishReason = (resp.choices && resp.choices[0] && resp.choices[0].finish_reason) || 'unknown';
				log('debug', `[Classifier] OpenAI finishReason=${finishReason}`);
				const text = extractTextFromOpenAIResponse(resp);
				settleKey({ isSuccess: true });
				if (resp.usage) {
					recordUsage(provider._name, body.model, {
						input_tokens: resp.usage.prompt_tokens || 0,
						output_tokens: resp.usage.completion_tokens || 0,
						cache_read_tokens: resp.usage.prompt_tokens_details?.cached_tokens || 0,
					}, 'auto');
				}
				callback(null, text);
			}
			catch (e) {
				log('warn', `[Classifier] Failed to parse OpenAI response: ${e.message}`);
				settleKey({ isKeyFailure: true });
				callback(new Error('Invalid classification response'));
			}
		});
		proxyRes.on('error', (e) => {
			settleKey({ isProviderDown: true });
			callback(e);
		});
	};

	const proxyReq = proxyRequest(provider.proxy, options, bodyStr, once);
	proxyReq.setTimeout(CLASSIFICATION_TIMEOUT);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		settleKey({ isProviderDown: true });
		once(new Error('Classification timeout'));
	});
};

// 过滤系统快
const isSystemBlock = content => {
	if (!content) return true;
	let match = content.match(/^<(system\-reminder|\w+ instructions|\w+\-instructions|\w+_instructions|\w+ context|\w+\-context|\w+_context|\w+ mode|\w+\-mode|\w+_mode|\w+ hook|\w+\-hook|\w+_hook)>/i);
	if (match) return true;
	match = content.match(/^(Analyze this rollout and produce JSON with|## Memory\n\nYou have access to a memory folder with guidance from prior runs|# AGENTS.md instructions for|You are a helpful assistant)/);
	if (match) return true;
	return false;
};

// 对外接口：话题分类
// callback(err, result)  result = { isNewTopic: boolean, mode: string } 或 null
const classifyTopic = (quickProvider, quickModel, messages, availableModes, maxTokens, currentMode, conversationGroups, callback) => {
	const startTime = Date.now();
	if (!quickProvider || !quickModel || !Array.isArray(messages)) {
		callback(new Error('Invalid classification parameters'));
		return;
	}

	// 深拷贝后处理，不动原始 messages，并过滤掉所有Copilot插入内容
	let cleanMessages = JSON.parse(JSON.stringify(messages))
	.map((msg) => {
		if (typeof msg.content === 'string') {
			let ctx = msg.content.trim();
			const isSB = isSystemBlock(ctx);
			if (isSB) return null;
			return msg;
		}
		if (!Array.isArray(msg.content)) {
			return null;
		}
		const textBlocks = msg.content.filter((b) => {
			if (b.type !== 'text') return;
			let msg = b.text;
			if (!msg?.trim) return;
			msg = msg.trim();
			return !isSystemBlock(msg);
		});
		if (textBlocks.length === 0) {
			return null;
		}
		msg.content = textBlocks;
		return msg;
	})
	.filter(Boolean);

	// 限制对话组数
	const maxGroups = (conversationGroups != null && conversationGroups > 0) ? conversationGroups : 5;
	if (cleanMessages.length > 0) {
		const filteredMessages = [];
		let isAI = false, convGroupIdx = 0;
		cleanMessages.reverse().some(item => {
			if (item.role === 'user') {
				if (isAI) {
					convGroupIdx ++;
					if (convGroupIdx >= maxGroups) {
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
		log('debug', `[Classifier] Trimmed: ${messages.length} → ${cleanMessages.length} messages (${maxGroups} groups)`);
	}
	else {
		callback(null, {isNewTopic: true, mode: "quick"});
		return;
	}

	// 生成去重查询
	let cacheKey = [];
	cacheKey.push(currentMode || 'default');
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
			log('debug', `[Classifier] Cache hit: isNewTopic=${cached.cache.isNewTopic}, mode="${cached.cache.mode}"`);
			callback(null, {...cached.cache});
			return;
		}
	}

	// 对最后一组对话进行修饰
	let last = cleanMessages[cleanMessages.length - 1];
	const isUser = last?.role === 'user';
	if (isUser) {
		if (Array.isArray(last.content)) {
			last = last.content[last.content.length - 1];
			last.text = getPrompt('classifier-prefix') + '\n\n' + last.text.trim();
		}
		else {
			last.content = getPrompt('classifier-prefix') + '\n\n' + last.content.trim();
		}
	}

	// 生成判断工作模式的提示词
	const classificationPrompt = buildClassificationPrompt(availableModes, currentMode, isUser);
	if (!classificationPrompt) {
		log('info', '[Classifier] No classification prompt available, falling back to default mode');
		callback(null, { isNewTopic: true, mode: '' });
		return;
	}

	const classificationBody = {
		model: quickModel,
		messages: [
			...cleanMessages,
			{
				role: 'user',
				content: [{ type: 'text', text: classificationPrompt }],
			},
		],
		stream: false,
		system: [{ type: 'text', text: getPrompt('classifier-system') || 'You are a request router. Always respond with valid JSON only.' }],
		thinking: { type: 'disabled' },
	};

	log('debug', `[Classifier] Sending to ${quickProvider.type}:${quickModel}, modes=[${availableModes.map((m) => m.name).join(',')}]`);
	classifierIndex ++;
	const cid = classifierIndex;
	logClientStage('AUTO', cid, '0', 'classifyTopic', classificationBody, true);

	const handleResponse = (err, text) => {
		const elapsed = Date.now() - startTime;
		if (err) {
			log('warn', `[Classifier] Request failed after ${elapsed}ms: ${err.message}`);
			callback(err, null);
			return;
		}
		log('debug', `[Classifier] Raw response: ${(text || '').substring(0, 300)}`);

		const result = parseClassificationResult(text);
		logClientStage('AUTO', cid, '0', 'classifyTopic', '\n------\n', true);
		logClientStage('AUTO', cid, '0', 'classifyTopic', 'TimeSpent: ' + elapsed + 'ms\n', true);
		logClientStage('AUTO', cid, '0', 'classifyTopic', text, true);
		if (!result) {
			log('warn', `[Classifier] Failed to parse result after ${elapsed}ms`);
			callback(new Error('Failed to parse classification result'), null);
		}
		else {
			log('info', `[Classifier] Result (${elapsed}ms): isNewTopic=${result.isNewTopic}, mode=${result.mode}, IsUserTurn=${isUser}`);
			const cache = {
				timestamp: Date.now(),
				cache: {...result}
			};
			CACHEDCLASSIFIERRESULT.set(cacheKey, cache);
			callback(null, result);
		}
	};

	if (quickProvider.type === 'gemini') {
		sendGeminiClassification(quickProvider, quickModel, classificationBody, handleResponse);
	}
	else if (quickProvider.type === 'openai') {
		sendOpenAIClassification(quickProvider, classificationBody, handleResponse);
	}
	else {
		// anthropic 及其他
		sendAnthropicClassification(quickProvider, classificationBody, maxTokens, handleResponse);
	}
};

module.exports = {
	classifyTopic,
	buildClassificationPrompt,
};
