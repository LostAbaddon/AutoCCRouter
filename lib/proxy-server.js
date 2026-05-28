const http = require('http');
const { log } = require('./logger');
const { resolveMaxTokens } = require('./config');
const { mapModel } = require('./model-mapper');
const { handleAnthropicRequest } = require('./providers/anthropic-compat');
const { handleOpenAIRequest } = require('./providers/openai-compat');
const { handleGeminiRequest } = require('./providers/gemini');
const { handleAutoRequest } = require('./providers/auto');
const { handleOpenAINativeRequest } = require('./handlers/openai-native');
const { handleGeminiNativeRequest } = require('./handlers/gemini-native');

const buildModelList = (modelMapping) => {
	const models = [];
	const today = new Date().toISOString().split('T')[0];
	for (const rule of modelMapping) {
		models.push({
			id: rule.prefix,
			object: 'model',
			type: 'model',
			display_name: rule.prefix,
			created: Math.floor(Date.now() / 1000),
			created_at: today,
			owned_by: rule.provider || 'cc2llm',
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

			const sessionId = (typeof body === 'string' ? (() => {
				try {
					let json = JSON.parse(body);
					if (typeof json.metadata?.user_id === 'string') {
						json = JSON.parse(json.metadata?.user_id);
						return json.session_id;
					}
					else {
						return json.metadata?.user_id?.session_id;
					}
				} catch {};
			})() : (() => {
				if (typeof body.metadata?.user_id === 'string') {
					let json = JSON.parse(body.metadata?.user_id);
					return json.session_id;
				}
				else {
					return body.metadata?.user_id?.session_id;
				}
			})()) || req.headers?.["x-claude-code-session-id"] || null;
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

			if (body && (req.url.includes('/v1/messages'))) {
				try {
					const parsed = JSON.parse(body);
					
					// Remove Anthropic billing headers from system prompt to prevent cache invalidation
					if (parsed.system) {
						if (typeof parsed.system === 'string') {
							parsed.system = parsed.system.replace(/^x-anthropic-billing-header:.*?\n/gim, '');
						} else if (Array.isArray(parsed.system)) {
							parsed.system = parsed.system.map(block => {
								if (block && block.type === 'text' && block.text) {
									block.text = block.text.replace(/^x-anthropic-billing-header:.*?\n/gim, '');
								}
								return block;
							});
							// Optional: remove any completely empty blocks
							parsed.system = parsed.system.filter(b => !(b.type === 'text' && !b.text.trim() && !b.cache_control));
						}
					}
					
					if (parsed.model) {
						originalModel = parsed.model;
						const mapped = mapModel(parsed.model, config.modelMapping) || parsed.model;
						if (mapped) {
							targetModel = mapped.targetModel;
							provider = config.providers[mapped.provider];
						provider._name = mapped.provider;
							log('info', `Model: ${originalModel} → ${targetModel} (${mapped.provider})`);
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

						parsed.model = targetModel;

						// 对非 auto provider 设置目标模型的 max_tokens
						if (provider.type !== 'auto') {
							const resolvedMaxTokens = resolveMaxTokens(config, provider, targetModel);
							parsed.max_tokens = resolvedMaxTokens;
							log('debug', `[Proxy] max_tokens set to ${resolvedMaxTokens} for ${mapped.provider}/${targetModel}`);
						}

						if (parsed.thinking && parsed.thinking.type === 'adaptive') {
							const hasToolUseWithoutThinking = (parsed.messages || []).some((msg) => {
								if (msg.role !== 'assistant') {
									return false;
								}
								const blocks = Array.isArray(msg.content) ? msg.content : [];
								const hasToolUse = blocks.some((b) => b.type === 'tool_use');
								const hasThinking = blocks.some((b) => b.type === 'thinking');
								return hasToolUse && !hasThinking;
							});
							if (!hasToolUseWithoutThinking) {
								parsed.thinking.type = 'enabled';
								log('info', `Thinking: adaptive → enabled for ${targetModel}`);
							}
						}

						body = JSON.stringify(parsed);
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

			if (providerType === 'anthropic') {
				handleAnthropicRequest(provider, targetModel, originalModel, req, body, res);
			}
			else if (providerType === 'openai') {
				handleOpenAIRequest(provider, targetModel, originalModel, req, body, res);
			}
			else if (providerType === 'gemini') {
				handleGeminiRequest(provider, targetModel, originalModel, req, body, res);
			}
			else if (providerType === 'auto') {
				handleAutoRequest(provider, targetModel, originalModel, req, body, res, config, sessionId);
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
