const http = require('http');
const { log, getNextInteractionId, logClientStage } = require('./logger');
const { resolveMaxTokens } = require('./config');
const { mapModel, isWildcardPrefix } = require('./model-mapper');
const { handleAnthropicRequest } = require('./providers/anthropic-compat');
const { handleOpenAIRequest } = require('./providers/openai-compat');
const { handleGeminiRequest } = require('./providers/gemini');
const { handleAutoRequest } = require('./providers/auto');
const { handleOpenAINativeRequest } = require('./handlers/openai-native');
const { handleGeminiNativeRequest } = require('./handlers/gemini-native');
const { translateTools, enableHotReload } = require('./tool-translator');
const modelRouter = require('./model-router');

enableHotReload();

const buildModelList = (modelMapping) => {
	const models = [];
	const today = new Date().toISOString().split('T')[0];
	for (const rule of modelMapping) {
		// 跳过通配规则（prefix 含 *）——它不是具体模型名，不应暴露给客户端
		if (isWildcardPrefix(rule.prefix)) {
			continue;
		}
		models.push({
			id: rule.prefix,
			object: 'model',
			type: 'model',
			display_name: rule.prefix,
			created: Math.floor(Date.now() / 1000),
			created_at: today,
			owned_by: rule.provider || 'nervhub',
		});
	}
	return {
		object: 'list',
		data: models,
		has_more: false,
		first_id: models[0] ? models[0].id : null,
		last_id: models.length > 0 ? models[models.length - 1].id : null,
	};
};

const sanitizeBlocks = (blocks) => {
	if (!Array.isArray(blocks)) {
		return blocks;
	}
	return blocks.filter((b) => {
		if (!b || typeof b !== 'object') {
			return false;
		}
		// OpenAI / Anthropic 风格: type='text' 但 text 是空的
		if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') {
			return typeof b.text === 'string' && b.text.trim().length > 0;
		}
		// Gemini 风格: 有 text 但为空，且没有其他如 functionCall 等结构字段
		if (typeof b.text === 'string' && b.text.trim().length === 0) {
			// 如果除了 text 以外没别的东西了（比如没有 functionCall），那就是纯空文本块，剔除
			const keys = Object.keys(b);
			if (keys.length === 1 && keys[0] === 'text') {
				return false;
			}
			delete b.text;
		}
		return true;
	});
};
const sanitizeIncoming = (parsedBody) => {
	if (!parsedBody || typeof parsedBody !== 'object') {
		return false;
	}

	let changed = false;
	// 1. Codex Responses API: parsedBody.input
	if (Array.isArray(parsedBody.input)) {
		const newInputs = [];
		for (const item of parsedBody.input) {
			if (!item) {
				continue;
			}
			if (item.type === 'message') {
				if (Array.isArray(item.content)) {
					const cleaned = sanitizeBlocks(item.content);
					if (cleaned.length === 0) {
						// 纯空 message，直接丢弃，不要污染上下文
						changed = true;
						continue;
					}
					item.content = cleaned;
				}
				else if (!item.content) {
					// 纯空 message，直接丢弃，不要污染上下文
					changed = true;
					continue;
				}
				else if (item.content.trim && !item.content.trim()) {
					// 纯空 message，直接丢弃，不要污染上下文
					changed = true;
					continue;
				}
			}
			newInputs.push(item);
		}
		parsedBody.input = newInputs;
	}

	// 2. OpenAI / Anthropic: parsedBody.messages
	if (Array.isArray(parsedBody.messages)) {
		const newMessages = [];
		for (const msg of parsedBody.messages) {
			if (!msg) {
				// 纯空 message，直接丢弃，不要污染上下文
				changed = true;
				continue;
			}
			if (Array.isArray(msg.content)) {
				const cleaned = sanitizeBlocks(msg.content);
				msg.content = cleaned.length > 0 ? cleaned : '';
				// 丢弃真正没有任何内容的消息（除了 tool 等结构占位）
				if (msg.content === '' && !msg.tool_calls) {
					// 纯空 message，直接丢弃，不要污染上下文
					changed = true;
					continue;
				}
			}
			else if (!msg.content) {
				if (!msg.tool_calls) {
					// 纯空 message，直接丢弃，不要污染上下文
					changed = true;
					continue;
				}
			}
			else if (msg.content.trim && !msg.content.trim()) {
				if (!msg.tool_calls) {
					// 纯空 message，直接丢弃，不要污染上下文
					changed = true;
					continue;
				}
			}
			newMessages.push(msg);
		}
		parsedBody.messages = newMessages;
	}

	// 3. Gemini: parsedBody.contents
	if (Array.isArray(parsedBody.contents)) {
		const newContents = [];
		for (const content of parsedBody.contents) {
			if (!content) {
				// 纯空 message，直接丢弃，不要污染上下文
				changed = true;
				continue;
			}
			if (Array.isArray(content.parts)) {
				const cleaned = sanitizeBlocks(content.parts);
				if (cleaned.length === 0) {
					// 纯空 message，直接丢弃，不要污染上下文
					changed = true;
					continue;
				}
				content.parts = cleaned;
			}
			newContents.push(content);
		}
		parsedBody.contents = newContents;
	}

	return changed;
};

const removeBillingHeader = (content) => {
	if (content.match(/x-anthropic-billing-header:/gim)) {
		content = (content + '\n').replace(/x-anthropic-billing-header:.*?\n/gim, '').trim();
	}
	return content;
};
const removeBillingHeaderFromList = (list) => {
	if (typeof list === 'string') {
		list = removeBillingHeader(list);
	}
	else if (Array.isArray(list)) {
		list = list.map(block => {
			if (block && block.type === 'text' && block.text) {
				block.text = removeBillingHeader(block.text);
			}
			return block;
		});
		// Optional: remove any completely empty blocks
		list = list.filter(b => !(b.type === 'text' && !b.text.trim() && !b.cache_control));
	}
	return list;
};

const getSessionId = (body, headers) => {
	if (body?.metadata?.user_id) {
		if (typeof body.metadata.user_id === 'string') {
			try {
				let json = JSON.parse(body.metadata.user_id);
				if (json.session_id) return json.session_id;
			} catch {}
		}
		else {
			if (body.metadata.user_id?.session_id) return body.metadata.user_id.session_id;
		}
	}

	if (headers) {
		let sessionId = headers['x-claude-code-session-id'] || headers['session-id'] || headers['thread-id'];
		if (sessionId) return sessionId;
		let meta = headers['x-codex-turn-metadata'];
		if (meta) {
			try {
				meta = JSON.parse(meta);
				sessionId = meta.session_id || meta.thread_id;
				if (sessionId) return sessionId;
			}
			catch {}
		}
	}

	// 针对Gemini，它没有SessionId或类似等价物，所以使用最早的用户输入作为SessionId
	if (Array.isArray(body?.contents)) {
		let sessionContent;
		for (const content of body.contents) {
			if (content.role === 'user' && Array.isArray(content.parts)) {
				for (const item of content.parts) {
					if (typeof item.text === 'string') {
						let text = item.text.trim();
						text = text.replace(/<([\w _\-]+)>[\w\W]*?<\/\1>/g, '').replace(/\s+/g, '').trim();
						if (text) {
							sessionContent = text;
							break;
						}
					}
				}
				if (sessionContent) break;
			}
		}
		if (sessionContent) {
			sessionContent = sessionContent.substring(0, 40);
			return sessionContent;
		}
	}

	return null;
};

// Claude会发送一些特殊请求，不要求回复，但会消耗 input token，唯一优势是方便 coding plan 的五小时积分周期的快速开启
const isDiabolicalClaudeRequest = (parsedBody) => {
	if (!parsedBody || typeof parsedBody !== 'object') {
		return false;
	}

	// 条件 1：!(max_tokens > 10) —— 未设置 / null / ≤ 10 都算
	if (parsedBody.max_tokens > 10) {
		return false;
	}

	// 条件 2：!system || 归一化后长度 === 0
	const system = parsedBody.system;
	if (system) {
		const normalized = Array.isArray(system) ? system : (system.trim ? system.trim() : system);
		if (normalized.length !== 0) {
			return false;
		}
	}

	// 条件 3：messages.length <= 1
	if (parsedBody.messages?.length > 1) {
		return false;
	}

	// 条件 4：唯一消息的 role 为 user
	const onlyMsg = parsedBody.messages?.[0];
	if (onlyMsg?.role !== 'user') {
		return !onlyMsg;
	}

	// 条件 5：content 是字符串
	if (typeof onlyMsg.content !== 'string') {
		return false;
	}

	return true;
};

const createProxyServer = (getConfig) => {
	const server = http.createServer((req, res) => {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', '*');

		if (req.method === 'OPTIONS') {
			res.writeHead(200);
			res.end();
			return;
		}

		const config = getConfig();

		if (req.url === '/v1/models' || (req.url && req.url.startsWith('/v1/models?'))
			|| req.url === '/codex/models' || (req.url && req.url.startsWith('/codex/models?'))) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(buildModelList(config.modelMapping)));
			return;
		}

		if (req.url === '/health' || req.url === '/') {
			const providerNames = Object.keys(config.providers || {});
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				status: 'ok',
				providers: providerNames,
				mappings: config.modelMapping ? config.modelMapping.length : 0,
			}));
			return;
		}

		let body = '';
		req.on('error', (err) => {
			log('warn', `[Proxy] Request error: ${err.message}`);
		});
		res.on('error', (err) => {
			log('warn', `[Proxy] Response error: ${err.message}`);
		});
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', () => {
			const url = req.url || '';

			// 检测是否为 OpenAI 原生请求 (Codex CLI/App)
			// Codex 新版使用 Responses API (/responses), 旧版使用 Chat Completions (/chat/completions)
			const isOpenAINative = url.includes('/chat/completions') || url.includes('/responses');
			// 检测是否为 Gemini 原生请求 (Gemini CLI)
			const isGeminiNative = url.includes('/models/') && (
				url.includes(':generateContent') || url.includes(':streamGenerateContent')
			);

			const interactionId = getNextInteractionId();
			req.interactionId = interactionId;
			req.clientSource = isOpenAINative ? 'codex' : (isGeminiNative ? 'gemini' : 'claudecode');
			const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
			const headerInfo = Object.entries(req.headers || {}).map(item => `${item[0]}: ${item[1]}`).join('\n');
			if (headerInfo) {
				logClientStage(req.clientSource, interactionId, '1', 'request', headerInfo + "\n\n----\n\n" + JSON.stringify(parsedBody, null, '\t'));
			}
			else {
				logClientStage(req.clientSource, interactionId, '1', 'request', parsedBody);
			}

			// 拦截防护性请求以减少 token 使用量
			if (req.clientSource === 'claudecode' && isDiabolicalClaudeRequest(parsedBody)) {
				log('info', `[Proxy] Intercepted diabolical Claude request: model=${parsedBody.model}, max_tokens=${parsedBody.max_tokens ?? 'unset'}`);
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					input_tokens: 0,
				}));
				return;
			}
			// 去掉可能出现的空对话
			if (sanitizeIncoming(parsedBody)) body = JSON.stringify(parsedBody);

			const sessionId = getSessionId(parsedBody, req.headers);
			log('debug', `[${sessionId} : ${req.method}] ${req.url}`);

			// OpenAI 原生路由 (Codex CLI / Codex App)
			if (isOpenAINative) {
				handleOpenAINativeRequest(config, req, body, res, sessionId);
				return;
			}
			// Gemini 原生路由 (Gemini CLI)
			if (isGeminiNative) {
				handleGeminiNativeRequest(config, req, body, res, sessionId);
				return;
			}

			let targetModel;
			let originalModel = null;
			let provider = null;
			let mapped = null;

			if (body && (req.url.includes('/v1/messages'))) {
				try {
					// Remove Anthropic billing headers from system prompt to prevent cache invalidation
					if (parsedBody.system) {
						parsedBody.system = removeBillingHeaderFromList(parsedBody.system);
					}
					if (Array.isArray(parsedBody.messages)) {
						parsedBody.messages.forEach(item => {
							item.content = removeBillingHeaderFromList(item.content);
						});
					}

					// Add Cyprite Mark!
					if (Array.isArray(parsedBody.system)) {
						parsedBody.system.some(item => {
							if (item.type === 'text' && item.text.match(/You are Claude Code/)) {
								item.text = item.text.replace(/You are Claude Code/g, 'You are Claude Code and your name is "Cyprite"');
								return true;
							}
							if (item.type === 'text' && item.text.match(/You are a Claude agent/)) {
								item.text = item.text.replace(/You are a Claude agent/g, 'You are a Claude agent and your name is "Cyprite"');
								return true;
							}
						});
					}
					else if ((typeof parsedBody.system) === "string") {
						parsedBody.system = parsedBody.system.replace(/You are Claude Code/g, 'You are Claude Code and your name is "Cyprite"');
						parsedBody.system = parsedBody.system.replace(/You are a Claude agent/g, 'You are a Claude agent and your name is "Cyprite"');
					}

					if (parsedBody.model) {
						originalModel = parsedBody.model;
						mapped = mapModel(parsedBody.model, config.modelMapping) || parsedBody.model;
						if (mapped) {
							targetModel = mapped.targetModel;
							provider = config.providers[mapped.provider];
							Object.defineProperty(provider, '_name', { value: mapped.provider, writable: true, enumerable: false, configurable: true });
							log('info', `Model: ${originalModel} → ${targetModel} (${mapped.provider})`);

							// Claude Code 走 Anthropic 兼容 provider 时,在分发前翻译 tools
							// (builtin 工具按 providerRender 渲染,普通 function 透传)
							// Codex/Gemini 已在原生 handler 内完成翻译,这里只处理 claudecode 路径
							if (req.clientSource === 'claudecode' && Array.isArray(parsedBody.tools)) {
								const beforeCount = parsedBody.tools.length;
								parsedBody.tools = translateTools(parsedBody.tools, 'claude_code', mapped.provider);
								log('debug', `[tool-translator] claudecode: ${beforeCount} → ${parsedBody.tools.length} tools for ${mapped.provider}`);
							}
						}
						else {
							log('warn', `Empty model name!`);
							res.writeHead(400, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									type: 'invalid_request_error',
									message: `Empty model name!`,
								},
							}));
							return;
						}

						if (!provider) {
							log('warn', `Provider not found: ${mapped.provider}`);
							res.writeHead(400, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									type: 'invalid_request_error',
									message: `Provider not configured: ${mapped.provider}`,
								},
							}));
							return;
						}

						// model 和 max_tokens 的设置已移入各 dispatch 路径的 buildBody,
						// 不再在此处做全局的 parsedBody 变更,避免在重试时复用旧的 model/max_tokens

						if (parsedBody.thinking && (parsedBody.thinking.type === 'adaptive' || parsedBody.thinking.type === 'enabled')) {
							const { getThinking } = require('./thinking-store');

							if (parsedBody.messages) {
								for (const msg of parsedBody.messages) {
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
											// log('debug', `Thinking: Restored ${restored.length} thinking block(s) for message in proxy-server`);
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
												// log('debug', `Thinking: Injected synthetic thinking block before tool_use ${firstToolUse.id}`);
											}
										}
									}
								}
							}

							const isMinimax = mapped.provider === 'minimax';
							if (parsedBody.thinking.type === 'adaptive') {
								if (isMinimax) {
									log('info', `Thinking: keeping adaptive for MiniMax ${targetModel}`);
								}
								else {
									parsedBody.thinking.type = 'enabled';
									log('info', `Thinking: adaptive → enabled for ${targetModel}`);
								}
							}
						}

						body = JSON.stringify(parsedBody);
					}
				}
				catch (e) {
					log('warn', `Failed to parse request body: ${e.message}`);
				}
			}

			if (!provider) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: {
						type: 'not_found_error',
						message: `Unsupported route: ${req.method} ${req.url}`,
					},
				}));
				return;
			}

			const providerType = provider.type || 'anthropic';

			if (providerType === 'auto') {
				handleAutoRequest(provider, targetModel, originalModel, req, body, res, config, sessionId);
			}
			else if (providerType === 'anthropic' || providerType === 'openai' || providerType === 'gemini') {
				// 非 auto 路径:单元素数组包装后走 modelRouter,统一 num_done/num_doing 统计和重试
				const spec = `${mapped.provider}/${targetModel}`;
				modelRouter.executeWithRetry({
					modelsArray: [spec],
					config,
					buildBody: (selected, p) => {
						const obj = JSON.parse(body);
						obj.model = selected.model;
						if (obj.max_tokens > 10) {
							obj.max_tokens = resolveMaxTokens(config, p, selected.model);
						}
						return JSON.stringify(obj);
					},
					dispatch: (p, m, pName, retryBody, onAttemptDone) => {
						if (providerType === 'anthropic') {
							handleAnthropicRequest(p, m, originalModel, req, retryBody, res, onAttemptDone);
						}
						else if (providerType === 'openai') {
							handleOpenAIRequest(p, m, originalModel, req, retryBody, res, onAttemptDone);
						}
						else {
							handleGeminiRequest(p, m, originalModel, req, retryBody, res, onAttemptDone);
						}
					},
					onDone: (err) => {
						if (err) {
							res.writeHead(502, { 'Content-Type': 'application/json' });
							res.end(JSON.stringify({
								error: {
									type: 'server_error',
									message: err.message,
								},
							}));
						}
					},
				});
			}
			else {
				log('warn', `Unknown provider type: ${providerType}`);
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: {
						type: 'invalid_request_error',
						message: `Unknown provider type: ${providerType}`,
					},
				}));
			}
		});
	});

	return server;
};

module.exports = { createProxyServer, mapModel };
