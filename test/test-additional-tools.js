// 验证: Codex App 桌面版用 input[].type="additional_tools" 传工具时
// 桥接能正确抽取并翻译给上游
// 之前修 A 只处理了 body.tools, 漏了这套新接口

global.cc2llmConfig = { logLevel: 'error' };

const { convertResponsesRequestToAnthropic } = require('../lib/handlers/openai-native');
const { convertAnthropicToGemini } = require('../lib/providers/gemini');

let passed = 0, failed = 0;
const assert = (cond, msg) => { cond ? passed++ : (failed++, console.error(`  FAIL: ${msg}`)); };
const test = (name, fn) => {
	process.stdout.write(`Testing ${name}... `);
	try { fn(); console.log('DONE'); }
	catch (e) { failed++; console.error(`ERROR: ${e.message}\n${e.stack}`); }
};

// 真实 Codex 桌面版 additional_tools item 的形状
const buildAddtlItem = () => ({
	type: 'additional_tools',
	id: 'at_test_001',
	role: 'developer',
	tools: [
		{
			type: 'namespace', name: 'functions', description: '',
			tools: [
				{ type: 'custom', name: 'exec', description: 'Run JS', format: { type: 'grammar', syntax: 'lark' } },
				{ type: 'function', name: 'wait', description: 'Wait', parameters: { type: 'object', properties: { cell_id: { type: 'string' } } } },
			],
		},
		{
			type: 'namespace', name: 'collaboration', description: '',
			tools: [
				{ type: 'function', name: 'spawn_agent', description: 'Spawn', parameters: { type: 'object', properties: {} } },
			],
		},
	],
});

test('additional_tools: input[0].tools 全部被抽取并展开为子工具', () => {
	const body = {
		model: 'gpt-5.6-sol',
		input: [buildAddtlItem(), { type: 'message', role: 'user', content: 'hi' }],
		tool_choice: 'auto',
	};
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'google');
	assert(Array.isArray(anth.tools), 'anthropicBody.tools 应是数组');
	assert(anth.tools.length === 3, `应展开为 3 个子工具, 实际 ${anth.tools.length}`);
	const names = anth.tools.map(t => t.name);
	assert(names.includes('exec'), '应包含 exec');
	assert(names.includes('wait'), '应包含 wait');
	assert(names.includes('spawn_agent'), '应包含 spawn_agent');
	assert(!names.includes('functions'), '外层 namespace "functions" 不应出现');
	assert(!names.includes('collaboration'), '外层 namespace "collaboration" 不应出现');
});

test('additional_tools item 不应被当作消息处理', () => {
	const body = {
		model: 'gpt-5.6-sol',
		input: [buildAddtlItem()],
	};
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'google');
	// input 里只有 1 个 additional_tools item, 它不应进 messages
	assert(anth.messages.length === 0, `additional_tools item 不应进 messages, 实际 messages.length=${anth.messages.length}`);
});

test('additional_tools + body.tools 两条路径合并', () => {
	const body = {
		model: 'gpt-5.6-sol',
		input: [buildAddtlItem()],
		tools: [
			{ type: 'web_search', external_web_access: true },
			{ type: 'function', name: 'extra_tool', parameters: { type: 'object', properties: {} } },
		],
	};
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'deepseek');
	assert(anth.tools.length === 5, `3 (additional) + 1 (web_search builtin) + 1 (extra_tool) = 5, 实际 ${anth.tools.length}`);
	assert(anth.tools.some(t => t.type === 'web_search_20260209'), 'web_search 应识别为 builtin');
	assert(anth.tools.some(t => t.name === 'extra_tool'), 'extra_tool 应保留');
	assert(anth.tools.some(t => t.name === 'exec'), 'additional_tools 里的 exec 应被展开');
});

test('additional_tools 在 Gemini 上游被正确转为 functionDeclarations', () => {
	const body = {
		model: 'gpt-5.6-sol',
		input: [buildAddtlItem()],
	};
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'google');
	const gem = convertAnthropicToGemini(anth);
	const fds = gem.tools?.[0]?.functionDeclarations;
	assert(Array.isArray(fds), 'geminiBody.tools[0].functionDeclarations 应是数组');
	assert(fds.length === 3, `应有 3 个 functionDeclaration, 实际 ${fds.length}`);
	const fdNames = fds.map(f => f.name);
	assert(fdNames.includes('exec') && fdNames.includes('wait') && fdNames.includes('spawn_agent'), '3 个子工具都应出现');
});

test('【老 mode】只有 body.tools 没有 additional_tools 时, 行为不变', () => {
	const body = {
		model: 'gpt-5.6-sol',
		input: [{ type: 'message', role: 'user', content: 'hi' }],
		tools: [
			{ type: 'function', name: 'old_tool', parameters: { type: 'object', properties: {} } },
		],
	};
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'google');
	assert(anth.tools.length === 1 && anth.tools[0].name === 'old_tool', '老 mode 行为不变');
});

test('【老 mode】既无 body.tools 也无 additional_tools 时, anthropicBody.tools 不应被设置', () => {
	const body = {
		model: 'gpt-5.6-sol',
		input: [{ type: 'message', role: 'user', content: 'hi' }],
	};
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'google');
	assert(!anth.tools || anth.tools.length === 0, '两种都缺时, tools 应为空/未设置');
});

test('空 input + 无 body.tools 时不出错', () => {
	const body = { model: 'gpt-5.6-sol' };
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'google');
	assert(!anth.tools || anth.tools.length === 0, 'input/tools 都缺时, tools 应为空');
});

test('additional_tools 里有空 namespace 不应残留空壳', () => {
	const body = {
		model: 'gpt-5.6-sol',
		input: [{
			type: 'additional_tools', id: 'a', role: 'developer',
			tools: [
				{ type: 'namespace', name: 'empty_ns', tools: [] },
				{ type: 'function', name: 'real_tool', parameters: { type: 'object', properties: {} } },
			],
		}],
	};
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'google');
	assert(anth.tools.length === 1, '空 namespace 应被丢弃, 只留 real_tool');
	assert(anth.tools[0].name === 'real_tool', 'real_tool 应保留');
});

test('多个 additional_tools item 全部合并', () => {
	const body = {
		model: 'gpt-5.6-sol',
		input: [
			{ type: 'additional_tools', id: 'a', role: 'developer', tools: [{ type: 'function', name: 'tool_a', parameters: { type: 'object', properties: {} } }] },
			{ type: 'additional_tools', id: 'b', role: 'developer', tools: [{ type: 'function', name: 'tool_b', parameters: { type: 'object', properties: {} } }] },
		],
	};
	const anth = convertResponsesRequestToAnthropic(body, 'session', 'google');
	assert(anth.tools.length === 2, '2 个 additional_tools item 应合并出 2 个工具');
	assert(anth.tools.some(t => t.name === 'tool_a') && anth.tools.some(t => t.name === 'tool_b'), 'tool_a 和 tool_b 都应出现');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
