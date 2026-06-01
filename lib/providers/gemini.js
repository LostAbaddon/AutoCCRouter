const { log, logClientStage } = require('../logger');
const { proxyRequest } = require('../proxy-agent');
const { saveThinking } = require('../thinking-store');
const { recordUsage } = require('../usage-tracker');

const thoughtSignatures = new Map();

const GEMINI_TYPES = {
	string: 'STRING',
	number: 'NUMBER',
	integer: 'INTEGER',
	boolean: 'BOOLEAN',
	object: 'OBJECT',
	array: 'ARRAY',
};

const GEMINI_UNSUPPORTED_KEYS = new Set([
	'$schema',
	'additionalProperties',
	'propertyNames',
	'exclusiveMinimum',
	'exclusiveMaximum',
	'$id',
	'$ref',
	'definitions',
	'allOf',
	'anyOf',
	'oneOf',
	'not',
	'const',
	'contains',
	'patternProperties',
	'dependentRequired',
	'if',
	'then',
	'else',
	'unevaluatedItems',
	'unevaluatedProperties',
]);

const cleanGeminiSchema = (obj) => {
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
		return obj;
	}

	const cleaned = {};
	for (const key of Object.keys(obj)) {
		if (GEMINI_UNSUPPORTED_KEYS.has(key)) {
			continue;
		}

		const value = obj[key];
		if (key === 'type' && typeof value === 'string') {
			cleaned[key] = GEMINI_TYPES[value] || value.toUpperCase();
		}
		else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
			cleaned[key] = cleanGeminiSchema(value);
		}
		else if (Array.isArray(value)) {
			cleaned[key] = value.map((v) => cleanGeminiSchema(v));
		}
		else {
			cleaned[key] = value;
		}
	}
	return cleaned;
};

// 过滤对话历史：移除没有 thought_signature 的 tool_use 及其对应的 tool_result
// thought_signature 来源有二：1) block 自身携带 2) thoughtSignatures 内存表中查找
const filterMessagesWithoutThoughtSignature = (messages) => {
	if (!Array.isArray(messages)) {
		return messages;
	}

	// 第一遍：收集所有需要移除的 tool_use id
	const idsToRemove = new Set();
	for (const msg of messages) {
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
			continue;
		}
		for (const block of msg.content) {
			if (block.type !== 'tool_use') {
				continue;
			}
			const hasInlineSig = !!block.thought_signature;
			const hasStoredSig = thoughtSignatures.has(block.id);
			if (!hasInlineSig && !hasStoredSig) {
				idsToRemove.add(block.id);
			}
		}
	}

	if (idsToRemove.size === 0) {
		return messages;
	}

	log('debug', `[Gemini] Filtering ${idsToRemove.size} tool_use(s) without thought_signature: ${[...idsToRemove].join(', ')}`);

	// 第二遍：过滤 assistant 消息中的 tool_use，以及 user 消息中的 tool_result
	const filtered = [];
	for (const msg of messages) {
		if (!Array.isArray(msg.content)) {
			filtered.push(msg);
			continue;
		}

		if (msg.role === 'assistant') {
			const newContent = msg.content.filter((block) => {
				if (block.type === 'tool_use' && idsToRemove.has(block.id)) {
					return false;
				}
				return true;
			});
			if (newContent.length > 0) {
				filtered.push({ ...msg, content: newContent });
			}
		}
		else if (msg.role === 'user') {
			const newContent = msg.content.filter((block) => {
				if (block.type === 'tool_result' && idsToRemove.has(block.tool_use_id)) {
					return false;
				}
				return true;
			});
			if (newContent.length > 0) {
				filtered.push({ ...msg, content: newContent });
			}
		}
		else {
			filtered.push(msg);
		}
	}

	return filtered;
};

const convertAnthropicToGemini = (parsedBody) => {
	const geminiBody = {
		contents: [],
		generationConfig: {},
	};

	const messages = filterMessagesWithoutThoughtSignature(parsedBody.messages);

	if (parsedBody.system) {
		const systemText = typeof parsedBody.system === 'string'
			? parsedBody.system
			: (Array.isArray(parsedBody.system)
				? parsedBody.system.map((b) => b.text || '').join('\n')
				: '');
		geminiBody.systemInstruction = {
			parts: [{ text: systemText }],
		};
	}

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
						if (sig) {
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
				geminiBody.contents.push({ role, parts });
			}
		}
	}

	if (Array.isArray(parsedBody.tools)) {
		geminiBody.tools = [{
			functionDeclarations: parsedBody.tools.map((tool) => ({
				name: tool.name,
				description: tool.description || '',
				parameters: cleanGeminiSchema(tool.input_schema || {}),
			})),
		}];
	}

	if (parsedBody.max_tokens) {
		geminiBody.generationConfig.maxOutputTokens = parsedBody.max_tokens;
	}
	if (parsedBody.temperature !== undefined) {
		geminiBody.generationConfig.temperature = parsedBody.temperature;
	}
	if (parsedBody.top_p !== undefined) {
		geminiBody.generationConfig.topP = parsedBody.top_p;
	}

	return geminiBody;
};

const saveThoughtSignatures = (parts) => {
	for (const part of parts) {
		if (part.functionCall && part.functionCall.id && part.thoughtSignature) {
			thoughtSignatures.set(part.functionCall.id, part.thoughtSignature);
			saveThinking(part.functionCall.id, [{ type: 'thinking', thinking: '(Gemini thinking)', signature: part.thoughtSignature.substring(0, 32) }]);
			log('debug', `[Gemini] Saved thought_signature + thinking for ${part.functionCall.id}`);
		}
	}
};

const handleGeminiRequest = (provider, targetModel, originalModel, req, body, res) => {
	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
		return;
	}

	log('debug', `[Gemini] stream=${parsedBody.stream}, tools=${(parsedBody.tools || []).length}, messages=${(parsedBody.messages || []).length}`);

	const geminiBody = convertAnthropicToGemini(parsedBody);
	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const apiKey = provider.apiKey;
	const stream = parsedBody.stream;

	const targetUrl = new URL(baseUrl);
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const action = stream ? 'streamGenerateContent' : 'generateContent';
	const querySep = stream ? '?alt=sse&' : '?';
	const path = `${pathPrefix}/models/${targetModel}:${action}${querySep}key=${encodeURIComponent(apiKey)}`;

	const requestBody = JSON.stringify(geminiBody);

	log('debug', `[Gemini] POST ${targetUrl.hostname}${path}`);

		if (req && req.interactionId) {
			logClientStage('claude', req.interactionId, '2', 'upstream', geminiBody);
		}
	log('debug', `[Gemini] Request body: ${requestBody.substring(0, 1000)}`);

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: path,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Content-Length': Buffer.byteLength(requestBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	if (provider.proxy) {
		log('debug', `[Gemini] Using proxy: ${provider.proxy}`);
	}
	else {
		log('debug', '[Gemini] Direct connection (no proxy)');
	}

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			log('warn', '[Gemini] once() called after settled — ignoring');
			return;
		}
		settled = true;

		if (err) {
			log('error', `[Gemini] Connection error: ${err.message || '(no message)'}`, err.stack || '');
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message || 'Unknown error' } }));
			return;
		}

		if (!proxyRes) {
			log('error', '[Gemini] null proxyRes in once()');
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'null response' } }));
			return;
		}

		log('debug', `[Gemini] Response: status=${proxyRes.statusCode}, content-type=${proxyRes.headers['content-type']}`);

		let responseBody = '';
		proxyRes.on('data', (chunk) => {
			const str = chunk.toString();
			responseBody += str;
			log('debug', `[Gemini] chunk (${chunk.length}b): ${str.substring(0, 300)}`);
		});
		proxyRes.on('end', () => {
			log('debug', `[Gemini] Full response body (${responseBody.length}b): ${responseBody.substring(0, 2000)}`);

			if (proxyRes.statusCode >= 400) {
				log('error', `[Gemini] API error ${proxyRes.statusCode}: ${responseBody.substring(0, 500)}`);
				res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
				res.end(responseBody);
				return;
			}

			if (stream) {
				log('debug', '[Gemini] Processing streaming SSE response');

				res.writeHead(proxyRes.statusCode, {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
				});

				const lines = responseBody.split('\n');
				log('debug', `[Gemini] SSE lines total: ${lines.length}`);

				let msgId = null;
				let contentIndex = 0;
				let sentBlocks = new Set();
				let streamUsage = null;

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
						log('warn', `[Gemini] Failed to parse SSE line: ${jsonStr.substring(0, 200)}`);
						continue;
					}

					log('debug', `[Gemini] SSE event: ${JSON.stringify(parsed).substring(0, 300)}`);

					if (parsed.usageMetadata) {
						streamUsage = parsed.usageMetadata;
					}

					const candidates = parsed.candidates || [];
					for (const candidate of candidates) {
						const parts = candidate.content && candidate.content.parts || [];
						saveThoughtSignatures(parts);
					}

					if (!msgId) {
						msgId = `msg_${Date.now()}`;
						res.write(`event: message_start\ndata: ${JSON.stringify({
							type: 'message_start',
							message: {
								id: msgId,
								type: 'message',
								role: 'assistant',
								model: originalModel,
								usage: { input_tokens: 0 },
							},
						})}\n\n`);
						log('debug', '[Gemini] Sent message_start');
					}

					for (const candidate of candidates) {
						const parts = candidate.content && candidate.content.parts || [];
						for (const part of parts) {
							if (part.text) {
								if (!sentBlocks.has(0)) {
									sentBlocks.add(0);
									res.write(`event: content_block_start\ndata: ${JSON.stringify({
										type: 'content_block_start',
										index: 0,
										content_block: { type: 'text', text: '' },
									})}\n\n`);
								}
								res.write(`event: content_block_delta\ndata: ${JSON.stringify({
									type: 'content_block_delta',
									index: 0,
									delta: { type: 'text_delta', text: part.text },
								})}\n\n`);
							}
							if (part.functionCall) {
								const thinkingIdx = contentIndex;
								contentIndex++;
								const toolIdx = contentIndex;
								contentIndex++;
								const thinkingSig = part.thoughtSignature ? part.thoughtSignature.substring(0, 32) : `gemini_${Date.now()}`;
								res.write(`event: content_block_start\ndata: ${JSON.stringify({
									type: 'content_block_start',
									index: thinkingIdx,
									content_block: { type: 'thinking', thinking: '', signature: thinkingSig },
								})}\n\n`);
								res.write(`event: content_block_delta\ndata: ${JSON.stringify({
									type: 'content_block_delta',
									index: thinkingIdx,
									delta: { type: 'thinking_delta', thinking: '(Gemini thinking)' },
								})}\n\n`);
								res.write(`event: content_block_stop\ndata: ${JSON.stringify({
									type: 'content_block_stop',
									index: thinkingIdx,
								})}\n\n`);
								res.write(`event: content_block_start\ndata: ${JSON.stringify({
									type: 'content_block_start',
									index: toolIdx,
									content_block: {
										type: 'tool_use',
										id: part.functionCall.id || `tool_${toolIdx}`,
										name: part.functionCall.name,
										input: {},
									},
								})}\n\n`);
								res.write(`event: content_block_delta\ndata: ${JSON.stringify({
									type: 'content_block_delta',
									index: toolIdx,
									delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.functionCall.args || {}) },
								})}\n\n`);
								res.write(`event: content_block_stop\ndata: ${JSON.stringify({
									type: 'content_block_stop',
									index: toolIdx,
								})}\n\n`);
							}
						}
					}
				}

				if (sentBlocks.has(0)) {
					res.write(`event: content_block_stop\ndata: ${JSON.stringify({
						type: 'content_block_stop',
						index: 0,
					})}\n\n`);
				}

				res.write(`event: message_delta\ndata: ${JSON.stringify({
					type: 'message_delta',
					delta: { stop_reason: 'end_turn' },
					usage: { output_tokens: 0 },
				})}\n\n`);
				res.write(`event: message_stop\ndata: ${JSON.stringify({
					type: 'message_stop',
				})}\n\n`);
				if (streamUsage) {
					recordUsage(provider._name || 'gemini', targetModel, {
						input_tokens: streamUsage.promptTokenCount || 0,
						output_tokens: streamUsage.candidatesTokenCount || 0,
						cache_read_input_tokens: streamUsage.cachedContentTokenCount || 0,
					}, req && req.clientSource ? req.clientSource : 'claudecode');

					if (req && req.interactionId) {
						logClientStage('claude', req.interactionId, '3', 'response', { note: 'streaming-sse', promptTokens: streamUsage ? streamUsage.promptTokenCount || 0 : 0, completionTokens: streamUsage ? streamUsage.candidatesTokenCount || 0 : 0 });
						logClientStage('claude', req.interactionId, '4', 'result', { note: 'streaming-sse-to-gemini', promptTokens: streamUsage ? streamUsage.promptTokenCount || 0 : 0, completionTokens: streamUsage ? streamUsage.candidatesTokenCount || 0 : 0 });
					}
				}
				res.end();
				log('debug', '[Gemini] Stream completed and response ended');
			}
			else {
				log('debug', '[Gemini] Processing non-streaming response');
				try {
					const geminiResp = JSON.parse(responseBody);
					if (req && req.interactionId) {
						logClientStage('claude', req.interactionId, '3', 'response', geminiResp);
					}
					const candidates = geminiResp.candidates || [];
					const content = [];
					let textParts = [];

					for (const candidate of candidates) {
						const parts = candidate.content && candidate.content.parts || [];
						saveThoughtSignatures(parts);
						for (const part of parts) {
							if (part.text) {
								textParts.push(part.text);
							}
							if (part.functionCall) {
								content.push({
									type: 'tool_use',
									id: part.functionCall.id || `tool_${content.length}`,
									name: part.functionCall.name,
									input: part.functionCall.args || {},
								});
							}
						}
					}

					if (textParts.length > 0) {
						content.unshift({ type: 'text', text: textParts.join('') });
					}

					const anthropicResp = {
						id: `msg_${Date.now()}`,
						type: 'message',
						role: 'assistant',
						model: originalModel,
						content: content.length > 0 ? content : [{ type: 'text', text: '' }],
						stop_reason: 'end_turn',
						usage: {
							input_tokens: geminiResp.usageMetadata ? geminiResp.usageMetadata.promptTokenCount || 0 : 0,
							output_tokens: geminiResp.usageMetadata ? geminiResp.usageMetadata.candidatesTokenCount || 0 : 0,
						},
					};

					// 记录用量
					if (geminiResp.usageMetadata) {
						recordUsage(provider._name || 'gemini', targetModel, {
							input_tokens: geminiResp.usageMetadata.promptTokenCount || 0,
							output_tokens: geminiResp.usageMetadata.candidatesTokenCount || 0,
							cache_read_input_tokens: geminiResp.usageMetadata.cachedContentTokenCount || 0,
						}, req && req.clientSource ? req.clientSource : 'claudecode');
					}

					log('debug', `[Gemini] Sending Anthropic response: id=${anthropicResp.id}, blocks=${content.length}`);
					if (req && req.interactionId) {
						logClientStage('claude', req.interactionId, '4', 'result', anthropicResp);
					}
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(anthropicResp));
				}
				catch (e) {
					log('warn', `[Gemini] Failed to parse response JSON: ${e.message}, raw: ${responseBody.substring(0, 500)}`);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(responseBody);
				}
			}
		});
		proxyRes.on('error', (e) => {
			log('error', `[Gemini] Response stream error: ${e.message}`);
		});
	};

	log('debug', `[Gemini] Sending request to ${options.hostname}:${options.port}${options.path}`);

	const proxyReq = proxyRequest(provider.proxy, options, requestBody, (err, proxyRes) => {
		once(err, proxyRes);
	});

	proxyReq.on('error', (err) => {
		log('error', `[Gemini] Request error (fallback): ${err.message}`);
		once(err, null);
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		log('error', '[Gemini] Request timeout (300s)');
		proxyReq.destroy();
		once(new Error('Upstream timeout'), null);
	});

	log('debug', '[Gemini] Request sent, waiting for response...');
};

module.exports = { handleGeminiRequest, convertAnthropicToGemini };
