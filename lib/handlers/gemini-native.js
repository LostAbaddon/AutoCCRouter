const { log, getNextInteractionId, logClientStage } = require('../logger');
const { proxyRequest } = require('../proxy-agent');
const { recordUsage } = require('../usage-tracker');
const { resolveMaxTokens } = require('../config');
const { mapModel } = require('../model-mapper');
const { getSession, setSession, getCachedMode, deriveSessionKey } = require('../session-store');
const { classifyTopic } = require('../classifier');
const { convertAnthropicToGemini } = require('../providers/gemini');
const { buildOpenAIRequest } = require('../providers/openai-compat');

// 从 Gemini 请求 Body 中提取模型名（从 URL 中）
const extractModelFromGeminiURL = (url) => {
	const match = url.match(/\/models\/([^:]+):/);
	return match ? match[1] : null;
};

// 过滤逐跳头（hop-by-hop headers），这些头是代理↔上游之间的协商结果，不应转发给客户端
const hopByHopHeaders = new Set([
	'transfer-encoding', 'connection', 'keep-alive',
	'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'upgrade',
]);

const filterHopByHopHeaders = (headers) => {
	const filtered = {};
	for (const key of Object.keys(headers)) {
		if (!hopByHopHeaders.has(key.toLowerCase())) {
			filtered[key] = headers[key];
		}
	}
	return filtered;
};

// 构建新的 Gemini URL（替换模型名）
const buildGeminiURL = (originalUrl, newModel) => {
	return originalUrl.replace(/\/models\/([^:]+):/, `/models/${newModel}:`);
};

// Gemini 请求 → Anthropic 请求
const convertGeminiRequestToAnthropic = (geminiBody, modelName) => {
	const anthropicBody = {
		model: modelName,
		messages: [],
		stream: false,
	};

	// System instruction
	if (geminiBody.systemInstruction && geminiBody.systemInstruction.parts) {
		const systemText = geminiBody.systemInstruction.parts
			.filter((p) => p.text)
			.map((p) => p.text)
			.join('\n');
		if (systemText) {
			anthropicBody.system = systemText;
		}
	}

	let toolUseSeq = 0;

	const gemToAnthId = new Map(); // Gemini functionCall id/name → new Anthropic tool_use id

	// Contents → messages
	if (Array.isArray(geminiBody.contents)) {
		for (const item of geminiBody.contents) {
			const role = item.role === 'model' ? 'assistant' : 'user';
			const content = [];

			if (Array.isArray(item.parts)) {
				for (const part of item.parts) {
					if (part.text) {
						content.push({ type: 'text', text: part.text });
					}
					else if (part.functionCall) {
						// 只在 assistant (model) 消息中转 tool_use；user 消息中的回传 echo 忽略
						if (role === 'assistant') {
							const anthId = `toolu_gem_${toolUseSeq++}`;
							// Map both id and name so functionResponse can find the match
							if (part.functionCall.id) {
								gemToAnthId.set(part.functionCall.id, anthId);
							}
							if (part.functionCall.name) {
								gemToAnthId.set('name:' + part.functionCall.name, anthId);
							}
							content.push({
								type: 'tool_use',
								id: anthId,
								name: part.functionCall.name,
								input: part.functionCall.args || {},
							});
						}
					}
					else if (part.functionResponse) {
						const resultContent = part.functionResponse.response
							&& typeof part.functionResponse.response.content === 'string'
							? part.functionResponse.response.content
							: JSON.stringify(part.functionResponse.response || {});
						const fnId = part.functionResponse.id;
						const fnName = part.functionResponse.name;
						// Try to find matching tool_use id for proper tool_result
						let toolUseId = null;
						if (fnId && gemToAnthId.has(fnId)) {
							toolUseId = gemToAnthId.get(fnId);
						}
						else if (fnName && gemToAnthId.has('name:' + fnName)) {
							toolUseId = gemToAnthId.get('name:' + fnName);
						}
						if (toolUseId) {
							content.push({
								type: 'tool_result',
								tool_use_id: toolUseId,
								content: [{ type: 'text', text: resultContent }],
							});
						}
						else {
							// Fallback: no matching tool_use found, use text
							content.push({
								type: 'text',
								text: `[Tool result: ${fnName || fnId || 'tool'}]\n${resultContent}`,
							});
						}
					}
					else if (part.inlineData) {
						content.push({
							type: 'image',
							source: {
								type: 'base64',
								media_type: part.inlineData.mimeType || 'image/png',
								data: part.inlineData.data,
							},
						});
					}
				}
			}

			if (content.length === 0) {
				continue;
			}
			// assistant 消息中如果有 tool_use，所有 text 转为 thinking（仅 DeepSeek 要求）
			if (role === 'assistant' && content.some((c) => c.type === 'tool_use') && modelName && modelName.includes('deepseek')) {
				for (let ci = 0; ci < content.length; ci++) {
					if (content[ci].type === 'text') {
						content[ci] = {
							type: 'thinking',
							thinking: content[ci].text,
							signature: '',
						};
					}
				}
			}
			anthropicBody.messages.push({ role, content });
		}
	}

	// Tools — filter Gemini built-in tools, keeping only convertible ones
	if (Array.isArray(geminiBody.tools)) {
		const allDeclarations = [];
		for (const tool of geminiBody.tools) {
			// Custom function declarations — pass through as-is
			if (Array.isArray(tool.functionDeclarations)) {
				for (const fd of tool.functionDeclarations) {
					allDeclarations.push({
						name: fd.name,
						description: fd.description || '',
						input_schema: fd.parameters || { type: 'object', properties: {} },
					});
				}
			}
			// Gemini built-in: Google Search → Anthropic function declaration
			else if (tool.googleSearch || tool.google_search) {
				allDeclarations.push({
					name: 'google_search',
					description: 'Search the web using Google Search. Returns relevant results for the given query.',
					input_schema: {
						type: 'object',
						properties: {
							query: { type: 'string', description: 'The search query' },
						},
						required: ['query'],
					},
				});
			}
			// Gemini built-in: URL Context / Web Fetch → Anthropic function declaration
			else if (tool.urlContext || tool.url_context) {
				allDeclarations.push({
					name: 'web_fetch',
					description: 'Fetch and read content from a URL. Returns the text content of the web page.',
					input_schema: {
						type: 'object',
						properties: {
							url: { type: 'string', description: 'The URL to fetch' },
						},
						required: ['url'],
					},
				});
			}
			// Other Gemini built-in tools (codeExecution, browser, etc.) — skip
		}
		if (allDeclarations.length > 0) {
			anthropicBody.tools = allDeclarations;
		}
	}

	// Generation config
	if (geminiBody.generationConfig) {
		const gc = geminiBody.generationConfig;
		if (gc.maxOutputTokens) {
			anthropicBody.max_tokens = gc.maxOutputTokens;
		}
		if (gc.temperature !== undefined) {
			anthropicBody.temperature = gc.temperature;
		}
		if (gc.topP !== undefined) {
			anthropicBody.top_p = gc.topP;
		}
	}

	return anthropicBody;
};

// Anthropic 非流式响应 → Gemini 响应
const transformAnthropicToGeminiResponse = (anthropicResp, modelName) => {
	const content = anthropicResp.content || [];
	const parts = [];

	for (const block of content) {
		if (block.type === 'text' && block.text) {
			parts.push({ text: block.text });
		}
		else if (block.type === 'tool_use') {
			const fc = {
				functionCall: {
					name: block.name,
					args: block.input || {},
				},
			};
			if (block.id) {
				fc.functionCall.id = block.id;
			}
			parts.push(fc);
		}
	}

	if (parts.length === 0) {
		parts.push({ text: '' });
	}

	const stopReasonMap = {
		'end_turn': 'STOP',
		'max_tokens': 'MAX_TOKENS',
		'tool_use': 'STOP',
		'stop_sequence': 'STOP',
	};

	return {
		candidates: [{
			content: {
				role: 'model',
				parts,
			},
			finishReason: stopReasonMap[anthropicResp.stop_reason] || 'STOP',
		}],
		usageMetadata: anthropicResp.usage ? {
			promptTokenCount: anthropicResp.usage.input_tokens || 0,
			candidatesTokenCount: anthropicResp.usage.output_tokens || 0,
			totalTokenCount: (anthropicResp.usage.input_tokens || 0) + (anthropicResp.usage.output_tokens || 0),
		} : undefined,
		modelVersion: modelName,
	};
};

// Anthropic SSE 流 → Gemini SSE 流
const transformAnthropicStreamToGemini = (res, originalModel, anthropicStream, usageMeta) => {
	let textContent = '';
	let streamInputTokens = 0;
	let streamOutputTokens = 0;
	let done = false;

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	const writeSSE = (data) => {
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	let buffer = '';
	let sseEventCount = 0;
	let sseDataLineCount = 0;

	// thinking 流式解析状态
	let activeThinkingIdx = -1;
	let activeThinkingSignature = '';
	let activeThinkingText = '';

	// tool_use 流式解析状态
	let activeToolIdx = -1;
	let activeToolName = '';
	let activeToolId = '';
	let activeToolJson = '';
	const emittedToolParts = []; // 已发出的 Gemini parts(含 text 和 functionCall)

	anthropicStream.on('data', (chunk) => {
		buffer += chunk.toString();

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.startsWith('data: ')) {
				if (line.startsWith('event: ')) {
					sseEventCount++;
				}
				continue;
			}

			sseDataLineCount++;
			const jsonStr = line.substring(6);
			let parsed;
			try {
				parsed = JSON.parse(jsonStr);
			}
			catch (e) {
				continue;
			}

			if (parsed.type === 'message_start') {
				if (parsed.message && parsed.message.usage) {
					streamInputTokens = parsed.message.usage.input_tokens || 0;
				}
			}
			else if (parsed.type === 'content_block_start') {
				const block = parsed.content_block;
				if (block && block.type === 'thinking') {
					activeThinkingIdx = parsed.index;
					activeThinkingSignature = block.signature || '';
					activeThinkingText = '';

				}
				else if (block && block.type === 'tool_use') {
					activeToolIdx = parsed.index;
					activeToolName = block.name || '';
					activeToolId = block.id || '';
					activeToolJson = '';
				}
			}
			else if (parsed.type === 'content_block_delta') {
				const delta = parsed.delta;
				if (!delta) {
					continue;
				}
				if (delta.type === 'thinking_delta' && parsed.index === activeThinkingIdx) {
					const t = delta.thinking || '';
					activeThinkingText += t;
					textContent += t;
					writeSSE({
						candidates: [{
							content: {
								role: 'model',
								parts: [{ text: t }],
							},
						}],
					});
				}
				else if (delta.type === 'text_delta' && delta.text) {
					textContent += delta.text;
					writeSSE({
						candidates: [{
							content: {
								role: 'model',
								parts: [{ text: delta.text }],
							},
						}],
					});
				}
				else if (delta.type === 'input_json_delta' && parsed.index === activeToolIdx) {
					activeToolJson += delta.partial_json || '';
				}
			}
			else if (parsed.type === 'content_block_stop') {
				if (parsed.index === activeThinkingIdx && activeThinkingIdx >= 0) {
				// thinking 块完成，存入 thoughtSignatures 供下一轮请求还原
				if (activeThinkingSignature && activeThinkingText) {
					// thinking preserved for potential future use
				}
				activeThinkingIdx = -1;
				activeThinkingSignature = '';
				activeThinkingText = '';
			}
			else if (parsed.index === activeToolIdx && activeToolIdx >= 0) {
					// tool_use 块完成，解析参数并发出 functionCall
					let args = {};
					if (activeToolJson) {
						try {
							args = JSON.parse(activeToolJson);
						}
						catch (e) {
							args = { _raw: activeToolJson };
						}
					}
					const fc = { functionCall: { name: activeToolName, args } };
					if (activeToolId) {
						fc.functionCall.id = activeToolId;
					}
					emittedToolParts.push(fc);
					writeSSE({
						candidates: [{
							content: { role: 'model', parts: [fc] },
						}],
					});
					// 重置
					activeToolIdx = -1;
					activeToolName = '';
					activeToolId = '';
					activeToolJson = '';
				}
			}
			else if (parsed.type === 'message_delta') {
				if (parsed.usage) {
					streamOutputTokens = parsed.usage.output_tokens || 0;
				}
			}
			else if (parsed.type === 'message_stop') {
				done = true;
				if (usageMeta && (streamInputTokens > 0 || streamOutputTokens > 0)) {
					recordUsage(usageMeta.providerName || 'gemini', usageMeta.targetModel, {
						input_tokens: streamInputTokens,
						output_tokens: streamOutputTokens,
					}, 'gemini');
				}
			}
		}
	});

	anthropicStream.on('end', () => {
		log('debug', `[Gemini-Native] Stream ended: done=${done}, textLen=${textContent.length}, toolParts=${emittedToolParts.length}, dataLines=${sseDataLineCount}, events=${sseEventCount}`);

		// 最终 SSE 只发 finishReason + usage，不重复内容（已通过增量 SSE 事件发出）
		writeSSE({
			candidates: [{
				content: { role: 'model', parts: [{ text: '' }] },
				finishReason: 'STOP',
			}],
			usageMetadata: {
				promptTokenCount: streamInputTokens,
				candidatesTokenCount: streamOutputTokens,
				totalTokenCount: streamInputTokens + streamOutputTokens,
			},
		});
		res.end();
	});

	anthropicStream.on('error', (e) => {
		log('error', `[Gemini-Native] Anthropic stream error: ${e.message}`);
		res.end();
	});
};

// 直接转发 Gemini 请求（Provider 也是 Gemini 类型）
const forwardGeminiDirect = (provider, targetModel, originalModel, req, body, res, isStream, interactionId) => {
	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const apiKey = provider.apiKey;
	const targetUrl = new URL(baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const action = isStream ? 'streamGenerateContent' : 'generateContent';
	const querySep = isStream ? '?alt=sse&' : '?';
	const path = `${pathPrefix}/models/${targetModel}:${action}${querySep}key=${encodeURIComponent(apiKey)}`;

	const parsedBody = JSON.parse(body);
		logClientStage('gemini', interactionId, '2', 'upstream', parsedBody);
	const reqBody = JSON.stringify(parsedBody);

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

	log('debug', `[Gemini-Native] Direct POST ${options.hostname}${options.path}`);

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: err.message, code: 502 } }));
			return;
		}

		const responseHeaders = filterHopByHopHeaders(proxyRes.headers);

		if (isStream) {
			// 流式请求：实时透传 SSE 事件，不做缓冲
			res.writeHead(proxyRes.statusCode, responseHeaders);

			let sseBuffer = '';
			let usageData = null;

			proxyRes.on('data', (chunk) => {
				res.write(chunk);

				// 从 SSE 流中提取 usageMetadata
				sseBuffer += chunk.toString();
				const lines = sseBuffer.split('\n');
				sseBuffer = lines.pop() || '';
				for (const line of lines) {
					if (line.startsWith('data: ')) {
						try {
							const parsed = JSON.parse(line.substring(6));
							if (parsed.usageMetadata) {
								usageData = parsed.usageMetadata;
							}
						}
						catch (_) {}
					}
				}
			});

			proxyRes.on('end', () => {
				// 处理最后一行可能未完整接收的数据
				if (sseBuffer && sseBuffer.startsWith('data: ')) {
					try {
						const parsed = JSON.parse(sseBuffer.substring(6));
						if (parsed.usageMetadata) {
							usageData = parsed.usageMetadata;
						}
					}
					catch (_) {}
				}

				res.end();

				if (usageData) {
					recordUsage(provider._name || 'gemini', targetModel, {
						input_tokens: usageData.promptTokenCount || 0,
						output_tokens: usageData.candidatesTokenCount || 0,
					}, 'gemini');
				}
				logClientStage('gemini', interactionId, '3', 'response', { stream: true, usage: usageData });
				logClientStage('gemini', interactionId, '4', 'result', { stream: true, usage: usageData });
			});

			proxyRes.on('error', (e) => {
				log('error', `[Gemini-Native] Stream response error: ${e.message}`);
				res.end();
			});
		}
		else {
			// 非流式请求：缓冲完整 JSON 响应
			res.writeHead(proxyRes.statusCode, responseHeaders);
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				res.end(responseBody);
				try {
					const resp = JSON.parse(responseBody);
					logClientStage('gemini', interactionId, '3', 'response', resp);
					logClientStage('gemini', interactionId, '4', 'result', resp);
					if (resp.usageMetadata) {
						recordUsage(provider._name || 'gemini', targetModel, {
							input_tokens: resp.usageMetadata.promptTokenCount || 0,
							output_tokens: resp.usageMetadata.candidatesTokenCount || 0,
						}, 'gemini');
					}
				}
				catch (e) {
					logClientStage('gemini', interactionId, '3', 'response', responseBody);
					logClientStage('gemini', interactionId, '4', 'result', responseBody);
				}
			});
			proxyRes.on('error', (e) => {
				log('error', `[Gemini-Native] Response error: ${e.message}`);
			});
		}
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		res.writeHead(504, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Upstream timeout', code: 504 } }));
	});
};

// Gemini → Anthropic Provider
const forwardGeminiViaAnthropic = (provider, targetModel, originalModel, req, body, res, isStream, interactionId) => {
	let geminiBody;
	try {
		geminiBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Invalid JSON', code: 400 } }));
		return;
	}

	const anthropicBody = convertGeminiRequestToAnthropic(geminiBody, targetModel);
	anthropicBody.stream = isStream || false;

	// Default max_tokens for Anthropic API
	if (!anthropicBody.max_tokens) {
		anthropicBody.max_tokens = 131072;
	}

	const targetUrl = new URL(provider.baseUrl);
	const reqPath = targetUrl.pathname.replace(/\/+$/, '') + '/v1/messages';
	const reqBody = JSON.stringify(anthropicBody);

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: reqPath,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': provider.apiKey,
			'anthropic-version': '2023-06-01',
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	log('debug', `[Gemini-Native] Anthropic POST ${options.hostname}${options.path}`);

	logClientStage('gemini', interactionId, '2', 'upstream', anthropicBody);

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: err.message, code: 502 } }));
			return;
		}

		// 根据上游实际响应的 Content-Type 判断是否为流式，而非仅凭请求 URL
		const upstreamContentType = proxyRes.headers['content-type'] || '';
		const upstreamIsStream = upstreamContentType.includes('text/event-stream');
		log('debug', `[Gemini-Native] upstream Content-Type: "${upstreamContentType}", isStream=${isStream}, upstreamIsStream=${upstreamIsStream}`);

		if (isStream && upstreamIsStream) {
			transformAnthropicStreamToGemini(res, originalModel, proxyRes, { interactionId,
				providerName: provider._name,
				targetModel,
				interactionId,
			});
		}
		else {
			// 上游返回非流式 JSON（或请求就是非流式）：读全量 body 后一次性转换
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				try {
					const anthropicResp = JSON.parse(responseBody);
					log('debug', `[Gemini-Native] Anthropic response (${responseBody.length}b): ${responseBody.substring(0, 400)}`);
					logClientStage('gemini', interactionId, '3', 'response', anthropicResp);
					if (anthropicResp.error) {
						res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: { message: anthropicResp.error.message, code: proxyRes.statusCode } }));
						return;
					}
					const geminiResp = transformAnthropicToGeminiResponse(anthropicResp, originalModel);
					logClientStage('gemini', interactionId, '4', 'result', geminiResp);
					const geminiJson = JSON.stringify(geminiResp);
					log('debug', `[Gemini-Native] Gemini response (${geminiJson.length}b): ${geminiJson.substring(0, 400)}`);
					if (anthropicResp.usage) {
						recordUsage(provider._name || 'anthropic', targetModel, {
							input_tokens: anthropicResp.usage.input_tokens || 0,
							output_tokens: anthropicResp.usage.output_tokens || 0,
						}, 'gemini');
					}

					// 如果客户端发的是流式请求但上游返回了 JSON，用 SSE 格式包裹返回
					if (isStream) {
						log('debug', '[Gemini-Native] Wrapping non-streamed response as SSE for streaming client');
						const ssePayload = `data: ${geminiJson}\n\n`;
						log('debug', `[Gemini-Native] SSE payload (${ssePayload.length}b): ${ssePayload.substring(0, 300)}`);
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						res.write(ssePayload);
						res.end();
						log('debug', '[Gemini-Native] SSE response sent and ended');
					}
					else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(geminiJson);
					}
				}
				catch (e) {
					log('warn', `[Gemini-Native] Transform error: ${e.message}`);
					res.writeHead(proxyRes.statusCode, filterHopByHopHeaders(proxyRes.headers));
					res.end(responseBody);
				}
			});
		}

		proxyRes.on('error', (e) => {
			log('error', `[Gemini-Native] Response error: ${e.message}`);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		res.writeHead(504, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Upstream timeout', code: 504 } }));
	});
};

// Gemini → OpenAI Provider (via Anthropic intermediate)
const forwardGeminiViaOpenAI = (provider, targetModel, originalModel, req, body, res, isStream, interactionId) => {
	let geminiBody;
	try {
		geminiBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Invalid JSON', code: 400 } }));
		return;
	}

	// Gemini → Anthropic → OpenAI
	const anthropicBody = convertGeminiRequestToAnthropic(geminiBody, targetModel);
	anthropicBody.stream = isStream || false;
	const openaiBody = buildOpenAIRequest(anthropicBody);

	openaiBody.model = targetModel;

	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);
	const reqPath = targetUrl.pathname + '/chat/completions';
	const reqBody = JSON.stringify(openaiBody);

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: reqPath,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${provider.apiKey}`,
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	log('debug', `[Gemini-Native] OpenAI POST ${options.hostname}${options.path}`);

	logClientStage('gemini', interactionId, '2', 'upstream', openaiBody);

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) {
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: err.message, code: 502 } }));
			return;
		}

		// 根据上游实际响应的 Content-Type 判断是否为流式
		const upstreamIsStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (isStream && upstreamIsStream) {
			transformOpenAIStreamToGemini(res, originalModel, proxyRes);
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				try {
					const openaiResp = JSON.parse(responseBody);
					logClientStage('gemini', interactionId, '3', 'response', openaiResp);
					const geminiResp = transformOpenAIToGeminiResponse(openaiResp, originalModel);
					logClientStage('gemini', interactionId, '4', 'result', geminiResp);
					if (openaiResp.usage) {
						recordUsage(provider._name || 'openai', targetModel, {
							input_tokens: openaiResp.usage.prompt_tokens || 0,
							output_tokens: openaiResp.usage.completion_tokens || 0,
						}, 'gemini');
					}

					// 客户端发了流式请求但上游返回 JSON → 用 SSE 包裹
					if (isStream) {
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						res.write(`data: ${JSON.stringify(geminiResp)}\n\n`);
						res.end();
					}
					else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify(geminiResp));
					}
				}
				catch (e) {
					log('warn', `[Gemini-Native] Transform error: ${e.message}`);
					res.writeHead(proxyRes.statusCode, filterHopByHopHeaders(proxyRes.headers));
					res.end(responseBody);
				}
			});
		}

		proxyRes.on('error', (e) => {
			log('error', `[Gemini-Native] Response error: ${e.message}`);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		res.writeHead(504, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Upstream timeout', code: 504 } }));
	});
};

// OpenAI 非流式响应 → Gemini 响应
const transformOpenAIToGeminiResponse = (openaiResp, modelName) => {
	const choice = (openaiResp.choices || [])[0] || {};
	const message = choice.message || {};
	const parts = [];

	if (message.content) {
		parts.push({ text: message.content });
	}

	if (Array.isArray(message.tool_calls)) {
		for (const tc of message.tool_calls) {
			let args = {};
			if (tc.function && tc.function.arguments) {
				try {
					args = typeof tc.function.arguments === 'string'
						? JSON.parse(tc.function.arguments)
						: tc.function.arguments;
				}
				catch (e) {
					args = { _raw: tc.function.arguments };
				}
			}
			parts.push({
				functionCall: {
					id: tc.id,
					name: tc.function ? tc.function.name : '',
					args,
				},
			});
		}
	}

	if (parts.length === 0) {
		parts.push({ text: '' });
	}

	const finishReasonMap = {
		'stop': 'STOP',
		'length': 'MAX_TOKENS',
		'tool_calls': 'STOP',
		'content_filter': 'SAFETY',
	};

	return {
		candidates: [{
			content: { role: 'model', parts },
			finishReason: finishReasonMap[choice.finish_reason] || 'STOP',
		}],
		usageMetadata: openaiResp.usage ? {
			promptTokenCount: openaiResp.usage.prompt_tokens || 0,
			candidatesTokenCount: openaiResp.usage.completion_tokens || 0,
			totalTokenCount: (openaiResp.usage.prompt_tokens || 0) + (openaiResp.usage.completion_tokens || 0),
		} : undefined,
		modelVersion: modelName,
	};
};

// OpenAI SSE 流 → Gemini SSE 流
const transformOpenAIStreamToGemini = (res, originalModel, openaiStream) => {
	let textContent = '';
	let streamPromptTokens = 0;
	let streamCompletionTokens = 0;
	let finishReason = 'STOP';

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	const writeSSE = (data) => {
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	let buffer = '';
	openaiStream.on('data', (chunk) => {
		buffer += chunk.toString();

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.startsWith('data: ') || line.includes('[DONE]')) {
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

			if (parsed.usage) {
				streamPromptTokens = parsed.usage.prompt_tokens || 0;
				streamCompletionTokens = parsed.usage.completion_tokens || 0;
			}

			const choices = parsed.choices || [];
			for (const choice of choices) {
				const delta = choice.delta || {};
				if (delta.content) {
					textContent += delta.content;
					writeSSE({
						candidates: [{
							content: {
								role: 'model',
								parts: [{ text: delta.content }],
							},
						}],
					});
				}

				if (choice.finish_reason) {
					const finishReasonMap = {
						'stop': 'STOP',
						'length': 'MAX_TOKENS',
						'tool_calls': 'STOP',
						'content_filter': 'SAFETY',
					};
					finishReason = finishReasonMap[choice.finish_reason] || 'STOP';
				}
			}
		}
	});

	openaiStream.on('end', () => {
		writeSSE({
			candidates: [{
				content: { role: 'model', parts: [{ text: '' }] },
				finishReason,
			}],
			usageMetadata: {
				promptTokenCount: streamPromptTokens,
				candidatesTokenCount: streamCompletionTokens,
				totalTokenCount: streamPromptTokens + streamCompletionTokens,
			},
		});
		res.end();
	});

	openaiStream.on('error', (e) => {
		log('error', `[Gemini-Native] OpenAI stream error: ${e.message}`);
		res.end();
	});
};

// 主处理函数
const handleGeminiNativeRequest = (config, req, body, res, sessionId) => {
	const originalModel = extractModelFromGeminiURL(req.url);
	if (!originalModel) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Cannot extract model from URL', code: 400 } }));
		return;
	}

	const mapped = mapModel(originalModel, config.modelMapping);
	if (!mapped) {
		log('warn', `[Gemini-Native] No mapping for model: ${originalModel}`);
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `No mapping configured for model: ${originalModel}. Add a matching prefix in modelMapping.`,
				code: 400,
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
				code: 400,
			},
		}));
		return;
	}

	const targetModel = mapped.targetModel || originalModel;
	provider._name = mapped.provider;

	// Detect stream mode from URL
	const isStream = req.url.includes('streamGenerateContent') || req.url.includes('alt=sse');
	log('info', `[Gemini-Native] ${originalModel} → ${targetModel} (${mapped.provider}, type=${provider.type}, stream=${isStream})`);

	const interactionId = getNextInteractionId();
	logClientStage('gemini', interactionId, '1', 'request', JSON.parse(body));

	// 对非 auto provider 设置 max_tokens
	if (provider.type !== 'auto') {
		const resolvedMaxTokens = resolveMaxTokens(config, provider, targetModel);
		log('debug', `[Gemini-Native] resolvedMaxTokens=${resolvedMaxTokens}`);
	}

	if (provider.type === 'auto') {
		handleGeminiAutoMode(config, provider, targetModel, originalModel, req, body, res, sessionId, isStream, interactionId);
	}
	else if (provider.type === 'gemini') {
		forwardGeminiDirect(provider, targetModel, originalModel, req, body, res, isStream, interactionId);
	}
	else if (provider.type === 'anthropic') {
		forwardGeminiViaAnthropic(provider, targetModel, originalModel, req, body, res, isStream, interactionId);
	}
	else if (provider.type === 'openai') {
		forwardGeminiViaOpenAI(provider, targetModel, originalModel, req, body, res, isStream, interactionId);
	}
	else {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `Unknown provider type: ${provider.type}`,
				code: 400,
			},
		}));
	}
};

// Auto mode for Gemini-native requests
const handleGeminiAutoMode = (config, provider, targetModel, originalModel, req, body, res, sessionId, isStream, interactionId) => {
	const agentSet = (config.agents || {})[targetModel] || (config.agents || {}).defaults || {};

	let geminiBody;
	try {
		geminiBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'Invalid JSON', code: 400 } }));
		return;
	}

	// Extract text messages for classification
	const messages = [];
	if (Array.isArray(geminiBody.contents)) {
		for (const item of geminiBody.contents) {
			const role = item.role === 'model' ? 'assistant' : 'user';
			const texts = (item.parts || []).filter((p) => p.text).map((p) => p.text);
			if (texts.length > 0) {
				messages.push({ role, content: [{ type: 'text', text: texts.join('\n') }] });
			}
		}
	}

	const sessionKey = sessionId || deriveSessionKey(messages);

	// Check if last message is user text input
	const lastMsg = messages[messages.length - 1];
	const isUserText = lastMsg && lastMsg.role === 'user';

	if (!isUserText) {
		// Continuation
		const currentMode = getSession(sessionKey) || 'default';
		const { resolveAgent } = require('../providers/auto');
		const agent = resolveAgent(config, currentMode, agentSet);
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Cannot resolve agent', code: 500 } }));
			return;
		}
		dispatchGeminiNative(config, agent.provider, agent.model, originalModel, req, body, res, isStream, interactionId);
		return;
	}

	// Use quick agent for classification
	let quickAgent = agentSet.quick;
	if (!quickAgent) {
		const { resolveAgent } = require('../providers/auto');
		const agent = resolveAgent(config, 'default', agentSet);
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'No agent configured', code: 500 } }));
			return;
		}
		dispatchGeminiNative(config, agent.provider, agent.model, originalModel, req, body, res, isStream, interactionId);
		return;
	}

	if (Array.isArray(quickAgent)) {
		quickAgent = quickAgent[Math.floor(Math.random() * quickAgent.length)];
	}

	const { parseAgentSpec } = require('../providers/auto');
	const quickSpec = parseAgentSpec(quickAgent);
	if (!quickSpec) {
		const { resolveAgent } = require('../providers/auto');
		const agent = resolveAgent(config, 'default', agentSet);
		dispatchGeminiNative(config, agent.provider, agent.model, originalModel, req, body, res, isStream, interactionId);
		return;
	}

	const quickProvider = config.providers[quickSpec.providerName];
	if (!quickProvider) {
		const { resolveAgent } = require('../providers/auto');
		const agent = resolveAgent(config, 'default', agentSet);
		dispatchGeminiNative(config, agent.provider, agent.model, originalModel, req, body, res, isStream, interactionId);
		return;
	}

	const availableModes = Object.keys(agentSet).filter((m) => m !== 'default' && m !== 'quick');
	const maxTokens = resolveMaxTokens(config, quickProvider, quickSpec.model);
	const currentMode = getSession(sessionKey) || 'default';
	const conversationGroups = config.conversationGroups != null ? config.conversationGroups : 5;

	// Check mode cache
	const modeCacheTtlSec = config.modeCacheTtl != null ? config.modeCacheTtl : 60;
	const cachedMode = getCachedMode(sessionKey, modeCacheTtlSec * 1000);
	if (cachedMode) {
		const { resolveAgent } = require('../providers/auto');
		const agent = resolveAgent(config, cachedMode, agentSet);
		if (agent) {
			dispatchGeminiNative(config, agent.provider, agent.model, originalModel, req, body, res, isStream, interactionId);
			return;
		}
	}

	// Classify
	classifyTopic(quickProvider, quickSpec.model, messages, availableModes, maxTokens, currentMode, conversationGroups, (err, result) => {
		let newMode;
		if (err || !result) {
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

		const { resolveAgent } = require('../providers/auto');
		const agent = resolveAgent(config, newMode, agentSet);
		if (!agent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { message: 'Cannot resolve agent', code: 500 } }));
			return;
		}

		log('info', `[Gemini-Native] ${originalModel} → ${agent.model} (mode=${newMode})`);
		dispatchGeminiNative(config, agent.provider, agent.model, originalModel, req, body, res, isStream, interactionId);
	});
};

// 根据 resolved provider 分发 Gemini 原生请求
const dispatchGeminiNative = (config, provider, targetModel, originalModel, req, body, res, isStream, interactionId) => {
	if (provider.type === 'gemini') {
		forwardGeminiDirect(provider, targetModel, originalModel, req, body, res, isStream, interactionId);
	}
	else if (provider.type === 'anthropic') {
		forwardGeminiViaAnthropic(provider, targetModel, originalModel, req, body, res, isStream, interactionId);
	}
	else if (provider.type === 'openai') {
		forwardGeminiViaOpenAI(provider, targetModel, originalModel, req, body, res, isStream, interactionId);
	}
	else {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			error: {
				message: `Unknown provider type: ${provider.type}`,
				code: 400,
			},
		}));
	}
};

module.exports = {
	handleGeminiNativeRequest,
	convertGeminiRequestToAnthropic,
	transformAnthropicToGeminiResponse,
	transformAnthropicStreamToGemini,
	extractModelFromGeminiURL,
};
