const { log, logClientStage } = require('../logger');
const { proxyRequest } = require('../proxy-agent');
const { recordUsage } = require('../usage-tracker');
const { acquireKey, releaseKey } = require('../key-state-manager');
const { classifyResponse, classifyStreamFirstBlock } = require('../error-detector');

const extractTextFromContent = (content) => {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.filter((block) => block.type === 'text')
			.map((block) => block.text || '')
			.join('');
	}
	return '';
};

const extractThinkingFromContent = (content) => {
	if (!Array.isArray(content)) {
		return '';
	}
	return content
		.filter((block) => block.type === 'thinking')
		.map((block) => block.thinking || block.text || '')
		.join('');
};


const hasCacheControl = (blocks) => {
	if (!Array.isArray(blocks)) {
		return false;
	}
	return blocks.some((b) => b.cache_control);
};

const convertAnthropicMessagesToOpenAI = (parsedBody) => {
	const openaiMessages = [];

	// System message: 有 cache_control 时输出 multipart content block 格式
	if (parsedBody.system) {
		if (typeof parsedBody.system === 'string') {
			openaiMessages.push({ role: 'system', content: parsedBody.system });
		}
		else if (Array.isArray(parsedBody.system)) {
			if (hasCacheControl(parsedBody.system)) {
				const blocks = parsedBody.system
					.filter((b) => b.text)
					.map((b) => {
						const blk = { type: 'text', text: b.text || '' };
						if (b.cache_control) { blk.cache_control = b.cache_control; }
						return blk;
					});
				if (blocks.length > 0) {
					openaiMessages.push({ role: 'system', content: blocks });
				}
			}
			else {
				const text = parsedBody.system.map((b) => b.text || '').join('\n');
				if (text) {
					openaiMessages.push({ role: 'system', content: text });
				}
			}
		}
	}

	if (Array.isArray(parsedBody.messages)) {
		for (const msg of parsedBody.messages) {
			log('debug', `[OpenAI] msg role=${msg.role}, content=${Array.isArray(msg.content) ? msg.content.map(b=>b.type).join(',') : typeof msg.content}`);
			const role = msg.role;
			const content = msg.content;

			if (typeof content === 'string') {
				openaiMessages.push({ role, content });
			}
			else if (Array.isArray(content)) {
				const hasToolUse = content.some((block) => block.type === 'tool_use');
				const hasToolResult = content.some((block) => block.type === 'tool_result');

				if (hasToolUse && role === 'assistant') {
					const textContent = extractTextFromContent(content);
					const thinkingContent = extractThinkingFromContent(content);
					const toolCalls = content
						.filter((block) => block.type === 'tool_use')
						.map((block) => ({
							id: block.id,
							type: 'function',
							function: {
								name: block.name,
								arguments: JSON.stringify(block.input || {}),
							},
						}));

					const msg = {
						role: 'assistant',
						content: textContent || null,
						tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
					};
					msg.reasoning_content = thinkingContent || '';
					openaiMessages.push(msg);
				}
				else if (hasToolResult && role === 'user') {
					for (const block of content) {
						if (block.type === 'tool_result') {
							openaiMessages.push({
								role: 'tool',
								tool_call_id: block.tool_use_id,
								content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {}),
							});
						}
					}

					const textContent = extractTextFromContent(content);
					if (textContent) {
						if (hasCacheControl(content)) {
							// multipart: content block 级别 cache_control
							const blocks = content
								.filter((b) => b.type === 'text')
								.map((b) => {
									const blk = { type: 'text', text: b.text || '' };
									if (b.cache_control) { blk.cache_control = b.cache_control; }
									return blk;
								});
							if (blocks.length > 0) {
								openaiMessages.push({ role: 'user', content: blocks });
							}
						}
						else {
							openaiMessages.push({ role: 'user', content: textContent });
						}
					}
				}
				else if (content.some((block) => block.type === 'image' || block.type === 'image_url')) {
					const openaiContent = content.map((block) => {
						if (block.type === 'text') {
							const tc = { type: 'text', text: block.text || '' };
							if (block.cache_control) { tc.cache_control = block.cache_control; }
							return tc;
						}
						if (block.type === 'image' && block.source) {
							return {
								type: 'image_url',
								image_url: {
									url: `data:${block.source.media_type || 'image/png'};base64,${block.source.data}`,
								},
							};
						}
						return block;
					});
					openaiMessages.push({ role, content: openaiContent });
				}
				else {
					const text = extractTextFromContent(content);
					if (text) {
						if (hasCacheControl(content)) {
							// multipart: content block 级别 cache_control
							const blocks = content
								.filter((b) => b.type === 'text' || b.type === 'image' || b.type === 'image_url')
								.map((b) => {
									if (b.type === 'text') {
										const blk = { type: 'text', text: b.text || '' };
										if (b.cache_control) { blk.cache_control = b.cache_control; }
										return blk;
									}
									if (b.type === 'image' && b.source) {
										return { type: 'image_url', image_url: { url: `data:${b.source.media_type || 'image/png'};base64,${b.source.data}` } };
									}
									return b;
								});
							if (blocks.length > 0) {
								openaiMessages.push({ role, content: blocks });
							}
						}
						else {
							openaiMessages.push({ role, content: text });
						}
					}
				}
			}
		}
	}

	return openaiMessages;
};


const convertAnthropicToolsToOpenAI = (tools) => {
	if (!Array.isArray(tools)) {
		return [];
	}
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description || '',
			parameters: tool.input_schema || { type: 'object', properties: {} },
		},
	}));
};

const buildOpenAIRequest = (parsedBody) => {
	const openaiBody = {
		model: parsedBody.model,
		messages: convertAnthropicMessagesToOpenAI(parsedBody),
		stream: parsedBody.stream || false,
	};

	if (parsedBody.max_tokens) {
		openaiBody.max_completion_tokens = parsedBody.max_tokens;
	}

	if (parsedBody.temperature !== undefined) {
		openaiBody.temperature = parsedBody.temperature;
	}

	if (parsedBody.top_p !== undefined) {
		openaiBody.top_p = parsedBody.top_p;
	}

	if (parsedBody.top_k !== undefined) {
		openaiBody.top_k = parsedBody.top_k;
	}

	const tools = convertAnthropicToolsToOpenAI(parsedBody.tools);
	if (tools.length > 0) {
		openaiBody.tools = tools;
	}

	if (parsedBody.tool_choice) {
		openaiBody.tool_choice = parsedBody.tool_choice;
	}

	if (Array.isArray(parsedBody.stop_sequences) && parsedBody.stop_sequences.length > 0) {
		openaiBody.stop = parsedBody.stop_sequences;
	}

	return openaiBody;
};

const transformOpenAIStreamToAnthropic = (res, originalModel, openaiStream, usageMeta) => {
	let msgId = null;
	let textBlockOpen = false;
	let textBlockIndex = -1;
	let toolCallIndexMap = {};
	let nextBlockIndex = 0;
	let buffer = '';
	let streamPromptTokens = 0;
	let streamCompletionTokens = 0;
	let streamCacheReadTokens = 0;
	let finishMessageDeltaSent = false;
	let thinkingBlockOpen = false;
	let thinkingBlockIndex = -1;
	let textBlockDeferred = false;

	const writeSSE = (event, data) => {
		const eventLine = event ? `event: ${event}\n` : '';
		const dataLine = `data: ${JSON.stringify(data)}\n\n`;
		const sseText = eventLine + dataLine;
		if (usageMeta && usageMeta.interactionId) {
			logClientStage('claudecode', usageMeta.interactionId, '3', 'response', sseText);
			logClientStage('claudecode', usageMeta.interactionId, '4', 'result', sseText);
		}
		res.write(sseText);
	};

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	const processChunk = (chunk) => {
		buffer += chunk.toString();

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) {
				continue;
			}

			const dataStr = line.substring(6).trim();
			if (dataStr === '[DONE]') {
				// 未关闭的 thinking 块先关闭
				if (thinkingBlockOpen) {
					writeSSE('content_block_delta', {
						type: 'content_block_delta',
						index: thinkingBlockIndex,
						delta: { type: 'signature_delta', signature: msgId || '' }
					});
					writeSSE('content_block_stop', { type: 'content_block_stop', index: thinkingBlockIndex });
					thinkingBlockOpen = false;
				}

				if (textBlockOpen) {
					writeSSE('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
					textBlockOpen = false;
				}

				// 避免在 finish_reason 已经发送过 message_delta 的情况下重复发送
				// 否则会触发 Claude Code 客户端的流式解析异常与降级重试
				if (!finishMessageDeltaSent) {
					writeSSE('message_delta', {
						type: 'message_delta',
						delta: { stop_reason: 'end_turn', stop_sequence: null },
						usage: { output_tokens: 0 },
					});
				}
				writeSSE('message_stop', { type: 'message_stop' });
				if (usageMeta && (streamPromptTokens > 0 || streamCompletionTokens > 0)) {
					recordUsage(usageMeta.providerName || 'openai', usageMeta.targetModel, {
						input_tokens: streamPromptTokens,
						output_tokens: streamCompletionTokens,
						cache_read_tokens: streamCacheReadTokens,
					}, usageMeta.clientSource || 'claudecode');
				}
				return;
			}

			let parsed;
			try {
				parsed = JSON.parse(dataStr);
			}
			catch (e) {
				continue;
			}

			if (!msgId) {
				msgId = parsed.id || `msg_${Date.now()}`;
				writeSSE('message_start', {
					type: 'message_start',
					message: {
						id: msgId,
						type: 'message',
						role: 'assistant',
						model: originalModel,
						usage: { input_tokens: 0 },
					},
				});
			}

			if (parsed.usage) {
				streamPromptTokens = parsed.usage.prompt_tokens || 0;
				streamCompletionTokens = parsed.usage.completion_tokens || 0;
				streamCacheReadTokens = parsed.usage.prompt_tokens_details?.cached_tokens || 0;
			}
				const choices = parsed.choices || [];
			for (const choice of choices) {
				const delta = choice.delta || {};

				// 空 content（如 Kimi 的预热信号 ""）不应创建 content_block，否则会在 idx=0 留下幽灵 text 块
				if (delta.content !== undefined && delta.content !== null && delta.content.length > 0) {
					// 收到 text 之前如有 thinking 未关闭：先关 thinking，让 Anthropic 看到正确顺序
					if (thinkingBlockOpen) {
						writeSSE('content_block_delta', {
							type: 'content_block_delta',
							index: thinkingBlockIndex,
							delta: { type: 'signature_delta', signature: msgId || '' }
						});
						writeSSE('content_block_stop', { type: 'content_block_stop', index: thinkingBlockIndex });
						thinkingBlockOpen = false;
					}

					// text 块曾被推迟（reasoning 抢先于 content 到达）：重新打开 text 块
					if (textBlockDeferred) {
						textBlockIndex = nextBlockIndex;
						nextBlockIndex++;
						textBlockOpen = true;
						textBlockDeferred = false;
						writeSSE('content_block_start', {
							type: 'content_block_start',
							index: textBlockIndex,
							content_block: { type: 'text', text: '' },
						});
					}
					else if (!textBlockOpen) {
						textBlockIndex = nextBlockIndex;
						nextBlockIndex++;
						textBlockOpen = true;
						writeSSE('content_block_start', {
							type: 'content_block_start',
							index: textBlockIndex,
							content_block: { type: 'text', text: '' },
						});
					}
					writeSSE('content_block_delta', {
						type: 'content_block_delta',
						index: textBlockIndex,
						delta: { type: 'text_delta', text: delta.content },
					});
				}

				// 聚合上游 reasoning_content：Kimi 等 provider 逐词推送，
				// 需要收拢到单个 thinking block 中，避免 80+ 个碎片触发 Claude Code 解析异常
				if (delta.reasoning_content) {
					// thinking 开始前，如果 text 块已被打开（Kimi 先发空 content），先关掉让它让路
					if (textBlockOpen) {
						writeSSE('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
						textBlockOpen = false;
						textBlockDeferred = true;
					}

					// 首次遇到 reasoning：打开聚合 thinking 块（后续 delta 往里追加，不关闭）
					if (!thinkingBlockOpen) {
						thinkingBlockIndex = nextBlockIndex;
						nextBlockIndex++;
						writeSSE('content_block_start', {
							type: 'content_block_start',
							index: thinkingBlockIndex,
							content_block: { type: 'thinking', thinking: '', signature: msgId || '' },
						});
						thinkingBlockOpen = true;
					}

					writeSSE('content_block_delta', {
						type: 'content_block_delta',
						index: thinkingBlockIndex,
						delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
					});
				}

				if (Array.isArray(delta.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const openaiIdx = tc.index !== undefined ? tc.index : 0;
						let anthropicIdx;

						if (tc.id) {
							if (toolCallIndexMap[openaiIdx] === undefined) {
								anthropicIdx = nextBlockIndex;
								nextBlockIndex++;
								toolCallIndexMap[openaiIdx] = anthropicIdx;
							}
							else {
								anthropicIdx = toolCallIndexMap[openaiIdx];
							}

							writeSSE('content_block_start', {
								type: 'content_block_start',
								index: anthropicIdx,
								content_block: {
									type: 'tool_use',
									id: tc.id,
									name: tc.function ? tc.function.name : '',
									input: {},
								},
							});
						}
						else {
							anthropicIdx = toolCallIndexMap[openaiIdx] !== undefined
								? toolCallIndexMap[openaiIdx]
								: nextBlockIndex - 1;
						}

						const args = tc.function && tc.function.arguments;
						if (args) {
							writeSSE('content_block_delta', {
								type: 'content_block_delta',
								index: anthropicIdx,
								delta: { type: 'input_json_delta', partial_json: args },
							});
						}
					}
				}

				if (choice.finish_reason && choice.finish_reason !== null) {
					// 未关闭的 thinking 块先关闭（Kimi reasoning 逐词推送时 thinking 可能仍开着）
					if (thinkingBlockOpen) {
						writeSSE('content_block_delta', {
							type: 'content_block_delta',
							index: thinkingBlockIndex,
							delta: { type: 'signature_delta', signature: msgId || '' }
						});
						writeSSE('content_block_stop', { type: 'content_block_stop', index: thinkingBlockIndex });
						thinkingBlockOpen = false;
					}

					if (textBlockOpen) {
						writeSSE('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
						textBlockOpen = false;
					}

					for (const oaiIdx of Object.keys(toolCallIndexMap)) {
						const aIdx = toolCallIndexMap[oaiIdx];
						writeSSE('content_block_stop', { type: 'content_block_stop', index: aIdx });
					}

					const stopReasonMap = {
						'stop': 'end_turn',
						'length': 'max_tokens',
						'tool_calls': 'tool_use',
						'content_filter': 'end_turn',
					};
					const stopReason = stopReasonMap[choice.finish_reason] || 'end_turn';

					const usage = parsed.usage ? {
						input_tokens: parsed.usage.prompt_tokens || 0,
						output_tokens: parsed.usage.completion_tokens || 0,
					} : { output_tokens: 0 };

					writeSSE('message_delta', {
						type: 'message_delta',
						delta: { stop_reason: stopReason, stop_sequence: null },
						usage,
					});
					finishMessageDeltaSent = true;
				}
			}
		}
	};

	openaiStream.on('data', processChunk);
	openaiStream.on('end', () => {
		if (buffer.trim()) {
			processChunk(Buffer.from('\n'));
		}
		res.end();
	});
	openaiStream.on('error', (e) => {
		log('error', `OpenAI stream error: ${e.message}`);
		res.end();
	});
};

const transformOpenAIToAnthropic = (openaiResp, originalModel) => {
	const choice = (openaiResp.choices || [])[0] || {};
	const message = choice.message || {};

	const content = [];

	// thinking 块必须排在 text 之前，符合 Anthropic Messages API 规范
	// 否则 Claude Code 的 UI 渲染层会因顺序错乱而陷入死等
	// 透传上游 reasoning_content：无论调用方是谁，都必须把思考内容原样给到调用方
	if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
		content.push({
			type: 'thinking',
			thinking: message.reasoning_content,
			signature: openaiResp.id ? `openai:${openaiResp.id}` : '',
		});
	}

	if (message.content) {
		content.push({ type: 'text', text: message.content });
	}

	if (Array.isArray(message.tool_calls)) {
		for (const tc of message.tool_calls) {
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
			content.push({
				type: 'tool_use',
				id: tc.id || `tool_${content.length}`,
				name: tc.function ? tc.function.name : '',
				input,
			});
		}
	}

	if (content.length === 0) {
		content.push({ type: 'text', text: '' });
	}

	const stopReasonMap = {
		'stop': 'end_turn',
		'length': 'max_tokens',
		'tool_calls': 'tool_use',
	};
	const stopReason = stopReasonMap[choice.finish_reason] || 'end_turn';

	return {
		id: openaiResp.id || `msg_${Date.now()}`,
		type: 'message',
		role: 'assistant',
		model: originalModel,
		content,
		stop_reason: stopReason,
		stop_sequence: null,
		usage: openaiResp.usage ? {
			input_tokens: openaiResp.usage.prompt_tokens || 0,
			output_tokens: openaiResp.usage.completion_tokens || 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: openaiResp.usage.prompt_tokens_details?.cached_tokens || 0,
		} : undefined,
	};
};

const handleOpenAIRequest = (provider, targetModel, originalModel, req, body, res, onComplete) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};

	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		if (onComplete) {
			onComplete(new Error('Invalid JSON'));
		}
		else {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
		}
		return;
	}

	log('debug', `[OpenAI] Request from CC: stream=${parsedBody.stream}, tools=${(parsedBody.tools || []).length}, messages=${(parsedBody.messages || []).length}`);
	const openaiBody = buildOpenAIRequest(parsedBody);
	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);

	const reqBody = JSON.stringify(openaiBody);
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

	log('debug', `[OpenAI] POST ${options.hostname}${options.path}`);
	if (req && req.interactionId) {
		try {
			logClientStage('claudecode', req.interactionId, '2', 'upstream', openaiBody);
		} catch (e) {
			logClientStage('claudecode', req.interactionId, '2', 'upstream', openaiBody);
		}
	}
	log('debug', `[OpenAI] Request body: ${reqBody.substring(0, 1000)}`);

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			return;
		}
		settled = true;
		if (err) {
			settleKey({ isProviderDown: true });
			log('error', `OpenAI upstream error: ${err.message}`);
			if (onComplete) {
				onComplete(err);
			}
			else {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
			}
			return;
		}

		if (!proxyRes) {
			return;
		}

		log('debug', `[OpenAI] Response: status=${proxyRes.statusCode}`);
		if (parsedBody.stream) {
			log('debug', '[OpenAI] Streaming response');
			let firstSseChecked = false;
			proxyRes.on('data', (chunk) => {
				if (!firstSseChecked) {
					firstSseChecked = true;
					const sseResult = classifyStreamFirstBlock(chunk.toString('utf8'));
					if (sseResult.isKeyFailure) { settleKey({ isKeyFailure: true }); }
				}
			});
			proxyRes.on('error', (e) => {
				settleKey({ isProviderDown: true });
				log('error', `[OpenAI] Stream upstream error: ${e.message}`);
			});
			transformOpenAIStreamToAnthropic(res, originalModel, proxyRes, { providerName: provider._name, targetModel, interactionId: req && req.interactionId });
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
				if (proxyRes.statusCode >= 400) {
					const cr = classifyResponse(proxyRes.statusCode, responseBody);
					settleKey({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
					if (onComplete) {
						onComplete(new Error(`API error: ${proxyRes.statusCode}`));
					}
					else {
						res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
						res.end(responseBody);
					}
					return;
				}

				try {
					const openaiResp = JSON.parse(responseBody);
					if (req && req.interactionId) {
						logClientStage('claudecode', req.interactionId, '3', 'response', openaiResp);
					}
					const anthropicResp = transformOpenAIToAnthropic(openaiResp, originalModel);
					if (req && req.interactionId) {
						logClientStage('claudecode', req.interactionId, '4', 'result', anthropicResp);
					}
					// 记录用量
					if (openaiResp.usage) {
						const usage = {
							input_tokens: openaiResp.usage.prompt_tokens || 0,
							output_tokens: openaiResp.usage.completion_tokens || 0,
							cache_read_tokens: openaiResp.usage.prompt_tokens_details?.cached_tokens || 0,
						};
						recordUsage(provider._name || targetModel, targetModel, usage, req && req.clientSource ? req.clientSource : 'claudecode');
					}
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(anthropicResp));
					settleKey({ isSuccess: true });
					if (onComplete) {
						onComplete(null);
					}
				}
				catch (e) {
					settleKey({ isKeyFailure: true });
					log('warn', `Failed to transform OpenAI response: ${e.message}`);
					if (onComplete) {
						onComplete(e);
					}
					else {
						res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
						res.end(responseBody);
					}
				}
			});
			proxyRes.on('error', (e) => {
				settleKey({ isProviderDown: true });
				log('error', `OpenAI response stream error: ${e.message}`);
			});
		}
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		once(err, proxyRes);
	});

	proxyReq.setTimeout(300000);
	proxyReq.on("timeout", () => {
		settleKey({ isProviderDown: true });
		proxyReq.destroy();
		once(new Error("Upstream timeout"), null);
	});
};

module.exports = { handleOpenAIRequest, buildOpenAIRequest, transformOpenAIToAnthropic };
