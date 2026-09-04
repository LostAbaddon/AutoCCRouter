// 锁死 BUG: Codex 路径上 tool_use / tool_result 被 thought_signature 抹除
// 背景: filterMessagesWithoutThoughtSignature 检查 tool_use 必须有 thought_signature (inline 字段或 Map 里)
//   旧版 Codex 路径:
//     - 入口: convertResponsesRequestToAnthropic 把 function_call item 转 tool_use 时不带 thought_signature
//     - 出口: transformGemini* 把上游 thoughtSignature 存到 pendingThinking (openai-native.js 自己的 Map),
//              但 filterMessagesWithoutThoughtSignature 检查的是 thoughtSignatures (gemini.js 另一个 Map)
//   后果: tool_use + 对应 tool_result 全部被抹去, 工具调用历史全丢
// 修复:
//   - 修 B (出口): 收到上游 functionCall.thoughtSignature 写入 thoughtSignatures Map
//   - 修 A (入口): 转换 function_call item 时从 thoughtSignatures Map 查 sig, 写到 tool_use inline thought_signature 字段

global.cc2llmConfig = { logLevel: 'error' };

const {
	convertResponsesRequestToAnthropic,
	transformGeminiToResponsesResponse,
} = require('../lib/handlers/openai-native');
const {
	filterMessagesWithoutThoughtSignature,
	thoughtSignatures,
} = require('../lib/providers/gemini');
const fs = require('fs');

let passed = 0, failed = 0;
const assert = (cond, msg) => { cond ? passed++ : (failed++, console.error(`  FAIL: ${msg}`)); };
const test = (name, fn) => {
	process.stdout.write(`Testing ${name}... `);
	try { fn(); console.log('DONE'); }
	catch (e) { failed++; console.error(`ERROR: ${e.message}\n${e.stack}`); }
};

// 工具: 数 tool_use/tool_result 个数
const countToolBlocks = (messages) => messages.reduce((s, m) =>
	s + m.content.filter(b => b.type === 'tool_use' || b.type === 'tool_result').length, 0);

// 真实 Codex 请求 (codex-2-1-request.log, 来自 codex App 桌面版)
const realRequestBody = (() => {
	const content = fs.readFileSync('/Users/zhanglei/MyApps/cc2llm/test/fixtures/codex-2-1-request-body.json', 'utf-8');
	return JSON.parse(content);
})();

test('【复现+修 A 修复】Codex input 含 function_call item → 修 A 后 tool_use 带 thought_signature, 过滤不掉', () => {
	// 模拟上一轮上游给过 sig
	thoughtSignatures.set('call_3133800', 'El4KX_REAL_SIG_FOR_3133800');

	const anth = convertResponsesRequestToAnthropic(realRequestBody, 'test-session', 'google');

	// 找到 tool_use block
	const toolUseBlocks = [];
	for (const msg of anth.messages) {
		for (const block of msg.content) {
			if (block.type === 'tool_use') toolUseBlocks.push(block);
		}
	}
	assert(toolUseBlocks.length === 1, `应有 1 个 tool_use, 实际 ${toolUseBlocks.length}`);
	assert(toolUseBlocks[0].thought_signature === 'El4KX_REAL_SIG_FOR_3133800',
		`修 A 关键断言: tool_use.thought_signature 应从 Map 查回, 实际 ${toolUseBlocks[0].thought_signature}`);

	// 过滤不掉
	const filtered = filterMessagesWithoutThoughtSignature(anth.messages);
	const before = countToolBlocks(anth.messages);
	const after = countToolBlocks(filtered);
	assert(before > 0 && after === before,
		`修 A 关键断言: 过滤前后数量应一致, 过滤前 ${before}, 过滤后 ${after}`);
});

test('【复现+修 B 修复】上游 Gemini 返回 functionCall.thoughtSignature → 修 B 后存入 thoughtSignatures Map', () => {
	const fakeResp = {
		candidates: [{
			content: {
				parts: [{
					functionCall: { name: 'exec', args: { cmd: 'ls' }, id: 'call_NEW_B_TEST' },
					thoughtSignature: 'El4KX_FAKE_SIG_FROM_UPSTREAM_B_TEST',
				}],
				role: 'model',
			},
			finishReason: 'STOP',
		}],
		usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
	};
	transformGeminiToResponsesResponse(fakeResp, 'gpt-5.6-sol', 'test-session');
	const sig = thoughtSignatures.get('call_NEW_B_TEST');
	assert(sig === 'El4KX_FAKE_SIG_FROM_UPSTREAM_B_TEST',
		`修 B 关键断言: thoughtSignatures.get('call_NEW_B_TEST') 应等于上游 sig, 实际 ${sig}`);
});

test('【完整链路】修 A + 修 B 联动: 第一轮上游 → 修 B 写入 Map → 第二轮 Codex input → 修 A 查回 → 工具调用历史完整保留', () => {
	// 模拟 session 重启, 清空 Map
	thoughtSignatures.clear();

	// 第一次: 上游 Gemini 返回 functionCall (这是 Codex 第一次工具调用, 上游有 sig)
	const geminiResp1 = {
		candidates: [{
			content: {
				parts: [{
					functionCall: { name: 'exec', args: { cmd: 'date' }, id: 'call_first_call' },
					thoughtSignature: 'El4KX_FIRST_SIG',
				}],
				role: 'model',
			},
			finishReason: 'STOP',
		}],
		usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 },
	};
	transformGeminiToResponsesResponse(geminiResp1, 'gpt-5.6-sol', 'test-session');
	// 修 B: 验证 sig 已存入 Map
	assert(thoughtSignatures.get('call_first_call') === 'El4KX_FIRST_SIG',
		'修 B: 上游 sig 应存入 thoughtSignatures Map');

	// 第二次: Codex 客户端把 function_call item 加到 input (会带 call_id=call_first_call)
	const secondRequest = {
		model: 'gpt-5.6-sol',
		input: [
			{ type: 'function_call', name: 'exec', call_id: 'call_first_call', arguments: '{"cmd":"date"}' },
		],
	};
	const anth2 = convertResponsesRequestToAnthropic(secondRequest, 'test-session', 'google');
	// 修 A: 验证 tool_use block 已 inline 写入 thought_signature
	const tu = anth2.messages.flatMap(m => m.content).find(b => b.type === 'tool_use');
	assert(tu && tu.id === 'call_first_call', '应生成 tool_use block');
	assert(tu.thought_signature === 'El4KX_FIRST_SIG',
		`修 A: tool_use.thought_signature 应等于上游 sig, 实际 ${tu.thought_signature}`);

	// 关键: 过滤后应保留
	const filtered = filterMessagesWithoutThoughtSignature(anth2.messages);
	const after = countToolBlocks(filtered);
	assert(after === 1, `完整链路断言: 过滤后应保留 1 个 tool_use, 实际 ${after}`);
});

test('【老 mode 兼容】inline thought_signature (Claude 路径) 仍然有效, 不受修 A 影响', () => {
	thoughtSignatures.clear();
	// 模拟 Claude 路径 (handleGeminiRequest) 行为: tool_use 自带 thought_signature inline 字段
	const messages = [{
		role: 'assistant',
		content: [{
			type: 'tool_use',
			id: 'toolu_claude_path',
			name: 'get_weather',
			input: { city: 'Beijing' },
			thought_signature: 'claude_thinking_sig_xxx',
		}],
	}];
	const filtered = filterMessagesWithoutThoughtSignature(messages);
	assert(filtered[0].content[0].id === 'toolu_claude_path',
		'【老 mode】inline thought_signature 应被 filterMessagesWithoutThoughtSignature 识别, tool_use 保留');
});

test('【防御】无任何 sig 来源时, 老 mode 行为不变: tool_use 被删除 (符合原始设计意图)', () => {
	// 边界: 真的没有 sig 的情况
	thoughtSignatures.clear();
	const messages = [{
		role: 'assistant',
		content: [{
			type: 'tool_use',
			id: 'toolu_no_sig_anywhere',
			name: 'mystery',
			input: {},
		}],
	}];
	const filtered = filterMessagesWithoutThoughtSignature(messages);
	assert(filtered.length === 0,
		'【老 mode 行为不变】无 sig 时 tool_use 应被删除 (避免 Gemini 收到不合规请求)');
});

test('【防御】修 A 不会写入 fake sig (gemini: 前缀的合成 sig 不会被信任)', () => {
	thoughtSignatures.clear();
	// 模拟 pendingThinking 之前写的合成 sig (gemini: 前缀)
	thoughtSignatures.set('call_xxx', 'gemini:xxx');
	const req = {
		model: 'gpt-5.6-sol',
		input: [
			{ type: 'function_call', name: 'foo', call_id: 'call_xxx', arguments: '{}' },
		],
	};
	const anth = convertResponsesRequestToAnthropic(req, 'test-session', 'google');
	const tu = anth.messages.flatMap(m => m.content).find(b => b.type === 'tool_use');
	assert(!tu.thought_signature, '【防御】gemini: 前缀的合成 sig 不应被信任, 不应写到 inline 字段');
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
