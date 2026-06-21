const { log, getNextInteractionId, logClientStage } = require('../logger');
const { proxyRequest } = require('../proxy-agent');
const { acquireKey, releaseKey } = require('../key-state-manager');
const { classifyResponse, classifyStreamFirstBlock } = require('../error-detector');
const { recordUsage } = require('../usage-tracker');
const { resolveMaxTokens } = require('../config');
const { mapModel } = require('../model-mapper');
const { getSession, setSession, getCachedMode, deriveSessionKey } = require('../session-store');
const { classifyTopic } = require('../classifier');
const { translateTools, enableHotReload } = require('../tool-translator');
const { recordToolCall, lookupToolCall, removeToolCall } = require('../tool-translator/call-id-map');

enableHotReload();

// 某些 OpenAI 兼容 provider（如 Moonshot）后端会对 tool_call_id 做内部归一化（例如 _ → :），
// 导致 assistant tool_calls 的 id 和 tool 消息的 tool_call_id 对不上。统一把下划线替换为连字符，
// 保证请求内部成对出现。
const normalizeToolCallId = (id) => {
	if (typeof id !== 'string' || id.length === 0) {
		return id;
	}
	return id.replace(/_/g, '-');
};

// 对 OpenAI Chat Completions 格式的请求体统一归一化 tool_call_id
const normalizeChatBodyToolCallIds = (body) => {
	if (!body || !Array.isArray(body.messages)) {
		return;
	}
	for (const msg of body.messages) {
		if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
			for (const tc of msg.tool_calls) {
				if (tc.id) {
					tc.id = normalizeToolCallId(tc.id);
				}
			}
		}
		else if (msg.role === 'tool' && msg.tool_call_id) {
			msg.tool_call_id = normalizeToolCallId(msg.tool_call_id);
		}
	}
};

// 缓存 DeepSeek thinking blocks，按 call_id 持久化映射，用于在后续请求中回传
// Map<conversationKey, Map<tool_use_call_id, {thinking, signature}>>
const pendingThinking = new Map();

// 将 OpenAI Chat Completions 请求转为 Anthropic Messages 请求
// targetProvider 用于 tool-translator 识别 provider 能力(如 minimax / deepseek / google)
const convertOpenAIRequestToAnthropic = (openaiBody, targetModel = '', sessionId = 'default', targetProvider = 'deepseek') => {
	const anthropicBody = {
		model: openaiBody.model,
		messages: [],
		stream: openaiBody.stream || false,
	};

	// System message(s)
	const systemMessages = (openaiBody.messages || []).filter((m) => m.role === 'system');
	if (systemMessages.length > 0) {
		const systemTexts = systemMessages.map((m) => {
			if (typeof m.content === 'string') {
				return m.content;
			}
			if (Array.isArray(m.content)) {
				return m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
			}
			return '';
		});
		anthropicBody.system = systemTexts.join('\n');
	}

	// Non-system messages
	const nonSystem = (openaiBody.messages || []).filter((m) => m.role !== 'system');
	// Anthropic requires alternating roles; merge consecutive same-role messages
	let lastRole = null;
	for (const msg of nonSystem) {
		let role = msg.role;
		if (role === 'tool') {
			role = 'user';
		}

		const content = [];

		if (typeof msg.content === 'string') {
			if (msg.content) {
				content.push({ type: 'text', text: msg.content });
			}
		}
		else if (Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type === 'text' && block.text) {
					content.push({ type: 'text', text: block.text });
				}
				else if (block.type === 'image_url' && block.image_url) {
					const url = block.image_url.url;
					if (url.startsWith('data:')) {
						const match = url.match(/^data:([^;]+);base64,(.+)$/);
						if (match) {
							content.push({
								type: 'image',
								source: {
									type: 'base64',
									media_type: match[1],
									data: match[2],
								},
							});
						}
					}
				}
			}
		}

		// Tool calls (assistant)
		if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
			for (const tc of msg.tool_calls) {
				let input = {};
				const args = tc.function && tc.function.arguments;
				if (typeof args === 'string') {
					try {
						input = JSON.parse(args);
					}
					catch (e) {
						input = { _raw: args };
					}
				}
				else if (typeof args === 'object') {
					input = args;
				}
				content.push({
					type: 'tool_use',
					id: tc.id || `toolu_${content.length}`,
					name: tc.function ? tc.function.name : '',
					input,
				});
			}
		}

		// Tool results (tool role → user role in Anthropic)
		if (msg.role === 'tool' && msg.tool_call_id) {
			const resultContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || {});
			content.push({
				type: 'tool_result',
				tool_use_id: msg.tool_call_id,
				content: resultContent,
			});
		}

		if (content.length === 0 && role !== 'assistant') {
			continue;
		}
		if (content.length === 0 && role === 'assistant') {
			content.push({ type: 'text', text: '' });
		}

		// Merge with previous message if same role
		if (role === lastRole && anthropicBody.messages.length > 0) {
			const last = anthropicBody.messages[anthropicBody.messages.length - 1];
			if (role === 'assistant') {
				const textBlocks = content.filter((b) => b.type === 'text');
				const otherBlocks = content.filter((b) => b.type !== 'text');
				last.content = [...last.content, ...textBlocks, ...otherBlocks];
			}
			else {
				last.content = [...last.content, ...content];
			}
		}
		else {
			anthropicBody.messages.push({ role, content });
			lastRole = role;
		}
	}

	// Tools — 通过 tool-translator 翻译(识别内置工具,避免被降级为普通 function)
	if (Array.isArray(openaiBody.tools)) {
		anthropicBody.tools = translateTools(openaiBody.tools, 'openai_chat', targetProvider);
	}

	// Tool choice — 字符串转为 Anthropic 对象格式
	if (openaiBody.tool_choice && openaiBody.tool_choice !== 'none') {
		anthropicBody.tool_choice = convertToolChoiceToAnthropic(openaiBody.tool_choice);
	}
	else if (openaiBody.tool_choice === 'none') {
		delete anthropicBody.tools;
	}

	// Parameters mapping
	if (openaiBody.max_completion_tokens) {
		anthropicBody.max_tokens = openaiBody.max_completion_tokens;
	}
	else if (openaiBody.max_tokens) {
		anthropicBody.max_tokens = openaiBody.max_tokens;
	}
	if (openaiBody.temperature !== undefined) {
		anthropicBody.temperature = openaiBody.temperature;
	}
	if (openaiBody.top_p !== undefined) {
		anthropicBody.top_p = openaiBody.top_p;
	}
	if (openaiBody.stop) {
		anthropicBody.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
	}

	// Reasoning/thinking support
	if (openaiBody.reasoning_effort && (targetModel.includes('deepseek') || targetModel.includes('claude'))) {
		anthropicBody.thinking = { type: 'enabled' };
	}

	
	// Inject pending thinking blocks if any (for deepseek)
	const effectiveThinkingKey = sessionId || 'default';
	log('debug', `[Thinking-Inject] sessionId="${sessionId}" key="${effectiveThinkingKey}" pendingThinking.size=${pendingThinking.size} keys=[${[...pendingThinking.keys()].join(', ')}]`);
	const thinkMap = pendingThinking.get(effectiveThinkingKey);
	if (thinkMap && thinkMap.size > 0) {
		log('debug', `[Thinking-Inject] Found thinkMap key="${effectiveThinkingKey}" size=${thinkMap.size} ids=[${[...thinkMap.keys()].join(', ')}]`);
	}
	const assistantMsgs = anthropicBody.messages.filter((m) => m.role === 'assistant');
	log('debug', `[Thinking-Inject] Request has ${assistantMsgs.length} assistant msgs, total msgs=${anthropicBody.messages.length}`);
	for (const msg of anthropicBody.messages) {
		if (msg.role !== 'assistant') {
			continue;
		}
		const hasThinking = msg.content.some((b) => b.type === 'thinking');
		if (hasThinking) {
			log('debug', `[Thinking-Inject] Skipping assistant msg: already has thinking block`);
			continue;
		}

		const toolUses = msg.content.filter((b) => b.type === 'tool_use');
		log('debug', `[Thinking-Inject] Assistant msg has ${toolUses.length} tool_use(s), ids=[${toolUses.map((t) => t.id).join(', ')}]`);
		if (toolUses.length === 0) continue;

		const firstToolUse = toolUses[0];
		let injectedTb = null;
		if (thinkMap) {
			injectedTb = thinkMap.get(firstToolUse.id);
		}
		if (injectedTb) {
			msg.content = [{ type: 'thinking', thinking: injectedTb.thinking, signature: injectedTb.signature || '' }, ...msg.content];
			log('debug', `[Thinking-Inject] INJECTED saved thinking for tool_use id="${firstToolUse.id}" thinking_len=${injectedTb.thinking.length}`);
		}
		else {
			// Try-inject fallback: synthetic thinking block
			msg.content = [
				{
					type: 'thinking',
					thinking: '(Synthetic thinking block for protocol compliance)',
					signature: 'synthetic:' + firstToolUse.id,
				},
				...msg.content,
			];
			log('debug', `[Thinking-Inject] INJECTED synthetic thinking for tool_use id="${firstToolUse.id}"`);
		}
	}

	return anthropicBody;
};

// 将 Anthropic 非流式 JSON 响应转为 OpenAI Chat Completions 响应
const transformAnthropicToOpenAIResponse = (anthropicResp, modelName, sessionId) => {
	const content = anthropicResp.content || [];
	const textParts = content.filter((b) => b.type === 'text').map((b) => b.text);
	const toolCalls = content.filter((b) => b.type === 'tool_use');
	const thinkingBlocks = content.filter((b) => b.type === 'thinking');

	// Save thinking blocks for DeepSeek: when tool_use present, persist thinking → pendingThinking
	if (toolCalls.length > 0 && thinkingBlocks.length > 0) {
		const effKey = sessionId || 'default';
		if (!pendingThinking.has(effKey)) {
			pendingThinking.set(effKey, new Map());
		}
		const thinkMap = pendingThinking.get(effKey);
		// Associate first thinking block with first tool_use (DeepSeek returns 1 thinking per response)
		const tb = thinkingBlocks[0];
		thinkMap.set(toolCalls[0].id, {
			thinking: tb.thinking,
			signature: tb.signature || '',
		});
		log('debug', `[Thinking-Save-NonStream] Saved thinking for callId="${toolCalls[0].id}" key="${effKey}" thinking_len=${tb.thinking.length} toolCalls=${toolCalls.length} thinkingBlocks=${thinkingBlocks.length}`);
	}
	else if (toolCalls.length > 0) {
		log('debug', `[Thinking-Save-NonStream] Response has ${toolCalls.length} tool_use(s) but NO thinking blocks (content types: [${content.map(b=>b.type).join(', ')}])`);
	}

	const message = { role: 'assistant', content: textParts.join('') || null };

	if (toolCalls.length > 0) {
		message.tool_calls = toolCalls.map((tc, idx) => {
			if (tc.id) {
				recordToolCall(tc.id, { upstreamName: tc.name });
			}
			return {
				id: tc.id || `call_${idx}`,
				type: 'function',
				function: {
					name: tc.name,
					arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {}),
				},
			};
		});
	}

	// 透传上游 reasoning 数据：无论调用方是谁，都必须把思考内容原样给到调用方
	if (thinkingBlocks.length > 0) {
		const reasoningText = thinkingBlocks.map((tb) => tb.thinking || '').join('');
		if (reasoningText) {
			message.reasoning_content = reasoningText;
		}
	}

	const stopReasonMap = {
		'end_turn': 'stop',
		'max_tokens': 'length',
		'tool_use': 'tool_calls',
		'stop_sequence': 'stop',
	};
	const finishReason = stopReasonMap[anthropicResp.stop_reason] || 'stop';

	const usage = anthropicResp.usage ? {
		prompt_tokens: anthropicResp.usage.input_tokens || 0,
		completion_tokens: anthropicResp.usage.output_tokens || 0,
		total_tokens: (anthropicResp.usage.input_tokens || 0) + (anthropicResp.usage.output_tokens || 0),
	} : undefined;

	return {
		id: anthropicResp.id || `chatcmpl-${Date.now()}`,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: modelName,
		choices: [{
			index: 0,
			message,
			finish_reason: finishReason,
		}],
		usage,
	};
};

// 将 Anthropic SSE 流转换为 OpenAI SSE 流, 直接写到 res
const transformAnthropicStreamToOpenAI = (res, originalModel, anthropicStream, usageMeta, sessionId) => {
	let msgId = null;
	let textContent = '';
	let created = Math.floor(Date.now() / 1000);
	let streamCacheReadTokens = 0;
	let streamPromptTokens = 0;
	let streamCompletionTokens = 0;
	let finishReason = 'stop';
	let choiceIndex = 0;
	let firstChunk = true;
	// Thinking block tracking (DeepSeek requires thinking blocks to be passed back)
	let thinkingText = '';
	let thinkingSignature = '';
	let lastThinking = null;
	let inThinking = false;
	let currentToolCallId = null;
	let currentToolName = '';
	// Full response accumulator for logging
	let fullResponseEvents = [];

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	const writeSSE = (data) => {
		const sseText = `data: ${JSON.stringify(data)}\n\n`;
		if (usageMeta && usageMeta.interactionId) {
			logClientStage('codex', usageMeta.interactionId, '4', 'result', sseText);
		}
		res.write(sseText);
	};

	let buffer = '';
	anthropicStream.on('data', (chunk) => {
		buffer += chunk.toString();

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) {
				continue;
			}

			const jsonStr = line.substring(6);
			let parsed;
			try {
				parsed = JSON.parse(jsonStr);
				fullResponseEvents.push(line + '\n');
				if (usageMeta && usageMeta.interactionId) {
					logClientStage('codex', usageMeta.interactionId, '3', 'response', line + '\n');
				}
			}
			catch (e) {
				continue;
			}

			if (parsed.type === 'message_start') {
				msgId = parsed.message ? parsed.message.id : null;
				if (parsed.message && parsed.message.usage) {
					streamPromptTokens = Math.max(streamPromptTokens, parsed.message.usage.input_tokens || 0);
					streamCompletionTokens = Math.max(streamCompletionTokens, parsed.usage.output_tokens || 0);
					streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.message.usage.cache_read_input_tokens || 0);
				}
				created = Math.floor(Date.now() / 1000);
			}
			else if (parsed.type === 'content_block_start') {
				const block = parsed.content_block || {};
				if (block.type === 'thinking' || block.type === 'redacted_thinking') {
					thinkingText = '';
					thinkingSignature = '';
					inThinking = true;
					log('debug', '[Thinking-Save-Stream] content_block_start: thinking detected');
				}
				else if (block.type === 'tool_use') {
					currentToolCallId = block.id;
					currentToolName = block.name || '';
					log('debug', `[Thinking-Save-Stream] content_block_start: tool_use id="${block.id}" name="${block.name}"`);
				}
			}
			else if (parsed.type === 'content_block_delta') {
				if (parsed.delta && parsed.delta.type === 'thinking_delta') {
					if (inThinking) {
						const t = parsed.delta.thinking || '';
						thinkingText += t;
						thinkingSignature = parsed.delta.signature || thinkingSignature;
						// 实时向调用方发射 reasoning_content delta —— 代理层无资格过滤上游内容
						const chunkData = {
							id: msgId || `chatcmpl-${Date.now()}`,
							object: 'chat.completion.chunk',
							created,
							model: originalModel,
							choices: [{
								index: choiceIndex,
								delta: { reasoning_content: t },
								finish_reason: null,
							}],
						};
						writeSSE(chunkData);
					}
				}
				else if (parsed.delta && parsed.delta.type === 'text_delta' && parsed.delta.text) {
					textContent += parsed.delta.text;
					const chunkData = {
						id: msgId || `chatcmpl-${Date.now()}`,
						object: 'chat.completion.chunk',
						created,
						model: originalModel,
						choices: [{
							index: choiceIndex,
							delta: { content: parsed.delta.text, role: firstChunk ? 'assistant' : undefined },
							finish_reason: null,
						}],
					};
					if (firstChunk) {
						firstChunk = false;
					}
					writeSSE(chunkData);
				}
			}
			else if (parsed.type === 'content_block_stop') {
				// Save thinking block
				if (inThinking && thinkingText) {
					lastThinking = {
						thinking: thinkingText,
						signature: thinkingSignature,
					};
					inThinking = false;
					thinkingText = '';
					thinkingSignature = '';
				}
				// When tool_use block ends, persist thinking → pendingThinking
				if (currentToolCallId && lastThinking && lastThinking.thinking) {
					const effKey = sessionId || 'default';
					if (!pendingThinking.has(effKey)) {
						pendingThinking.set(effKey, new Map());
					}
					recordToolCall(currentToolCallId, { upstreamName: currentToolName });
					pendingThinking.get(effKey).set(currentToolCallId, {
						thinking: lastThinking.thinking,
						signature: lastThinking.signature,
					});
					log('debug', `[Thinking-Save-Stream] Saved thinking callId="${currentToolCallId}" key="${effKey}" thinking_len=${lastThinking.thinking.length} pendingThinking.size=${pendingThinking.size}`);
					lastThinking = null;
					currentToolCallId = null;
				}
				else if (currentToolCallId) {
					log('debug', `[Thinking-Save-Stream] tool_use stop callId="${currentToolCallId}" but lastThinking=${!!lastThinking} hasThinking=${!!(lastThinking && lastThinking.thinking)}`);
					currentToolCallId = null;
				}
			}
			else if (parsed.type === 'message_delta') {
				const stopReasonMap = {
					'end_turn': 'stop',
					'max_tokens': 'length',
					'tool_use': 'tool_calls',
					'stop_sequence': 'stop',
				};
				finishReason = stopReasonMap[parsed.delta && parsed.delta.stop_reason] || 'stop';
				if (parsed.usage) {
					streamPromptTokens = Math.max(streamPromptTokens, parsed.message.usage.input_tokens || 0);
					streamCompletionTokens = Math.max(streamCompletionTokens, parsed.usage.output_tokens || 0);
					streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.message.usage.cache_read_input_tokens || 0);
				}
			}
			else if (parsed.type === 'message_stop') {
				if (usageMeta && (streamPromptTokens > 0 || streamCompletionTokens > 0)) {
					recordUsage(usageMeta.providerName || 'openai', usageMeta.targetModel, {
						input_tokens: streamPromptTokens,
						output_tokens: streamCompletionTokens,
						cache_read_tokens: streamCacheReadTokens,
					}, 'codex', usageMeta);
				}
			}
		}
	});

	anthropicStream.on('end', () => {
		// Send final chunk with finish_reason
		const finalChunk = {
			id: msgId || `chatcmpl-${Date.now()}`,
			object: 'chat.completion.chunk',
			created,
			model: originalModel,
			choices: [{
				index: choiceIndex,
				delta: {},
				finish_reason: finishReason,
			}],
			usage: (streamPromptTokens > 0 || streamCompletionTokens > 0) ? {
				prompt_tokens: streamPromptTokens,
				completion_tokens: streamCompletionTokens,
				total_tokens: streamPromptTokens + streamCompletionTokens,
			} : undefined,
		};
		writeSSE(finalChunk);
		writeSSE('[DONE]');
		res.end();
	});

	anthropicStream.on('error', (e) => {
		log('error', `[OpenAI-Native] Anthropic stream error: ${e.message}`);
		res.end();
	});
};

// 直接转发 OpenAI 请求到 OpenAI Provider（model 名替换）
const forwardOpenAIDirect = (provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;
	let settled = false;
	const settle = (opts) => {
		if (settled) { return; }
		settled = true;
		releaseKey(provider._name, key, opts);
	};
	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);

	// Log stages 1 & 2 (no conversion for direct pass-through)
	const interactionId = req.interactionId || getNextInteractionId();
	const modifiedBody = JSON.parse(body);
	modifiedBody.model = targetModel;
	normalizeChatBodyToolCallIds(modifiedBody);
	const reqBody = JSON.stringify(modifiedBody);
	const reqPath = targetUrl.pathname + '/chat/completions';

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: reqPath,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${key}`,
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			settle({ isProviderDown: true });
			if (onComplete) {
				onComplete(err);
			}
			else {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
			}
			return;
		}

		// 根据上游实际响应的 Content-Type 判断是否为流式
		const upstreamIsStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (parsedBody.stream && upstreamIsStream) {
			// Stream: substitute model name back and record usage
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			if (onComplete) {
				onComplete(null);
			}

			let streamPromptTokens = 0;
			let streamCompletionTokens = 0;
			let streamCacheReadTokens = 0;
			let buffer = '';
			let firstSseChecked = false;

			proxyRes.on('data', (chunk) => {
				const str = chunk.toString();
				if (!firstSseChecked) {
					firstSseChecked = true;
					const sseResult = classifyStreamFirstBlock(str);
					if (sseResult.isKeyFailure) {
						settle({ isKeyFailure: true });
					}
				}
				buffer += str;
				if (interactionId) {
					logClientStage('codex', interactionId, '3', 'response', str);
				}

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (line.startsWith('data: ') && !line.includes('[DONE]')) {
						try {
							const parsed = JSON.parse(line.substring(6));
							if (parsed.model && parsed.model !== originalModel) {
								parsed.model = originalModel;
							}
							if (parsed.usage) {
								streamPromptTokens = Math.max(streamPromptTokens, parsed.usage.prompt_tokens || 0);
								streamCompletionTokens = Math.max(streamCompletionTokens, parsed.usage.completion_tokens || 0);
								streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.usage.prompt_tokens_details?.cached_tokens || 0);
							}
							res.write(`data: ${JSON.stringify(parsed)}\n\n`);
							if (interactionId) {
								logClientStage('codex', interactionId, '4', 'result', `data: ${JSON.stringify(parsed)}\n\n`);
							}
						}
						catch (e) {
							res.write(line + '\n');
							if (interactionId) {
								logClientStage('codex', interactionId, '4', 'result', line + '\n');
							}
						}
					}
					else {
						res.write(line + '\n');
						if (interactionId) {
							logClientStage('codex', interactionId, '4', 'result', line + '\n');
						}
					}
				}
			});

			proxyRes.on('end', () => {
				if (buffer.trim()) {
					res.write(buffer);
				}
				res.end();
				settle({ isSuccess: true });
				if (streamPromptTokens > 0 || streamCompletionTokens > 0) {
					recordUsage(provider._name || 'openai', targetModel, {
						input_tokens: streamPromptTokens,
						output_tokens: streamCompletionTokens,
						cache_read_tokens: streamCacheReadTokens,
					}, 'codex');
				}
			});
		}
		else {
			// Non-streaming (or upstream returned JSON despite streaming request)
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				try {
					const resp = JSON.parse(responseBody);
					if (resp.error) {
						const cr = classifyResponse(proxyRes.statusCode, resp);
						settle({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
						if (onComplete) {
							onComplete(new Error(`API error: ${proxyRes.statusCode}`));
						}
						else {
							res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									message: resp.error.message || 'Unknown error',
									type: resp.error.type || 'api_error',
								},
							}));
						}
						return;
					}
					logClientStage('codex', interactionId, '3', 'response', resp);
					if (resp.model && resp.model !== originalModel) {
						resp.model = originalModel;
					}
					if (resp.usage) {
						recordUsage(provider._name || 'openai', targetModel, {
							input_tokens: resp.usage.prompt_tokens || 0,
							output_tokens: resp.usage.completion_tokens || 0,
							cache_read_tokens: resp.usage.prompt_tokens_details?.cached_tokens || 0,
						}, 'codex', resp.usage);
					}

					// 客户端发了流式请求但上游返回 JSON → 用 SSE 包裹返回
					if (parsedBody.stream) {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						const chunkData = {
							id: resp.id || `chatcmpl-${Date.now()}`,
							object: 'chat.completion.chunk',
							created: resp.created || Math.floor(Date.now() / 1000),
							model: originalModel,
							choices: [{
								index: 0,
								delta: resp.choices ? resp.choices[0].message : { content: '' },
								finish_reason: resp.choices ? (resp.choices[0].finish_reason || 'stop') : 'stop',
							}],
						};
						res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
						res.write('data: [DONE]\n\n');
						res.end();
						settle({ isSuccess: true });
					}
					else {
						res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(resp));
						settle({ isSuccess: true });
					}
					if (onComplete) {
						onComplete(null);
					}
				}
				catch (e) {
					settle({ isKeyFailure: true });
					if (onComplete) {
						onComplete(e);
					}
					else {
						res.writeHead(proxyRes.statusCode, proxyRes.headers);
						res.end(responseBody);
					}
				}
			});
		}

		proxyRes.on('error', (e) => {
			settle({ isProviderDown: true });
			log('error', `[OpenAI-Native] Response stream error: ${e.message}`);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		settle({ isProviderDown: true });
		proxyReq.destroy();
		if (onComplete) {
			onComplete(new Error('Upstream timeout'));
		}
		else {
			res.writeHead(504, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Upstream timeout', type: 'timeout_error' } }));
		}
	});
};

// 通过 Anthropic Provider 转发 OpenAI 请求
const forwardViaAnthropicProvider = (provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;
	let settled = false;
	const settle = (opts) => {
		if (settled) { return; }
		settled = true;
		releaseKey(provider._name, key, opts);
	};
	const targetUrl = new URL(provider.baseUrl);
	const anthropicBody = convertOpenAIRequestToAnthropic(parsedBody, targetModel, sessionId, provider._name || 'deepseek');
	anthropicBody.model = targetModel;

	// Set max_tokens for Anthropic API
	if (!anthropicBody.max_tokens) {
		anthropicBody.max_tokens = 131072;
	}

		// Log stages 1 & 2
	const interactionId = req.interactionId || getNextInteractionId();
	logClientStage('codex', interactionId, '2', 'upstream', anthropicBody);

	const reqBody = JSON.stringify(anthropicBody);
	const reqPath = targetUrl.pathname.replace(/\/+$/, '') + '/v1/messages';

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: reqPath,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			settle({ isProviderDown: true });
			if (onComplete) {
				onComplete(err);
			}
			else {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
			}
			return;
		}

		// 根据上游实际响应的 Content-Type 判断是否为流式
		const upstreamIsStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (parsedBody.stream && upstreamIsStream) {
			transformAnthropicStreamToOpenAI(res, originalModel, proxyRes, {
				providerName: provider._name,
				targetModel,
				interactionId,
			}, sessionId);
			if (onComplete) {
				onComplete(null);
			}
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				try {
					const anthropicResp = JSON.parse(responseBody);
					if (anthropicResp.error) {
					const cr = classifyResponse(proxyRes.statusCode, anthropicResp);
					settle({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
						if (onComplete) {
							onComplete(new Error(`API error: ${proxyRes.statusCode}`));
						}
						else {
							res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									message: anthropicResp.error.message || 'Unknown error',
									type: anthropicResp.error.type || 'api_error',
								},
							}));
						}
						return;
					}
					const openaiResp = transformAnthropicToOpenAIResponse(anthropicResp, originalModel, sessionId);
					if (anthropicResp.usage) {
						recordUsage(provider._name || 'anthropic', targetModel, {
							input_tokens: anthropicResp.usage.input_tokens || 0,
							output_tokens: anthropicResp.usage.output_tokens || 0,
							cache_read_tokens: anthropicResp.usage.cache_read_input_tokens || 0,
						}, 'codex', anthropicResp.usage);
					}

					// 客户端发了流式请求但上游返回 JSON → 用 SSE 包裹返回
					if (parsedBody.stream) {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						const chunkData = {
							id: openaiResp.id,
							object: 'chat.completion.chunk',
							created: openaiResp.created,
							model: originalModel,
							choices: [{
								index: 0,
								delta: openaiResp.choices[0].message,
								finish_reason: openaiResp.choices[0].finish_reason,
							}],
						};
						res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
						res.write('data: [DONE]\n\n');
						res.end();
						settle({ isSuccess: true });
						if (onComplete) { onComplete(null); }
					}
					else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(openaiResp));
						if (onComplete) { onComplete(null); }
					}
				}
				catch (e) {
					settle({ isKeyFailure: true });
					log('warn', `[OpenAI-Native] Failed to transform response: ${e.message}`);
					if (onComplete) {
						onComplete(e);
					}
					else {
						res.writeHead(proxyRes.statusCode, proxyRes.headers);
						res.end(responseBody);
					}
				}
			});
		}

		proxyRes.on('error', (e) => {
			settle({ isProviderDown: true });
			log('error', `[OpenAI-Native] Anthropic response error: ${e.message}`);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		settle({ isProviderDown: true });
		proxyReq.destroy();
		if (onComplete) {
			onComplete(new Error('Upstream timeout'));
		}
		else {
			res.writeHead(504, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Upstream timeout', type: 'timeout_error' } }));
		}
	});
};

// 通过 Gemini Provider 转发 OpenAI 请求
const forwardViaGeminiProvider = (provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;
	let settled = false;
	const settle = (opts) => {
		if (settled) { return; }
		settled = true;
		releaseKey(provider._name, key, opts);
	};
	const anthropicBody = convertOpenAIRequestToAnthropic(parsedBody, targetModel, sessionId, provider._name || 'google');
	anthropicBody.model = targetModel;
	if (!anthropicBody.max_tokens) {
		anthropicBody.max_tokens = 131072;
	}

	// Convert Anthropic → Gemini
	const { convertAnthropicToGemini } = require('../providers/gemini');
		// Log stages 1 & 2
	const interactionId = req.interactionId || getNextInteractionId();
	const geminiBody = convertAnthropicToGemini(anthropicBody);
	logClientStage('codex', interactionId, '2', 'upstream', geminiBody);

	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const stream = parsedBody.stream;
	const action = stream ? 'streamGenerateContent' : 'generateContent';
	const querySep = stream ? '?alt=sse&' : '?';
	const path = `${pathPrefix}/models/${targetModel}:${action}${querySep}key=${encodeURIComponent(key)}`;

	const reqBody = JSON.stringify(geminiBody);

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			settle({ isProviderDown: true });
			if (onComplete) {
				onComplete(err);
			}
			else {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
			}
			return;
		}

		// 根据上游实际响应的 Content-Type 判断是否为流式
		const upstreamIsStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (stream && upstreamIsStream) {
			// Convert Gemini SSE → OpenAI SSE
			transformGeminiStreamToOpenAI(res, originalModel, proxyRes, { providerName: provider._name, targetModel, interactionId }, sessionId);
			if (onComplete) { onComplete(null); }
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				try {
					const geminiResp = JSON.parse(responseBody);
					if (geminiResp.error) {
						const cr = classifyResponse(proxyRes.statusCode, geminiResp);
						settle({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
						if (onComplete) {
							onComplete(new Error(`API error: ${proxyRes.statusCode}`));
						}
						else {
							res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									message: geminiResp.error.message || 'Unknown error',
									type: geminiResp.error.type || 'api_error',
								},
							}));
						}
						return;
					}
					logClientStage('codex', interactionId, '3', 'response', geminiResp);
					const openaiResp = transformGeminiToOpenAIResponse(geminiResp, originalModel, sessionId);
					logClientStage('codex', interactionId, '4', 'result', openaiResp);
					if (geminiResp.usageMetadata) {
						recordUsage(provider._name || 'gemini', targetModel, {
							input_tokens: geminiResp.usageMetadata.promptTokenCount || 0,
							output_tokens: geminiResp.usageMetadata.candidatesTokenCount || 0,
							cache_read_tokens: geminiResp.usageMetadata.cachedContentTokenCount || 0,
						}, 'codex', geminiResp.usageMetadata);
					}

					// 客户端发了流式请求但上游返回 JSON → 用 SSE 包裹返回
					if (stream) {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						const chunkData = {
							id: openaiResp.id,
							object: 'chat.completion.chunk',
							created: openaiResp.created,
							model: originalModel,
							choices: [{
								index: 0,
								delta: openaiResp.choices[0].message,
								finish_reason: openaiResp.choices[0].finish_reason,
							}],
						};
						res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
						res.write('data: [DONE]\n\n');
						res.end();
						settle({ isSuccess: true });
						if (onComplete) { onComplete(null); }
					}
					else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(openaiResp));
						if (onComplete) { onComplete(null); }
					}
				}
				catch (e) {
					settle({ isKeyFailure: true });
					log('warn', `[OpenAI-Native] Failed to transform Gemini response: ${e.message}`);
					if (onComplete) {
						onComplete(e);
					}
					else {
						res.writeHead(proxyRes.statusCode, proxyRes.headers);
						res.end(responseBody);
					}
				}
			});
		}

		proxyRes.on('error', (e) => {
			settle({ isProviderDown: true });
			log('error', `[OpenAI-Native] Gemini response error: ${e.message}`);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		settle({ isProviderDown: true });
		proxyReq.destroy();
		if (onComplete) {
			onComplete(new Error('Upstream timeout'));
		}
		else {
			res.writeHead(504, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Upstream timeout', type: 'timeout_error' } }));
		}
	});
};

// Gemini 非流式响应 → OpenAI Chat Completions 响应
const transformGeminiToOpenAIResponse = (geminiResp, modelName, sessionId) => {
	const candidates = geminiResp.candidates || [];
	const content = [];
	const textParts = [];
	const pendingCallIds = [];

	for (const candidate of candidates) {
		const parts = (candidate.content && candidate.content.parts) || [];
		for (const part of parts) {
			if (part.text) {
				textParts.push(part.text);
			}
			if (part.functionCall) {
				const callId = part.functionCall.id || `call_${content.length}`;
				content.push({
					id: callId,
					type: 'function',
					function: {
						name: part.functionCall.name,
						arguments: JSON.stringify(part.functionCall.args || {}),
					},
				});
				pendingCallIds.push(callId);
			}
		}
	}

	const message = { role: 'assistant', content: textParts.join('') || null };
	if (content.length > 0) {
		message.tool_calls = content;
	}

	// Gemini 转换：把合成 thinking 写入 pendingThinking，供后续注入
	if (pendingCallIds.length > 0) {
		const effKey = sessionId || 'default';
		if (!pendingThinking.has(effKey)) {
			pendingThinking.set(effKey, new Map());
		}
		const thinkMap = pendingThinking.get(effKey);
		for (const callId of pendingCallIds) {
			thinkMap.set(callId, {
				thinking: '(Gemini thinking)',
				signature: `gemini:${callId}`,
			});
		}
	}

	const finishReasonMap = {
		'STOP': 'stop',
		'MAX_TOKENS': 'length',
		'SAFETY': 'content_filter',
		'RECITATION': 'content_filter',
	};
	const candidateFinish = candidates[0] && candidates[0].finishReason;
	const finishReason = finishReasonMap[candidateFinish] || 'stop';

	const usageMeta = geminiResp.usageMetadata;
	const usage = usageMeta ? {
		prompt_tokens: usageMeta.promptTokenCount || 0,
		completion_tokens: usageMeta.candidatesTokenCount || 0,
		total_tokens: (usageMeta.promptTokenCount || 0) + (usageMeta.candidatesTokenCount || 0),
	} : undefined;

	return {
		id: `chatcmpl-${Date.now()}`,
		object: 'chat.completion',
		created: Math.floor(Date.now() / 1000),
		model: modelName,
		choices: [{
			index: 0,
			message,
			finish_reason: finishReason,
		}],
		usage,
	};
};

// Gemini SSE 流 → OpenAI SSE 流
const transformGeminiStreamToOpenAI = (res, originalModel, geminiStream, usageMeta, sessionId) => {
	let msgId = null;
	let textContent = '';
	let created = Math.floor(Date.now() / 1000);
	let finishReason = 'stop';
	let firstChunk = true;
	let streamPromptTokens = 0;
	let streamCompletionTokens = 0;
	let streamCacheReadTokens = 0;
	// tool_calls 流式状态
	let streamToolCallIdx = 0;
	let currentToolCallId = null;
	let currentToolName = '';
	let currentToolArgs = '';

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	const writeSSE = (data) => {
		const sseText = `data: ${JSON.stringify(data)}\n\n`;
		if (usageMeta && usageMeta.interactionId) {
			logClientStage('codex', usageMeta.interactionId, '4', 'result', sseText);
		}
		res.write(sseText);
	};

	let collectedResponse = [];
	let buffer = '';
	geminiStream.on('data', (chunk) => {
		buffer += chunk.toString();
		if (usageMeta && usageMeta.interactionId) {
			logClientStage('codex', usageMeta.interactionId, '3', 'response', chunk.toString());
		}

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) {
				continue;
			}

			const jsonStr = line.substring(6);
			let parsed;
			try {
				parsed = JSON.parse(jsonStr);
			}
			catch (e) {
				continue;
			}

			collectedResponse.push(parsed);

			if (!msgId) {
				msgId = `chatcmpl-${Date.now()}`;
			}

			if (parsed.usageMetadata) {
				streamPromptTokens = Math.max(streamPromptTokens, parsed.usageMetadata.promptTokenCount || 0);
				streamCompletionTokens = Math.max(streamCompletionTokens, parsed.usageMetadata.candidatesTokenCount || 0);
				streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.usageMetadata.cachedContentTokenCount || 0);
			}

			const candidates = parsed.candidates || [];
			for (const candidate of candidates) {
				const parts = (candidate.content && candidate.content.parts) || [];
				for (const part of parts) {
					if (part.text) {
						textContent += part.text;
						const chunkData = {
							id: msgId,
							object: 'chat.completion.chunk',
							created,
							model: originalModel,
							choices: [{
								index: 0,
								delta: { content: part.text, role: firstChunk ? 'assistant' : undefined },
								finish_reason: null,
							}],
						};
						if (firstChunk) {
							firstChunk = false;
						}
						writeSSE(chunkData);
					}
					if (part.functionCall) {
						const callId = part.functionCall.id || `call_${streamToolCallIdx}`;
						const name = part.functionCall.name || '';
						const args = JSON.stringify(part.functionCall.args || {});
						// Gemini 流式返回完整 functionCall，不需要增量拼接
						const toolCallDelta = [{
							index: streamToolCallIdx,
							id: callId,
							type: 'function',
							function: {
								name,
								arguments: args,
							},
						}];
						const chunkData = {
							id: msgId,
							object: 'chat.completion.chunk',
							created,
							model: originalModel,
							choices: [{
								index: 0,
								delta: {
									role: firstChunk ? 'assistant' : undefined,
									tool_calls: toolCallDelta,
								},
								finish_reason: null,
							}],
						};
						if (firstChunk) {
							firstChunk = false;
						}
						writeSSE(chunkData);
						// 写入 pendingThinking
						const effKey = sessionId || 'default';
						if (!pendingThinking.has(effKey)) {
							pendingThinking.set(effKey, new Map());
						}
						pendingThinking.get(effKey).set(callId, {
							thinking: '(Gemini thinking)',
							signature: `gemini:${callId}`,
						});
						streamToolCallIdx++;
					}
				}

				if (candidate.finishReason) {
					const finishReasonMap = {
						'STOP': 'stop',
						'MAX_TOKENS': 'length',
						'SAFETY': 'content_filter',
						'RECITATION': 'content_filter',
					};
					finishReason = finishReasonMap[candidate.finishReason] || 'stop';
				}
			}
		}
	});

	geminiStream.on('end', () => {
		const finalChunk = {
			id: msgId || `chatcmpl-${Date.now()}`,
			object: 'chat.completion.chunk',
			created,
			model: originalModel,
			choices: [{
				index: 0,
				delta: {},
				finish_reason: finishReason,
			}],
			usage: (streamPromptTokens > 0 || streamCompletionTokens > 0) ? {
				prompt_tokens: streamPromptTokens,
				completion_tokens: streamCompletionTokens,
				total_tokens: streamPromptTokens + streamCompletionTokens,
			} : undefined,
		};
		writeSSE(finalChunk);
		writeSSE('[DONE]');
		if (usageMeta && (streamPromptTokens > 0 || streamCompletionTokens > 0)) {
			recordUsage(usageMeta.providerName || 'gemini', usageMeta.targetModel, {
				input_tokens: streamPromptTokens,
				output_tokens: streamCompletionTokens,
				cache_read_tokens: streamCacheReadTokens,
			}, 'codex', usageMeta);
		}
		res.end();
	});

	geminiStream.on('error', (e) => {
		log('error', `[OpenAI-Native] Gemini stream error: ${e.message}`);
		res.end();
	});
};

// 简单的 web 搜索: 用 fetch 调用搜索 API 或返回 fallback 文本

// ==============================
// Responses API 转换函数 (Codex CLI 新版 wire_api = "responses")
// ==============================

// OpenAI/Responses API tool_choice → Anthropic tool_choice 格式转换
// OpenAI: "auto" | "none" | "required" | { type: "function", function: { name: "..." } }
// Anthropic: { type: "auto" } | { type: "any" } | { type: "tool", name: "..." }
const convertToolChoiceToAnthropic = (toolChoice) => {
	if (typeof toolChoice === 'string') {
		if (toolChoice === 'auto') {
			return { type: 'auto' };
		}
		if (toolChoice === 'required') {
			return { type: 'any' };
		}
		// 'none' / 'off' / 其他字符串 → 由调用方处理
		return { type: toolChoice };
	}
	if (typeof toolChoice === 'object' && toolChoice) {
		if (toolChoice.function && toolChoice.function.name) {
			return { type: 'tool', name: toolChoice.function.name };
		}
		if (toolChoice.name) {
			return { type: 'tool', name: toolChoice.name };
		}
		if (toolChoice.type === 'required') {
			return { type: 'any' };
		}
		return toolChoice;
	}
	return toolChoice;
};

// 将 OpenAI Responses API 请求转为 Anthropic Messages 请求
const convertResponsesRequestToAnthropic = (responsesBody, sessionId, thinkingKeyOverride, targetProvider = 'deepseek') => {
	const anthropicBody = {
		model: responsesBody.model,
		messages: [],
		stream: responsesBody.stream || false,
	};

	// instructions → system
	if (responsesBody.instructions) {
		anthropicBody.system = responsesBody.instructions;
	}

	// input → messages
	// input 可以是字符串 (单条 user 消息) 或数组 (完整对话历史)
	let inputItems = [];
	if (typeof responsesBody.input === 'string') {
		inputItems = [{ role: 'user', content: responsesBody.input }];
	}
	else if (Array.isArray(responsesBody.input)) {
		inputItems = responsesBody.input;
	}

	const parseItemContent = (item) => {
		const parts = [];
		const raw = item.content;

		if (typeof raw === 'string') {
			if (raw) {
				parts.push({ type: 'text', text: raw });
			}
		}
		else if (Array.isArray(raw)) {
			for (const part of raw) {
				if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
					if (part.text) {
						parts.push({ type: 'text', text: part.text });
					}
				}
				else if (part.type === 'image_url' || part.type === 'input_image') {
					const url = part.image_url ? part.image_url.url : (part.url || '');
					if (url.startsWith('data:')) {
						const match = url.match(/^data:([^;]+);base64,(.+)$/);
						if (match) {
							parts.push({
								type: 'image',
								source: {
									type: 'base64',
									media_type: match[1],
									data: match[2],
								},
							});
						}
					}
				}
				else if (part.type === 'function_call') {
					let input = {};
					const args = part.arguments;
					if (typeof args === 'string') {
						try {
							input = JSON.parse(args);
						}
						catch (e) {
							input = { _raw: args };
						}
					}
					else if (typeof args === 'object') {
						input = args;
					}
					parts.push({
						type: 'tool_use',
						id: part.call_id || `toolu_${parts.length}`,
						name: part.name || '',
						input,
					});
				}
				else if (part.type === 'function_call_output') {
					const resultContent = typeof part.output === 'string' ? part.output : JSON.stringify(part.output || {});
					parts.push({
						type: 'tool_result',
						tool_use_id: part.call_id || '',
						content: resultContent,
					});
				}
			}
		}

		return parts;
	};

	// 三道防线: 按 (name, args) 去重 / call_id 冲突检测 / 孤儿或重复结果检测
	// 全部丢弃不打补丁——只 warn 日志,把 Codex 端的异常行为留在本地
	const seenCallKeys = new Set();   // key = `${name}::${argsStr}`
	const seenCallIds = new Set();    // 已保留的 function_call 的 call_id
	const seenResultIds = new Set();  // 已保留的 function_call_output 的 call_id
	const argsKeyOf = (item) => {
		const name = item.name || '';
		const args = item.arguments;
		const argsStr = typeof args === 'string'
			? args
			: JSON.stringify(args || {});
		return `${name}::${argsStr}`;
	};

	let lastRole = null;
	for (const item of inputItems) {
		// function_call 属于 assistant, function_call_output 属于 user
		// 这两类 item 通常没有 role 字段，需要根据 type 判定
		let role;
		if (item.type === 'function_call') {
			role = 'assistant';
		}
		else if (item.type === 'function_call_output') {
			role = 'user';
		}
		else {
			role = item.role || 'user';
			// 归一化: developer/tool/function → user
			if (role === 'tool' || role === 'function' || role === 'developer') {
				role = 'user';
			}
		}

		let content;

		// function_call item: 从顶层字段提取 tool_use
		if (item.type === 'function_call') {
			const cid = item.call_id;
			const key = argsKeyOf(item);
			// 防线 A: 按 (name, args) 去重
			if (seenCallKeys.has(key)) {
				log('warn', `[DupByArgs] dropping function_call: name="${item.name}", args="${item.arguments}", dup_call_id="${cid}", dup_item_index=${inputItems.indexOf(item)}`);
				continue;
			}
			// 防线 B: call_id 冲突 (与已保留的不同内容冲突)
			if (cid && seenCallIds.has(cid)) {
				log('warn', `[DupById] dropping function_call with conflicting call_id: name="${item.name}", args="${item.arguments}", conflict_call_id="${cid}", conflict_item_index=${inputItems.indexOf(item)}`);
				continue;
			}
			let input = {};
			const args = item.arguments;
			if (typeof args === 'string') {
				try { input = JSON.parse(args); }
				catch (e) { input = { _raw: args }; }
			}
			else if (typeof args === 'object') {
				input = args;
			}
			seenCallKeys.add(key);
			if (cid) seenCallIds.add(cid);
			content = [{
				type: 'tool_use',
				id: item.call_id || 'toolu_' + Date.now(),
				name: item.name || '',
				input,
			}];
		}
		// function_call_output item: 从顶层字段提取 tool_result
		else if (item.type === 'function_call_output') {
			const cid = item.call_id;
			// 防线 C-1: 同 call_id 重复结果
			if (cid && seenResultIds.has(cid)) {
				log('warn', `[DupResult] dropping duplicate function_call_output: call_id="${cid}", dup_item_index=${inputItems.indexOf(item)}`);
				continue;
			}
			// 防线 C-2: 孤儿结果 (没有对应已保留的 call)
			if (cid && !seenCallIds.has(cid)) {
				log('warn', `[OrphanResult] dropping orphan function_call_output: call_id="${cid}", orphan_item_index=${inputItems.indexOf(item)}`);
				continue;
			}
			const resultContent = typeof item.output === 'string' ? item.output : JSON.stringify(item.output || {});
			if (cid) seenResultIds.add(cid);
			content = [{
				type: 'tool_result',
				tool_use_id: item.call_id || '',
				content: resultContent,
			}];
		}
		// message item: 解析 content 数组
		else {
			content = parseItemContent(item);
		}

		if (content.length === 0 && role !== 'assistant') {
			continue;
		}
		if (content.length === 0 && role === 'assistant') {
			content.push({ type: 'text', text: '' });
		}

		// 合并连续同 role 的消息 (Anthropic 要求严格交替)
		if (role === lastRole && anthropicBody.messages.length > 0) {
			const last = anthropicBody.messages[anthropicBody.messages.length - 1];
			last.content = [...last.content, ...content];
		}
		else {
			anthropicBody.messages.push({ role, content });
			lastRole = role;
		}
	}

	// Tools — 通过 tool-translator 翻译(识别内置工具,避免降级为普通 function)
	if (Array.isArray(responsesBody.tools)) {
		anthropicBody.tools = translateTools(responsesBody.tools, 'openai_responses', targetProvider);
	}

	// Tool choice — 字符串转为 Anthropic 对象格式
	if (responsesBody.tool_choice && responsesBody.tool_choice !== 'none' && responsesBody.tool_choice !== 'off') {
		anthropicBody.tool_choice = convertToolChoiceToAnthropic(responsesBody.tool_choice);
	}
	else if (responsesBody.tool_choice === 'none' || responsesBody.tool_choice === 'off') {
		delete anthropicBody.tools;
	}

	// 参数映射
	if (responsesBody.max_output_tokens) {
		anthropicBody.max_tokens = responsesBody.max_output_tokens;
	}
	else if (responsesBody.max_tokens) {
		anthropicBody.max_tokens = responsesBody.max_tokens;
	}
	if (responsesBody.temperature !== undefined) {
		anthropicBody.temperature = responsesBody.temperature;
	}
	if (responsesBody.top_p !== undefined) {
		anthropicBody.top_p = responsesBody.top_p;
	}
	if (responsesBody.reasoning) {
		anthropicBody.thinking = { type: 'enabled' };
	}

	// 注入 DeepSeek thinking blocks: 按 tool_use 的 call_id 查找持久化映射
	// 注意：缓存 key 必须与 transformAnthropicStreamToResponses 写入处一致，
	// 用 sessionId 而不是 prompt_cache_key（后者 Codex CLI 每次请求会变，无法跨请求命中）。
	const effectiveThinkingKey = thinkingKeyOverride || sessionId || 'default';
	log('debug', `[Thinking-Inject-Responses] effectiveKey="${effectiveThinkingKey}" thinkingKeyOverride="${thinkingKeyOverride}" sessionId="${sessionId}" pendingThinking.size=${pendingThinking.size} keys=[${[...pendingThinking.keys()].join(',')}]`);
	const thinkMap = pendingThinking.get(effectiveThinkingKey);
	for (const msg of anthropicBody.messages) {
		if (msg.role !== 'assistant') {
			continue;
		}
		const hasThinking = msg.content.some((b) => b.type === 'thinking');
		if (hasThinking) {
			continue;
		}
		const toolUses = msg.content.filter((b) => b.type === 'tool_use');
		if (toolUses.length === 0) {
			continue;
		}
		const firstToolUse = toolUses[0];
		let injectedTb = null;
		if (thinkMap) {
			injectedTb = thinkMap.get(firstToolUse.id);
		}
		if (injectedTb) {
			log('debug', `[Thinking-Inject-Responses] MATCHED and injected for id="${firstToolUse.id}"`);
			msg.content = [{ type: 'thinking', thinking: injectedTb.thinking, signature: injectedTb.signature }, ...msg.content];
		}
		else {
			// Try-inject fallback: synthetic thinking block
			msg.content = [
				{
					type: 'thinking',
					thinking: '(Synthetic thinking block for protocol compliance)',
					signature: 'synthetic:' + firstToolUse.id,
				},
				...msg.content,
			];
			log('debug', `[Thinking-Inject-Responses] INJECTED synthetic thinking for tool_use id="${firstToolUse.id}"`);
		}
	}

	// 归一化 assistant 消息内的 content 顺序：text 在前，tool_use 在后
	for (const msg of anthropicBody.messages) {
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
			continue;
		}
		const textBlocks = msg.content.filter((b) => b.type === 'text');
		const otherBlocks = msg.content.filter((b) => b.type !== 'text');
		msg.content = [...textBlocks, ...otherBlocks];
	}

	return anthropicBody;
};

// 将 Responses API 请求转为 OpenAI Chat Completions 请求
const convertResponsesRequestToOpenAIChat = (responsesBody) => {
	const chatBody = {
		model: responsesBody.model,
		messages: [],
		stream: responsesBody.stream || false,
	};

	if (responsesBody.instructions) {
		chatBody.messages.push({ role: 'system', content: responsesBody.instructions });
	}

	// 三道防线: 按 (name, args) 去重 / call_id 冲突检测 / 孤儿或重复结果检测
	// 与 Anthropic 路径保持一致;只 warn 日志,不打补丁
	// ID 重命名机制：同一个 call_id 在一次请求内被多次使用时，从第二次起自动加 _N 后缀，
	// 保证尾增量历史中重复项每次都得到相同后缀，避免被 Moonshot 等 provider 内部归一化误判。
	const seenCallIds = new Set();
	const seenResultIds = new Set();
	const idRenameMap = new Map();
	const idRenameCount = new Map();
	const renameCallId = (cid) => {
		if (!cid) {
			return cid;
		}
		if (!seenCallIds.has(cid)) {
			seenCallIds.add(cid);
			return cid;
		}
		if (idRenameMap.has(cid)) {
			return idRenameMap.get(cid);
		}
		const count = (idRenameCount.get(cid) || 0) + 1;
		idRenameCount.set(cid, count);
		const renamed = `${cid}_${count}`;
		idRenameMap.set(cid, renamed);
		seenCallIds.add(renamed);
		return renamed;
	};

	let inputItems = [];
	if (typeof responsesBody.input === 'string') {
		inputItems = [{ role: 'user', content: responsesBody.input }];
	}
	else if (Array.isArray(responsesBody.input)) {
		inputItems = responsesBody.input;
	}

	let pendingAssistant = null;
	const flushAssistant = () => {
		if (!pendingAssistant) {
			return;
		}
		chatBody.messages.push(pendingAssistant);
		pendingAssistant = null;
	};
	const ensureAssistant = () => {
		if (!pendingAssistant) {
			pendingAssistant = { role: 'assistant', content: null };
		}
		return pendingAssistant;
	};

	for (const item of inputItems) {
		// function_call item: 合并到当前 assistant 消息
		if (item.type === 'function_call') {
			const cid = item.call_id;
			const rcid = renameCallId(cid);
			const assistant = ensureAssistant();
			if (!Array.isArray(assistant.tool_calls)) {
				assistant.tool_calls = [];
			}
			assistant.tool_calls.push({
				id: normalizeToolCallId(rcid) || 'call_' + Date.now(),
				type: 'function',
				function: {
					name: item.name || '',
					arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
				},
			});
			continue;
		}
		// function_call_output item: 先 flush assistant，再输出 tool 消息
		if (item.type === 'function_call_output') {
			const originalCid = item.call_id;
			const rcid = idRenameMap.get(originalCid) || originalCid;
			if (rcid && seenResultIds.has(rcid)) {
				log('warn', `[DupResult] dropping duplicate function_call_output: original_call_id="${originalCid}", renamed_call_id="${rcid}", dup_item_index=${inputItems.indexOf(item)}`);
				continue;
			}
			if (rcid) {
				seenResultIds.add(rcid);
			}
			flushAssistant();
			chatBody.messages.push({
				role: 'tool',
				tool_call_id: normalizeToolCallId(rcid) || '',
				content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output || {}),
			});
			continue;
		}
		// reasoning item: 不产出对话消息且不打断 pendingAssistant 缓冲
		if (item.type === 'reasoning') {
			continue;
		}
		// message item: 从 content 解析
		let role = item.role || 'user';
		if (role === 'developer') {
			role = 'system';
		}
		if (role === 'function') {
			role = 'assistant';
		}

		if (role === 'assistant') {
			if (typeof item.content === 'string') {
				if (item.content) {
					const assistant = ensureAssistant();
					if (item.content) {
						assistant.content = item.content;
					}
				}
			}
			else if (Array.isArray(item.content)) {
				const assistant = ensureAssistant();
				for (const part of item.content) {
					if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
						if (part.text) {
							assistant.content = part.text;
						}
					}
					else if (part.type === 'function_call') {
						const cid = part.call_id;
						const rcid = renameCallId(cid);
						if (!Array.isArray(assistant.tool_calls)) {
							assistant.tool_calls = [];
						}
						assistant.tool_calls.push({
							id: normalizeToolCallId(rcid) || `call_${assistant.tool_calls.length}`,
							type: 'function',
							function: {
								name: part.name || '',
								arguments: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments || {}),
							},
						});
					}
					else if (part.type === 'function_call_output') {
						const originalCid = part.call_id;
						const rcid = idRenameMap.get(originalCid) || originalCid;
						if (rcid && seenResultIds.has(rcid)) {
							log('warn', `[DupResult] dropping duplicate nested function_call_output: original_call_id="${originalCid}", renamed_call_id="${rcid}"`);
							continue;
						}
						if (rcid) {
							seenResultIds.add(rcid);
						}
						flushAssistant();
						chatBody.messages.push({
							role: 'tool',
							tool_call_id: normalizeToolCallId(rcid) || '',
							content: typeof part.output === 'string' ? part.output : JSON.stringify(part.output || {}),
						});
					}
				}
			}
		}
		else if (typeof item.content === 'string') {
			chatBody.messages.push({ role, content: item.content });
		}
		else if (Array.isArray(item.content)) {
			const textParts = [];
			const toolCalls = [];
			let toolCallId = null;
			let toolCallOutput = null;

			for (const part of item.content) {
				if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
					if (part.text) {
						textParts.push(part.text);
					}
				}
				else if (part.type === 'function_call') {
					toolCalls.push({
						id: part.call_id || `call_${toolCalls.length}`,
						type: 'function',
						function: {
							name: part.name || '',
							arguments: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.arguments || {}),
						},
					});
				}
				else if (part.type === 'function_call_output') {
					toolCallId = part.call_id;
					toolCallOutput = typeof part.output === 'string' ? part.output : JSON.stringify(part.output || {});
				}
			}

			if (toolCallId && toolCallOutput !== null) {
				chatBody.messages.push({
					role: 'tool',
					tool_call_id: toolCallId,
					content: toolCallOutput,
				});
			}
			else if (toolCalls.length > 0) {
				chatBody.messages.push({
					role: 'assistant',
					content: textParts.join('') || null,
					tool_calls: toolCalls,
				});
			}
			else {
				chatBody.messages.push({ role, content: textParts.join('') });
			}
		}
	}

	if (Array.isArray(responsesBody.tools)) {
		chatBody.tools = responsesBody.tools
			.map((tool) => {
				// web_search 工具 → 转为普通 function tool
				// (不使用 web_search_20250305，DeepSeek/Moonshot 等兼容 API 不支持)
				if (tool.type === 'web_search') {
					return {
						type: 'function',
						function: {
							name: 'web_search',
							description: 'Search the web for current information. Use this to find up-to-date facts, news, documentation, or any information that may have changed since your training data.',
							parameters: {
								type: 'object',
								properties: {
									query: { type: 'string', description: 'The search query' },
								},
								required: ['query'],
							},
						},
					};
				}
				// tool_search 内置工具 → function tool
				if (tool.type === 'tool_search') {
					return {
						type: 'function',
						function: {
							name: 'tool_search',
							description: tool.description || 'Search for tools and capabilities',
							parameters: tool.parameters || {
								type: 'object',
								properties: {
									query: { type: 'string', description: 'The search query' },
								},
								required: ['query'],
							},
						},
					};
				}
				// custom 类型 — name 在顶层
				if (tool.type === 'custom' && tool.name) {
					return {
						type: 'function',
						function: {
							name: tool.name,
							description: tool.description || '',
							parameters: tool.parameters || { type: 'object', properties: {} },
						},
					};
				}
				// 标准 function 类型
				if (tool.name && tool.name.trim()) {
					return {
						type: 'function',
						function: {
							name: tool.name,
							description: tool.description || '',
							parameters: tool.parameters || { type: 'object', properties: {} },
						},
					};
				}
				log('warn', `[Responses] Unknown tool type for Chat, skipping: ${tool.type || 'unknown'}`);
				return null;
			})
			.filter(Boolean);
	}

	if (responsesBody.tool_choice) {
		chatBody.tool_choice = responsesBody.tool_choice;
	}

	if (responsesBody.max_output_tokens) {
		chatBody.max_completion_tokens = responsesBody.max_output_tokens;
	}
	else if (responsesBody.max_tokens) {
		chatBody.max_tokens = responsesBody.max_tokens;
	}
	if (responsesBody.temperature !== undefined) {
		chatBody.temperature = responsesBody.temperature;
	}
	if (responsesBody.top_p !== undefined) {
		chatBody.top_p = responsesBody.top_p;
	}
	if (responsesBody.stop) {
		chatBody.stop = responsesBody.stop;
	}

	return chatBody;
};
// 将 Anthropic 非流式 JSON 响应转为 Responses API 响应
const transformAnthropicToResponsesResponse = (anthropicResp, modelName) => {
	const output = [];
	const content = anthropicResp.content || [];

	const textParts = content.filter((b) => b.type === 'text').map((b) => b.text).filter(Boolean);
	const toolUses = content.filter((b) => b.type === 'tool_use');

	// 文本部分作为 message output item（保持原始顺序，web_search_result 也转为 text）
	const messageContent = [];
	for (const block of content) {
		if (block.type === 'text' && block.text) {
			messageContent.push({ type: 'output_text', text: block.text });
		}
		else if (block.type === 'web_search_result') {
			const results = block.results || [];
			if (results.length > 0) {
				const searchText = results.map((r, i) =>
					`[${i + 1}] ${r.title || ''}\n${r.url || ''}\n${r.content || r.snippet || ''}`
				).join('\n\n');
				messageContent.push({ type: 'output_text', text: searchText });
			}
		}
	}

	if (messageContent.length > 0 || toolUses.length === 0) {
		output.push({
			type: 'message',
			role: 'assistant',
			content: messageContent,
		});
	}

	// 透传上游 reasoning 数据：无论调用方是谁，都必须把思考内容原样给到调用方
	const thinkingBlocks = content.filter((b) => b.type === 'thinking');
	for (const tb of thinkingBlocks) {
		if (tb.thinking) {
			output.push({
				type: 'reasoning',
				id: `rs_${tb.signature || Date.now()}`,
				summary: [],
				content: [{ type: 'reasoning_text', text: tb.thinking }],
				signature: tb.signature || undefined,
			});
		}
	}

	// 工具调用作为 function_call output item
	for (const tc of toolUses) {
		output.push({
			type: 'function_call',
			id: tc.id,
			name: tc.name,
			arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {}),
		});
	}

	const stopReasonMap = {
		'end_turn': 'completed',
		'max_tokens': 'incomplete',
		'tool_use': 'completed',
		'stop_sequence': 'completed',
	};
	const status = stopReasonMap[anthropicResp.stop_reason] || 'completed';

	const usage = anthropicResp.usage ? {
		input_tokens: anthropicResp.usage.input_tokens || 0,
		output_tokens: anthropicResp.usage.output_tokens || 0,
		total_tokens: (anthropicResp.usage.input_tokens || 0) + (anthropicResp.usage.output_tokens || 0),
	} : undefined;

	return {
		id: anthropicResp.id || `resp_${Date.now()}`,
		object: 'response',
		created_at: Math.floor(Date.now() / 1000),
		model: modelName,
		status,
		output,
		usage,
	};
};

// 将 Anthropic SSE 流转换为 Responses API SSE 流 (含 event: 行)
const transformAnthropicStreamToResponses = (res, originalModel, anthropicStream, usageMeta, sessionId, thinkingKeyOverride, interactionId) => {
	let respId = null;
	let streamInputTokens = 0;
	let streamOutputTokens = 0;
	let streamCacheReadTokens = 0;
	let respStatus = 'completed';
	let outputIndex = 0;
	let contentIndex = 0;
	let currentItemType = null;
	let hasStartedMessage = false;
	let textContentFull = '';
	let callId = null;
	let fcId = null;
	let functionCallName = '';
	let functionCallArgs = '';
	let thinkingText = '';
	let thinkingSignature = '';
	let lastThinking = null;
	let inThinking = false;
	// 透传 reasoning 时需要的额外状态：item_id、content_index、累积的 items
	let reasoningItemId = null;
	let reasoningContentIndex = 0;
	const completedReasoningItems = [];

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	let convertedSseBuffer = '';
	const writeSSE = (eventType, data) => {
		const line = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
		res.write(line);
		if (interactionId) logClientStage('codex', interactionId, '4', 'result', line, true);
	};

	let buffer = '';
	let rawSseBuffer = '';
	anthropicStream.on('data', (chunk) => {
		const chunkStr = chunk.toString();
		if (interactionId) logClientStage('codex', interactionId, '3', 'response', chunkStr, true);
		rawSseBuffer += chunkStr;
		buffer += chunkStr;

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) {
				continue;
			}

			const jsonStr = line.substring(6);
			let parsed;
			try {
				parsed = JSON.parse(jsonStr);
			}
			catch (e) {
				continue;
			}

			if (parsed.type === 'message_start') {
				const msgId = parsed.message ? parsed.message.id : `${Date.now()}`;
				respId = `resp_${msgId}`;
				if (parsed.message && parsed.message.usage) {
					streamInputTokens = Math.max(streamInputTokens, parsed.message.usage.input_tokens || 0);
					streamOutputTokens = Math.max(streamOutputTokens, parsed.message.usage.output_tokens || 0);
					streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.message.usage.cache_read_input_tokens || 0);
				}

				writeSSE('response.created', {
					type: 'response.created',
					response_id: respId,
					response: {
						id: respId,
						object: 'response',
						model: originalModel,
						status: 'in_progress',
					},
				});

				writeSSE('response.in_progress', {
					type: 'response.in_progress',
					response_id: respId,
					response: {
						id: respId,
						object: 'response',
						model: originalModel,
						status: 'in_progress',
					},
				});
			}
			else if (parsed.type === 'content_block_start') {
				const block = parsed.content_block || {};
				if (block.type === 'thinking' || block.type === 'redacted_thinking') {
						// 开始捕获 thinking 内容，稍后在请求转换时回传
						thinkingText = '';
						thinkingSignature = '';
						inThinking = true;
						// 同步向调用方发射 reasoning item 开始事件 —— 代理层无资格过滤上游内容
						reasoningItemId = `rs_${block.index || 0}_${Date.now()}`;
						reasoningContentIndex = 0;
						currentItemType = 'reasoning';
						writeSSE('response.output_item.added', {
							type: 'response.output_item.added',
							response_id: respId,
							output_index: outputIndex,
							item: {
								type: 'reasoning',
								id: reasoningItemId,
								summary: [],
								content: [],
								status: 'in_progress',
							},
						});
				}
				else if (block.type === 'text') {
					currentItemType = 'message';
					if (!hasStartedMessage) {
						hasStartedMessage = true;
						writeSSE('response.output_item.added', {
							type: 'response.output_item.added',
							response_id: respId,
							output_index: outputIndex,
							item: {
								type: 'message',
								role: 'assistant',
								status: 'in_progress',
								content: [],
							},
						});
						writeSSE('response.content_part.added', {
							type: 'response.content_part.added',
							response_id: respId,
							output_index: outputIndex,
							content_index: contentIndex,
							part: { type: 'output_text', text: '' },
						});
					}
				}
				else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
					// close previous message item if any
					if (currentItemType === 'message' && hasStartedMessage) {
						writeSSE('response.output_text.done', {
							type: 'response.output_text.done',
							response_id: respId,
							item_id: respId,
							output_index: outputIndex,
							content_index: contentIndex,
							text: textContentFull,
						});
						writeSSE('response.content_part.done', {
							type: 'response.content_part.done',
							response_id: respId,
							item_id: respId,
							output_index: outputIndex,
							content_index: contentIndex,
							part: { type: 'output_text', text: textContentFull },
						});
						writeSSE('response.output_item.done', {
							type: 'response.output_item.done',
							response_id: respId,
							output_index: outputIndex,
							item: {
								type: 'message',
								role: 'assistant',
								status: 'completed',
								content: textContentFull ? [{ type: 'output_text', text: textContentFull }] : [],
							},
						});
						outputIndex++;
						contentIndex = 0;
						textContentFull = '';
						hasStartedMessage = false;
					}
					callId = block.id;
					fcId = `fc_${block.id.replace('call_', '')}`;
					functionCallName = block.name;
					functionCallArgs = '';
					currentItemType = 'function_call';
					writeSSE('response.output_item.added', {
						type: 'response.output_item.added',
						response_id: respId,
						output_index: outputIndex,
						item: {
							type: 'function_call',
							id: fcId,
							call_id: callId,
							name: functionCallName,
							arguments: '',
							status: 'in_progress',
						},
					});
				}
				else if (block.type === 'web_search_result') {
					// Anthropic 原生 web_search 结果 → 转为 output_text
					// 先关闭当前消息（如果有的话）
					if (currentItemType === 'message' && hasStartedMessage) {
						writeSSE('response.output_text.done', {
							type: 'response.output_text.done',
							response_id: respId,
							item_id: respId,
							output_index: outputIndex,
							content_index: contentIndex,
							text: textContentFull,
						});
						writeSSE('response.content_part.done', {
							type: 'response.content_part.done',
							response_id: respId,
							item_id: respId,
							output_index: outputIndex,
							content_index: contentIndex,
							part: { type: 'output_text', text: textContentFull },
						});
						writeSSE('response.output_item.done', {
							type: 'response.output_item.done',
							response_id: respId,
							output_index: outputIndex,
							item: {
								type: 'message',
								role: 'assistant',
								status: 'completed',
								content: textContentFull ? [{ type: 'output_text', text: textContentFull }] : [],
							},
						});
						outputIndex++;
						contentIndex = 0;
						textContentFull = '';
						hasStartedMessage = false;
					}
					// 格式化搜索结果
					let searchText = '';
					const results = block.results || [];
					if (results.length > 0) {
						searchText = results.map((r, i) =>
							`[${i + 1}] ${r.title || ''}\n${r.url || ''}\n${r.content || r.snippet || ''}`
						).join('\n\n');
					}
					else {
						searchText = '[Web search completed, no results returned]';
					}
					// 作为新的 output_text 消息发出
					outputIndex++;
					contentIndex = 0;
					writeSSE('response.output_item.added', {
						type: 'response.output_item.added',
						response_id: respId,
						output_index: outputIndex,
						item: { type: 'message', role: 'assistant', status: 'in_progress', content: [] },
					});
					writeSSE('response.content_part.added', {
						type: 'response.content_part.added',
						response_id: respId,
						output_index: outputIndex,
						content_index: contentIndex,
						part: { type: 'output_text', text: '' },
					});
					writeSSE('response.output_text.delta', {
						type: 'response.output_text.delta',
						response_id: respId,
						item_id: respId,
						output_index: outputIndex,
						content_index: contentIndex,
						delta: searchText,
					});
					writeSSE('response.output_text.done', {
						type: 'response.output_text.done',
						response_id: respId,
						item_id: respId,
						output_index: outputIndex,
						content_index: contentIndex,
						text: searchText,
					});
					writeSSE('response.content_part.done', {
						type: 'response.content_part.done',
						response_id: respId,
						item_id: respId,
						output_index: outputIndex,
						content_index: contentIndex,
						part: { type: 'output_text', text: searchText },
					});
					writeSSE('response.output_item.done', {
						type: 'response.output_item.done',
						response_id: respId,
						output_index: outputIndex,
						item: { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: searchText }] },
					});
					outputIndex++;
					contentIndex = 0;
					currentItemType = 'web_search_result';
				}
			}
			else if (parsed.type === 'content_block_delta') {
				const delta = parsed.delta || {};
					if (inThinking) {
						if (delta.type === 'thinking_delta' && delta.thinking) {
							thinkingText += delta.thinking;
							// 实时向调用方发射 reasoning_text.delta —— 与 text_delta 处理对等
							writeSSE('response.reasoning_text.delta', {
								type: 'response.reasoning_text.delta',
								response_id: respId,
								item_id: reasoningItemId,
								output_index: outputIndex,
								content_index: reasoningContentIndex,
								delta: delta.thinking,
							});
						}
						else if (delta.type === 'signature_delta' && delta.signature) {
							thinkingSignature += delta.signature;
						}
						continue;
					}
				if (delta.type === 'text_delta' && delta.text) {
					textContentFull += delta.text;
					writeSSE('response.output_text.delta', {
						type: 'response.output_text.delta',
						response_id: respId,
						item_id: respId,
						output_index: outputIndex,
						content_index: contentIndex,
						delta: delta.text,
					});
				}
				else if (delta.type === 'input_json_delta' && delta.partial_json) {
					functionCallArgs += delta.partial_json;
					writeSSE('response.function_call_arguments.delta', {
						type: 'response.function_call_arguments.delta',
						response_id: respId,
						item_id: fcId,
						call_id: callId,
						output_index: outputIndex,
						delta: delta.partial_json,
					});
				}
			}
			else if (parsed.type === 'content_block_stop') {
				if (inThinking) {
					if (thinkingText) {
						const effThinkingKey = thinkingKeyOverride || sessionId;
						lastThinking = {
							thinking: thinkingText,
							signature: thinkingSignature,
						};
					}
					// 关闭 reasoning item —— 实时向调用方发射 done 事件
					const finalReasoningText = thinkingText;
					const finalReasoningSig = thinkingSignature;
					if (finalReasoningText || finalReasoningSig) {
						writeSSE('response.reasoning_text.done', {
							type: 'response.reasoning_text.done',
							response_id: respId,
							item_id: reasoningItemId,
							output_index: outputIndex,
							content_index: reasoningContentIndex,
							text: finalReasoningText,
							signature: finalReasoningSig || undefined,
						});
						const reasoningItem = {
							type: 'reasoning',
							id: reasoningItemId,
							summary: [],
							content: finalReasoningText
								? [{ type: 'reasoning_text', text: finalReasoningText }]
								: [],
							signature: finalReasoningSig || undefined,
							status: 'completed',
						};
						completedReasoningItems.push(reasoningItem);
						writeSSE('response.output_item.done', {
							type: 'response.output_item.done',
							response_id: respId,
							output_index: outputIndex,
							item: reasoningItem,
						});
					}
					inThinking = false;
					thinkingText = '';
					thinkingSignature = '';
					if (currentItemType === 'reasoning') {
						currentItemType = null;
						outputIndex++;
						contentIndex = 0;
						reasoningContentIndex = 0;
					}
				}

				if (currentItemType === 'web_search_result') {
					currentItemType = null;
				}
				else if (currentItemType === 'function_call') {
					writeSSE('response.function_call_arguments.done', {
						type: 'response.function_call_arguments.done',
						response_id: respId,
						item_id: fcId,
						call_id: callId,
						output_index: outputIndex,
						arguments: functionCallArgs,
					});
					writeSSE('response.output_item.done', {
						type: 'response.output_item.done',
						response_id: respId,
						output_index: outputIndex,
						item: {
							type: 'function_call',
							id: fcId,
							call_id: callId,
							name: functionCallName,
							arguments: functionCallArgs,
							status: 'completed',
						},
					});
						// 将本次响应的 thinking block 按 callId 持久化缓存
						if (callId && lastThinking && lastThinking.thinking) {
							const effKey = thinkingKeyOverride || sessionId || 'default';
							if (!pendingThinking.has(effKey)) {
								pendingThinking.set(effKey, new Map());
							}
							pendingThinking.get(effKey).set(callId, {
								thinking: lastThinking.thinking,
								signature: lastThinking.signature,
							});
							log('debug', `[Thinking-Save-Responses] SAVED callId="${callId}" key="${effKey}" thinkingLen=${lastThinking.thinking.length} sigLen=${(lastThinking.signature||'').length} pendingThinkingKeys=[${[...pendingThinking.keys()].join(',')}]`);
							lastThinking = null;
						}
						else {
							log('debug', `[Thinking-Save-Responses] SKIPPED save: callId=${callId} hasLastThinking=${!!lastThinking} hasThinkingText=${!!(lastThinking&&lastThinking.thinking)}`);
						}
					outputIndex++;
					contentIndex = 0;
				}
			}
			else if (parsed.type === 'message_delta') {
				if (parsed.delta && parsed.delta.stop_reason) {
					const stopMap = {
						end_turn: 'completed',
						max_tokens: 'incomplete',
						tool_use: 'completed',
						stop_sequence: 'completed',
					};
					respStatus = stopMap[parsed.delta.stop_reason] || 'completed';
				}
				if (parsed.usage) {
					streamInputTokens = Math.max(streamInputTokens, parsed.usage.input_tokens || 0);
					streamOutputTokens = Math.max(streamOutputTokens, parsed.usage.output_tokens || 0);
					streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.usage.cache_read_input_tokens || 0);
				}
			}
			else if (parsed.type === 'message_stop') {
				// close current message item if any
				if (currentItemType === 'message' && hasStartedMessage) {
					writeSSE('response.output_text.done', {
						type: 'response.output_text.done',
						response_id: respId,
						item_id: respId,
						output_index: outputIndex,
						content_index: contentIndex,
						text: textContentFull,
					});
					writeSSE('response.content_part.done', {
						type: 'response.content_part.done',
						response_id: respId,
						item_id: respId,
						output_index: outputIndex,
						content_index: contentIndex,
						part: { type: 'output_text', text: textContentFull },
					});
					writeSSE('response.output_item.done', {
						type: 'response.output_item.done',
						response_id: respId,
						output_index: outputIndex,
						item: {
							type: 'message',
							role: 'assistant',
							status: 'completed',
							content: textContentFull ? [{ type: 'output_text', text: textContentFull }] : [],
						},
					});
				}
				// build output array for response.completed
				const outputItems = [];
				// 按优先级排列：reasoning → message → function_call
				for (const ri of completedReasoningItems) {
					outputItems.push(ri);
				}
				if (textContentFull) {
					outputItems.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textContentFull }] });
				}
				if (callId) {
					outputItems.push({ type: 'function_call', id: fcId, call_id: callId, name: functionCallName, arguments: functionCallArgs, status: 'completed' });
				}
				// 防御性兜底：若模型既没有 reasoning、也没有文本、也没有函数调用，
				// 但上游声明为 completed，降级为 incomplete，避免 Codex 客户端因 output=[] 状态机死锁
				if (outputItems.length === 0 && respStatus === 'completed') {
					respStatus = 'incomplete';
				}
				writeSSE('response.completed', {
					type: 'response.completed',
					response_id: respId,
					response: {
						id: respId,
						object: 'response',
						model: originalModel,
						status: respStatus,
						output: outputItems,
						usage: (streamInputTokens > 0 || streamOutputTokens > 0) ? {
							input_tokens: streamInputTokens,
							output_tokens: streamOutputTokens,
							total_tokens: streamInputTokens + streamOutputTokens,
						} : undefined,
					},
				});
				if (usageMeta && (streamInputTokens > 0 || streamOutputTokens > 0)) {
					recordUsage(usageMeta.providerName || 'openai', usageMeta.targetModel, {
						input_tokens: streamInputTokens,
						output_tokens: streamOutputTokens,
						cache_read_tokens: streamCacheReadTokens,
					}, 'codex', usageMeta);
				}
			// ping events are silently ignored
		}
		}
	});

	anthropicStream.on('end', () => {
		res.end();
	});

	anthropicStream.on('error', (e) => {
		log('error', `[Responses] Anthropic stream error: ${e.message}`);
		res.end();
	});
};
const transformOpenAIChatToResponsesResponse = (chatResp, modelName) => {
	const output = [];
	const choice = chatResp.choices ? chatResp.choices[0] : null;
	const message = choice ? choice.message : null;

	if (message) {
		const content = [];

		if (message.content) {
			content.push({ type: 'output_text', text: message.content });
		}

		// 透传上游 reasoning_content：无论调用方是谁，都必须把思考内容原样给到调用方
		if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
			output.push({
				type: 'reasoning',
				id: `rs_${chatResp.id || Date.now()}`,
				summary: [],
				content: [{ type: 'reasoning_text', text: message.reasoning_content }],
			});
		}

		if (content.length > 0) {
			output.push({
				type: 'message',
				role: 'assistant',
				content,
			});
		}

		if (Array.isArray(message.tool_calls)) {
			for (const tc of message.tool_calls) {
				output.push({
					type: 'function_call',
					id: tc.id,
					name: tc.function ? tc.function.name : '',
					arguments: tc.function ? tc.function.arguments : '{}',
				});
			}
		}
	}

	const stopReasonMap = {
		'stop': 'completed',
		'length': 'incomplete',
		'tool_calls': 'completed',
		'content_filter': 'incomplete',
	};
	const status = choice ? (stopReasonMap[choice.finish_reason] || 'completed') : 'completed';

	const usage = chatResp.usage ? {
		input_tokens: chatResp.usage.prompt_tokens || 0,
		output_tokens: chatResp.usage.completion_tokens || 0,
		total_tokens: chatResp.usage.total_tokens || 0,
	} : undefined;

	return {
		id: chatResp.id || `resp_${Date.now()}`,
		object: 'response',
		created_at: chatResp.created || Math.floor(Date.now() / 1000),
		model: modelName,
		status,
		output,
		usage,
	};
};

// 将 Chat Completions SSE 流转为 Responses API SSE 流
const transformOpenAIChatStreamToResponses = (res, originalModel, chatStream, usageMeta, interactionId) => {
	let respId = null;
	let streamInputTokens = 0;
	let streamOutputTokens = 0;
	let streamCacheReadTokens = 0;
	let status = 'completed';
	let outputIndex = 0;
	let contentIndex = 0;
	let textContentFull = '';
	let messageItemId = null;
	let hasStartedItem = false;
	let hasFinished = false;
	// 透传 reasoning：无论调用方是谁，都必须把思考内容原样给到调用方
	let reasoningTextFull = '';
	let reasoningItemId = null;
	let hasStartedReasoning = false;
	// 状态机：'message' | 'reasoning' | 'function_call' | null
	// 用来处理 Moonshot 等 provider 在流中交错发送 reasoning、text 和 tool_call 的情况，
	// 保证最终 output 顺序为 reasoning → message → function_call。
	let currentItemType = null;
	// 流式 tool_call 状态：按 index 追踪每个 function_call 的 id/name/累计 args
	const streamToolStates = new Map();
	const completedFunctionCalls = [];

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	let convertedSseBuffer = '';
	const writeSSE = (eventType, data) => {
		const line = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
		convertedSseBuffer += line;
		res.write(line);
		if (interactionId) logClientStage('codex', interactionId, '4', 'result', line, true);
	};

	let buffer = '';
	chatStream.on('data', (chunk) => {
		const chunkStr = chunk.toString();
		if (interactionId) logClientStage('codex', interactionId, '3', 'response', chunkStr, true);
		buffer += chunkStr;

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) {
				continue;
			}
			if (line.includes('[DONE]')) {
				continue;
			}

			const jsonStr = line.substring(6);
			let parsed;
			try {
				parsed = JSON.parse(jsonStr);
			}
			catch (e) {
				continue;
			}

			const choice = parsed.choices ? parsed.choices[0] : null;

			// 首次: 只发送 response.created + response.in_progress，output item 按实际内容延迟创建
			if (!respId) {
				respId = parsed.id || `resp_${Date.now()}`;
				messageItemId = `msg_${respId}`;

				writeSSE('response.created', {
					type: 'response.created',
					response: {
						id: respId,
						object: 'response',
						model: originalModel,
						status: 'in_progress',
					},
				});

				writeSSE('response.in_progress', {
					type: 'response.in_progress',
					response: {
						id: respId,
						object: 'response',
						model: originalModel,
						status: 'in_progress',
					},
				});
			}

			// 状态机辅助函数
			const openMessageIfNeeded = () => {
				if (currentItemType === 'message') {
					return;
				}
				if (currentItemType === 'reasoning' && hasStartedReasoning && reasoningItemId) {
					writeSSE('response.reasoning_text.done', {
						type: 'response.reasoning_text.done',
						item_id: reasoningItemId,
						output_index: outputIndex,
						content_index: 0,
						text: reasoningTextFull,
					});
					writeSSE('response.output_item.done', {
						type: 'response.output_item.done',
						output_index: outputIndex,
						item: {
							type: 'reasoning',
							id: reasoningItemId,
							summary: [],
							content: reasoningTextFull ? [{ type: 'reasoning_text', text: reasoningTextFull }] : [],
							status: 'completed',
						},
					});
					outputIndex++;
					contentIndex = 0;
					hasStartedReasoning = false;
					reasoningTextFull = '';
					reasoningItemId = null;
				}
				outputIndex++;
				writeSSE('response.output_item.added', {
					type: 'response.output_item.added',
					output_index: outputIndex,
					item: {
						type: 'message',
						id: messageItemId,
						role: 'assistant',
						status: 'in_progress',
						content: [],
					},
				});
				writeSSE('response.content_part.added', {
					type: 'response.content_part.added',
					item_id: messageItemId,
					output_index: outputIndex,
					content_index: contentIndex,
					part: { type: 'output_text', text: '' },
				});
				hasStartedItem = true;
				currentItemType = 'message';
			};

			const openReasoningIfNeeded = () => {
				if (currentItemType === 'reasoning') {
					return;
				}
				if (currentItemType === 'message' && hasStartedItem && textContentFull) {
					writeSSE('response.output_text.done', {
						type: 'response.output_text.done',
						item_id: messageItemId,
						output_index: outputIndex,
						content_index: contentIndex,
						text: textContentFull,
					});
					writeSSE('response.content_part.done', {
						type: 'response.content_part.done',
						item_id: messageItemId,
						output_index: outputIndex,
						content_index: contentIndex,
						part: { type: 'output_text', text: textContentFull },
					});
					writeSSE('response.output_item.done', {
						type: 'response.output_item.done',
						output_index: outputIndex,
						item: {
							type: 'message',
							id: messageItemId,
							role: 'assistant',
							status: 'completed',
							content: textContentFull ? [{ type: 'output_text', text: textContentFull }] : [],
						},
					});
					outputIndex++;
					contentIndex = 0;
					textContentFull = '';
					hasStartedItem = false;
				}
				outputIndex++;
				reasoningItemId = `rs_${respId || Date.now()}_${outputIndex}`;
				writeSSE('response.output_item.added', {
					type: 'response.output_item.added',
					output_index: outputIndex,
					item: {
						type: 'reasoning',
						id: reasoningItemId,
						summary: [],
						content: [],
						status: 'in_progress',
					},
				});
				hasStartedReasoning = true;
				currentItemType = 'reasoning';
			};

			// 文本 delta：按需开 message item，必要时先关掉当前 reasoning item
			if (choice && choice.delta && choice.delta.content) {
				openMessageIfNeeded();
				textContentFull += choice.delta.content;
				writeSSE('response.output_text.delta', {
					type: 'response.output_text.delta',
					item_id: messageItemId,
					output_index: outputIndex,
					content_index: contentIndex,
					delta: choice.delta.content,
				});
			}

			// 透传上游 reasoning_content：按需开 reasoning item，必要时先关掉当前 message item
			if (choice && choice.delta && choice.delta.reasoning_content) {
				openReasoningIfNeeded();
				reasoningTextFull += choice.delta.reasoning_content;
				writeSSE('response.reasoning_text.delta', {
					type: 'response.reasoning_text.delta',
					item_id: reasoningItemId,
					output_index: outputIndex,
					content_index: 0,
					delta: choice.delta.reasoning_content,
				});
			}

			// tool_calls 转换为 function_call item
			// OpenAI 流式协议：第一个 chunk 带 id+name，后续 chunk 仅带 arguments 增量片段
			if (choice && choice.delta && Array.isArray(choice.delta.tool_calls)) {
				for (const tc of choice.delta.tool_calls) {
					const idx = tc.index ?? 0;
					let st = streamToolStates.get(idx);
					if (tc.id) {
						// 关掉当前 message item
						if (currentItemType === 'message' && hasStartedItem) {
							writeSSE('response.output_text.done', {
								type: 'response.output_text.done',
								item_id: messageItemId,
								output_index: outputIndex,
								content_index: contentIndex,
								text: textContentFull,
							});
							writeSSE('response.content_part.done', {
								type: 'response.content_part.done',
								item_id: messageItemId,
								output_index: outputIndex,
								content_index: contentIndex,
								part: { type: 'output_text', text: textContentFull },
							});
							writeSSE('response.output_item.done', {
								type: 'response.output_item.done',
								output_index: outputIndex,
								item: {
									type: 'message',
									id: messageItemId,
									role: 'assistant',
									status: 'completed',
									content: textContentFull ? [{ type: 'output_text', text: textContentFull }] : [],
								},
							});
							outputIndex++;
							contentIndex = 0;
							textContentFull = '';
							hasStartedItem = false;
						}
						// 关掉当前 reasoning item
						else if (currentItemType === 'reasoning' && hasStartedReasoning && reasoningItemId) {
							writeSSE('response.reasoning_text.done', {
								type: 'response.reasoning_text.done',
								item_id: reasoningItemId,
								output_index: outputIndex,
								content_index: 0,
								text: reasoningTextFull,
							});
							writeSSE('response.output_item.done', {
								type: 'response.output_item.done',
								output_index: outputIndex,
								item: {
									type: 'reasoning',
									id: reasoningItemId,
									summary: [],
									content: reasoningTextFull ? [{ type: 'reasoning_text', text: reasoningTextFull }] : [],
									status: 'completed',
								},
							});
							outputIndex++;
							hasStartedReasoning = false;
							reasoningTextFull = '';
							reasoningItemId = null;
						}
						const ncid = normalizeToolCallId(tc.id);
						st = { id: ncid, fcId: `fc_${ncid}`, name: tc.function ? tc.function.name : '', args: '', outputIndex: outputIndex + 1 };
						streamToolStates.set(idx, st);
						outputIndex++;
						writeSSE('response.output_item.added', {
							type: 'response.output_item.added',
							output_index: outputIndex,
							item: {
								type: 'function_call',
								id: st.fcId,
								call_id: st.id,
								name: st.name,
								arguments: '',
								status: 'in_progress',
							},
						});
						currentItemType = 'function_call';
					}
					if (tc.function && tc.function.arguments) {
						if (st) {
							st.args += tc.function.arguments;
							writeSSE('response.function_call_arguments.delta', {
								type: 'response.function_call_arguments.delta',
								item_id: st.fcId,
								output_index: st.outputIndex,
								delta: tc.function.arguments,
							});
						}
					}
				}
			}

			// 结束
			if (choice && choice.finish_reason) {
				const stopMap = {
					'stop': 'completed',
					'length': 'incomplete',
					'tool_calls': 'completed',
				};
				status = stopMap[choice.finish_reason] || 'completed';
			}

			if (parsed.usage) {
				streamInputTokens = Math.max(streamInputTokens, parsed.usage.prompt_tokens || 0);
				streamOutputTokens = Math.max(streamOutputTokens, parsed.usage.completion_tokens || 0);
				streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.usage.prompt_tokens_details?.cached_tokens || 0);
			}
		}
	});

	chatStream.on('end', () => {
		if (!hasFinished) {
			hasFinished = true;

			// 关闭当前打开的 item（根据状态机决定是 message 还是 reasoning）
			if (currentItemType === 'message' && hasStartedItem) {
				writeSSE('response.output_text.done', {
					type: 'response.output_text.done',
					item_id: messageItemId,
					output_index: outputIndex,
					content_index: contentIndex,
					text: textContentFull,
				});
				writeSSE('response.content_part.done', {
					type: 'response.content_part.done',
					item_id: messageItemId,
					output_index: outputIndex,
					content_index: contentIndex,
					part: { type: 'output_text', text: textContentFull },
				});
				writeSSE('response.output_item.done', {
					type: 'response.output_item.done',
					output_index: outputIndex,
					item: {
						type: 'message',
						id: messageItemId,
						role: 'assistant',
						status: 'completed',
						content: textContentFull ? [{ type: 'output_text', text: textContentFull }] : [],
					},
				});
				outputIndex++;
			}
			else if (currentItemType === 'reasoning' && hasStartedReasoning && reasoningItemId) {
				writeSSE('response.reasoning_text.done', {
					type: 'response.reasoning_text.done',
					item_id: reasoningItemId,
					output_index: outputIndex,
					content_index: 0,
					text: reasoningTextFull,
				});
				writeSSE('response.output_item.done', {
					type: 'response.output_item.done',
					output_index: outputIndex,
					item: {
						type: 'reasoning',
						id: reasoningItemId,
						summary: [],
						content: reasoningTextFull ? [{ type: 'reasoning_text', text: reasoningTextFull }] : [],
						status: 'completed',
					},
				});
				outputIndex++;
			}

			// 构建最终 output：reasoning → message → function_call
			const outputItems = [];
			if (reasoningTextFull) {
				outputItems.push({
					type: 'reasoning',
					id: reasoningItemId,
					summary: [],
					content: [{ type: 'reasoning_text', text: reasoningTextFull }],
				});
			}
			if (textContentFull) {
				outputItems.push({ type: 'message', id: messageItemId, role: 'assistant', content: [{ type: 'output_text', text: textContentFull }] });
			}
			// 收集所有流式累积的 tool_call（用累计的完整 args）
			// 先 emit function_call_arguments.done 和 output_item.done
			for (const st of streamToolStates.values()) {
				writeSSE('response.function_call_arguments.done', {
					type: 'response.function_call_arguments.done',
					item_id: st.fcId,
					output_index: st.outputIndex,
					arguments: st.args,
				});
				writeSSE('response.output_item.done', {
					type: 'response.output_item.done',
					output_index: st.outputIndex,
					item: {
						type: 'function_call',
						id: st.fcId,
						call_id: st.id,
						name: st.name,
						arguments: st.args,
						status: 'completed',
					},
				});
				outputItems.push({
					type: 'function_call',
					id: st.fcId,
					call_id: st.id,
					name: st.name,
					arguments: st.args,
					status: 'completed',
				});
			}
			if (outputItems.length === 0 && status === 'completed') {
				status = 'incomplete';
			}

			writeSSE('response.completed', {
				type: 'response.completed',
				response: {
					id: respId,
					object: 'response',
					model: originalModel,
					status,
					output: outputItems,
					usage: (streamInputTokens > 0 || streamOutputTokens > 0) ? {
						input_tokens: streamInputTokens,
						output_tokens: streamOutputTokens,
						total_tokens: streamInputTokens + streamOutputTokens,
					} : undefined,
				},
			});

			if (usageMeta && (streamInputTokens > 0 || streamOutputTokens > 0)) {
				recordUsage(usageMeta.providerName || 'openai', usageMeta.targetModel, {
					input_tokens: streamInputTokens,
					output_tokens: streamOutputTokens,
					cache_read_tokens: streamCacheReadTokens,
				}, 'codex', usageMeta);
			}
		}
		res.end();
	});

	chatStream.on('error', (e) => {
		log('error', `[Responses] Chat stream error: ${e.message}`);
		res.end();
	});
};

// 将 Gemini 非流式响应转为 Responses API 响应
const transformGeminiToResponsesResponse = (geminiResp, modelName, sessionId) => {
	const output = [];
	const candidates = geminiResp.candidates || [];
	const textParts = [];
	const functionCalls = [];
	const pendingCallIds = [];

	for (const candidate of candidates) {
		const parts = (candidate.content && candidate.content.parts) || [];
		for (const part of parts) {
			if (part.text) {
				textParts.push(part.text);
			}
			if (part.functionCall) {
				const callId = part.functionCall.id || `call_${functionCalls.length}`;
				functionCalls.push({
					type: 'function_call',
					id: callId,
					name: part.functionCall.name,
					arguments: JSON.stringify(part.functionCall.args || {}),
				});
				pendingCallIds.push(callId);
			}
		}
	}

	// Gemini 转换：把合成 thinking 写入 pendingThinking，供后续注入
	if (pendingCallIds.length > 0) {
		const effKey = sessionId || 'default';
		if (!pendingThinking.has(effKey)) {
			pendingThinking.set(effKey, new Map());
		}
		const thinkMap = pendingThinking.get(effKey);
		for (const callId of pendingCallIds) {
			thinkMap.set(callId, {
				thinking: '(Gemini thinking)',
				signature: `gemini:${callId}`,
			});
		}
	}

	const messageContent = textParts.map((t) => ({ type: 'output_text', text: t }));
	const thoughtParts = [];
	for (const candidate of candidates) {
		const parts = (candidate.content && candidate.content.parts) || [];
		for (const part of parts) {
			if (part.thought && typeof part.text === 'string' && part.text) {
				thoughtParts.push(part.text);
			}
		}
	}
	// 透传上游 thought 数据：无论调用方是谁，都必须把思考内容原样给到调用方
	if (thoughtParts.length > 0) {
		const reasoningText = thoughtParts.join('');
		if (reasoningText) {
			output.push({
				type: 'reasoning',
				id: `rs_gem_${Date.now()}`,
				summary: [],
				content: [{ type: 'reasoning_text', text: reasoningText }],
			});
		}
	}
	if (messageContent.length > 0 || functionCalls.length === 0) {
		output.push({
			type: 'message',
			role: 'assistant',
			content: messageContent,
		});
	}

	for (const fc of functionCalls) {
		output.push(fc);
	}

	const finishMap = {
		'STOP': 'completed',
		'MAX_TOKENS': 'incomplete',
		'SAFETY': 'incomplete',
		'RECITATION': 'incomplete',
	};
	const candidateFinish = candidates[0] && candidates[0].finishReason;
	const status = finishMap[candidateFinish] || 'completed';

	const usageMetaGemini = geminiResp.usageMetadata;
	const usage = usageMetaGemini ? {
		input_tokens: usageMetaGemini.promptTokenCount || 0,
		output_tokens: usageMetaGemini.candidatesTokenCount || 0,
		total_tokens: (usageMetaGemini.promptTokenCount || 0) + (usageMetaGemini.candidatesTokenCount || 0),
	} : undefined;

	return {
		id: `resp_${Date.now()}`,
		object: 'response',
		created_at: Math.floor(Date.now() / 1000),
		model: modelName,
		status,
		output,
		usage,
	};
};

// 将 Gemini SSE 流转换为 Responses API SSE 流
const transformGeminiStreamToResponses = (res, originalModel, geminiStream, usageMeta, interactionId, sessionId) => {
	let respId = null;
	let streamInputTokens = 0;
	let streamOutputTokens = 0;
	let streamCacheReadTokens = 0;
	let status = 'completed';
	let outputIndex = 0;
	let contentIndex = 0;
	let textContentFull = '';
	let currentItemType = null; // 'message' | 'function_call' | 'reasoning' | null
	let hasStartedItem = false;
	let hasFinished = false;
	// Function call 状态
	let functionCallItemId = null;
	let functionCallId = null;
	let functionCallName = '';
	let functionCallArgs = '';
	const completedFunctionCalls = [];
	// Reasoning 状态：透传上游 thought parts
	let reasoningItemId = null;
	let reasoningTextFull = '';
	const completedReasoningItems = [];

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	const writeSSE = (eventType, data) => {
		const line = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
		res.write(line);
		if (interactionId) logClientStage('codex', interactionId, '4', 'result', line, true);
	};

	const openMessageItem = () => {
		if (currentItemType === 'message') {
			return;
		}
		// 切换 item 类型前先关闭上一个
		if (currentItemType === 'function_call') {
			finishFunctionCall();
		}
		currentItemType = 'message';
		writeSSE('response.output_item.added', {
			type: 'response.output_item.added',
			output_index: outputIndex,
			item: {
				type: 'message',
				role: 'assistant',
				status: 'in_progress',
				content: [],
			},
		});
		writeSSE('response.content_part.added', {
			type: 'response.content_part.added',
			output_index: outputIndex,
			content_index: contentIndex,
			part: { type: 'output_text', text: '' },
		});
		hasStartedItem = true;
	};

	const closeMessageItem = () => {
		if (currentItemType !== 'message') {
			return null;
		}
		const finalText = textContentFull;
		writeSSE('response.output_text.done', {
			type: 'response.output_text.done',
			item_id: respId,
			output_index: outputIndex,
			content_index: contentIndex,
			text: finalText,
		});
		writeSSE('response.content_part.done', {
			type: 'response.content_part.done',
			item_id: respId,
			output_index: outputIndex,
			content_index: contentIndex,
			part: { type: 'output_text', text: finalText },
		});
		writeSSE('response.output_item.done', {
			type: 'response.output_item.done',
			output_index: outputIndex,
			item: {
				type: 'message',
				role: 'assistant',
				status: 'completed',
				content: finalText ? [{ type: 'output_text', text: finalText }] : [],
			},
		});
		outputIndex++;
		contentIndex = 0;
		textContentFull = '';
		currentItemType = null;
		return finalText ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: finalText }] } : null;
	};

	// 打开 reasoning item —— 透传上游 thought parts
	const openReasoningItem = () => {
		if (currentItemType === 'reasoning') {
			return;
		}
		if (currentItemType === 'function_call') {
			finishFunctionCall();
		}
		else if (currentItemType === 'message') {
			closeMessageItem();
		}
		currentItemType = 'reasoning';
		reasoningItemId = `rs_gem_${Date.now()}`;
		writeSSE('response.output_item.added', {
			type: 'response.output_item.added',
			output_index: outputIndex,
			item: {
				type: 'reasoning',
				id: reasoningItemId,
				summary: [],
				content: [],
				status: 'in_progress',
			},
		});
	};

	const closeReasoningItem = () => {
		if (currentItemType !== 'reasoning') {
			return null;
		}
		writeSSE('response.reasoning_text.done', {
			type: 'response.reasoning_text.done',
			item_id: reasoningItemId,
			output_index: outputIndex,
			content_index: 0,
			text: reasoningTextFull,
		});
		const item = {
			type: 'reasoning',
			id: reasoningItemId,
			summary: [],
			content: reasoningTextFull ? [{ type: 'reasoning_text', text: reasoningTextFull }] : [],
			status: 'completed',
		};
		writeSSE('response.output_item.done', {
			type: 'response.output_item.done',
			output_index: outputIndex,
			item,
		});
		completedReasoningItems.push(item);
		outputIndex++;
		reasoningTextFull = '';
		reasoningItemId = null;
		currentItemType = null;
		return item;
	};

	const openFunctionCallItem = (fc) => {
		if (currentItemType === 'function_call') {
			// 同一个 function_call 还没关闭 (异常路径)，先关掉
			finishFunctionCall();
		}
		if (currentItemType === 'message') {
			closeMessageItem();
		}
		functionCallId = fc.id || `call_${completedFunctionCalls.length}`;
		functionCallItemId = `fc_${functionCallId.replace(/^call_/, '')}`;
		functionCallName = fc.name || '';
		functionCallArgs = JSON.stringify(fc.args || {});
		currentItemType = 'function_call';
		writeSSE('response.output_item.added', {
			type: 'response.output_item.added',
			output_index: outputIndex,
			item: {
				type: 'function_call',
				id: functionCallItemId,
				call_id: functionCallId,
				name: functionCallName,
				arguments: '',
				status: 'in_progress',
			},
		});
		hasStartedItem = true;
	};

	const finishFunctionCall = () => {
		if (currentItemType !== 'function_call') {
			return;
		}
		writeSSE('response.function_call_arguments.delta', {
			type: 'response.function_call_arguments.delta',
			item_id: functionCallItemId,
			call_id: functionCallId,
			output_index: outputIndex,
			delta: functionCallArgs,
		});
		writeSSE('response.function_call_arguments.done', {
			type: 'response.function_call_arguments.done',
			item_id: functionCallItemId,
			call_id: functionCallId,
			output_index: outputIndex,
			arguments: functionCallArgs,
		});
		writeSSE('response.output_item.done', {
			type: 'response.output_item.done',
			output_index: outputIndex,
			item: {
				type: 'function_call',
				id: functionCallItemId,
				call_id: functionCallId,
				name: functionCallName,
				arguments: functionCallArgs,
				status: 'completed',
			},
		});
		completedFunctionCalls.push({
			type: 'function_call',
			id: functionCallItemId,
			call_id: functionCallId,
			name: functionCallName,
			arguments: functionCallArgs,
			status: 'completed',
		});
		// 写入 pendingThinking 供后续注入
		if (functionCallId) {
			const effKey = sessionId || 'default';
			if (!pendingThinking.has(effKey)) {
				pendingThinking.set(effKey, new Map());
			}
			pendingThinking.get(effKey).set(functionCallId, {
				thinking: '(Gemini thinking)',
				signature: `gemini:${functionCallId}`,
			});
		}
		outputIndex++;
		contentIndex = 0;
		currentItemType = null;
		functionCallId = null;
		functionCallItemId = null;
		functionCallName = '';
		functionCallArgs = '';
	};

	let buffer = '';
	geminiStream.on('data', (chunk) => {
		const chunkStr = chunk.toString();
		if (interactionId) logClientStage('codex', interactionId, '3', 'response', chunkStr, true);
		buffer += chunkStr;

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) {
				continue;
			}

			const jsonStr = line.substring(6);
			let parsed;
			try {
				parsed = JSON.parse(jsonStr);
			}
			catch (e) {
				continue;
			}

			if (!respId) {
				respId = `resp_${Date.now()}`;

				writeSSE('response.created', {
					type: 'response.created',
					response: {
						id: respId,
						object: 'response',
						model: originalModel,
						status: 'in_progress',
					},
				});

				writeSSE('response.in_progress', {
					type: 'response.in_progress',
					response: {
						id: respId,
						object: 'response',
						model: originalModel,
						status: 'in_progress',
					},
				});
			}

			if (parsed.usageMetadata) {
				streamInputTokens = Math.max(streamInputTokens, parsed.usageMetadata.promptTokenCount || 0);
				streamOutputTokens = Math.max(streamOutputTokens, parsed.usageMetadata.candidatesTokenCount || 0);
				streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.usageMetadata.cachedContentTokenCount || 0);
			}

			const candidates = parsed.candidates || [];
			for (const candidate of candidates) {
				const parts = (candidate.content && candidate.content.parts) || [];
				for (const part of parts) {
					if (typeof part.text === 'string') {
						// 透传上游 thought parts：无论调用方是谁，都必须把思考内容原样给到调用方
						if (part.thought === true) {
							openReasoningItem();
							if (part.text) {
								reasoningTextFull += part.text;
								writeSSE('response.reasoning_text.delta', {
									type: 'response.reasoning_text.delta',
									item_id: reasoningItemId,
									output_index: outputIndex,
									content_index: 0,
									delta: part.text,
								});
							}
						}
						else {
							openMessageItem();
							if (part.text) {
								textContentFull += part.text;
								writeSSE('response.output_text.delta', {
									type: 'response.output_text.delta',
									item_id: respId,
									output_index: outputIndex,
									content_index: contentIndex,
									delta: part.text,
								});
							}
						}
					}
					else if (part.functionCall) {
						openFunctionCallItem(part.functionCall);
						// Gemini 每个 SSE chunk 携带一个完整 functionCall，一次性 flush
						finishFunctionCall();
					}
				}

				if (candidate.finishReason) {
					const finishMap = {
						'STOP': 'completed',
						'MAX_TOKENS': 'incomplete',
						'SAFETY': 'incomplete',
					};
					status = finishMap[candidate.finishReason] || 'completed';
				}
			}
		}
	});

	geminiStream.on('end', () => {
		if (!hasFinished) {
			hasFinished = true;

			// 关闭任何还开着的 item，同时收集关闭时返回的最终消息项
			let trailingMessageItem = null;
			if (currentItemType === 'reasoning') {
				closeReasoningItem();
			}
			if (currentItemType === 'message') {
				trailingMessageItem = closeMessageItem();
			}
			else if (currentItemType === 'function_call') {
				finishFunctionCall();
			}

			// 构造最终 output 数组：reasoning → message → function_call
			const outputItems = [];
			for (const ri of completedReasoningItems) {
				outputItems.push(ri);
			}
			if (trailingMessageItem) {
				outputItems.push(trailingMessageItem);
			}
			for (const fc of completedFunctionCalls) {
				outputItems.push(fc);
			}

			// 防御性兜底：若模型既没有 reasoning 也没有文本也没有函数调用、且上游声明为 completed，主动降级为 incomplete，
			// 避免 Codex CLI 客户端因 output=[] 状态机死锁
			if (outputItems.length === 0 && status === 'completed') {
				status = 'incomplete';
			}

			writeSSE('response.completed', {
				type: 'response.completed',
				response: {
					id: respId,
					object: 'response',
					model: originalModel,
					status,
					output: outputItems,
					usage: (streamInputTokens > 0 || streamOutputTokens > 0) ? {
						input_tokens: streamInputTokens,
						output_tokens: streamOutputTokens,
						total_tokens: streamInputTokens + streamOutputTokens,
					} : undefined,
				},
			});

			if (usageMeta && (streamInputTokens > 0 || streamOutputTokens > 0)) {
				recordUsage(usageMeta.providerName || 'gemini', usageMeta.targetModel, {
					input_tokens: streamInputTokens,
					output_tokens: streamOutputTokens,
					cache_read_tokens: streamCacheReadTokens,
				}, 'codex', usageMeta);
			}
		}
		res.end();
	});

	geminiStream.on('error', (e) => {
		log('error', `[Responses] Gemini stream error: ${e.message}`);
		res.end();
	});
};

// 解析 OpenAI 请求中的 model 名
const extractModelFromOpenAIRequest = (body) => {
	try {
		const parsed = JSON.parse(body);
		return parsed.model || null;
	}
	catch (e) {
		return null;
	}
};

// 主处理函数
const handleOpenAINativeRequest = (config, req, body, res, sessionId, onComplete) => {
	// Codex 新版 wire_api = "responses": 走 Responses API 处理
	if ((req.url || '').includes('/responses')) {
		handleResponsesRequest(config, req, body, res, sessionId);
		return;
	}

	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
		return;
	}

	// Add Cyprite Mark!
	if (Array.isArray(parsedBody.instructions)) {
		parsedBody.instructions.some(item => {
			if (item.type === 'text' && item.text.match(/You are Codex/)) {
				item.text = item.text.replace(/You are Codex/g, 'You are Codex and your name is "Cyprite"');
				return true;
			}
		});
	}
	else if ((typeof parsedBody.instructions) === "string") {
		parsedBody.instructions = parsedBody.instructions.replace(/You are Codex/g, 'You are Codex and your name is "Cyprite"');
	}

	const originalModel = parsedBody.model;
	if (!originalModel) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Missing model parameter', type: 'invalid_request_error' } }));
		return;
	}

	const mapped = mapModel(originalModel, config.modelMapping);
	if (!mapped) {
		log('warn', `[OpenAI-Native] No mapping for model: ${originalModel}`);
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `No mapping configured for model: ${originalModel}. Add a matching prefix in modelMapping.`,
				type: 'invalid_request_error',
			},
		}));
		return;
	}

	let provider = config.providers[mapped.provider];
	if (!provider) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `Provider not configured: ${mapped.provider}`,
				type: 'invalid_request_error',
			},
		}));
		return;
	}

	const targetModel = mapped.targetModel || originalModel;
	Object.defineProperty(provider, '_name', { value: mapped.provider, writable: true, enumerable: false, configurable: true });

	log('info', `[OpenAI-Native] ${originalModel} → ${targetModel} (${mapped.provider}, type=${provider.type})`);

	// 对非 auto provider 设置 max_tokens
	if (provider.type !== 'auto') {
		const resolvedMaxTokens = resolveMaxTokens(config, provider, targetModel);
		if (!parsedBody.max_completion_tokens && !parsedBody.max_tokens) {
			parsedBody.max_completion_tokens = resolvedMaxTokens;
		}
	}

	if (provider.type === 'auto') {
		handleAutoMode(config, provider, targetModel, originalModel, req, body, res, sessionId, parsedBody, onComplete);
	}
	else if (provider.type === 'openai') {
		forwardOpenAIDirect(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete);
	}
	else if (provider.type === 'anthropic') {
		forwardViaAnthropicProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete);
	}
	else if (provider.type === 'gemini') {
		forwardViaGeminiProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete);
	}
	else {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `Unknown provider type: ${provider.type}`,
				type: 'invalid_request_error',
			},
		}));
	}
};

// Auto mode for OpenAI-native requests
const handleAutoMode = (config, provider, targetModel, originalModel, req, body, res, sessionId, parsedBody, onComplete) => {
	const rawAgentSet = (config.agents || {})[targetModel] || (config.agents || {}).defaults || {};
	const { normalizeAgentSet } = require('../providers/auto');
	const agentSet = normalizeAgentSet(rawAgentSet);
	const sessionKey = sessionId || deriveSessionKey(parsedBody.messages);
	const messages = parsedBody.messages || [];

	// buildBody + dispatch 工厂:用 executeWithRetry 统一派发
	const modelRouter = require('../model-router');
	const dispatch = (p, model, pName, retryBody, onAttemptDone) => {
		dispatchOpenAINative(config, p, model, originalModel, req, retryBody, res, parsedBody, sessionId, onAttemptDone);
	};
	const makeBuildBody = () => (selected, p) => {
		const obj = JSON.parse(JSON.stringify(parsedBody));
		obj.model = selected.model;
		return JSON.stringify(obj);
	};

	// Check if this is user text input (non-tool)
	const isUserText = (() => {
		if (!Array.isArray(messages) || messages.length === 0) { return false; }
		const lastMsg = messages[messages.length - 1];
		if (lastMsg.role !== 'user') { return false; }
		return true;
	})();

	const currentMode = getSession(sessionKey) || 'default';

	if (!isUserText) {
		const modeName = (agentSet && agentSet[currentMode]) ? currentMode : 'default';
		const modelsArray = (agentSet && agentSet[modeName] && agentSet[modeName].models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'Cannot resolve agent', type: 'server_error' } }));
				}
			},
		});
		return;
	}

	// User text input: use classifier
	let quickEntry = agentSet.quick;
	if (!quickEntry) {
		log('warn', '[OpenAI-Native] No quick agent, using default');
		const modelsArray = (agentSet && agentSet.default && agentSet.default.models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'No agent configured', type: 'server_error' } }));
				}
			},
		});
		return;
	}

	const quickModels = quickEntry.models || [];
	if (quickModels.length === 0) {
		log('warn', '[OpenAI-Native] Quick entry has no models, using default');
		const modelsArray = (agentSet && agentSet.default && agentSet.default.models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'No agent configured', type: 'server_error' } }));
				}
			},
		});
		return;
	}
	const quickSelected = modelRouter.selectModel(quickModels);

	const quickProvider = config.providers[quickSelected.providerName];
	if (!quickProvider || quickProvider.type === 'auto') {
		const modelsArray = (agentSet && agentSet.default && agentSet.default.models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'No agent configured', type: 'server_error' } }));
				}
			},
		});
		return;
	}
	if (!quickProvider._name) {
		Object.defineProperty(quickProvider, '_name', { value: quickSelected.providerName, writable: true, enumerable: false, configurable: true });
	}

	const availableModes = Object.entries(agentSet)
		.filter(([name]) => name !== 'default' && name !== 'quick')
		.map(([name, entry]) => ({ name, description: entry.description }));
	const maxTokens = resolveMaxTokens(config, quickProvider, quickSelected.model);
	const conversationGroups = config.conversationGroups != null ? config.conversationGroups : 5;

	// Check mode cache
	const modeCacheTtlSec = config.modeCacheTtl != null ? config.modeCacheTtl : 60;
	const modeCacheTtlMs = modeCacheTtlSec * 1000 * (!!currentMode && !["default", "quick"].includes(currentMode) ? 1 : 0);
	const cachedMode = getCachedMode(sessionKey, modeCacheTtlMs);
	if (cachedMode) {
		log('info', `[OpenAI-Native] Cache hit: ${originalModel} → mode=${cachedMode}`);
		const modelsArray = (agentSet && agentSet[cachedMode] && agentSet[cachedMode].models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'Cannot resolve agent', type: 'server_error' } }));
				}
			},
		});
		return;
	}

	// Classify — 带重试：每次失败重新从 quickModels 加权选模型
	const MAX_RETRY_ATTEMPTS = modelRouter._LIMITS.MAX_RETRY_ATTEMPTS;
	const anthropicMessages = convertOpenAIRequestToAnthropic(parsedBody, targetModel, sessionId).messages || [];

	const classifyWithRetry = (attemptNum) => {
		if (attemptNum >= MAX_RETRY_ATTEMPTS) {
			log('warn', `[OpenAI-Native] Classifier all ${MAX_RETRY_ATTEMPTS} attempts failed, using mode=${currentMode}`);
			const modeName = (agentSet && agentSet[currentMode]) ? currentMode : 'default';
			const modelsArray = (agentSet && agentSet[modeName] && agentSet[modeName].models) || [];
			modelRouter.executeWithRetry({
				modelsArray,
				config,
				buildBody: makeBuildBody(),
				dispatch,
				onDone: (err) => {
					if (err) {
						res.writeHead(502, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
					}
				},
			});
			return;
		}

			const quickSelected = modelRouter.selectModel(quickModels);
			const quickP = config.providers[quickSelected.providerName];
			if (!quickP || quickP.type === 'auto') {
				log('warn', `[OpenAI-Native] Quick provider invalid: ${quickSelected.providerName}, retrying`);
				classifyWithRetry(attemptNum + 1);
				return;
			}
			if (!quickP._name) {
				Object.defineProperty(quickP, '_name', { value: quickSelected.providerName, writable: true, enumerable: false, configurable: true });
			}

			const classifyMaxTokens = resolveMaxTokens(config, quickP, quickSelected.model);
			modelRouter.startTask(quickSelected.providerName, quickSelected.model);

			classifyTopic(quickP, quickSelected.model, anthropicMessages, sessionId, availableModes, classifyMaxTokens, currentMode, conversationGroups, (err, result) => {
				if (err) {
					modelRouter.finishTask(quickSelected.providerName, quickSelected.model, false, true);
					log('warn', `[OpenAI-Native] Classifier attempt ${attemptNum + 1}/${MAX_RETRY_ATTEMPTS} failed: ${err.message}`);
					classifyWithRetry(attemptNum + 1);
					return;
				}

				modelRouter.finishTask(quickSelected.providerName, quickSelected.model, true, false);

				let newMode;
				if (!result) {
					log('warn', '[OpenAI-Native] Classification returned null');
					newMode = currentMode;
				}
				else if (result.isNewTopic && result.mode && agentSet[result.mode]) {
					newMode = result.mode;
				}
				else if (result.isNewTopic && !result.mode) {
					newMode = 'default';
				}
				else {
					newMode = currentMode;
				}

				setSession(sessionKey, newMode);
				const modeName = (agentSet && agentSet[newMode]) ? newMode : 'default';
				const modelsArray = (agentSet && agentSet[modeName] && agentSet[modeName].models) || [];
				log('info', `[OpenAI-Native] ${originalModel} → mode=${newMode}`);
				modelRouter.executeWithRetry({
					modelsArray,
					config,
					buildBody: makeBuildBody(),
					dispatch,
					onDone: (err) => {
						if (err) {
							res.writeHead(502, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
						}
					},
				});
			});
		};

	classifyWithRetry(0);
};

// 根据 resolved provider 分发 OpenAI 原生请求
const dispatchOpenAINative = (config, provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete) => {
	if (provider.type === 'openai') {
			forwardOpenAIDirect(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete);
	}
	else if (provider.type === 'anthropic') {
			forwardViaAnthropicProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete);
	}
	else if (provider.type === 'gemini') {
			forwardViaGeminiProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete);
	}
	else {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `Unknown provider type: ${provider.type}`,
				type: 'invalid_request_error',
			},
		}));
	}
};

// ==============================
// Responses API 转发函数 (Codex wire_api = "responses")
// ==============================

// 通过 Anthropic Provider 转发 Responses 请求
const forwardResponsesViaAnthropicProvider = (provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, thinkingKey, onComplete) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;
	let settled = false;
	const settle = (opts) => {
		if (settled) { return; }
		settled = true;
		releaseKey(provider._name, key, opts);
	};
	const respIid = req.interactionId || getNextInteractionId();
	const targetUrl = new URL(provider.baseUrl);
	const anthropicBody = convertResponsesRequestToAnthropic(parsedBody, sessionId, thinkingKey, provider._name || 'deepseek');
	anthropicBody.model = targetModel;
	if (!anthropicBody.max_tokens) anthropicBody.max_tokens = parsedBody.max_tokens;
	const reqBody = JSON.stringify(anthropicBody);
	logClientStage('codex', respIid, '2', 'upstream', anthropicBody);

	const reqPath = targetUrl.pathname.replace(/\/+$/, '') + '/v1/messages';

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: reqPath,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			settle({ isProviderDown: true });
			if (onComplete) {
				onComplete(err);
			}
			else {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
			}
			return;
		}

		log('debug', `[Responses] Upstream response: status=${proxyRes.statusCode}, content-type=${proxyRes.headers['content-type'] || 'none'}`);
		const upstreamIsStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (parsedBody.stream && upstreamIsStream) {
			transformAnthropicStreamToResponses(res, originalModel, proxyRes, {
				providerName: provider._name,
				targetModel,
			}, sessionId, thinkingKey, respIid);
			if (onComplete) { onComplete(null); }
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				log('debug', `[Responses] Non-stream response body (first 500 chars): ${responseBody.substring(0, 500)}`);
				try {
					const anthropicResp = JSON.parse(responseBody);
					logClientStage('codex', respIid, '3', 'response', anthropicResp);
					if (anthropicResp.error) {
						const cr = classifyResponse(proxyRes.statusCode, anthropicResp);
						settle({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
						if (onComplete) {
							onComplete(new Error(`API error: ${proxyRes.statusCode}`));
						}
						else {
							res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									message: anthropicResp.error.message || 'Unknown error',
									type: anthropicResp.error.type || 'api_error',
								},
							}));
						}
						return;
					}
					const responsesResp = transformAnthropicToResponsesResponse(anthropicResp, originalModel);
					logClientStage('codex', respIid, '4', 'result', responsesResp);
					if (anthropicResp.usage) {
						recordUsage(provider._name || 'anthropic', targetModel, {
							input_tokens: anthropicResp.usage.input_tokens || 0,
							output_tokens: anthropicResp.usage.output_tokens || 0,
							cache_read_tokens: anthropicResp.usage.cache_read_input_tokens || 0,
						}, 'codex', anthropicResp.usage);
					}

					if (parsedBody.stream) {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responsesResp.id, object: 'response', model: originalModel, status: 'completed' } })}\n\n`);
						res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: responsesResp })}\n\n`);
						res.end();
						if (onComplete) { onComplete(null); }
					}
					else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(responsesResp));
						if (onComplete) { onComplete(null); }
					}
				}
				catch (e) {
					settle({ isKeyFailure: true });
					log('warn', `[Responses] Failed to transform response: ${e.message}`);
					if (onComplete) {
						onComplete(e);
					}
					else {
						res.writeHead(proxyRes.statusCode, proxyRes.headers);
						res.end(responseBody);
					}
				}
			});
		}

		proxyRes.on('error', (e) => {
			settle({ isProviderDown: true });
			log('error', `[Responses] Anthropic response error: ${e.message}`);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		settle({ isProviderDown: true });
		proxyReq.destroy();
		if (onComplete) {
			onComplete(new Error('Upstream timeout'));
		}
		else {
			res.writeHead(504, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Upstream timeout', type: 'timeout_error' } }));
		}
	});
};

// 通过 OpenAI Provider 转发 Responses 请求
const forwardResponsesViaOpenAIProvider = (provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;
	let settled = false;
	const settle = (opts) => {
		if (settled) { return; }
		settled = true;
		releaseKey(provider._name, key, opts);
	};
	const oaiIid = req.interactionId || getNextInteractionId();
	const chatBody = convertResponsesRequestToOpenAIChat(parsedBody);
	chatBody.model = targetModel;
	if (!chatBody.max_tokens) chatBody.max_tokens = parsedBody.max_tokens;
	logClientStage('codex', oaiIid, '2', 'upstream', chatBody);

	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);
	const reqBody = JSON.stringify(chatBody);
	const reqPath = targetUrl.pathname + '/chat/completions';

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: reqPath,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${key}`,
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			settle({ isProviderDown: true });
			if (onComplete) {
				onComplete(err);
			}
			else {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
			}
			return;
		}

		const upstreamIsStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (parsedBody.stream && upstreamIsStream) {
			transformOpenAIChatStreamToResponses(res, originalModel, proxyRes, {
				providerName: provider._name || 'openai',
				targetModel,
			}, oaiIid);
			if (onComplete) { onComplete(null); }
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				try {
					const chatResp = JSON.parse(responseBody);
					logClientStage('codex', oaiIid, '3', 'response', chatResp);
					if (chatResp.error) {
						if (onComplete) {
							onComplete(new Error(`API error: ${proxyRes.statusCode}`));
						}
						else {
							res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									message: chatResp.error.message || 'Unknown error',
									type: chatResp.error.type || 'api_error',
								},
							}));
						}
						return;
					}
					const responsesResp = transformOpenAIChatToResponsesResponse(chatResp, originalModel);
					logClientStage('codex', oaiIid, '4', 'result', responsesResp);
					if (chatResp.usage) {
						recordUsage(provider._name || 'openai', targetModel, {
							input_tokens: chatResp.usage.prompt_tokens || 0,
							output_tokens: chatResp.usage.completion_tokens || 0,
							cache_read_tokens: chatResp.usage.prompt_tokens_details?.cached_tokens || 0,
						}, 'codex', chatResp.usage);
					}

					if (parsedBody.stream) {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responsesResp.id, object: 'response', model: originalModel, status: 'completed' } })}\n\n`);
						res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: responsesResp })}\n\n`);
						res.end();
						if (onComplete) { onComplete(null); }
					}
					else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(responsesResp));
						if (onComplete) { onComplete(null); }
					}
				}
				catch (e) {
					settle({ isKeyFailure: true });
					log('warn', `[Responses] Failed to transform response: ${e.message}`);
					if (onComplete) {
						onComplete(e);
					}
					else {
						res.writeHead(proxyRes.statusCode, proxyRes.headers);
						res.end(responseBody);
					}
				}
			});
		}

		proxyRes.on('error', (e) => {
			settle({ isProviderDown: true });
			log('error', `[Responses] OpenAI response error: ${e.message}`);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		settle({ isProviderDown: true });
		proxyReq.destroy();
		if (onComplete) {
			onComplete(new Error('Upstream timeout'));
		}
		else {
			res.writeHead(504, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Upstream timeout', type: 'timeout_error' } }));
		}
	});
};

// 通过 Gemini Provider 转发 Responses 请求
const forwardResponsesViaGeminiProvider = (provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, thinkingKey, onComplete) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;
	let settled = false;
	const settle = (opts) => {
		if (settled) { return; }
		settled = true;
		releaseKey(provider._name, key, opts);
	};
	const gemIid = req.interactionId || getNextInteractionId();
	const anthropicBody = convertResponsesRequestToAnthropic(parsedBody, sessionId, thinkingKey, provider._name || 'google');
	anthropicBody.model = targetModel;
	if (!anthropicBody.max_tokens) anthropicBody.max_tokens = parsedBody.max_tokens;
	const { convertAnthropicToGemini } = require('../providers/gemini');
	const geminiBody = convertAnthropicToGemini(anthropicBody);
	logClientStage('codex', gemIid, '2', 'upstream', geminiBody);

	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const stream = parsedBody.stream;
	const action = stream ? 'streamGenerateContent' : 'generateContent';
	const querySep = stream ? '?alt=sse&' : '?';
	const path = `${pathPrefix}/models/${targetModel}:${action}${querySep}key=${encodeURIComponent(key)}`;

	const reqBody = JSON.stringify(geminiBody);

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			settle({ isProviderDown: true });
			if (onComplete) {
				onComplete(err);
			}
			else {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { message: err.message, type: 'proxy_error' } }));
			}
			return;
		}

		const upstreamIsStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (stream && upstreamIsStream) {
			transformGeminiStreamToResponses(res, originalModel, proxyRes, {
				providerName: provider._name || 'gemini',
				targetModel,
			}, gemIid, sessionId);
			if (onComplete) { onComplete(null); }
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				try {
					const geminiResp = JSON.parse(responseBody);
					logClientStage('codex', gemIid, '3', 'response', geminiResp);
					if (geminiResp.error) {
						const cr = classifyResponse(proxyRes.statusCode, geminiResp);
						settle({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
						if (onComplete) {
							onComplete(new Error(`API error: ${proxyRes.statusCode}`));
						}
						else {
							res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									message: geminiResp.error.message || 'Unknown error',
									type: geminiResp.error.type || 'api_error',
								},
							}));
						}
						return;
					}
					const responsesResp = transformGeminiToResponsesResponse(geminiResp, originalModel, sessionId);
					logClientStage('codex', gemIid, '4', 'result', responsesResp);
					if (geminiResp.usageMetadata) {
						recordUsage(provider._name || 'gemini', targetModel, {
							input_tokens: geminiResp.usageMetadata.promptTokenCount || 0,
							output_tokens: geminiResp.usageMetadata.candidatesTokenCount || 0,
							cache_read_tokens: geminiResp.usageMetadata.cachedContentTokenCount || 0,
						}, 'codex', geminiResp.usageMetadata);
					}

					if (stream) {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: responsesResp.id, object: 'response', model: originalModel, status: 'completed' } })}\n\n`);
						res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: responsesResp })}\n\n`);
						res.end();
						if (onComplete) { onComplete(null); }
					}
					else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(responsesResp));
						if (onComplete) { onComplete(null); }
					}
				}
				catch (e) {
					settle({ isKeyFailure: true });
					log('warn', `[Responses] Failed to transform Gemini response: ${e.message}`);
					if (onComplete) {
						onComplete(e);
					}
					else {
						res.writeHead(proxyRes.statusCode, proxyRes.headers);
						res.end(responseBody);
					}
				}
			});
		}

		proxyRes.on('error', (e) => {
			settle({ isProviderDown: true });
			log('error', `[Responses] Gemini response error: ${e.message}`);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		settle({ isProviderDown: true });
		proxyReq.destroy();
		if (onComplete) {
			onComplete(new Error('Upstream timeout'));
		}
		else {
			res.writeHead(504, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Upstream timeout', type: 'timeout_error' } }));
		}
	});
};

// Responses API 分发器
const dispatchResponsesNative = (config, provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, thinkingKey, onComplete) => {
	// 设置 max_tokens
	const resolvedMaxTokens = resolveMaxTokens(config, provider, targetModel);
	parsedBody.max_tokens = resolvedMaxTokens;
	parsedBody.max_output_tokens = resolvedMaxTokens;

	if (provider.type === 'anthropic') {
		forwardResponsesViaAnthropicProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, thinkingKey, onComplete);
	}
	else if (provider.type === 'openai') {
		forwardResponsesViaOpenAIProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete);
	}
	else if (provider.type === 'gemini') {
		forwardResponsesViaGeminiProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, thinkingKey, onComplete);
	}
	else {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `Unknown provider type: ${provider.type}`,
				type: 'invalid_request_error',
			},
		}));
	}
};

// Responses API Auto Mode
const handleResponsesAutoMode = (config, provider, targetModel, originalModel, req, body, res, sessionId, parsedBody, thinkingKey, onComplete) => {
	const rawAgentSet = (config.agents || {})[targetModel] || (config.agents || {}).defaults || {};
	const { normalizeAgentSet } = require('../providers/auto');
	const agentSet = normalizeAgentSet(rawAgentSet);

	// buildBody + dispatch 工厂:用 executeWithRetry 统一派发
	const modelRouter = require('../model-router');
	const dispatch = (p, model, pName, retryBody, onAttemptDone) => {
		dispatchResponsesNative(config, p, model, originalModel, req, retryBody, res, parsedBody, sessionId, thinkingKey, onAttemptDone);
	};
	const makeBuildBody = () => (selected, p) => {
		const obj = JSON.parse(JSON.stringify(parsedBody));
		obj.model = selected.model;
		return JSON.stringify(obj);
	};

	// 用 Anthropic 格式的消息做分类
	const anthropicBody = convertResponsesRequestToAnthropic(parsedBody, sessionId, thinkingKey);
	const messages = anthropicBody.messages || [];
	const sessionKey = sessionId || deriveSessionKey(messages);

	const isUserText = (() => {
		if (!Array.isArray(messages) || messages.length === 0) { return false; }
		const lastMsg = messages[messages.length - 1];
		if (lastMsg.role !== 'user') { return false; }
		return true;
	})();

	const currentMode = getSession(sessionKey) || 'default';

	if (!isUserText) {
		const modeName = (agentSet && agentSet[currentMode]) ? currentMode : 'default';
		const modelsArray = (agentSet && agentSet[modeName] && agentSet[modeName].models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'Cannot resolve agent', type: 'server_error' } }));
				}
			},
		});
		return;
	}

	let quickEntry = agentSet.quick;
	if (!quickEntry) {
		log('warn', '[Responses] No quick agent, using default');
		const modelsArray = (agentSet && agentSet.default && agentSet.default.models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'No agent configured', type: 'server_error' } }));
				}
			},
		});
		return;
	}

	const quickModels = quickEntry.models || [];
	if (quickModels.length === 0) {
		log('warn', '[Responses] Quick entry has no models, using default');
		const modelsArray = (agentSet && agentSet.default && agentSet.default.models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'No agent configured', type: 'server_error' } }));
				}
			},
		});
		return;
	}
	const quickSelected = modelRouter.selectModel(quickModels);

	const quickProvider = config.providers[quickSelected.providerName];
	if (!quickProvider || quickProvider.type === 'auto') {
		const modelsArray = (agentSet && agentSet.default && agentSet.default.models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'No agent configured', type: 'server_error' } }));
				}
			},
		});
		return;
	}
	if (!quickProvider._name) {
		Object.defineProperty(quickProvider, '_name', { value: quickSelected.providerName, writable: true, enumerable: false, configurable: true });
	}

	const availableModes = Object.entries(agentSet)
		.filter(([name]) => name !== 'default' && name !== 'quick')
		.map(([name, entry]) => ({ name, description: entry.description }));
	const maxTokens = resolveMaxTokens(config, quickProvider, quickSelected.model);
	const conversationGroups = config.conversationGroups != null ? config.conversationGroups : 5;

	const modeCacheTtlSec = config.modeCacheTtl != null ? config.modeCacheTtl : 60;
	const modeCacheTtlMs = modeCacheTtlSec * 1000 * (!!currentMode && !["default", "quick"].includes(currentMode) ? 1 : 0);
	const cachedMode = getCachedMode(sessionKey, modeCacheTtlMs);
	if (cachedMode) {
		log('debug', `[Responses] Cache hit: ${originalModel} → mode=${cachedMode}`);
		const modelsArray = (agentSet && agentSet[cachedMode] && agentSet[cachedMode].models) || [];
		modelRouter.executeWithRetry({
			modelsArray,
			config,
			buildBody: makeBuildBody(),
			dispatch,
			onDone: (err) => {
				if (err) {
					res.writeHead(500, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { message: 'Cannot resolve agent', type: 'server_error' } }));
				}
			},
		});
		return;
	}

	// Classify — 带重试：每次失败重新从 quickModels 加权选模型
	const MAX_RETRY_ATTEMPTS_RESP = modelRouter._LIMITS.MAX_RETRY_ATTEMPTS;

	const classifyWithRetry = (attemptNum) => {
		if (attemptNum >= MAX_RETRY_ATTEMPTS_RESP) {
			log('warn', `[Responses] Classifier all ${MAX_RETRY_ATTEMPTS_RESP} attempts failed, using mode=${currentMode}`);
			const modeName = (agentSet && agentSet[currentMode]) ? currentMode : 'default';
			const modelsArray = (agentSet && agentSet[modeName] && agentSet[modeName].models) || [];
			modelRouter.executeWithRetry({
				modelsArray,
				config,
				buildBody: makeBuildBody(),
				dispatch,
				onDone: (err) => {
					if (err) {
						res.writeHead(502, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
					}
				},
			});
			return;
		}

		const quickSelected = modelRouter.selectModel(quickModels);
		const quickP = config.providers[quickSelected.providerName];
		if (!quickP || quickP.type === 'auto') {
			log('warn', `[Responses] Quick provider invalid: ${quickSelected.providerName}, retrying`);
			classifyWithRetry(attemptNum + 1);
			return;
		}
		if (!quickP._name) {
			Object.defineProperty(quickP, '_name', { value: quickSelected.providerName, writable: true, enumerable: false, configurable: true });
		}

		const classifyMaxTokens = resolveMaxTokens(config, quickP, quickSelected.model);
		modelRouter.startTask(quickSelected.providerName, quickSelected.model);

		classifyTopic(quickP, quickSelected.model, messages, sessionId, availableModes, classifyMaxTokens, currentMode, conversationGroups, (err, result) => {
			if (err) {
				modelRouter.finishTask(quickSelected.providerName, quickSelected.model, false, true);
				log('warn', `[Responses] Classifier attempt ${attemptNum + 1}/${MAX_RETRY_ATTEMPTS_RESP} failed: ${err.message}`);
				classifyWithRetry(attemptNum + 1);
				return;
			}

			modelRouter.finishTask(quickSelected.providerName, quickSelected.model, true, false);

			let newMode;
			if (!result) {
				log('warn', '[Responses] Classification returned null');
				newMode = currentMode;
			}
			else if (result.isNewTopic && result.mode && agentSet[result.mode]) {
				newMode = result.mode;
			}
			else if (result.isNewTopic && !result.mode) {
				newMode = 'default';
			}
			else {
				newMode = currentMode;
			}

			setSession(sessionKey, newMode);
			const modeName = (agentSet && agentSet[newMode]) ? newMode : 'default';
			const modelsArray = (agentSet && agentSet[modeName] && agentSet[modeName].models) || [];
			log('debug', `[Responses] ${originalModel} → mode=${newMode}`);
			modelRouter.executeWithRetry({
				modelsArray,
				config,
				buildBody: makeBuildBody(),
				dispatch,
				onDone: (err) => {
					if (err) {
						res.writeHead(502, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
					}
				},
			});
		});
	};

	classifyWithRetry(0);
};

// Responses API 主处理函数
const handleResponsesRequest = (config, req, body, res, sessionId, onComplete) => {
	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
		return;
	}
	// Add Cyprite Mark!
	if (Array.isArray(parsedBody.instructions)) {
		parsedBody.instructions.some(item => {
			if (item.type === 'text' && item.text.match(/You are Codex/)) {
				item.text = item.text.replace(/You are Codex/g, 'You are Codex and your name is "Cyprite"');
				return true;
			}
		});
	}
	else if ((typeof parsedBody.instructions) === "string") {
		parsedBody.instructions = parsedBody.instructions.replace(/You are Codex/g, 'You are Codex and your name is "Cyprite"');
	}

	// thinking 缓存跨请求共用 sessionId（不混 prompt_cache_key，因为它每次请求会变）
	const thinkingKey = sessionId;
	const originalModel = parsedBody.model;
	if (!originalModel) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Missing model parameter', type: 'invalid_request_error' } }));
		return;
	}

	const mapped = mapModel(originalModel, config.modelMapping);
	if (!mapped) {
		log('warn', `[Responses] No mapping for model: ${originalModel}`);
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `No mapping configured for model: ${originalModel}. Add a matching prefix in modelMapping.`,
				type: 'invalid_request_error',
			},
		}));
		return;
	}

	let provider = config.providers[mapped.provider];
	if (!provider) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `Provider not configured: ${mapped.provider}`,
				type: 'invalid_request_error',
			},
		}));
		return;
	}

	const targetModel = mapped.targetModel || originalModel;
	Object.defineProperty(provider, '_name', { value: mapped.provider, writable: true, enumerable: false, configurable: true });

	log('debug', `[Responses] ${originalModel} → ${targetModel} (${mapped.provider}, type=${provider.type})`);

	if (provider.type === 'auto') {
		handleResponsesAutoMode(config, provider, targetModel, originalModel, req, body, res, sessionId, parsedBody, thinkingKey, onComplete);
	}
	else {
		// 设置 max_tokens
		const resolvedMaxTokens = resolveMaxTokens(config, provider, targetModel);
		parsedBody.max_tokens = resolvedMaxTokens;
		parsedBody.max_output_tokens = resolvedMaxTokens;

		if (provider.type === 'anthropic') {
			forwardResponsesViaAnthropicProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, thinkingKey, onComplete);
		}
		else if (provider.type === 'openai') {
			forwardResponsesViaOpenAIProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, onComplete);
		}
		else if (provider.type === 'gemini') {
			forwardResponsesViaGeminiProvider(provider, targetModel, originalModel, req, body, res, parsedBody, sessionId, thinkingKey, onComplete);
		}
		else {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: {
					message: `Unknown provider type: ${provider.type}`,
					type: 'invalid_request_error',
				},
			}));
		}
	}
};

module.exports = {
	handleOpenAINativeRequest,
	convertOpenAIRequestToAnthropic,
	transformAnthropicToOpenAIResponse,
	transformAnthropicStreamToOpenAI,
	extractModelFromOpenAIRequest,
	// Responses API
	convertResponsesRequestToAnthropic,
	transformAnthropicToResponsesResponse,
	transformAnthropicStreamToResponses,
};
