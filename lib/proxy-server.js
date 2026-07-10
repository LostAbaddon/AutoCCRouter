const http = require('http');
const { log, getNextInteractionId, logClientStage } = require('./logger');
const { resolveMaxTokens } = require('./config');
const { mapModel, matchModelsByRule, isWildcardPrefix } = require('./model-mapper');
const { handleAnthropicRequest } = require('./providers/anthropic-compat');
const { handleOpenAIRequest } = require('./providers/openai-compat');
const { handleGeminiRequest } = require('./providers/gemini');
const { autoModelRouter, handleAutoRequest } = require('./providers/auto');
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

const antiProtection = (res, body, copilotType) => {
	if (copilotType.isClaude) {
		// 减少 token 使用量：Claude Code 会发出大量 max_tokens 极小的请求以获取当前 token 使用量或别的作用，反而会增加 input/cache 开销
		if (isDiabolicalClaudeRequest(body)) {
			log('info', `[Proxy] Intercepted diabolical Claude request: model=${body.model}, max_tokens=${body.max_tokens ?? 'unset'}`);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				input_tokens: 0,
			}));
			return true;
		}
		// 移除 Claude Code 独有计费头以增加 Cache 命中
		if (body.system) {
			body.system = removeBillingHeaderFromList(body.system);
		}
		if (Array.isArray(body.messages)) {
			body.messages.forEach(item => {
				item.content = removeBillingHeaderFromList(item.content);
			});
		}
	}
};
const addCypriteMark = (body, copilotType) => {
	if (copilotType.isClaude) {
		if (Array.isArray(body.system)) {
			body.system.some(item => {
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
		else if ((typeof body.system) === "string") {
			body.system = body.system.replace(/You are Claude Code/g, 'You are Claude Code and your name is "Cyprite"');
			body.system = body.system.replace(/You are a Claude agent/g, 'You are a Claude agent and your name is "Cyprite"');
		}
	}
	else if (copilotType.isOpenAI) {
		if (Array.isArray(body.instructions)) {
			body.instructions.some(item => {
				if (item.type === 'text' && item.text.match(/You are Codex/)) {
					item.text = item.text.replace(/You are Codex/g, 'You are Codex and your name is "Cyprite"');
					return true;
				}
			});
		}
		else if ((typeof body.instructions) === "string") {
			body.instructions = body.instructions.replace(/You are Codex/g, 'You are Codex and your name is "Cyprite"');
		}
	}
	else if (copilotType.isGemini) {
		if (Array.isArray(body.systemInstruction?.parts)) {
			body.systemInstruction.parts.some(item => {
				if (item.text.match(/You are Gemini CLI/)) {
					item.text = item.text.replace(/You are Gemini CLI/g, 'You are Gemini CLI and your name is "Cyprite"');
					return true;
				}
			});
		}
		else if ((typeof body.systemInstruction) === "string") {
			body.systemInstruction = body.systemInstruction.replace(/You are Gemini CLI/g, 'You are Gemini CLI and your name is "Cyprite"');
		}
	}
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
		let sessionContent = '';
		for (const content of body.contents) {
			if (content.role === 'user' && Array.isArray(content.parts)) {
				for (const item of content.parts) {
					if (typeof item.text === 'string') {
						let text = item.text.trim();
						text = text.replace(/<([\w _\-]+)>[\w\W]*?<\/\1>/g, '').replace(/\s+/g, '').trim();
						if (text) {
							sessionContent += text;
							if (sessionContent.length > 40) break;
						}
					}
				}
				if (sessionContent.length > 40) break;
			}
		}
		if (sessionContent) {
			sessionContent = sessionContent.substring(0, 40);
			return sessionContent;
		}
	}

	return null;
};
const getProviderAndModel = (body, url, config, copilotType) => {
	let targetProvider = null, targetModel = null, originModel = null;

	if (copilotType.isGemini) {
		const match = String(url || '').match(/\/models\/([^:]+):/);
		originModel = match ? match[1] : null;
	}
	else {
		originModel = body.model;
	}
	if (!originModel) return { error: 'Missing model parameter' };

	const modelList = matchModelsByRule(originModel, config.modelMapping);
	if (!modelList) return { error: `No mapping for model: ${originModel}` };

	if (modelList.provider === 'auto') {
		targetModel = modelList.targetModel;
		targetProvider = {
			type: "auto",
			_name: "auto",
		};
	}
	else {
		targetModel = Array.isArray(modelList.targetModel) ? modelList.targetModel : [modelList.targetModel];
		targetProvider = config.providers[modelList.provider];
	}
	log('info', `Model: ${originModel} → ${targetModel} (${modelList.provider})`);

	return {
		targetProvider,
		targetModel,
		originModel,
	};
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

const createProxyServer = () => {
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

		// 获取模型列表
		if (req.url && req.url.match(/^\/(v1|codex)\/models(?:\?.*)?$/i)) {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(buildModelList(config.modelMapping)));
			return;
		}
		// 获取系统运行状况
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

		// temp
		const isNativeSearchEngine = (provider) => {
			const engine = config?.searchEngine?.[provider] || config?.searchEngine?.default;
			return !engine || ["native", "builtin", "default"].includes(engine.toLowerCase());
		};

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
		req.on('end', async () => {
			const url = req.url || '';

			// 判断 Copilot 类型
			const CopilotType = {
				isOpenAI: url.includes('/chat/completions') || url.includes('/responses'),
				isGemini: url.includes('/models/') && url.match(/:(generate|streamGenerate)Content/),
			};
			CopilotType.isClaude = !CopilotType.isOpenAI && !CopilotType.isGemini;

			// 日志标记
			const interactionId = getNextInteractionId();
			req.interactionId = interactionId;
			req.clientSource = CopilotType.isOpenAI ? 'codex' : (CopilotType.isGemini ? 'gemini' : 'claudecode');

			// 解析请求
			const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
			const headerInfo = Object.entries(req.headers || {}).map(item => `${item[0]}: ${item[1]}`).join('\n');
			// 获取 Session Id
			const sessionId = getSessionId(parsedBody, req.headers);
			log('debug', `[${sessionId} : ${req.method}] ${req.url}`);
			// 获取 Provider/Model
			const modelInfo = getProviderAndModel(parsedBody, url, config, CopilotType);
			if (modelInfo.error) {
				log('error', `[${sessionId} : ${req.method}] ${modelInfo.error}`);
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: modelInfo.error } }));
				return;
			}
			else {
				log('debug', `[${sessionId} : ${req.method}] ${req.url}`);
			}

			// 反防护拦截
			const shouldStop = antiProtection(res, parsedBody, CopilotType);
			if (shouldStop) return;
			// 去掉可能出现的空对话
			sanitizeIncoming(parsedBody);
			// 添加 Cyprite 印记
			addCypriteMark(parsedBody, CopilotType);

			// AutoModelRouter
			if (modelInfo.targetProvider.type === 'auto' && (typeof modelInfo.targetModel === 'string')) {
				try {
					const models = await autoModelRouter(modelInfo.targetModel, sessionId, parsedBody, CopilotType);
					if (models?.length) {
						modelInfo.targetModel = models;
					}
					else {
						log('error', `[AutoModelRouter] no suitable model for new working mode`);
						res.writeHead(400, { 'Content-Type': 'application/json' });
						res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: "No suitable model for new working mode" } }));
						return;
					}
				}
				catch (err) {
					log('error', `[AutoModelRouter] determine model failed: ${err.message}`);
					console.error(err);
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: "Failed to fetch working mode and its matching models" } }));
					return;
				}
			}

			// 获取 Provider/Model 列表
			const actionModels = [];
			if (Array.isArray(modelInfo.targetModel)) {
				modelInfo.targetModel.forEach(model => {
					const parts = model.split('/');
					const provider = parts.shift();
					if (!config.providers[provider]) return;
					actionModels.push({
						provider: config.providers[provider],
						model: parts.join('/'),
					});
				});
			}
			else {
				actionModels.push({
					provider: modelInfo.targetProvider,
					model: modelInfo.targetModel,
				});
			}

			// 重新生成文本版请求体
			body = JSON.stringify(parsedBody);
			// 记录原始请求
			if (headerInfo) {
				logClientStage(req.clientSource, interactionId, '1', 'request', headerInfo + "\n\n----\n\n" + JSON.stringify(parsedBody, null, '\t'));
			}
			else {
				logClientStage(req.clientSource, interactionId, '1', 'request', parsedBody);
			}

			// 生成执行函数
			const generateRequestHandler = (handler) => async (requestBody, ...args) => {
				// 选择模型
				const models = [...actionModels];
				const selection = modelRouter.selectModel(models);
				if (!selection) {
					log('error', "[AutoModelRouter] No model for modelRouter");
					return;
				}
				const idx = actionModels.findIndex(item => item.provider._name === selection.providerName && item.model === selection.model);
				if (idx >= 0) {
					actionModels.splice(idx, 1);
				}
				const config = getConfig();
				const provider = config.providers[selection.providerName];
				if (!provider) {
					log('warn', `[AutoModelRouter] Provider not found: ${selection.providerName}, retrying...`);
					throw new Error(`Provider not found: ${selection.providerName}`);
				}
				console.log('x'.repeat(100), provider.type, provider._name, selection.model);

				// 复制请求
				const reqBody = JSON.parse(JSON.stringify(requestBody));
				reqBody.model = selection.model;
				reqBody.max_tokens = resolveMaxTokens(provider, selection.model);

				return await handler(provider, selection.model, reqBody, ...args);
			};

			// 正式执行
			let handler;
			// Claude Code / Cowork
			if (CopilotType.isClaude) {
				handler = generateRequestHandler(async (provider, model, requestBody) => new Promise((resolve, reject) => {
					try {
						// Claude Code 走 Anthropic 兼容 provider 时，在分发前翻译 tools
						// (builtin 工具按 providerRender 渲染,普通 function 透传)
						if (Array.isArray(requestBody.tools)) {
							const beforeCount = requestBody.tools.length;
							requestBody.tools = translateTools(requestBody.tools, 'claude_code', modelInfo.targetProvider._name);
							log('debug', `[tool-translator] claudecode: ${beforeCount} → ${requestBody.tools.length} tools for ${modelInfo.targetProvider._name}`);
						}

						// 处理 Thinking 块，需要调整
						if (requestBody.thinking && (requestBody.thinking.type === 'adaptive' || requestBody.thinking.type === 'enabled')) {
							const { getThinking } = require('./thinking-store');
							if (requestBody.messages) {
								for (const msg of requestBody.messages) {
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

							if (requestBody.thinking.type === 'adaptive') {
								if (modelInfo.targetProvider._name === 'anthropic') {
									requestBody.output_config = parsedBody.output_config || {};
									parsedBody.output_config.effort = parsedBody.output_config.effort || 'high';
								}
								else if (modelInfo.targetProvider._name === 'minimax') {
									delete parsedBody.output_config;
								}
								else {
									parsedBody.thinking.type = "enabled";
									if (parsedBody.max_tokens > 0) {
										parsedBody.thinking.budget_tokens = Math.ceil(parsedBody.max_tokens * 0.4); // 最多使用40$用于思考
									}
								}
							}
						}
					}
					catch (e) {
						log('warn', `Failed to parse request body: ${e.message}`);
					}

					// 结束处理
					let settled = false;
					const onDone = (err) => {
						if (settled) return;
						settled = true;

						modelRouter.finishTask(provider._name, model, !err, !!err);

						if (err) {
							log('error', `[AutoModelRouter] ${provider._name}/${model} failed: ${err.message}`);
							console.error(err);
							return reject(err);
						}
						resolve();
					};

					// 启动任务
					modelRouter.startTask(provider._name, model);
					try {
						if (provider.type === 'anthropic') {
							handleAnthropicRequest(provider, model, modelInfo.originModel, req, requestBody, res, onDone);
						}
						else if (provider.type === 'openai') {
							handleOpenAIRequest(provider, model, modelInfo.originModel, req, requestBody, res, onDone);
						}
						else if (provider.type === 'gemini') {
							handleGeminiRequest(provider, model, modelInfo.originModel, req, requestBody, res, onDone);
						}
						else {
							onDone(new Error(`No provider for type "${provider.type}"`));
						}
					}
					catch (err) {
						onDone(err);
					}
				}));
			}
			// Codex CLI / App
			else if (CopilotType.isOpenAI) {
				handler = generateRequestHandler(async (provider, model, requestBody) => new Promise((resolve, reject) => {
					// 调整请求体参数
					requestBody.max_output_tokens = requestBody.max_tokens;
					requestBody.max_completion_tokens = requestBody.max_tokens;

					// 结束处理
					let settled = false;
					const onDone = (err) => {
						if (settled) return;
						settled = true;

						modelRouter.finishTask(provider._name, model, !err, !!err);

						if (err) {
							log('error', `[AutoModelRouter] ${provider._name}/${model} failed: ${err.message}`);
							console.error(err);
							return reject(err);
						}
						resolve();
					};

					// 启动任务
					modelRouter.startTask(provider._name, model);
					try {
						handleOpenAINativeRequest(provider, model, modelInfo.originModel, sessionId, req, requestBody, res, onDone);
					}
					catch (err) {
						onDone(err);
					}
				}));
			}
			// Gemini CLI
			else if (CopilotType.isGemini) {
				handler = generateRequestHandler(async (provider, model, requestBody) => new Promise((resolve, reject) => {
					// 结束处理
					let settled = false;
					const onDone = (err) => {
						if (settled) return;
						settled = true;

						modelRouter.finishTask(provider._name, model, !err, !!err);

						if (err) {
							log('error', `[AutoModelRouter] ${provider._name}/${model} failed: ${err.message}`);
							console.error(err);
							return reject(err);
						}
						resolve();
					};

					// 启动任务
					modelRouter.startTask(provider._name, model);
					try {
						handleGeminiNativeRequest(provider, model, modelInfo.originModel, sessionId, req, requestBody, res, onDone);
					}
					catch (err) {
						onDone(err);
					}
				}));
			}

			try {
				await executeWithRetry(handler, actionModels.length)(parsedBody);
			}
			catch (err) {
				res.writeHead(502, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					error: {
						type: 'server_error',
						message: err.message,
					},
				}));
			}
		});
	});

	return server;
};

module.exports = { createProxyServer, mapModel };
