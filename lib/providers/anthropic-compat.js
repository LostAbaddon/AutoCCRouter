const { Transform } = require('stream');
const { log } = require('../logger');
const { proxyRequest } = require('../proxy-agent');
const { recordUsage } = require('../usage-tracker');

const { saveThinking, getThinking } = require('../thinking-store');

const stripExtraUsage = (usage) => {
	if (!usage) {
		return usage;
	}
	const { cache_creation_input_tokens, cache_read_input_tokens, service_tier, ...clean } = usage;
	return clean;
};

const saveThinkingBlocks = (content) => {
	if (!Array.isArray(content)) {
		return;
	}
	const thinkingBlocks = content.filter((b) => b.type === 'thinking');
	if (thinkingBlocks.length === 0) {
		return;
	}
	const toolUseIds = content.filter((b) => b.type === 'tool_use').map((b) => b.id);
	for (const id of toolUseIds) {
		if (id) {
			saveThinking(id, thinkingBlocks);
			log('debug', `[Anthropic] Saved ${thinkingBlocks.length} thinking block(s) for tool_use ${id}`);
		}
	}
};

const restoreThinkingBlocks = (body) => {
	if (!body) {
		return body;
	}
	let parsed;
	try {
		parsed = JSON.parse(body);
	}
	catch (e) {
		return body;
	}
	if (!Array.isArray(parsed.messages)) {
		return body;
	}
	let modified = false;
	for (const msg of parsed.messages) {
		if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
			continue;
		}
		const hasToolUse = msg.content.some((b) => b.type === 'tool_use');
		const hasThinking = msg.content.some((b) => b.type === 'thinking');
		if (hasToolUse && !hasThinking) {
			const restored = [];
			const seenIds = new Set();
			for (const block of msg.content) {
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
				msg.content = [...restored, ...msg.content];
				modified = true;
				log('debug', `[Anthropic] Restored ${restored.length} thinking block(s) for ${seenIds.size} tool_use(s)`);
			}
		}
	}
	if (modified) {
		return JSON.stringify(parsed);
	}
	return body;
};

const createResponseTransformer = (targetModel, originalModel, usageMeta) => {
	let msgId = null;
	let collectingThinking = false;
	let thinkingBlocks = [];
	let thinkingIndex = -1;
	let streamInputTokens = 0;
	let streamOutputTokens = 0;

	return new Transform({
		transform(chunk, encoding, callback) {
			let str = chunk.toString();

			if (originalModel && originalModel !== targetModel) {
				const escaped = targetModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				str = str.replace(new RegExp(escaped, 'g'), originalModel);
			}

			const lines = str.split('\n');
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
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

				if (parsed.type === 'message_start' && parsed.message) {
					msgId = parsed.message.id;
					thinkingBlocks = [];
					collectingThinking = false;
					if (parsed.message.usage) {
						streamInputTokens = parsed.message.usage.input_tokens || 0;
						parsed.message.usage = stripExtraUsage(parsed.message.usage);
					}
					lines[i] = 'data: ' + JSON.stringify(parsed);
				}
				else if (parsed.type === 'content_block_start') {
					if (parsed.content_block && parsed.content_block.type === 'thinking') {
						collectingThinking = true;
						thinkingIndex = parsed.index;
						if (!thinkingBlocks[thinkingIndex]) {
							thinkingBlocks[thinkingIndex] = { type: 'thinking', thinking: '', signature: '' };
						}
						if (parsed.content_block.signature === '' && msgId) {
							parsed.content_block.signature = msgId;
							lines[i] = 'data: ' + JSON.stringify(parsed);
						}
					}
					else if (parsed.content_block && parsed.content_block.type === 'tool_use') {
						if (thinkingBlocks.length > 0 && msgId) {
							const validBlocks = thinkingBlocks.filter((b) => b !== undefined && b.thinking);
							if (validBlocks.length > 0) {
								saveThinking(parsed.content_block.id, validBlocks);
								log('debug', `[Anthropic] Stream: saved ${validBlocks.length} thinking block(s) for tool_use ${parsed.content_block.id}`);
							}
						}
					}
				}
				else if (parsed.type === 'content_block_delta') {
					if (collectingThinking && parsed.index === thinkingIndex && parsed.delta && parsed.delta.type === 'thinking_delta') {
						if (thinkingBlocks[thinkingIndex]) {
							thinkingBlocks[thinkingIndex].thinking += parsed.delta.thinking || '';
							thinkingBlocks[thinkingIndex].signature = parsed.delta.signature || thinkingBlocks[thinkingIndex].signature;
						}
					}
				}
				else if (parsed.type === 'content_block_stop') {
					if (parsed.index === thinkingIndex) {
						collectingThinking = false;
					}
				}
				else if (parsed.type === 'message_delta') {
					if (parsed.usage) {
						streamOutputTokens = parsed.usage.output_tokens || 0;
						parsed.usage = stripExtraUsage(parsed.usage);
					}
					lines[i] = 'data: ' + JSON.stringify(parsed);
				}
				else if (parsed.type === 'message_stop') {
					collectingThinking = false;
					if (usageMeta && (streamInputTokens > 0 || streamOutputTokens > 0)) {
						recordUsage(usageMeta.providerName || 'anthropic', usageMeta.targetModel, {
							input_tokens: streamInputTokens,
							output_tokens: streamOutputTokens,
						});
					}
				}
			}

			this.push(lines.join('\n'));
			callback();
		},
	});
};

// 确保请求体中的关键消息带有 cache_control breakpoint
const ensureCacheControl = (body) => {
	let parsed;
	try {
		parsed = JSON.parse(body);
	}
	catch (e) {
		return body;
	}

	let modified = false;

	// 确保 system 消息带有 cache_control
	if (Array.isArray(parsed.system)) {
		for (const block of parsed.system) {
			if (block.type === 'text' && !block.cache_control) {
				block.cache_control = { type: 'ephemeral' };
				modified = true;
			}
		}
	}

	// 确保最后一条非 assistant 消息的关键 content block 带有 cache_control
	// 从后向前找到最后一条 user 消息，为其最后几个 text block 添加 cache_control
	if (Array.isArray(parsed.messages)) {
		for (let i = parsed.messages.length - 1; i >= 0; i--) {
			const msg = parsed.messages[i];
			if (msg.role === 'user' && Array.isArray(msg.content)) {
				// 为最后几个 text/tool_result block 添加 cache_control（最多 4 个）
				let marked = 0;
				for (let j = msg.content.length - 1; j >= 0 && marked < 4; j--) {
					const block = msg.content[j];
					if ((block.type === 'text' || block.type === 'tool_result') && !block.cache_control) {
						block.cache_control = { type: 'ephemeral' };
						marked++;
						modified = true;
					}
				}
				break;
			}
		}
	}

	if (modified) {
		log('debug', '[Anthropic] Added cache_control breakpoints');
		return JSON.stringify(parsed);
	}
	return body;
};

const forwardRequest = (provider, req, body, callback) => {
	const targetUrl = new URL(provider.baseUrl);
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${provider.apiKey}`,
	};

	let processedBody = restoreThinkingBlocks(body);
	try {
		processedBody = ensureCacheControl(processedBody);
	}
	catch (e) {
		log('warn', `[Anthropic] ensureCacheControl failed: ${e.message}`);
	}
	if (processedBody) {
		headers['Content-Length'] = Buffer.byteLength(processedBody);
	}

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: targetUrl.pathname + (req.url || ''),
		method: req.method,
		headers,
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			return;
		}
		settled = true;
		callback(err, proxyRes);
	};

	log('debug', `[Anthropic] POST ${options.hostname}${options.path}`);

	const proxyReq = proxyRequest(provider.proxy, options, processedBody, (err, proxyRes) => {
		once(err, proxyRes);
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		log('warn', `Upstream timeout: ${provider.baseUrl}`);
		once(new Error('Upstream timeout'), null);
	});
};

const handleAnthropicRequest = (provider, targetModel, originalModel, req, body, res) => {
	forwardRequest(provider, req, body, (err, proxyRes) => {
		if (err) {
			res.writeHead(502, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				error: {
					type: 'proxy_error',
					message: err.message,
				},
			}));
			return;
		}

		log('debug', `[Anthropic] Response: status=${proxyRes.statusCode}`);
		const isStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (isStream) {
			const transformer = createResponseTransformer(targetModel, originalModel, { providerName: provider._name, targetModel });
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			proxyRes.pipe(transformer).pipe(res);
			transformer.on('error', (e) => {
				log('error', `Transformer stream error: ${e.message}`);
			});
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				log('debug', `[Anthropic] Response body (${responseBody.length}b): ${responseBody.substring(0, 500)}`);
					try {
					const parsed = JSON.parse(responseBody);

					if (parsed.error) {
						log('error', `[Anthropic] API error: ${JSON.stringify(parsed.error).substring(0, 500)}`);
						res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
						res.end(responseBody);
						return;
					}

					if (parsed.content) {
						saveThinkingBlocks(parsed.content);
					}

					if (originalModel && originalModel !== targetModel) {
						parsed.model = originalModel;
					}
					if (parsed.usage) {
						parsed.usage = stripExtraUsage(parsed.usage);
						recordUsage(provider._name || 'anthropic', targetModel, parsed.usage);
					}
					if (parsed.content) {
						for (const block of parsed.content) {
							if (block.type === 'thinking' && block.signature === '' && parsed.id) {
								block.signature = parsed.id;
							}
						}
					}

					responseBody = JSON.stringify(parsed);
				}
				catch (e) {
					log('warn', `Failed to transform JSON response: ${e.message}`);
				}

				res.writeHead(proxyRes.statusCode, proxyRes.headers);
				res.end(responseBody);
			});
		}

		proxyRes.on('error', (e) => {
			log('error', `Response stream error: ${e.message}`);
		});
	});
};

module.exports = { handleAnthropicRequest, createResponseTransformer, stripExtraUsage };
