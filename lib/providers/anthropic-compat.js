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
			log('debug', `[ClaudeCode-Anthropic] Saved ${thinkingBlocks.length} thinking block(s) for tool_use ${id}`);
		}
	}
};

const DEFAULT_THINKING_LEVEL = 'medium';
const restoreThinkingBlocks = (requestBody, providerName) => {
	// 对于 thinking 策略的处理
	if (requestBody.thinking?.type === 'adaptive') {
		if (providerName === 'anthropic') {
			requestBody.output_config = requestBody.output_config || {};
			requestBody.output_config.effort = DEFAULT_THINKING_LEVEL;
		}
		else if (providerName === 'minimax') {
		}
		else {
			requestBody.thinking = {
				type: "enabled",
			};
			if (requestBody.max_tokens > 0) {
				requestBody.thinking.budget_tokens = Math.ceil(requestBody.max_tokens * 0.4); // 最多使用40%用于思考
			}
		}
	}
	else if (requestBody.thinking?.type === 'enabled') {
	}
	else {
		requestBody.thinking = {
			type: "disabled",
		};
	}
	// MiniMax 不支持且不能传入 budget_tokens
	if (providerName === 'minimax') {
		if (!requestBody.thinking?.budget_tokens) delete requestBody.thinking.budget_tokens;
	}
	
	if (!Array.isArray(requestBody.messages)) return;

	for (const msg of requestBody.messages) {
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
				log('debug', `[ClaudeCode-Anthropic] Restored ${restored.length} thinking block(s) for ${seenIds.size} tool_use(s)`);
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
					log('info', `[ClaudeCode-Anthropic] TryInject: synthetic thinking for tool_use ${firstToolUse.id}`);
				}
			}
		}
	}
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
			if (usageMeta && usageMeta.interactionId) logClientStage('claudecode', usageMeta.interactionId, '3', 'response', str);

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
						streamInputTokens = Math.max(streamInputTokens, parsed.message.usage.input_tokens || 0);
						streamOutputTokens = Math.max(streamOutputTokens, parsed.message.usage.output_tokens || 0);
						streamCacheCreationTokens = Math.max(streamCacheCreationTokens, parsed.message.usage.cache_creation_input_tokens || 0);
						streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.message.usage.cache_read_input_tokens || 0);
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
								log('debug', `[ClaudeCode-Anthropic] Stream: saved ${validBlocks.length} thinking block(s) for tool_use ${parsed.content_block.id}`);
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
						streamInputTokens = Math.max(streamInputTokens, parsed.usage.input_tokens || 0);
						streamOutputTokens = Math.max(streamOutputTokens, parsed.usage.output_tokens || 0);
						streamCacheCreationTokens = Math.max(streamCacheCreationTokens, parsed.usage.cache_creation_input_tokens || 0);
						streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.usage.cache_read_input_tokens || 0);
						parsed.usage = stripExtraUsage(parsed.usage);
					}
					lines[i] = 'data: ' + JSON.stringify(parsed);
				}
				else if (parsed.type === 'message_stop') {
					collectingThinking = false;
					if (usageMeta && (streamInputTokens > 0 || streamOutputTokens > 0 || streamCacheCreationTokens > 0 || streamCacheReadTokens > 0)) {
						recordUsage(usageMeta.providerName || 'anthropic', usageMeta.targetModel, {
							input_tokens: streamInputTokens,
							output_tokens: streamOutputTokens,
							cache_creation_tokens: streamCacheCreationTokens,
							cache_read_tokens: streamCacheReadTokens
						}, usageMeta.clientSource || 'claudecode', usageMeta);
					}

				}
			}

			const output = lines.join('\n');
			if (usageMeta && usageMeta.interactionId) {
				logClientStage('claudecode', usageMeta.interactionId, '4', 'result', output);
			}
			this.push(output);
			callback();
		},
	});
};

// 确保请求体中的关键消息带有 cache_control breakpoint
const ensureCacheControl = (requestBody) => {
	// 确保 system 消息带有 cache_control
	if (Array.isArray(requestBody.system)) {
		for (const block of requestBody.system) {
			if (block.type === 'text' && !block.cache_control) {
				block.cache_control = { type: 'ephemeral' };
			}
		}
	}

	// 确保最后一条非 assistant 消息的关键 content block 带有 cache_control
	// 从后向前找到最后一条 user 消息，为其最后几个 text block 添加 cache_control
	if (Array.isArray(requestBody.messages)) {
		for (let i = requestBody.messages.length - 1; i >= 0; i--) {
			const msg = requestBody.messages[i];
			if (msg.role === 'user' && Array.isArray(msg.content)) {
				// 为最后几个 text/tool_result block 添加 cache_control（最多 4 个）
				let marked = 0;
				for (let j = msg.content.length - 1; j >= 0 && marked < 4; j--) {
					const block = msg.content[j];
					if ((block.type === 'text' || block.type === 'tool_result') && !block.cache_control) {
						block.cache_control = { type: 'ephemeral' };
						marked++;
					}
				}
				break;
			}
		}
	}
};

const forwardRequest = (provider, req, requestBody, selectedKey, callback) => {
	const targetUrl = new URL(provider.baseUrl);
	const headers = {
		'Content-Type': 'application/json',
		'Authorization': `Bearer ${selectedKey}`,
	};
	if (provider._name === 'anthropic') {
		headers['x-api-key'] = selectedKey;
		headers['anthropic-version'] = '2023-06-01';
	}

	// 处理 Thinking 块和配置
	restoreThinkingBlocks(requestBody, provider._name);
	try {
		ensureCacheControl(requestBody);
	}
	catch (e) {
		log('warn', `[ClaudeCode-Anthropic] ensureCacheControl failed: ${e.message}`);
	}
	const body = JSON.stringify(requestBody);
	logClientStage('claudecode', req.interactionId, '2', 'upstream', requestBody);

	// 设置 Header Size
	headers['Content-Length'] = Buffer.byteLength(body);

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: targetUrl.pathname + (req.url || ''),
		method: req.method,
		headers,
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};
	log('debug', `[ClaudeCode-Anthropic] POST ${options.hostname}${options.path}`);

	let settled = false;
	const once = (err, proxyRes) => {
		if (settled) {
			return;
		}
		settled = true;
		callback(err, proxyRes);
	};

	const proxyReq = proxyRequest(provider.proxy, options, body, (err, proxyRes) => {
		once(err, proxyRes);
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		log('warn', `Upstream timeout: ${provider.baseUrl}`);
		once(new Error('Upstream timeout'), null);
	});
};

const handleAnthropicRequest = (provider, targetModel, originalModel, req, requestBody, res, onComplete) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const selectedKey = acquired.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, selectedKey, opts);
	};

	if (typeof requestBody === 'string') requestBody = JSON.parse(requestBody);
	requestBody.model = targetModel;

	const onDone = (err, isProviderDown=true, isKeyFailure=false) => {
		if (err) {
			log('error', `[ClaudeCode-Anthropic] ${err.message}`);
			settle({ isProviderDown, isKeyFailure });
			onComplete(err);
			return;
		}
		settle({ isSuccess: true });
		onComplete();
	};

	forwardRequest(provider, req, requestBody, selectedKey, (err, proxyRes) => {
		if (err) return onDone(err);

		log('debug', `[Anthropic] Response: status=${proxyRes.statusCode}`);
		const isStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (isStream) {
			const transformer = createResponseTransformer(targetModel, originalModel, { providerName: provider._name, targetModel, interactionId: req && req.interactionId });
			try {
				res.writeHead(proxyRes.statusCode, proxyRes.headers);
			} catch {}
			proxyRes.pipe(transformer).pipe(res);
			transformer.on('end', () => {
				onComplete();
			});
			transformer.on('error', (e) => {
				onComplete(e);
			});
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				log('debug', `[ClaudeCode-Anthropic] Response body (${responseBody.length}b): ${responseBody.substring(0, 500)}`);
				try {
					const parsed = JSON.parse(responseBody);

					if (req && req.interactionId) {
						logClientStage('claudecode', req.interactionId, '3', 'response', parsed);
					}

					if (parsed.error) {
						const cr = classifyResponse(proxyRes.statusCode, parsed);
						settleKey({ isKeyFailure: cr.isKeyFailure, isProviderDown: cr.isProviderDown });
						log('error', `[ClaudeCode-Anthropic] API error: ${JSON.stringify(parsed.error).substring(0, 500)}`);
						onComplete(new Error(`API error: ${proxyRes.statusCode}`));
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
						recordUsage(provider._name || 'anthropic', targetModel, originalUsage, req && req.clientSource ? req.clientSource : 'claudecode', parsed.usage);
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

				try {
					res.writeHead(proxyRes.statusCode, proxyRes.headers);
				} catch {}
				res.end(responseBody);
				onDone();
			});
			proxyRes.on('error', (e) => {
				onDone(e);
			});
		}
	});
};

module.exports = { handleAnthropicRequest };
