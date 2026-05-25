const { log } = require('../logger');
const { proxyRequest } = require('../proxy-agent');

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

const convertAnthropicMessagesToOpenAI = (parsedBody) => {
	const openaiMessages = [];

	if (parsedBody.system) {
		const systemText = typeof parsedBody.system === 'string'
			? parsedBody.system
			: (Array.isArray(parsedBody.system)
				? parsedBody.system.map((b) => b.text || '').join('\n')
				: '');
		if (systemText) {
			openaiMessages.push({ role: 'system', content: systemText });
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
					const textContent = extractTextFromContent(content);
					if (textContent) {
						openaiMessages.push({ role: 'user', content: textContent });
					}

					for (const block of content) {
						if (block.type === 'tool_result') {
							openaiMessages.push({
								role: 'tool',
								tool_call_id: block.tool_use_id,
								content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content || {}),
							});
						}
					}
				}
				else if (content.some((block) => block.type === 'image' || block.type === 'image_url')) {
					const openaiContent = content.map((block) => {
						if (block.type === 'text') {
							return { type: 'text', text: block.text || '' };
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
						openaiMessages.push({ role, content: text });
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

const transformOpenAIStreamToAnthropic = (res, originalModel, openaiStream) => {
	let msgId = null;
	let textBlockOpen = false;
	let textBlockIndex = -1;
	let toolCallIndexMap = {};
	let nextBlockIndex = 0;
	let buffer = '';

	const writeSSE = (event, data) => {
		if (event) {
			res.write(`event: ${event}\n`);
		}
		res.write(`data: ${JSON.stringify(data)}\n\n`);
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
				if (textBlockOpen) {
					writeSSE(null, { type: 'content_block_stop', index: textBlockIndex });
					textBlockOpen = false;
				}

				writeSSE(null, {
					type: 'message_delta',
					delta: { stop_reason: 'end_turn' },
					usage: { output_tokens: 0 },
				});
				writeSSE(null, { type: 'message_stop' });
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

			const choices = parsed.choices || [];
			for (const choice of choices) {
				const delta = choice.delta || {};

				if (delta.content !== undefined && delta.content !== null) {
					if (!textBlockOpen) {
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
					if (textBlockOpen) {
						writeSSE(null, { type: 'content_block_stop', index: textBlockIndex });
						textBlockOpen = false;
					}

					for (const oaiIdx of Object.keys(toolCallIndexMap)) {
						const aIdx = toolCallIndexMap[oaiIdx];
						writeSSE(null, { type: 'content_block_stop', index: aIdx });
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

					writeSSE(null, {
						type: 'message_delta',
						delta: { stop_reason: stopReason },
						usage,
					});
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
		usage: openaiResp.usage ? {
			input_tokens: openaiResp.usage.prompt_tokens || 0,
			output_tokens: openaiResp.usage.completion_tokens || 0,
		} : undefined,
	};
};

const handleOpenAIRequest = (provider, targetModel, originalModel, req, body, res) => {
	let parsedBody;
	try {
		parsedBody = JSON.parse(body);
	}
	catch (e) {
		res.writeHead(400, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
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
			'Authorization': `Bearer ${provider.apiKey}`,
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	log('debug', `[OpenAI] POST ${options.hostname}${options.path}`);
	log('debug', `[OpenAI] Request body: ${reqBody.substring(0, 1000)}`);

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			return;
		}
		settled = true;
		if (err) {
			log('error', `OpenAI upstream error: ${err.message}`);
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
			return;
		}

		if (!proxyRes) {
			return;
		}

		log('info', `[OpenAI] Response: status=${proxyRes.statusCode}`);
		if (parsedBody.stream) {
			log('debug', '[OpenAI] Streaming response');
			transformOpenAIStreamToAnthropic(res, originalModel, proxyRes);
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				if (proxyRes.statusCode >= 400) {
					res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
					res.end(responseBody);
					return;
				}

				try {
					const openaiResp = JSON.parse(responseBody);
					const anthropicResp = transformOpenAIToAnthropic(openaiResp, originalModel);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(anthropicResp));
				}
				catch (e) {
					log('warn', `Failed to transform OpenAI response: ${e.message}`);
					res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
					res.end(responseBody);
				}
			});
			proxyRes.on('error', (e) => {
				log('error', `OpenAI response stream error: ${e.message}`);
			});
		}
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
			once(err, proxyRes);
		});

		proxyReq.setTimeout(300000);
		proxyReq.on("timeout", () => {
			proxyReq.destroy();
			once(new Error("Upstream timeout"), null);
		});
};

module.exports = { handleOpenAIRequest, buildOpenAIRequest, transformOpenAIToAnthropic };
