// 验证生成的 tools 是否严格符合各家 Provider 的官方 schema
// 完全无空格容忍,逐字段检查

const { translateTools, loadConfig } = require('../lib/tool-translator');

let passed = 0, failed = 0;
const log = (ok, msg) => {
	if (ok) { passed++; console.log(`  ✓ ${msg}`); }
	else { failed++; console.log(`  ✗ ${msg}`); }
};

const eq = (actual, expected, path) => log(actual === expected, `${path}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`);

// ============================================================
// Test 1: Anthropic 协议 (deepseek / minimax / claude_code)
// ============================================================
console.log('\n=== Test 1: Anthropic 协议 (deepseek / minimax) ===');

{
	const tools = translateTools(
		[{ urlContext: {} }, { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } }],
		'gemini_wrapped', 'deepseek',
	);

	// 共 1 个 tool (url_context alias web_fetch, 加上 get_weather) — 但 web_fetch 与 url_context 互斥去重
	// 实际期望: 2 个 tools [web_fetch_20250929, get_weather]
	log(tools.length === 2, `总长度 2 (web_fetch 1 + get_weather 1), 实际 ${tools.length}`);

	const webFetch = tools.find(t => t.name === 'web_fetch');
	eq(webFetch !== undefined, true, 'web_fetch 存在');
	eq(webFetch?.type, 'web_fetch_20250929', 'web_fetch.type');
	eq(webFetch?.name, 'web_fetch', 'web_fetch.name');
	eq(webFetch?.max_uses, 5, 'web_fetch.max_uses');
	eq(webFetch?.input_schema, undefined, 'web_fetch.input_schema 必须不存在(否则降级)');

	const userTool = tools.find(t => t.name === 'get_weather');
	eq(userTool !== undefined, true, 'get_weather 存在');
	eq(userTool?.name, 'get_weather', 'get_weather.name');
	eq(userTool?.description, 'Get weather', 'get_weather.description');
	eq(userTool?.type, undefined, 'user tool 不应有 type 字段');
	eq(userTool?.input_schema?.type, 'object', 'get_weather.input_schema.type');
	eq(userTool?.input_schema?.properties?.location?.type, 'string', 'get_weather.input_schema.properties.location.type');
	eq(userTool?.input_schema?.required?.[0], 'location', 'get_weather.input_schema.required[0]');

	// 反面检查:不能有 function 包装 (Anthropic 协议)
	eq(userTool?.function, undefined, 'user tool 不应有 function 包装');
}

// ============================================================
// Test 2: openai_responses (Codex 0.81+)
// ============================================================
console.log('\n=== Test 2: openai_responses (Codex) ===');

{
	// Codex 不会发 url_context,所以测 web_search
	const tools = translateTools(
		[{ type: 'web_search' }, { name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
		'openai_responses', 'deepseek',
	);

	log(tools.length === 2, `总长度 2, 实际 ${tools.length}`);

	const ws = tools.find(t => t.type === 'web_search_20260209');
	eq(ws?.type, 'web_search_20260209', 'web_search.type');
	eq(ws?.name, 'web_search', 'web_search.name');
	eq(ws?.max_uses, 5, 'web_search.max_uses');

	const ut = tools.find(t => t.name === 'exec_command');
	eq(ut?.name, 'exec_command', 'exec_command.name');
	eq(ut?.input_schema?.type, 'object', 'exec_command.input_schema.type');
}

// ============================================================
// Test 3: openai_responses → google provider (跨协议翻译)
// ============================================================
console.log('\n=== Test 3: openai_responses → google (原生 Gemini) ===');

{
	const tools = translateTools(
		[{ type: 'web_search' }],
		'openai_responses', 'google',
	);

	log(tools.length === 1, `总长度 1, 实际 ${tools.length}`);
	eq(tools[0].googleSearch !== undefined, true, 'tools[0].googleSearch 字段存在');
	eq(tools[0].type, undefined, 'google provider 工具不应有 type 字段');
}

// ============================================================
// Test 4: gemini_wrapped → google provider (原生)
// ============================================================
console.log('\n=== Test 4: gemini_wrapped → google ===');

{
	const tools = translateTools(
		[{ urlContext: {} }],
		'gemini_wrapped', 'google',
	);

	log(tools.length === 1, `总长度 1, 实际 ${tools.length}`);
	eq(tools[0].urlContext !== undefined, true, 'tools[0].urlContext 字段存在');
}

// ============================================================
// Test 5: gemini_native 直接发原生字段 → deepseek 应转 Anthropic
// ============================================================
console.log('\n=== Test 5: gemini_native → deepseek ===');

{
	const tools = translateTools(
		[{ googleSearch: {} }],
		'gemini_native', 'deepseek',
	);

	log(tools.length === 1, `总长度 1, 实际 ${tools.length}`);
	eq(tools[0].type, 'web_search_20260209', 'web_search.type');
	eq(tools[0].name, 'web_search', 'web_search.name');
}

// ============================================================
// Test 6: 去重 — url_context 在已有 web_fetch 时被忽略
// ============================================================
console.log('\n=== Test 6: url_context 与 web_fetch 去重 ===');

{
	const tools = translateTools(
		[{ urlContext: {} }, { type: 'web_fetch_20250929', name: 'web_fetch', max_uses: 5 }],
		'gemini_wrapped', 'deepseek',
	);

	// 两个 builtin 但 alias 同 → 互斥去重只保留 1 个
	log(tools.length === 1, `应有 1 个 builtin (去重), 实际 ${tools.length}`);
	eq(tools[0].type, 'web_fetch_20250929', '应保留 web_fetch (去重后)');
}

// ============================================================
// Test 7: openai_chat (Codex 0.81- 兼容模式)
// ============================================================
console.log('\n=== Test 7: openai_chat → deepseek ===');

{
	const tools = translateTools(
		[{ type: 'function', function: { name: 'web_search', description: 'Search the web' } }],
		'openai_chat', 'deepseek',
	);

	log(tools.length === 1, `总长度 1, 实际 ${tools.length}`);
	eq(tools[0].type, 'web_search_20260209', 'web_search.type');
	eq(tools[0].name, 'web_search', 'web_search.name');
}

// ============================================================
// Test 8: 验证返回值的精确类型 (防"狗屎"返回)
// ============================================================
console.log('\n=== Test 8: 返回值类型检查 ===');

{
	const r = translateTools([{ type: 'web_search' }], 'openai_responses', 'deepseek');
	log(Array.isArray(r), `translateTools 返回值必须是 Array, 实际 ${Array.isArray(r) ? 'Array' : typeof r}`);
	log(!('translatedTools' in (r || {})), '返回值不应含 translatedTools 字段');
	log(!('reverseMapping' in (r || {})), '返回值不应含 reverseMapping 字段');
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
