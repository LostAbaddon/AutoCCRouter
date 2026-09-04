const { log, getNextInteractionId, logClientStage } = require('../logger');
const { proxyRequest } = require('../proxy-agent');
const { recordUsage } = require('../usage-tracker');
const { buildOpenAIRequest } = require('../providers/openai-compat');
const { translateTools, enableHotReload, collectBuiltinKeys } = require('../tool-translator');
const { recordToolCall, lookupToolCall, removeToolCall } = require('../tool-translator/call-id-map');
const { saveThinking, getThinking } = require('../thinking-store');
const { acquireKey, releaseKey } = require('../key-state-manager');
const { classifyResponse, classifyStreamFirstBlock } = require('../error-detector');

enableHotReload();

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

// 为 functionCall 对应的 tool_use 构造 thinking 块(三档降级)
// 1) part.thought 原样构造 2) thinking-store 恢复 3) synthetic 兜底
const resolveThinkingForToolCall = (part, gemCallId, anthId) => {
	// 档位1:已从 Gemini part 解析出 thought 文本
	if (part.thought && part.text) {
		const tb = { type: 'thinking', thinking: part.text };
		if (part.thoughtSignature) tb.signature = part.thoughtSignature;
		return tb;
	}
	// 档位2:尝试从 thinking-store 恢复(Gemini 此前响应已保存)
	if (gemCallId || anthId) {
		const saved = getThinking(gemCallId) || getThinking(anthId);
		if (saved && saved.length > 0) {
			return { ...saved[0] };
		}
	}
	// 档位3:synthetic 兜底
	const id = gemCallId || anthId || 'unknown';
	const sig = part.thoughtSignature || ('synthetic:' + id);
	return { type: 'thinking', thinking: '(Synthetic thinking block for protocol compliance)', signature: sig };
};

// 将响应中的 thinking 块关联到 tool_use 并保存至 thinking-store
const saveThinkingBlocksForToolUses = (toolUses, thinkingBlocks) => {
	if (!Array.isArray(toolUses) || !Array.isArray(thinkingBlocks) || thinkingBlocks.length === 0) {
		return;
	}
	for (const tu of toolUses) {
		if (tu.id) {
			saveThinking(tu.id, thinkingBlocks);
		}
	}
};

// Gemini 请求 → Anthropic 请求
// targetProvider 用于 tool-translator 识别 provider 能力(如 minimax / deepseek / google)
const convertGeminiRequestToAnthropic = (geminiBody, modelName, targetProvider) => {
	const config = getConfig();

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
					if (part.text && !part.thought) {
						content.push({ type: 'text', text: part.text });
					}
					else if (part.thought && part.text) {
						// Gemini 的 thought 块 → Anthropic 的 thinking 块
						// 必须保留;否则下次请求 DeepSeek 校验 thinking mode 时因缺 thinking 而报 400
						const tBlock = { type: 'thinking', thinking: part.text };
						if (part.thoughtSignature) {
							tBlock.signature = part.thoughtSignature;
						}
						content.push(tBlock);
					}
					else if (part.functionCall) {
						// 只在 assistant (model) 消息中转 tool_use；user 消息中的回传 echo 忽略
						if (role === 'assistant') {
							const gemCallId = part.functionCall.id;
							const anthId = `toolu_gem_${toolUseSeq++}`;
							// Map both id and name so functionResponse can find the match
							if (gemCallId) {
								gemToAnthId.set(gemCallId, anthId);
							}
							if (part.functionCall.name) {
								gemToAnthId.set('name:' + part.functionCall.name, anthId);
							}
							// Thinking 恢复:DeepSeek 等 thinking-mode provider 要求 tool_use 必须有 thinking 块
							// 三档降级:part.thought(原样)→ thinking-store(Gemini 此前响应存过)→ 兜底
							const tBlock = resolveThinkingForToolCall(part, gemCallId, anthId);
							if (tBlock) {
								content.push(tBlock);
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
						// Cross-turn fallback:查 callIdMap 拿到上游 tool_use 的 id
						if (!toolUseId && fnId) {
							const callMeta = lookupToolCall(fnId);
							if (callMeta) {
								toolUseId = fnId;
								removeToolCall(fnId);
							}
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

	// Tools — Gemini 协议层兼容:
	// - 主路径: 大多数工具被压在一个外层 {functionDeclarations: [...]} 里 → 展平
	// - 备用路径: Gemini 客户端未来可能用原生字段 {googleSearch: {}} / {urlContext: {}} 等,原样保留
	// 两种路径都进 translateTools 统一识别 builtin key
	if (Array.isArray(geminiBody.tools)) {
		const flatTools = [];
		for (const outer of geminiBody.tools) {
			if (Array.isArray(outer.functionDeclarations)) {
				for (const fd of outer.functionDeclarations) {
					flatTools.push({
						name: fd.name,
						description: fd.description,
						parameters: fd.parametersJsonSchema || fd.parameters,
					});
				}
			}
			else {
				// 原生内置字段(googleSearch / urlContext / codeExecution) → 原样保留
				flatTools.push(outer);
			}
		}
		anthropicBody.tools = translateTools(flatTools, 'gemini_wrapped', targetProvider);
	}

	// Generation config
	anthropicBody.max_tokens = geminiBody.generationConfig?.maxOutputTokens || geminiBody.max_tokens || config.defaultMaxTokens || 131072;
	if (geminiBody.generationConfig) {
		const gc = geminiBody.generationConfig;
		if (gc.temperature !== undefined) {
			anthropicBody.temperature = gc.temperature;
		}
		if (gc.topP !== undefined) {
			anthropicBody.top_p = gc.topP;
		}
		// 设置 Thinking 配置
		const thinking = (gc.thinkingConfig?.thinkingLevel || '').toLowerCase();
		if (!thinking || thinking === 'none' || thinking === 'low') {
			anthropicBody.thinking = {
				type: "disabled",
			};
		}
		else {
			if (targetProvider === 'claude' || targetProvider === 'minimax') {
				anthropicBody.thinking = {
					type: "adaptive",
				};
			}
			else {
				anthropicBody.thinking = {
					type: "enabled",
				};
			}
		}
	}

	return anthropicBody;
};

// Anthropic 非流式响应 → Gemini 响应
const transformAnthropicToGeminiResponse = (anthropicResp, modelName, builtinKeys = new Set()) => {
	const content = anthropicResp.content || [];
	const parts = [];

	const thinkingBlocks = content.filter((b) => b.type === 'thinking' && b.thinking);
	const toolUses = content.filter((b) => b.type === 'tool_use');

	// 保存 thinking:将响应中第一个 thinking 块关联到所有 tool_use，供后续请求恢复
	if (toolUses.length > 0 && thinkingBlocks.length > 0) {
		saveThinkingBlocksForToolUses(toolUses, thinkingBlocks);
	}

	for (const block of content) {
		if (block.type === 'text' && block.text) {
			parts.push({ text: block.text });
		}
		else if (block.type === 'tool_use') {
			// 记录 tool_use_id → upstreamName,供后续 tool_result 翻译使用
			if (block.id) {
				recordToolCall(block.id, { upstreamName: block.name });
			}
			// 工具名回译:DS 把 urlContext 当作 web_fetch 执行,响应里的 tool_use.name = 'web_fetch'
			// 若原始请求里 builtinKeys 包含 url_context,应还原为 urlContext
			let name = block.name;
			if (name === 'web_fetch' && builtinKeys.has('url_context')) {
				name = 'urlContext';
			}
			const fc = {
				functionCall: {
					name,
					args: block.input || {},
				},
			};
			if (block.id) {
				fc.functionCall.id = block.id;
			}
			parts.push(fc);
		}
		else if (block.type === 'thinking' && block.thinking) {
			// 透传上游 thinking：无论调用方是谁，都必须把思考内容原样给到调用方
			parts.push({ thought: true, text: block.thinking });
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
const transformAnthropicStreamToGemini = (res, originalModel, anthropicStream, interactionId, usageMeta, builtinKeys = new Set(), onDone) => {
	let textContent = '';
	let streamInputTokens = 0;
	let streamOutputTokens = 0;
	let streamCacheReadTokens = 0;
	let done = false;

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	const writeSSE = (data) => {
		const chunkStr = `data: ${JSON.stringify(data)}\n\n`;
		res.write(chunkStr);
		logClientStage('gemini', interactionId, '4', 'response', chunkStr, true);
	};

	let buffer = '';
	let sseEventCount = 0;
	let sseDataLineCount = 0;

	// thinking 流式解析状态
	let activeThinkingIdx = -1;
	let activeThinkingSignature = '';
	let activeThinkingText = '';
	let lastThinking = null;

	// tool_use 流式解析状态
	let activeToolIdx = -1;
	let activeToolName = '';
	let activeToolId = '';
	let activeToolJson = '';
	const emittedToolParts = []; // 已发出的 Gemini parts(含 text 和 functionCall)

	anthropicStream.on('data', (chunk) => {
		const chunkStr = chunk.toString();
		logClientStage('gemini', interactionId, '3', 'response', chunkStr, true);
		
		buffer += chunkStr;
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
					streamInputTokens = Math.max(streamInputTokens, parsed.message.usage.input_tokens || 0);
					streamOutputTokens = Math.max(streamOutputTokens, parsed.message.usage.output_tokens || 0);
					streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.message.usage.cache_read_input_tokens || 0);
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
					// 实时向调用方发射 thought part —— 代理层无资格把 thinking 当成 text
					writeSSE({
						candidates: [{
							content: {
								role: 'model',
								parts: [{ thought: true, text: t }],
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
				// thinking 块完成:暂存到 lastThinking,等后续 tool_use 收尾时一起存到 thinking-store
				if (activeThinkingText) {
					lastThinking = {
						type: 'thinking',
						thinking: activeThinkingText,
						signature: activeThinkingSignature || '',
					};
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
					// 记录 tool_use_id → upstreamName,供后续 tool_result 翻译使用
					if (activeToolId) {
						recordToolCall(activeToolId, { upstreamName: activeToolName });
					}
					// 落盘 thinking 块:此前累积的 lastThinking 与本 tool_use 关联
					if (activeToolId && lastThinking) {
						saveThinking(activeToolId, [lastThinking]);
						lastThinking = null;
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
					streamInputTokens = Math.max(streamInputTokens, parsed.usage.input_tokens || 0);
					streamOutputTokens = Math.max(streamOutputTokens, parsed.usage.output_tokens || 0);
					streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.usage.cache_read_input_tokens || 0);
				}
			}
			else if (parsed.type === 'message_stop') {
				done = true;
				if (usageMeta && (streamInputTokens > 0 || streamOutputTokens > 0)) {
					recordUsage(usageMeta.providerName || 'gemini', usageMeta.targetModel, {
						input_tokens: streamInputTokens,
						output_tokens: streamOutputTokens,
						cache_read_tokens: streamCacheReadTokens,
					}, 'gemini', usageMeta);
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
		onDone();
	});
	anthropicStream.on('error', (e) => {
		res.end();
		onDone(e);
	});
};

// 直接转发 Gemini 请求（Provider 也是 Gemini 类型）
const forwardGeminiDirect = (provider, targetModel, originalModel, requestBody, req, sessionId, res, isStream, interactionId, onDone) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const apiKey = acquired.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, apiKey, opts);
	};

	// 请求体处理
	if (requestBody.max_tokens) {
		requestBody.generationConfig = requestBody.generationConfig || {};
		requestBody.generationConfig.maxOutputTokens = requestBody.max_tokens;
		delete requestBody.max_tokens;
	}
	if (requestBody.model) delete requestBody.model;
	if (requestBody.stream) delete requestBody.stream;

	const reqBody = JSON.stringify(requestBody);
	logClientStage('gemini', interactionId, '2', 'upstream', requestBody);

	const targetUrl = new URL(provider.baseUrl.replace(/\/+$/, ''));
	const pathPrefix = targetUrl.pathname.replace(/\/+$/, '');
	const action = isStream ? 'streamGenerateContent' : 'generateContent';
	const querySep = isStream ? '?alt=sse&' : '?';
	const path = `${pathPrefix}/models/${targetModel}:${action}${querySep}key=${encodeURIComponent(apiKey)}`;

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

	const onComplete = (err, isProviderDown=true, isKeyFailure=false) => {
		if (err) {
			log('error', `[Gemini-Native] ${err.message}`);
			settleKey({ isProviderDown, isKeyFailure });
			onDone(err);
			return;
		}
		settleKey({ isSuccess: true });
		onDone();
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) return onComplete(err);

		const responseHeaders = filterHopByHopHeaders(proxyRes.headers);

		if (isStream) {
			try {
				res.writeHead(proxyRes.statusCode, responseHeaders);
			} catch {}

			let sseBuffer = '';
			let usageData = null;
			let firstSseChecked = false;

			proxyRes.on('data', (chunk) => {
				const chunkStr = chunk.toString();
				if (!firstSseChecked) {
					firstSseChecked = true;
					const sseResult = classifyStreamFirstBlock(chunkStr);
					if (sseResult.isKeyFailure) { settleKey({ isKeyFailure: true }); }
				}
				res.write(chunk);
				if (interactionId) {
					logClientStage('gemini', interactionId, '3', 'response', chunkStr, true);
					logClientStage('gemini', interactionId, '4', 'result', chunkStr, true);
				}

				sseBuffer += chunkStr;
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
						cache_read_tokens: usageData.cachedContentTokenCount || 0,
					}, 'gemini', usageData);
				}

				onComplete();
			});
		}
		else {
			let responseBody = '';
			proxyRes.on('data', (chunk) => {
				responseBody += chunk;
			});
			proxyRes.on('end', () => {
				if (proxyRes.statusCode >= 400) {
					let parsed = null;
					try { parsed = JSON.parse(responseBody); } catch (e) {}
					const cr = classifyResponse(proxyRes.statusCode, parsed);
					onComplete(new Error(`[Gemini-Native] Direct API error: ${proxyRes.statusCode}`), cr.isProviderDown, cr.isKeyFailure);
					return;
				}

				try {
					res.writeHead(proxyRes.statusCode, responseHeaders);
				} catch {}
				res.end(responseBody);
				try {
					const resp = JSON.parse(responseBody);
					logClientStage('gemini', interactionId, '3', 'response', resp);
					logClientStage('gemini', interactionId, '4', 'result', resp);
					if (resp.usageMetadata) {
						recordUsage(provider._name || 'gemini', targetModel, {
							input_tokens: resp.usageMetadata.promptTokenCount || 0,
							output_tokens: resp.usageMetadata.candidatesTokenCount || 0,
							cache_read_tokens: resp.usageMetadata.cachedContentTokenCount || 0,
						}, 'gemini', resp.usageMetadata);
					}
				}
				catch (e) {
					logClientStage('gemini', interactionId, '3', 'response', responseBody);
					logClientStage('gemini', interactionId, '4', 'result', responseBody);
				}
				onComplete();
			});
		}
		proxyRes.on('error', (e) => {
			res.end();
			onComplete(e);
		});
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		onComplete(new Error('Upstream timeout'));
	});
};

// Gemini → Anthropic Provider
const forwardGeminiViaAnthropic = (provider, targetModel, originalModel, requestBody, req, sessionId, res, isStream, interactionId, onDone) => {
	const _origApiKey = provider.apiKey;
	const acquired = acquireKey(provider._name, _origApiKey);
	const key = acquired.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};

	const anthropicBody = convertGeminiRequestToAnthropic(requestBody, targetModel, provider._name);
	anthropicBody.stream = isStream || false;
	const reqBody = JSON.stringify(anthropicBody);
	logClientStage('gemini', interactionId, '2', 'upstream', anthropicBody);

	// 请求中涉及的内置工具 key 集合——响应方向根据此把 Anthropic 内置工具结果还原成 Gemini 客户端期望格式
	// (如 url_context 在 DS 上以 web_fetch 执行,响应要还原成 urlContext toolResponse 格式)
	const builtinKeys = collectBuiltinKeys(requestBody.tools || [], 'gemini_wrapped');

	const targetUrl = new URL(provider.baseUrl);
	const reqPath = targetUrl.pathname.replace(/\/+$/, '') + (targetUrl.pathname.match(/v\d\/(chat\/|messages\/)/) ? '' : '/v1/messages');

	const options = {
		hostname: targetUrl.hostname,
		port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
		path: reqPath,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': key,
			'anthropic-version': '2023-06-01',
			'Content-Length': Buffer.byteLength(reqBody),
		},
		rejectUnauthorized: false,
		_isHttps: targetUrl.protocol === 'https:',
	};

	const onComplete = (err, isProviderDown=true, isKeyFailure=false) => {
		if (err) {
			log('error', `[Gemini-Anthropic] ${err.message}`);
			settleKey({ isProviderDown, isKeyFailure });
			onDone(err);
			return;
		}
		settleKey({ isSuccess: true });
		onDone();
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) return onComplete(err);

		// 根据上游实际响应的 Content-Type 判断是否为流式，而非仅凭请求 URL
		const upstreamContentType = proxyRes.headers['content-type'] || '';
		const upstreamIsStream = upstreamContentType.includes('text/event-stream');
		log('debug', `[Gemini-Anthropic] upstream Content-Type: "${upstreamContentType}", isStream=${isStream}, upstreamIsStream=${upstreamIsStream}`);

		if (isStream && upstreamIsStream) {
			transformAnthropicStreamToGemini(res, originalModel, proxyRes, interactionId, { interactionId,
				providerName: provider._name,
				targetModel,
				interactionId,
			}, builtinKeys, onComplete);
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
					logClientStage('gemini', interactionId, '3', 'response', anthropicResp);
					if (anthropicResp.error) {
						const cr = classifyResponse(proxyRes.statusCode, anthropicResp);
						onComplete(new Error(`API error: ${proxyRes.statusCode}`), cr.isProviderDown, cr.isKeyFailure);
						return;
					}
					const geminiResp = transformAnthropicToGeminiResponse(anthropicResp, originalModel);
					const geminiJson = JSON.stringify(geminiResp);
					logClientStage('gemini', interactionId, '4', 'result', geminiJson);
					if (anthropicResp.usage) {
						recordUsage(provider._name || 'anthropic', targetModel, {
							input_tokens: anthropicResp.usage.input_tokens || 0,
							output_tokens: anthropicResp.usage.output_tokens || 0,
							cache_read_tokens: anthropicResp.usage.cache_read_input_tokens || 0,
						}, 'gemini', anthropicResp.usage);
					}

					// 如果客户端发的是流式请求但上游返回了 JSON，用 SSE 格式包裹返回
					if (isStream) {
						const ssePayload = `data: ${geminiJson}\n\n`;
						log('debug', `[Gemini-Native] SSE payload (${ssePayload.length}b): ${ssePayload.substring(0, 300)}`);
						res.writeHead(200, {
							'Content-Type': 'text/event-stream',
							'Cache-Control': 'no-cache',
							'Connection': 'keep-alive',
						});
						res.write(ssePayload);
						res.end();
					}
					else {
						res.writeHead(200, { 'Content-Type': 'application/json' });
						res.end(geminiJson);
					}
					onComplete();
				}
				catch (e) {
					onComplete(e);
				}
			});
			proxyRes.on('error', (e) => {
				onComplete(e);
			});
		}
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		onComplete(new Error('Upstream timeout'));
	});
};

// Gemini → OpenAI Provider (via Anthropic intermediate)
const forwardGeminiViaOpenAI = (provider, targetModel, originalModel, requestBody, req, sessionId, res, isStream, interactionId, onDone) => {
	const _origApiKey = provider.apiKey;
	const acq = acquireKey(provider._name, _origApiKey);
	const key = acq.key;

	let keySettled = false;
	const settleKey = (opts) => {
		if (keySettled) { return; }
		keySettled = true;
		releaseKey(provider._name, key, opts);
	};

	// Gemini → Anthropic → OpenAI
	const anthropicBody = convertGeminiRequestToAnthropic(requestBody, targetModel, provider._name);
	anthropicBody.stream = isStream || false;
	const openaiBody = buildOpenAIRequest(anthropicBody, provider._name, targetModel);
	openaiBody.model = targetModel;
	// 设置 Thinking 配置
	if (!requestBody.generationConfig?.thinkingConfig?.thinkingLevel) {
		if (provider._name === 'agnes') {
			openaiBody.chat_template_kwargs = {
				enable_thinking: false
			};
		}
		else if (provider._name === 'moonshot') {
			if (!targetModel.match(/k(2\.7|3)/i)) {
				openaiBody.thinking = {
					type: "disabled"
				};
			}
		}
		else {
			openaiBody.reasoning_effort = "none";
		}
	}
	else {
		const thinkingLevel = requestBody.generationConfig.thinkingConfig.thinkingLevel.toLowerCase();
		if (provider._name === 'agnes') {
			openaiBody.chat_template_kwargs = {
				enable_thinking: thinkingLevel !== 'low'
			};
		}
		else if (provider._name === 'moonshot') {
			if (targetModel.match(/k3/i)) {
				openaiBody.reasoning_effort = 'max';
			}
			else {
				openaiBody.thinking = {
					type: thinkingLevel === 'low' ? "disabled" : "enabled"
				};
			}
		}
		else {
			openaiBody.reasoning_effort = thinkingLevel;
		}
	}
	const reqBody = JSON.stringify(openaiBody);
	logClientStage('gemini', interactionId, '2', 'upstream', openaiBody);

	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const targetUrl = new URL(baseUrl);
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

	const onComplete = (err, isProviderDown=true, isKeyFailure=false) => {
		if (err) {
			log('error', `[Gemini-OpenAI] ${err.message}`);
			settleKey({ isProviderDown, isKeyFailure });
			onDone(err);
			return;
		}
		settleKey({ isSuccess: true });
		onDone();
	};

	const proxyReq = proxyRequest(provider.proxy, options, reqBody, (err, proxyRes) => {
		if (err) return onComplete(err);

		// 根据上游实际响应的 Content-Type 判断是否为流式
		const upstreamIsStream = (proxyRes.headers['content-type'] || '').includes('text/event-stream');

		if (isStream && upstreamIsStream) {
			transformOpenAIStreamToGemini(res, originalModel, proxyRes, interactionId, { providerName: provider._name, targetModel, interactionId }, onComplete);
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
					if (openaiResp.error) {
						const cr = classifyResponse(proxyRes.statusCode, openaiResp);
						onComplete(new Error(`OpenAI API error: ${openaiResp.error.message || proxyRes.statusCode}`), cr.isProviderDown, cr.isKeyFailure);
						return;
					}
					const geminiResp = transformOpenAIToGeminiResponse(openaiResp, originalModel);
					logClientStage('gemini', interactionId, '4', 'result', geminiResp);
					if (openaiResp.usage) {
						recordUsage(provider._name || 'openai', targetModel, {
							input_tokens: openaiResp.usage.prompt_tokens || 0,
							output_tokens: openaiResp.usage.completion_tokens || 0,
							cache_read_tokens: openaiResp.usage.prompt_tokens_details?.cached_tokens || 0,
						}, 'gemini', openaiResp.usage);
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
					onComplete();
				}
				catch (e) {
					onComplete(e);
				}
			});
			proxyRes.on('error', (e) => {
				onComplete(e);
			});
		}
	});

	proxyReq.setTimeout(300000);
	proxyReq.on('timeout', () => {
		proxyReq.destroy();
		onComplete(new Error('Upstream timeout'));
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

	// 透传上游 reasoning_content：无论调用方是谁，都必须把思考内容原样给到调用方
	if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
		parts.push({ thought: true, text: message.reasoning_content });
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
const transformOpenAIStreamToGemini = (res, originalModel, openaiStream, interactionId, usageMeta, onDone) => {
	let textContent = '';
	let streamPromptTokens = 0;
	let streamCompletionTokens = 0;
	let streamCacheReadTokens = 0;
	let finishReason = 'STOP';

	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
	});

	const writeSSE = (data) => {
		const msg = `data: ${JSON.stringify(data)}\n\n`;
		res.write(msg);
		logClientStage('gemini', interactionId, '4', 'result', msg);
	};

	let buffer = '';
	openaiStream.on('data', (chunk) => {
		buffer += chunk.toString();

		const lines = buffer.split('\n');
		buffer = lines.pop() || '';
		logClientStage('gemini', interactionId, '3', 'response', lines.join('\n'));

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
				streamPromptTokens = Math.max(streamPromptTokens, parsed.usage.prompt_tokens || 0);
				streamCompletionTokens = Math.max(streamCompletionTokens, parsed.usage.completion_tokens || 0);
				streamCacheReadTokens = Math.max(streamCacheReadTokens, parsed.usage.prompt_tokens_details?.cached_tokens || 0);
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

				// 透传上游 reasoning_content：无论调用方是谁，都必须把思考内容原样给到调用方
				if (delta.reasoning_content) {
					writeSSE({
						candidates: [{
							content: {
								role: 'model',
								parts: [{ thought: true, text: delta.reasoning_content }],
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
		if (usageMeta && (streamPromptTokens > 0 || streamCompletionTokens > 0)) {
			recordUsage(usageMeta.providerName || 'openai', usageMeta.targetModel, {
				input_tokens: streamPromptTokens,
				output_tokens: streamCompletionTokens,
				cache_read_tokens: streamCacheReadTokens,
			}, 'gemini', usageMeta);
		}
		res.end();
	});
	openaiStream.on('error', (e) => {
		res.end();
		onDone(e);
	});
};

// 主处理函数
const handleGeminiNativeRequest = (provider, targetModel, originalModel, sessionId, req, requestBody, res, onDone) => {
	if (typeof requestBody === 'string') requestBody = JSON.parse(requestBody);

	// Detect stream mode from URL
	const isStream = req.url.includes('streamGenerateContent') || req.url.includes('alt=sse');
	log('info', `[Gemini-Native] ${originalModel} → ${targetModel} (${provider._name}, type=${provider.type}, stream=${isStream})`);

	const interactionId = req.interactionId || getNextInteractionId();

	if (provider.type === 'gemini') {
		forwardGeminiDirect(provider, targetModel, originalModel, requestBody, req, sessionId, res, isStream, interactionId, onDone);
	}
	else if (provider.type === 'anthropic') {
		forwardGeminiViaAnthropic(provider, targetModel, originalModel, requestBody, req, sessionId, res, isStream, interactionId, onDone);
	}
	else if (provider.type === 'openai') {
		forwardGeminiViaOpenAI(provider, targetModel, originalModel, requestBody, req, sessionId, res, isStream, interactionId, onDone);
	}
	else {
		throw new Error(`Unknown provider type: ${provider.type}`);
	}
};

module.exports = {
	handleGeminiNativeRequest,
};
