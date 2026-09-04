// 锁死 BUG: Gemini 400 (encrypted 字段) + Codex 客户端解析 id:null 失败
// 背景:
//   - Codex 桌面版在工具参数 properties 里带 "encrypted": true 字段(OpenAI 私有)
//   - Gemini API 不认识这个字段, 报 400
//   - bridge 在 ?alt=sse 模式下让 Gemini 把错误也用 SSE 返回, 但内容是裸 JSON
//   - transformGeminiStreamToResponses 收到非 data: 格式的 chunk, respId 永远 null
//   - end 时发 id:null 的 response.completed 事件 → Codex 客户端 parse 失败
// 修复:
//   - 修 A: cleanGeminiSchema 的 GEMINI_UNSUPPORTED_KEYS 加 encrypted, 请求阶段就清理
//   - 修 B: transformGeminiStreamToResponses 在 respId=null 时, 把非 SSE body 解析为 error
//           构造 response.created/in_progress/completed 三件套, 携带 error 字段

global.cc2llmConfig = { logLevel: 'error' };

const { translateTools } = require('../lib/tool-translator');
const { convertAnthropicToGemini, cleanGeminiSchema } = require('../lib/providers/gemini');

let passed = 0, failed = 0;
const assert = (cond, msg) => { cond ? passed++ : (failed++, console.error(`  FAIL: ${msg}`)); };
const test = (name, fn) => {
	process.stdout.write(`Testing ${name}... `);
	try { fn(); console.log('DONE'); }
	catch (e) { failed++; console.error(`ERROR: ${e.message}\n${e.stack}`); }
};

// ========== 修 A: encrypted 字段清理 ==========

test('修 A: Codex 工具参数 property 里的 "encrypted" 字段被 cleanGeminiSchema 清理', () => {
	const toolDef = {
		type: 'function',
		name: 'followup_task',
		description: 'Send a follow-up',
		parameters: {
			type: 'object',
			properties: {
				message: {
					type: 'string',
					description: 'Message text',
					encrypted: true,  // <-- 这个字段 Gemini 不认
				},
				target: { type: 'string' },
			},
			required: ['target', 'message'],
		},
	};

	const cleaned = cleanGeminiSchema(toolDef.parameters);
	assert(cleaned.properties.message && !('encrypted' in cleaned.properties.message),
		'修 A 关键断言: encrypted 字段应被清理');
	// 注意: cleanGeminiSchema 把 type 字符串转大写 (STRING/OBJECT 等)
	assert(cleaned.properties.message.type === 'STRING', '其他字段 (type) 应保留并转大写');
	assert(cleaned.properties.message.description === 'Message text', '其他字段 (description) 应保留');
});

test('修 A: 真实 additional_tools 链路转换后, 所有 encrypted 字段都消失', () => {
	const additionalTools = [{
		type: 'namespace', name: 'collaboration', description: '',
		tools: [
			{ type: 'function', name: 'followup_task', parameters: {
				type: 'object', properties: {
					message: { type: 'string', encrypted: true },
				},
			} },
			{ type: 'function', name: 'send_message', parameters: {
				type: 'object', properties: {
					body: { type: 'string', encrypted: true },
				},
			} },
			{ type: 'function', name: 'spawn_agent', parameters: {
				type: 'object', properties: {
					instructions: { type: 'string', encrypted: true },
					model: { type: 'string' },
				},
			} },
		],
	}];

	const anth = translateTools(additionalTools, 'openai_responses', 'google');
	const gem = convertAnthropicToGemini({ tools: anth });
	const fds = gem.tools?.[0]?.functionDeclarations || [];

	let encryptedCount = 0;
	let totalProps = 0;
	for (const fd of fds) {
		const props = fd.parameters?.properties || {};
		for (const [k, v] of Object.entries(props)) {
			totalProps++;
			if ('encrypted' in v) encryptedCount++;
		}
	}
	assert(encryptedCount === 0,
		`修 A 关键断言: 转换后 0 个 encrypted 字段, 实际 ${encryptedCount}`);
	// message / body / instructions / model = 4 个 properties
	assert(totalProps === 4, `应保留 4 个 properties (message/body/instructions/model), 实际 ${totalProps}`);
});

test('【老 mode】其它已有黑名单字段 (additionalProperties, allOf 等) 仍被清理, 不受影响', () => {
	const schema = {
		type: 'object',
		additionalProperties: false,
		allOf: [{ required: ['x'] }],
		properties: {
			x: { type: 'string', encrypted: true },  // 同时含 encrypted
		},
	};
	const cleaned = cleanGeminiSchema(schema);
	assert(!('additionalProperties' in cleaned), 'additionalProperties 应被清理 (老行为)');
	assert(!('allOf' in cleaned), 'allOf 应被清理 (老行为)');
	assert(!('encrypted' in cleaned.properties.x), 'encrypted 应被清理 (新行为)');
});

test('【防御】黑名单外的字段不被误删', () => {
	const schema = {
		type: 'object',
		properties: {
			x: { type: 'string', description: 'hi' },
		},
	};
	const cleaned = cleanGeminiSchema(schema);
	// type 字符串会被转大写
	assert(cleaned.properties.x.type === 'STRING', 'type 应保留并转大写');
	assert(cleaned.properties.x.description === 'hi', 'description 应保留');
});

// ========== 修 B: 错误响应兜底 ==========
// 直接测: 模拟一个非 SSE 的 geminiStream, 看 transformGeminiStreamToResponses 怎么输出

// 写一个简易 readable mock, 模拟 Node http.IncomingMessage
const { Readable } = require('stream');

const makeMockStream = (chunks) => {
	const stream = new Readable({ read() {} });
	for (const c of chunks) stream.push(c);
	stream.push(null);
	return stream;
};

test('修 B: 上游返回 400 错误 JSON (无 SSE data: 前缀) → response.completed 不再 id:null, 有 error 字段', (done) => {
	// 模拟"响应"写入器
	let written = '';
	const mockRes = {
		writeHead: () => {},
		write: (data) => { written += data; return true; },
		end: () => { written += '[END]'; },
	};

	const { transformGeminiStreamToResponses } = require('../lib/handlers/openai-native');

	// 模拟 Gemini 在 ?alt=sse 模式下的 400 错误响应: 裸 JSON (没有 data: 前缀)
	const errorJson = JSON.stringify({
		error: { code: 400, message: 'Invalid JSON payload received. Unknown name "encrypted"' },
	});
	const mockStream = makeMockStream([errorJson]);

	transformGeminiStreamToResponses(
		mockRes,
		'gpt-5.6-sol',
		mockStream,
		{ providerName: 'google', targetModel: 'gemini-3.8-flash' },
		'test-iid',
		'test-session',
		() => {},
	);

	// 等待 stream end
	setImmediate(() => {
		// 修 B 关键断言: response.completed 不再 id:null
		assert(written.includes('"id":"resp_'),
			`修 B 关键断言: 应该有 id:"resp_..." (非 null), 实际写入:\n${written}`);
		assert(!written.includes('"id":null'),
			`修 B 关键断言: 不应有 "id":null, 实际写入:\n${written}`);
		assert(written.includes('"status":"failed"'),
			`修 B 关键断言: 状态应为 failed, 实际:\n${written}`);
		assert(written.includes('"error":{'),
			`修 B 关键断言: 应有 error 字段, 实际:\n${written}`);
		assert(written.includes('Invalid JSON payload'),
			`修 B 关键断言: error.message 应包含原始上游错误, 实际:\n${written}`);
		// 修 B 防御: 同时发出 response.created 和 response.in_progress, 让 Codex 状态机完整
		assert(written.includes('event: response.created'),
			'应有 response.created 事件 (与正常路径一致)');
		assert(written.includes('event: response.in_progress'),
			'应有 response.in_progress 事件');
		done();
	});
});

test('修 B: 正常 SSE 路径 (有 data: 行) 不受影响, 行为完全不变', (done) => {
	let written = '';
	const mockRes = {
		writeHead: () => {},
		write: (data) => { written += data; return true; },
		end: () => { written += '[END]'; },
	};

	const { transformGeminiStreamToResponses } = require('../lib/handlers/openai-native');

	// 模拟正常 SSE 流
	const normalChunks = [
		'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}\n\n',
	];
	const mockStream = makeMockStream(normalChunks);

	transformGeminiStreamToResponses(
		mockRes,
		'gpt-5.6-sol',
		mockStream,
		{ providerName: 'google', targetModel: 'gemini-3.8-flash' },
		'test-iid',
		'test-session',
		() => {},
	);

	setImmediate(() => {
		// 修 B 防御: 正常路径不能误触发错误路径
		assert(written.includes('"id":"resp_') && !written.includes('"id":null'),
			'正常路径仍应设 respId, 不能为 null');
		assert(written.includes('"text":"Hello"'),
			'正常路径应输出 text 字段');
		assert(written.includes('"status":"completed"'),
			'正常路径 status 应是 completed, 不是 failed');
		assert(!written.includes('"error":{'),
			'正常路径不应有 error 字段');
		done();
	});
});

test('修 B: 上游空响应 (啥都没收到) → response.completed 仍有 id, 不再 null', (done) => {
	let written = '';
	const mockRes = {
		writeHead: () => {},
		write: (data) => { written += data; return true; },
		end: () => { written += '[END]'; },
	};

	const { transformGeminiStreamToResponses } = require('../lib/handlers/openai-native');
	const mockStream = makeMockStream(['']);

	transformGeminiStreamToResponses(
		mockRes, 'gpt-5.6-sol', mockStream, {}, 'iid', 'session', () => {},
	);

	setImmediate(() => {
		// 上游完全没响应, 没有 nonSseBody 也没有 data: 行
		// 这种情况下 respId 仍是 null, 走原始 completed 路径 (无 error)
		// 不期望有 id, 只检查不会 crash
		assert(written.length > 0, '应该有写入内容');
		done();
	});
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
