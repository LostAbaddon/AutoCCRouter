// 测试 lib/tool-translator — 配置驱动的内置工具翻译器
// 验证: Codex/Gemini/ClaudeCode 的内置 web_search 不会被降级为普通 function

global.cc2llmConfig = { logLevel: 'error' };

const { translateTools, loadConfig, recognizeTools } = require('../lib/tool-translator');

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

// ============ 单元测试 ============

test('配置加载', () => {
	const cfg = loadConfig();
	assert(cfg.version === '1.0.0', `version 应为 1.1.0, 实际 ${cfg.version}`);
	assert(cfg.copilots['openai_responses'], '应包含 openai_responses copilot');
	assert(cfg.copilots['gemini_wrapped'], '应包含 gemini_wrapped copilot');
	assert(cfg.providerRender && cfg.providerRender.deepseek, '应包含 deepseek providerRender');
	assert(cfg.providerRender && cfg.providerRender.google, '应包含 google providerRender');
	assert(cfg.defaultRender && cfg.defaultRender.web_search, '应包含 defaultRender.web_search');
});

test('Codex Responses web_search → anthropic 内置(关键修复)', () => {
	const tools = [{
		type: 'web_search',
		external_web_access: true,
		search_content_types: ['text', 'image'],
	}];
	const result = translateTools(tools, 'openai_responses', 'deepseek');
	assert(result.length === 1, '应翻译出 1 个工具');
	assert(result[0].type === 'web_search_20260209', `关键: type 应为 web_search_20260209, 实际 ${result[0].type}`);
	assert(result[0].name === 'web_search', 'name 应为 web_search');
	assert(result[0].max_uses === 5, 'max_uses 应为 5');
	assert(!result[0].input_schema, '关键: 不应包含 input_schema 字段(否则就降级为普通 function 了)');
});

test('Codex Responses web_search → google provider(转 Gemini 原生)', () => {
	const tools = [{
		type: 'web_search',
		external_web_access: true,
		search_content_types: ['text'],
	}];
	const result = translateTools(tools, 'openai_responses', 'google');
	assert(result.length === 1, '应翻译出 1 个工具');
	// google providerRender.web_search → googleSearch: {} (原生协议)
	assert(result[0].googleSearch !== undefined, '【关键】google provider 下 web_search 应转为 googleSearch: {}');
});

test('Codex Chat API 的 web_search function → 翻译为内置', () => {
	const tools = [{
		type: 'function',
		function: {
			name: 'web_search',
			description: 'Search the web',
			parameters: { type: 'object', properties: { query: { type: 'string' } } },
		},
	}];
	const result = translateTools(tools, 'openai_chat', 'minimax');
	assert(result.length === 1, '应翻译出 1 个工具');
	assert(result[0].type === 'web_search_20260209', 'Chat API 的 web_search function 也应被识别为内置');
	assert(!result[0].input_schema, '关键: 不应包含 input_schema 字段');
});

test('Gemini CLI wrapped google_web_search → 翻译为 Anthropic 内置', () => {
	// 展平后格式 (gemini-native.js 展平 functionDeclarations 后传入 translateTools)
	const tools = [{
		name: 'google_web_search',
		description: 'Web search',
		parameters: { type: 'object', properties: { query: { type: 'string' } } },
	}];
	const result = translateTools(tools, 'gemini_wrapped', 'deepseek');
	assert(result.length === 1, '应翻译出 1 个工具: 展平后 google_web_search → 内置 web_search');
	assert(result[0].type === 'web_search_20260209', '应渲染为 Anthropic 内置 web_search');
	assert(!result[0].input_schema, '关键: 不应包含 input_schema 字段');
});

test('Gemini CLI wrapped web_fetch → deepseek: DS 不支持 web_fetch 内置,被丢弃', () => {
	// DS providerRender 没有 web_fetch 条目,所以 builtin 无法渲染,会被丢弃
	const tools = [{
		name: 'web_fetch',
		description: 'Analyzes and extracts information from up to 20 URLs...',
		parameters: {
			type: 'object',
			properties: { prompt: { type: 'string' } },
			required: ['prompt'],
		},
	}];
	const result = translateTools(tools, 'gemini_wrapped', 'deepseek');
	// DS providerRender 无 web_fetch → builtin 无法渲染,丢弃。不以普通 function 降级。
	assert(result.length === 0, 'DS 不支持 web_fetch,应完全丢弃');
});

test('Gemini CLI wrapped web_fetch → minimax: MM 支持 web_fetch,正确翻译', () => {
	const tools = [{
		name: 'web_fetch',
		description: 'Analyzes URLs',
		parameters: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
	}];
	const result = translateTools(tools, 'gemini_wrapped', 'minimax');
	assert(result.length === 1, 'MM 支持 web_fetch,应渲染 1 个 builtin');
	assert(result[0].type === 'web_fetch_20250929', 'MM 应渲染为 Anthropic 内置');
	assert(!result[0].input_schema, '不应含 input_schema');
});

test('Gemini CLI 未来兼容: googleSearch 原生字段也被识别为 web_search', () => {
	const tools = [{ googleSearch: {} }];
	const result = translateTools(tools, 'gemini_wrapped', 'deepseek');
	assert(result.length === 1, '应识别 googleSearch → web_search');
	assert(result[0].type === 'web_search_20260209', '应渲染为 Anthropic 内置');
});

test('Gemini CLI 未来兼容: urlContext 原生字段 → deepseek: DS 不支持,丢弃', () => {
	const tools = [{ urlContext: {} }];
	const result = translateTools(tools, 'gemini_wrapped', 'deepseek');
	assert(result.length === 0, 'DS 的 providerRender 无 web_fetch,urlContext 无法渲染,应丢弃');
});

test('Gemini CLI 未来兼容: urlContext 原生字段 → minimax: 走 alias,正确翻译', () => {
	const tools = [{ urlContext: {} }];
	const result = translateTools(tools, 'gemini_wrapped', 'minimax');
	assert(result.length === 1, 'MM 的 providerRender 有 url_context alias → web_fetch,应渲染');
	assert(result[0].type === 'web_fetch_20250929', 'urlContext → web_fetch_20250929');
});

test('Gemini native 路径 (gemini_native copilot) — googleSearch 字段 → Anthropic web_search', () => {
	const tools = [{ googleSearch: {} }];
	const result = translateTools(tools, 'gemini_native', 'deepseek');
	assert(result.length === 1, 'gemini_native 识别 googleSearch');
	assert(result[0].type === 'web_search_20260209', '渲染为 Anthropic 内置');
});

test('Gemini native 路径 (gemini_native copilot) — urlContext 字段 → deepseek: 不支持,丢弃', () => {
	const tools = [{ urlContext: {} }];
	const result = translateTools(tools, 'gemini_native', 'deepseek');
	assert(result.length === 0, 'DS 不支持 urlContext/web_fetch,应丢弃');
});

test('Claude Code 原生 web_search → 原样透传', () => {
	const tools = [{
		type: 'web_search_20260209',
		name: 'web_search',
		max_uses: 5,
	}];
	const result = translateTools(tools, 'claude_code', 'deepseek');
	assert(result.length === 1, '应翻译出 1 个工具');
	assert(result[0].type === 'web_search_20260209', '原样透传');
	assert(result[0].max_uses === 5, '原样透传');
});

test('Gemini native -customtools: googleSearch 字段被识别为 web_search builtin', () => {
	// providerRender.google.web_search → googleSearch: {} (直接输出原生协议)
	const tools = [{ googleSearch: {} }];
	const result = translateTools(tools, 'gemini_native', 'google');
	assert(result.length === 1, '应翻译出 1 个工具');
	assert(result[0].googleSearch !== undefined, '【关键】google provider 下转为 googleSearch: {}');
});

test('普通 user tool 不会被错误识别为内置', () => {
	const tools = [{
		type: 'function',
		function: {
			name: 'get_weather',
			description: 'Get weather',
			parameters: { type: 'object', properties: { location: { type: 'string' } } },
		},
	}];
	const result = translateTools(tools, 'openai_chat', 'deepseek');
	assert(result.length === 1, '应翻译出 1 个工具');
	assert(result[0].name === 'get_weather', 'name 应保持');
	assert(result[0].input_schema, '普通 function 应保持 input_schema');
});

test('混用: 内置 + 普通 user tool', () => {
	const tools = [
		{ type: 'web_search', external_web_access: true },
		{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } },
	];
	const result = translateTools(tools, 'openai_responses', 'deepseek');
	assert(result.length === 2, '应翻译出 2 个工具');
	assert(result[0].type === 'web_search_20260209', 'web_search 应为内置');
	assert(!result[0].input_schema, 'web_search 不应含 input_schema');
	assert(result[1].name === 'exec_command', 'exec_command 应保持为普通 function');
	assert(result[1].input_schema, 'exec_command 应保持 input_schema');
});

test('unknown provider → builtin 走 defaultRender 兜底(user tool 也保留)', () => {
	const tools = [
		{ type: 'web_search', external_web_access: true },
		{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } },
	];
	const result = translateTools(tools, 'openai_responses', 'unknown_provider');
	assert(result.length === 2, 'unknown provider 有 defaultRender 兜底,应能渲染 builtin + user tool');
	const webSearch = result.find((t) => t.name === 'web_search' || t.type === 'web_search_20260209');
	assert(webSearch, 'web_search 应走 defaultRender 兜底');
	assert(webSearch.type === 'web_search_20260209', 'defaultRender 的 web_search 应为 web_search_20260209');
	assert(result.some((t) => t.name === 'exec_command'), 'exec_command 也应保留');
});

test('【关键 bug】Codex tool_search 无 name 字段 — 不应产生空 name', () => {
	// 真实场景: Codex Responses API 的 tool_search 内置工具只有 type/description/parameters,没有 name
	const toolSearch = {
		type: 'tool_search',
		execution: 'client',
		description: '# Tool discovery\nSearches over deferred tool metadata with BM25',
		parameters: {
			type: 'object',
			properties: {
				limit: { type: 'number' },
				query: { type: 'string' },
			},
			required: ['query'],
		},
	};
	const result = translateTools([toolSearch], 'openai_responses', 'deepseek');
	assert(result.length === 1, 'tool_search 应被保留');
	const out = result[0];
	assert(out.name && out.name.length > 0, `【关键】name 不应为空,实际: "${out.name}"`);
	assert(out.name === 'tool_search', `name 应兜底为 type,实际: "${out.name}"`);
	assert(out.description.includes('Tool discovery'), 'description 应保留');
	assert(out.input_schema && out.input_schema.required && out.input_schema.required.includes('query'), 'input_schema 应保留');
});

test('recognizeTools 分类正确', () => {
	const tools = [
		{ type: 'web_search' },
		{ type: 'function', function: { name: 'get_weather' } },
	];
	const config = loadConfig();
	const r = recognizeTools(tools, 'openai_responses', config);
	assert(r.builtin.length === 1, '应识别 1 个 builtin');
	assert(r.builtin[0].key === 'web_search', 'key 应为 web_search');
	assert(r.userTools.length === 1, '应识别 1 个 user tool');
});

// ============ 日志回放测试 ============

test('回放: codex-1-1-request.log 的 web_search 工具', () => {
	// 模拟 codex-1-1-request.log 里的 web_search tool 定义(在 line 476)
	const realCodexWebSearch = {
		type: 'web_search',
		external_web_access: true,
		search_content_types: ['text', 'image'],
	};
	const result = translateTools([realCodexWebSearch], 'openai_responses', 'deepseek');
	// 关键断言: 渲染结果不应有 input_schema 字段(否则就是降级为普通 function)
	assert(!result[0].input_schema, '【关键】不能降级为普通 function tool,否则 MM/DS 会把它当本地函数等 tool_result');
	assert(result[0].type === 'web_search_20260209', '【关键】必须保留 type 字段让 MM/DS 自己识别为内置');
});

test('回放: gemini-10-1-request.log 的 google_web_search 工具', () => {
	// 展平后 (gemini-native.js 在调用 translateTools 前已展平 functionDeclarations 嵌套)
	const flatTool = {
		name: 'google_web_search',
		description: 'Performs a grounded Google Search to find information across the internet.',
		parameters: {
			type: 'object',
			properties: { query: { type: 'string', description: 'The search query.' } },
			required: ['query'],
		},
	};
	const result = translateTools([flatTool], 'gemini_wrapped', 'deepseek');
	assert(result.length === 1, '应翻译出 1 个工具');
	assert(result[0].type === 'web_search_20260209', '应渲染为 Anthropic 内置');
	assert(!result[0].input_schema, '【关键】不应有 input_schema');
});


// ============ 总结 ============
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
