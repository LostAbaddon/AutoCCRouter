const { Transform } = require('stream');
const { log, logClientStage } = require('../logger');
const { proxyRequest } = require('../proxy-agent');
const { recordUsage } = require('../usage-tracker');

const { saveThinking, getThinking } = require('../thinking-store');
const { acquireKey, releaseKey } = require('../key-state-manager');
const { classifyResponse } = require('../error-detector');

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
			else {
				// Try-inject fallback: synthetic thinking block
				const firstToolUse = msg.content.find((b) => b.type === 'tool_use');
				if (firstToolUse && firstToolUse.id) {
					msg.content = [
						{
							type: 'thinking',
							thinking: '(Synthetic thinking block for protocol compliance)',
							signature: 'synthetic:' + firstToolUse.id,
						},
						...msg.content,
					];
					modified = true;
					log('info', `[Anthropic] TryInject: synthetic thinking for tool_use ${firstToolUse.id}`);
				}
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
	let streamCacheCreationTokens = 0;
	let streamCacheReadTokens = 0;

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
						streamCacheCreationTokens = parsed.message.usage.cache_creation_input_tokens || 0;
						streamCacheReadTokens = parsed.message.usage.cache_read_input_tokens || 0;
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
							cache_creation_tokens: streamCacheCreationTokens,
							cache_read_tokens: streamCacheReadTokens
						}, usageMeta.clientSource || 'claudecode');
					}

				}
			}

			const output = lines.join('\n');
			if (usageMeta && usageMeta.interactionId) {
				logClientStage('claudecode', usageMeta.interactionId, '3', 'response', output);
				logClientStage('claudecode', usageMeta.interactionId, '4', 'result', output);
			}
			this.push(output);
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
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const selectedKey = acquired.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, selectedKey, opts);
	};
	const targetUrl = new URL(provider.baseUrl);
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${selectedKey}`,
	};

	let processedBody = restoreThinkingBlocks(body);
	try {
		processedBody = ensureCacheControl(processedBody);

		// 针对 minimax 的特有处理
		if (provider._name === 'minimax') {
			let parsed;
			try {
				parsed = JSON.parse(processedBody);
				if (parsed.thinking) {
					// MiniMax 不支持且不能传入 budget_tokens
					if (parsed.thinking.budget_tokens !== undefined) {
						delete parsed.thinking.budget_tokens;
					}
					processedBody = JSON.stringify(parsed);
					log('debug', `[Anthropic] Removed budget_tokens for MiniMax`);
				}
			}
			catch (e) {
				log('warn', `[Anthropic] Failed to process MiniMax thinking params: ${e.message}`);
			}
		}
	}
	catch (e) {
		log('warn', `[Anthropic] ensureCacheControl failed: ${e.message}`);
	}
	if (provider._name === 'minimax' && processedBody) {
		try {
			const parsed = JSON.parse(processedBody);
			if (parsed && parsed.thinking && typeof parsed.thinking === 'object') {
				if ('budget_tokens' in parsed.thinking) {
					delete parsed.thinking.budget_tokens;
					log('debug', '[Anthropic] Removed thinking.budget_tokens for MiniMax');
				}
				processedBody = JSON.stringify(parsed);
			}
		}
		catch (e) {
			log('warn', `[Anthropic] MiniMax thinking sanitization failed: ${e.message}`);
		}
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

	if (req && req.interactionId) {
		try {
			logClientStage('claudecode', req.interactionId, '2', 'upstream', JSON.parse(processedBody));
		}
		catch (e) {
			logClientStage('claudecode', req.interactionId, '2', 'upstream', processedBody);
		}
	}

	const proxyReq = proxyRequest(provider.proxy, options, processedBody, (err, proxyRes) => {
		once(err, proxyRes);
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		log('warn', `Upstream timeout: ${provider.baseUrl}`);
		settleKey({ isProviderDown: true });
		once(new Error('Upstream timeout'), null);
	});
};

const handleAnthropicRequest = (provider, targetModel, originalModel, req, body, res, onComplete) => {
	forwardRequest(provider, req, body, (err, proxyRes) => {
		if (err) {
			if (onComplete) {
				onComplete(err);
			}
			else {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: {
						type: 'proxy_error',
						message: err.message,
					},
				}));
			}
			return;
		}

		log('debug', `[Anthropic] Response: status=${proxyRes.statusCode}`);
		const isStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (isStream) {
			const transformer = createResponseTransformer(targetModel, originalModel, { providerName: provider._name, targetModel, interactionId: req && req.interactionId });
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			proxyRes.pipe(transformer).pipe(res);
			transformer.on('error', (e) => {
				log('error', `Transformer stream error: ${e.message}`);
			});
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
				log('debug', `[Anthropic] Response body (${responseBody.length}b): ${responseBody.substring(0, 500)}`);
					try {
					const parsed = JSON.parse(responseBody);

					if (req && req.interactionId) {
						logClientStage('claudecode', req.interactionId, '3', 'response', parsed);
					}

					if (parsed.error) {
						const cr = classifyResponse(proxyRes.statusCode, parsed);
						settleKey({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
						log('error', `[Anthropic] API error: ${JSON.stringify(parsed.error).substring(0, 500)}`);
						if (onComplete) {
							onComplete(new Error(`API error: ${proxyRes.statusCode}`));
						}
						else {
							res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
							res.end(responseBody);
						}
						return;
					}

					if (parsed.content) {
						saveThinkingBlocks(parsed.content);
					}

					if (originalModel && originalModel !== targetModel) {
						parsed.model = originalModel;
					}
					if (parsed.usage) {
						const originalUsage = {
							input_tokens: parsed.usage?.input_tokens || 0,
							output_tokens: parsed.usage?.output_tokens || 0,
							cache_read_tokens: parsed.usage?.cache_read_input_tokens || 0,
							cache_creation_tokens: parsed.usage?.cache_creation_input_tokens || 0,
						};
						parsed.usage = stripExtraUsage(parsed.usage);
						recordUsage(provider._name || 'anthropic', targetModel, originalUsage, req && req.clientSource ? req.clientSource : 'claudecode');
					}
					if (parsed.content) {
						for (const block of parsed.content) {
							if (block.type === 'thinking' && block.signature === '' && parsed.id) {
								block.signature = parsed.id;
							}
						}
					}

					if (req && req.interactionId) {
						logClientStage('claudecode', req.interactionId, '4', 'result', parsed);
					}

					responseBody = JSON.stringify(parsed);
				}
				catch (e) {
					log('warn', `Failed to transform JSON response: ${e.message}`);
				}

				res.writeHead(proxyRes.statusCode, proxyRes.headers);
				res.end(responseBody);
				if (onComplete) {
					onComplete(null);
				}
			});
		}

		proxyRes.on('error', (e) => {
			settleKey({ isProviderDown: true });
			log('error', `Response stream error: ${e.message}`);
		});
	});
};

module.exports = { handleAnthropicRequest, createResponseTransformer, stripExtraUsage };
