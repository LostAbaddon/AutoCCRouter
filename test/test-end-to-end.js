// 端到端联调 — 模拟 Codex/Gemini/Claude 真实请求,验证 handler 翻译结果
// 不启动 cc2llm 代理服务器,只调用 handler 的转换函数

global.cc2llmConfig = { logLevel: 'error' };

let passed = 0;
let failed = 0;

const assert = (condition, msg) => {
	if (condition) {
		passed++;
	}
	else {
		failed++;
		console.error(`  FAIL: ${msg}`);
	}
};

const test = (name, fn) => {
	process.stdout.write(`Testing ${name}... `);
	try {
		fn();
		console.log('DONE');
	}
	catch (e) {
		failed++;
		console.error(`ERROR: ${e.message}`);
		console.error(e.stack);
	}
};

// ============ Codex → Minimax 端到端 ============

test('E2E Codex Responses API → Minimax(Anthropic 协议)', () => {
	const { convertResponsesRequestToAnthropic } = require('../lib/handlers/openai-native');

	// 模拟 Codex 实际发出的请求(简化)
	const codexRequest = {
		model: 'gpt-5',
		stream: true,
		input: [{ role: 'user', content: '搜索 Claude Code 最新版本号' }],
		tools: [
			{ type: 'web_search', external_web_access: true, search_content_types: ['text'] },
			{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
		],
	};

	// minimax provider (provider._name = 'minimax')
	const result = convertResponsesRequestToAnthropic(codexRequest, 'claude-sonnet-4.6', 'test-session', 'minimax');

	// 关键验证 1: web_search 应翻译为 Anthropic 内置工具(不是普通 function)
	const webSearch = result.tools.find((t) => t.name === 'web_search' || t.type === 'web_search_20260209');
	assert(webSearch, 'web_search 工具应被保留');
	assert(webSearch.type === 'web_search_20260209', `【关键】web_search 应为 web_search_20260209,实际 type=${webSearch.type}`);
	assert(!webSearch.input_schema, '【关键】web_search 不应含 input_schema(否则就降级为普通 function,MM 不会自己执行)');

	// 验证 2: 普通 user tool 仍按 function 处理
	const weatherTool = result.tools.find((t) => t.name === 'get_weather');
	assert(weatherTool, 'get_weather user tool 应被保留');
	assert(weatherTool.input_schema, 'user tool 应保持 input_schema');
});

test('E2E Codex Chat API → DeepSeek(Anthropic 协议)', () => {
	const { convertOpenAIRequestToAnthropic } = require('../lib/handlers/openai-native');

	// 模拟 Codex Chat API 风格的请求
	const codexRequest = {
		model: 'gpt-5',
		stream: false,
		messages: [{ role: 'user', content: '查一下明天北京天气' }],
		tools: [
			{
				type: 'function',
				function: {
					name: 'web_search',
					description: 'Search the web',
					parameters: { type: 'object', properties: { query: { type: 'string' } } },
				},
			},
		],
	};

	const result = convertOpenAIRequestToAnthropic(codexRequest, 'deepseek-v4-pro', 'test-session', 'deepseek');

	const webSearch = result.tools[0];
	assert(webSearch.type === 'web_search_20260209', `【关键】Chat API 的 web_search function 应翻译为内置,实际 type=${webSearch.type}`);
	assert(!webSearch.input_schema, '【关键】不应含 input_schema');
});

test('E2E Gemini CLI → DeepSeek(wrapped 模式)', () => {
	const { convertGeminiRequestToAnthropic } = require('../lib/handlers/gemini-native');

	// 模拟 Gemini CLI 实际请求(简化)
	const geminiRequest = {
		contents: [{ role: 'user', parts: [{ text: '查一下 Anthropic 最新公告' }] }],
		tools: [{
			functionDeclarations: [{
				name: 'google_web_search',
				description: 'Web search',
				parameters: { type: 'object', properties: { query: { type: 'string' } } },
			}],
		}],
	};

	const result = convertGeminiRequestToAnthropic(geminiRequest, 'deepseek-v4-pro', 'deepseek');

	const webSearch = result.tools[0];
	assert(webSearch.type === 'web_search_20260209', `【关键】Gemini CLI wrapped 应翻译为内置,实际 type=${webSearch.type}`);
	assert(!webSearch.input_schema, '【关键】不应含 input_schema');
});

test('E2E Gemini CLI → Google provider(customtools 模式)', () => {
	const { convertGeminiRequestToAnthropic } = require('../lib/handlers/gemini-native');

	// 模拟 Gemini CLI 发出 wrapped 形式,但目标是 google provider
	const geminiRequest = {
		contents: [{ role: 'user', parts: [{ text: '查个事' }] }],
		tools: [{
			functionDeclarations: [{
				name: 'google_web_search',
				description: 'Web search',
				parameters: { type: 'object', properties: { query: { type: 'string' } } },
			}],
		}],
	};

	// translator 直接输出 googleSearch: {} (providerRender.google 的 web_search → googleSearch {} 原生格式)
	const anthropicBody = convertGeminiRequestToAnthropic(geminiRequest, 'gemini-3.1-pro-preview', 'google');
	const tool = anthropicBody.tools[0];
	assert(tool.googleSearch !== undefined, '【关键】google provider 应直接输出 googleSearch: {} 格式');
});

test('E2E Codex → Google provider 走原生 Gemini 协议', () => {
	const { convertResponsesRequestToAnthropic } = require('../lib/handlers/openai-native');

	const codexRequest = {
		model: 'gpt-5',
		stream: false,
		input: [{ role: 'user', content: 'test' }],
		tools: [{ type: 'web_search', external_web_access: true, search_content_types: ['text'] }],
	};

	// providerRender.google.web_search → googleSearch: {} (原生格式,直接输出)
	const anthropicBody = convertResponsesRequestToAnthropic(codexRequest, 'gemini-3.1-pro-preview', 'test', 'google');
	const tool = anthropicBody.tools[0];
	assert(tool.googleSearch !== undefined, '【关键】google provider 下 web_search 直接转为 googleSearch: {}');
});


test('E2E Gemini thought 块 → Anthropic thinking 块(关键: 不可丢失)', () => {
	const { convertGeminiRequestToAnthropic } = require('../lib/handlers/gemini-native');

	// 模拟 Gemini CLI 带有 thought: true 的 part(来自之前 DeepSeek 的思维链)
	const geminiRequest = {
		contents: [
			{ role: 'user', parts: [{ text: '帮我查一下东西' }] },
			{ role: 'model', parts: [
				{ thought: true, text: '用户需要我查询一些信息,让我想一想...' },
				{ text: '我查询到的结果如下: ...' },
			]},
			{ role: 'user', parts: [{ text: '继续分析' }] },
		],
	};

	const result = convertGeminiRequestToAnthropic(geminiRequest, 'deepseek-v4-pro', 'deepseek');
	// 第二个消息 (role=assistant, 对应 Gemini role=model)
	const assistantMsg = result.messages.find((m) => m.role === 'assistant');
	assert(assistantMsg, '应有 assistant 消息');
	const thinkingBlock = assistantMsg.content.find((b) => b.type === 'thinking');
	assert(thinkingBlock, '【关键】thought 块必须被转换为 thinking 块(否则下次 DeepSeek 请求会因缺 thinking 而 400)');
	assert(thinkingBlock.thinking && thinkingBlock.thinking.length > 0, 'thinking 内容非空');
	const textBlock = assistantMsg.content.find((b) => b.type === 'text');
	assert(textBlock, '普通 text 部分也应保留');
});


console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
