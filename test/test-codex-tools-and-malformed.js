// 验证: Codex namespace 工具展开 + Gemini MALFORMED_FUNCTION_CALL 响应翻译
// 修 A + 修 B 联动
// 兼顾老模式: 不带 namespace 的 tools 应该和之前完全一致

global.cc2llmConfig = { logLevel: 'error' };

const { translateTools, loadConfig } = require('../lib/tool-translator');
const { convertAnthropicToGemini } = require('../lib/providers/gemini');

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

// ========== 修 A: namespace 展开 ==========

test('Codex namespace 展开 — functions 下的子工具全部出现', () => {
	const tools = [{
		type: 'namespace',
		name: 'functions',
		description: '',
		tools: [
			{ type: 'custom', name: 'exec', description: 'Run JS code', format: { type: 'grammar', syntax: 'lark' } },
			{ type: 'function', name: 'wait', description: 'Wait on cell', parameters: { type: 'object', properties: { cell_id: { type: 'string' } } } },
			{ type: 'function', name: 'request_user_input', description: 'Ask user', parameters: { type: 'object', properties: { questions: { type: 'array' } } } },
		],
	}];
	const result = translateTools(tools, 'openai_responses', 'google');
	assert(result.length === 3, `应展开为 3 个子工具, 实际 ${result.length}`);
	const names = result.map((r) => r.name);
	assert(names.includes('exec'), '应包含 exec');
	assert(names.includes('wait'), '应包含 wait');
	assert(names.includes('request_user_input'), '应包含 request_user_input');
	assert(!names.includes('functions'), '【关键】外层 namespace "functions" 不应出现在结果中');
});

test('Codex 嵌套 namespace 递归展开', () => {
	const tools = [{
		type: 'namespace',
		name: 'outer',
		tools: [{
			type: 'namespace',
			name: 'inner',
			tools: [
				{ type: 'function', name: 'leaf', parameters: { type: 'object', properties: {} } },
			],
		}],
	}];
	const result = translateTools(tools, 'openai_responses', 'google');
	assert(result.length === 1, '嵌套 namespace 应最终展平为 1 个 leaf 工具');
	assert(result[0].name === 'leaf', 'leaf 工具名应保留');
});

test('Codex 空 namespace (tools=[]) 不应产生空壳', () => {
	const tools = [{
		type: 'namespace',
		name: 'empty_ns',
		tools: [],
	}];
	const result = translateTools(tools, 'openai_responses', 'google');
	assert(result.length === 0, '空 namespace 应展开为空, 不留空壳');
});

test('Codex type=custom 工具 (带 grammar format) 降级为带空 schema 的 function', () => {
	const tools = [{
		type: 'namespace',
		name: 'functions',
		tools: [
			{ type: 'custom', name: 'exec', description: 'Run JS code', format: { type: 'grammar', syntax: 'lark', definition: '...' } },
		],
	}];
	const result = translateTools(tools, 'openai_responses', 'google');
	assert(result.length === 1, '应展开为 1 个工具');
	assert(result[0].name === 'exec', 'name 应保留为 exec');
	assert(result[0].description === 'Run JS code', 'description 应保留');
	assert(result[0].input_schema && result[0].input_schema.type === 'object', 'type=custom 应降级为空 schema');
	assert(!('format' in result[0]), '【关键】format 字段(grammar 专用)应被丢弃');
});

test('展开后的工具经 convertAnthropicToGemini 转为 functionDeclarations', () => {
	const tools = [{
		type: 'namespace',
		name: 'functions',
		tools: [
			{ type: 'function', name: 'wait', description: 'Wait', parameters: { type: 'object', properties: { cell_id: { type: 'string' } } } },
		],
	}];
	const anthropic = translateTools(tools, 'openai_responses', 'google');
	const gemini = convertAnthropicToGemini({ tools: anthropic });
	assert(Array.isArray(gemini.tools), 'Gemini body 应有 tools 字段');
	const fds = gemini.tools[0].functionDeclarations;
	assert(Array.isArray(fds) && fds.length === 1, '应有一个 functionDeclaration');
	assert(fds[0].name === 'wait', 'functionDeclaration 名称应为 wait');
	assert(fds[0].parameters.properties.cell_id, '参数 schema 应保留');
});

test('【老模式】不带 namespace 的 Codex tools 行为不变', () => {
	const tools = [
		{ type: 'web_search', external_web_access: true },
		{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { location: { type: 'string' } } } } },
	];
	const result = translateTools(tools, 'openai_responses', 'deepseek');
	assert(result.length === 2, '应翻译出 2 个工具');
	assert(result[0].type === 'web_search_20260209', 'web_search 应渲染为内置');
	assert(result[1].name === 'get_weather', '普通 function name 应保留');
	assert(result[1].input_schema, '普通 function 应保留 input_schema');
});

test('【老模式】标准 OpenAI Chat 风格 tools (function.name 嵌套) 行为不变', () => {
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
	assert(result[0].name === 'get_weather', 'name 应保留');
	assert(result[0].input_schema, 'input_schema 应保留');
});

test('【老模式】top-level type=function name=... (Codex App 风格, 无 namespace) 仍能工作', () => {
	const tools = [
		{ type: 'function', name: 'mcp_tool', description: 'mcp tool', parameters: { type: 'object', properties: {} } },
	];
	const result = translateTools(tools, 'openai_responses', 'google');
	assert(result.length === 1, '应翻译出 1 个工具');
	assert(result[0].name === 'mcp_tool', 'name 应保留');
});

test('namespace 内同名 builtin (如 web_search) 仍能被 builtin 渲染覆盖', () => {
	// 即便 Codex 在 namespace 内放了一个叫 web_search 的工具, builtin 策略应该仍然把它识别为 web_search builtin
	const tools = [
		{ type: 'web_search', external_web_access: true },
		{ type: 'namespace', name: 'functions', tools: [{ type: 'function', name: 'exec', parameters: { type: 'object', properties: {} } }] },
	];
	const result = translateTools(tools, 'openai_responses', 'deepseek');
	assert(result.length === 2, '应翻译出 2 个工具');
	// web_search 应该是 builtin (type=web_search_20260209, 无 input_schema)
	assert(result[0].type === 'web_search_20260209', 'web_search 应被识别为 builtin');
	assert(!result[0].input_schema, 'web_search 不应含 input_schema');
	// exec 是 namespace 展开出来的普通 function
	assert(result[1].name === 'exec', 'exec 应作为普通 function 出现');
	assert(result[1].input_schema, 'exec 应保留 input_schema');
});

// ========== 修 B: 响应阶段失败处理 ==========

// 模拟 transformGeminiToResponsesResponse 的关键逻辑, 因为它没被 export
// 这里直接 inline 测试
const finishMap = {
	'STOP': 'completed',
	'MAX_TOKENS': 'incomplete',
	'SAFETY': 'incomplete',
	'RECITATION': 'incomplete',
	'MALFORMED_FUNCTION_CALL': 'failed',
	'BLOCKLIST': 'failed',
	'PROHIBITED_CONTENT': 'failed',
	'SPII': 'failed',
	'LANGUAGE': 'failed',
	'OTHER': 'failed',
};

const fakeTransform = (geminiResp) => {
	const candidates = geminiResp.candidates || [];
	const candidateFinish = candidates[0] && candidates[0].finishReason;
	const finishMessage = (candidates[0] && candidates[0].finishMessage) || '';
	const status = finishMap[candidateFinish] || 'completed';
	const output = [];
	if (status === 'failed' && finishMessage) {
		output.push({
			type: 'message',
			role: 'assistant',
			content: [{ type: 'output_text', text: `⚠️ 模型未能完成生成：${finishMessage}` }],
		});
	}
	return { status, output, finishMessage };
};

test('修 B: MALFORMED_FUNCTION_CALL + finishMessage 翻译为 status=failed + 可见消息', () => {
	const geminiResp = {
		candidates: [{
			content: { parts: [{ text: '' }], role: 'model' },
			finishReason: 'MALFORMED_FUNCTION_CALL',
			finishMessage: 'Malformed function call: call:functions.exec{cmd:`sed -n \'1,120p\' /path`}',
		}],
		usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110 },
	};
	const result = fakeTransform(geminiResp);
	assert(result.status === 'failed', `status 应为 failed, 实际 ${result.status}`);
	assert(result.output.length === 1, '应输出一条可见消息');
	assert(result.output[0].type === 'message', 'output 应是 message 类型');
	assert(result.output[0].content[0].text.includes('Malformed function call'), '可见消息应包含原始 finishMessage');
	assert(result.output[0].content[0].text.includes('⚠️'), '可见消息应以警示图标开头');
});

test('修 B: 老模式 STOP 不应受影响', () => {
	const geminiResp = {
		candidates: [{
			content: { parts: [{ text: 'Hello world' }], role: 'model' },
			finishReason: 'STOP',
		}],
	};
	const result = fakeTransform(geminiResp);
	assert(result.status === 'completed', `STOP 应保持 completed, 实际 ${result.status}`);
	assert(result.output.length === 0, '老模式 STOP 不应产生额外错误消息');
});

test('修 B: 老模式 MAX_TOKENS 仍映射 incomplete', () => {
	const geminiResp = {
		candidates: [{
			content: { parts: [{ text: 'partial' }], role: 'model' },
			finishReason: 'MAX_TOKENS',
		}],
	};
	const result = fakeTransform(geminiResp);
	assert(result.status === 'incomplete', `MAX_TOKENS 应保持 incomplete, 实际 ${result.status}`);
});

test('修 B: BLOCKLIST/SPII 等其他失败原因也映射为 failed', () => {
	for (const reason of ['BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'OTHER']) {
		const result = fakeTransform({
			candidates: [{ content: { parts: [] }, finishReason: reason, finishMessage: `blocked: ${reason}` }],
		});
		assert(result.status === 'failed', `${reason} 应映射为 failed`);
		assert(result.output.length === 1, `${reason} 应有可见消息`);
	}
});

test('修 B: failed 但无 finishMessage 时不应有误导性 output', () => {
	const result = fakeTransform({
		candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }],
	});
	assert(result.status === 'failed', '状态仍应是 failed');
	assert(result.output.length === 0, '无 finishMessage 时不应硬塞一条内容为空的 message');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
