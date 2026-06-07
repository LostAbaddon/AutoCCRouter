const http = require('http');
const { mapModel } = require('../lib/proxy-server');
const { buildOpenAIRequest, transformOpenAIToAnthropic } = require('../lib/providers/openai-compat');
const { convertAnthropicToGemini } = require('../lib/providers/gemini');
const { log } = require('../lib/logger');

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
	}
};

test('mapModel - prefix match', () => {
	const mapping = [
		{ prefix: 'claude-opus', target: 'deepseek-v4-pro', provider: 'deepseek' },
		{ prefix: 'claude-sonnet', target: 'deepseek-v4-pro', provider: 'deepseek' },
		{ prefix: 'claude-haiku', target: 'deepseek-v4-flash', provider: 'deepseek' },
	];

	const result = mapModel('claude-opus-4-7-20250805', mapping);
	assert(result !== null, 'should find mapping');
	assert(result.targetModel === 'deepseek-v4-pro', 'should map opus to deepseek-v4-pro');
	assert(result.provider === 'deepseek', 'should use deepseek provider');
});

test('mapModel - no match', () => {
	const mapping = [
		{ prefix: 'claude-opus', target: 'deepseek-v4-pro', provider: 'deepseek' },
	];

	const result = mapModel('unknown-model', mapping);
	assert(result === null, 'should return null for unknown model');
});

test('mapModel - empty mapping', () => {
	const result = mapModel('claude-opus', []);
	assert(result === null, 'should return null for empty mapping');

	const result2 = mapModel('claude-opus', null);
	assert(result2 === null, 'should return null for null mapping');
});

test('mapModel - longest prefix wins regardless of order', () => {
	const mapping = [
		{ prefix: 'claude', target: 'model-default', provider: 'prov-default' },
		{ prefix: 'claude-opus-4-7', target: 'model-specific', provider: 'prov-specific' },
		{ prefix: 'claude-opus', target: 'model-general', provider: 'prov-general' },
	];

	const result = mapModel('claude-opus-4-7-20250805', mapping);
	assert(result.targetModel === 'model-specific', 'longest prefix claude-opus-4-7 should win even though listed second');
	assert(result.provider === 'prov-specific', 'provider should match longest prefix');
});

test('mapModel - shorter prefix when longer not present', () => {
	const mapping = [
		{ prefix: 'claude-opus-4-7', target: 'model-specific', provider: 'prov-specific' },
		{ prefix: 'claude-opus', target: 'model-general', provider: 'prov-general' },
	];

	const result = mapModel('claude-opus-4-5-20251001', mapping);
	assert(result.targetModel === 'model-general', 'should fall back to shorter prefix claude-opus');
});


test('mapModel - wildcard match', () => {
	const mapping = [
		{ prefix: 'gpt-*-mini', target: 'gpt-mini-mapped', provider: 'openai' },
		{ prefix: 'gemini-*', target: 'gemini-default', provider: 'google' },
	];

	// * matches any sequence
	const r1 = mapModel('gpt-5.4-mini', mapping);
	assert(r1 !== null, 'gpt-5.4-mini should match gpt-*-mini');
	assert(r1.targetModel === 'gpt-mini-mapped', 'should map to gpt-mini-mapped');

	const r2 = mapModel('gpt-5-mini', mapping);
	assert(r2.targetModel === 'gpt-mini-mapped', 'gpt-5-mini should also match gpt-*-mini');

	const r3 = mapModel('gemini-2.5-flash', mapping);
	assert(r3 !== null, 'gemini-2.5-flash should match gemini-*');
	assert(r3.targetModel === 'gemini-default', 'should map to gemini-default');
});

test('mapModel - wildcard with multiple stars', () => {
	const mapping = [
		{ prefix: '*-*-mini', target: 'any-mini', provider: 'openai' },
	];

	const r = mapModel('foo-bar-mini', mapping);
	assert(r !== null, 'foo-bar-mini should match *-*-mini');
	assert(r.targetModel === 'any-mini', 'should map to any-mini');
});

test('mapModel - precise prefix wins over wildcard', () => {
	const mapping = [
		{ prefix: 'gpt-5.4-mini', target: 'precise', provider: 'openai' },
		{ prefix: 'gpt-*-mini', target: 'wildcard', provider: 'google' },
	];

	// 精确前缀优先
	const r = mapModel('gpt-5.4-mini', mapping);
	assert(r.targetModel === 'precise', 'precise gpt-5.4-mini should win over wildcard gpt-*-mini');
	assert(r.provider === 'openai', 'provider should match precise rule');

	// 通配兜底
	const r2 = mapModel('gpt-6-mini', mapping);
	assert(r2.targetModel === 'wildcard', 'unmatched variant should hit wildcard');
});

test('mapModel - wildcard at start', () => {
	const mapping = [
		{ prefix: '*-preview', target: 'preview-model', provider: 'google' },
	];

	const r = mapModel('gemini-3.1-pro-preview', mapping);
	assert(r !== null, 'gemini-3.1-pro-preview should match *-preview');
	assert(r.targetModel === 'preview-model', 'should map to preview-model');

	// 不匹配的
	const r2 = mapModel('gemini-3.1-pro', mapping);
	assert(r2 === null, 'gemini-3.1-pro should not match *-preview');
});

test('buildOpenAIRequest - basic conversion', () => {
	const anthropicBody = {
		model: 'claude-sonnet-4-6',
		messages: [
			{ role: 'user', content: 'Hello' },
		],
		system: 'You are helpful',
		stream: true,
		max_tokens: 4096,
	};

	const openaiBody = buildOpenAIRequest(anthropicBody);
	assert(openaiBody.stream === true, 'stream should be true');
	assert(openaiBody.max_completion_tokens === 4096, 'max_tokens should map to max_completion_tokens');
	assert(openaiBody.messages.length === 2, 'should have system and user messages');
	assert(openaiBody.messages[0].role === 'system', 'first message should be system');
	assert(openaiBody.messages[0].content === 'You are helpful', 'system content should match');
});

test('buildOpenAIRequest - tools conversion', () => {
	const anthropicBody = {
		model: 'claude-sonnet-4-6',
		messages: [{ role: 'user', content: 'Hello' }],
		tools: [
			{
				name: 'get_weather',
				description: 'Get weather info',
				input_schema: {
					type: 'object',
					properties: {
						city: { type: 'string' },
					},
				},
			},
		],
	};

	const openaiBody = buildOpenAIRequest(anthropicBody);
	assert(openaiBody.tools.length === 1, 'should have one tool');
	assert(openaiBody.tools[0].type === 'function', 'tool type should be function');
	assert(openaiBody.tools[0].function.name === 'get_weather', 'tool name should match');
	assert(openaiBody.tools[0].function.parameters.type === 'object', 'parameters should be object');
});

test('buildOpenAIRequest - system as array', () => {
	const anthropicBody = {
		model: 'claude-sonnet-4-6',
		messages: [{ role: 'user', content: 'Hello' }],
		system: [{ type: 'text', text: 'Part 1' }, { type: 'text', text: 'Part 2' }],
	};

	const openaiBody = buildOpenAIRequest(anthropicBody);
	assert(openaiBody.messages[0].role === 'system', 'should have system role');
	assert(openaiBody.messages[0].content === 'Part 1\nPart 2', 'system content should be concatenated with newlines');
});

test('transformOpenAIToAnthropic - basic', () => {
	const openaiResp = {
		id: 'chatcmpl-123',
		choices: [{
			index: 0,
			message: {
				role: 'assistant',
				content: 'Hello! How can I help?',
			},
			finish_reason: 'stop',
		}],
		usage: {
			prompt_tokens: 10,
			completion_tokens: 5,
			total_tokens: 15,
		},
	};

	const anthropicResp = transformOpenAIToAnthropic(openaiResp, 'claude-sonnet-4-6');
	assert(anthropicResp.model === 'claude-sonnet-4-6', 'model should be original');
	assert(anthropicResp.role === 'assistant', 'role should be assistant');
	assert(anthropicResp.content.length > 0, 'should have content');
	assert(anthropicResp.content[0].type === 'text', 'first content should be text');
	assert(anthropicResp.content[0].text === 'Hello! How can I help?', 'text should match');
	assert(anthropicResp.stop_reason === 'end_turn', 'stop_reason should be end_turn');
});

test('transformOpenAIToAnthropic - with tool calls', () => {
	const openaiResp = {
		id: 'chatcmpl-456',
		choices: [{
			message: {
				role: 'assistant',
				content: 'Let me check the weather.',
				tool_calls: [{
					id: 'call_abc',
					type: 'function',
					function: {
						name: 'get_weather',
						arguments: '{"city":"NYC"}',
					},
				}],
			},
			finish_reason: 'tool_calls',
		}],
	};

	const anthropicResp = transformOpenAIToAnthropic(openaiResp, 'claude-haiku-4-5');
	assert(anthropicResp.stop_reason === 'tool_use', 'stop_reason should be tool_use');
	assert(anthropicResp.content.length >= 2, 'should have text and tool_use');
	const toolUse = anthropicResp.content.find((b) => b.type === 'tool_use');
	assert(toolUse !== undefined, 'should have tool_use block');
	assert(toolUse.name === 'get_weather', 'tool name should match');
	assert(toolUse.input.city === 'NYC', 'tool input should be parsed');
});

test('convertAnthropicToGemini - basic', () => {
	const anthropicBody = {
		model: 'claude-sonnet-4-6',
		messages: [
			{ role: 'user', content: 'Hello' },
		],
		system: 'You are helpful',
		max_tokens: 4096,
	};

	const geminiBody = convertAnthropicToGemini(anthropicBody);
	assert(geminiBody.systemInstruction !== undefined, 'should have systemInstruction');
	assert(geminiBody.systemInstruction.parts[0].text === 'You are helpful', 'system text should match');
	assert(geminiBody.contents.length === 1, 'should have one content');
	assert(geminiBody.contents[0].role === 'user', 'role should be user');
	assert(geminiBody.generationConfig.maxOutputTokens === 4096, 'maxOutputTokens should match');
});

test('convertAnthropicToGemini - role mapping', () => {
	const anthropicBody = {
		model: 'claude-sonnet-4-6',
		messages: [
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hi there' },
		],
	};

	const geminiBody = convertAnthropicToGemini(anthropicBody);
	assert(geminiBody.contents.length === 2, 'should have two contents');
	assert(geminiBody.contents[0].role === 'user', 'first role should be user');
	assert(geminiBody.contents[1].role === 'model', 'assistant should map to model');
});

console.log(`\nResults: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
