global.cc2llmConfig = { logLevel: 'error' };
const { convertResponsesRequestToAnthropic } = require('./lib/handlers/openai-native');
const { filterMessagesWithoutThoughtSignature } = require('./lib/providers/gemini');
const fs = require('fs');
const content = fs.readFileSync('/Users/zhanglei/MyApps/cc2llm/logs/codex-2-1-request.log', 'utf-8');
const idx = content.indexOf('\n\n----\n\n');
const body = JSON.parse(content.substring(idx + 7));

const anth = convertResponsesRequestToAnthropic(body, 'test-session', 'google');
console.log('=== 转换后的 tool_use/tool_result (过滤前) ===');
for (const msg of anth.messages) {
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      const hasSig = !!block.thought_signature;
      console.log(`  [tool_use] id=${block.id} name=${block.name} has_thought_signature=${hasSig}`);
    } else if (block.type === 'tool_result') {
      console.log(`  [tool_result] tool_use_id=${block.tool_use_id}`);
    }
  }
}

const filtered = filterMessagesWithoutThoughtSignature(anth.messages);

console.log('=== 过滤后还剩什么 ===');
let found = 0;
for (const msg of filtered) {
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      console.log(`  [tool_use 幸存的] id=${block.id} name=${block.name}`);
      found++;
    } else if (block.type === 'tool_result') {
      console.log(`  [tool_result 幸存的] tool_use_id=${block.tool_use_id}`);
      found++;
    }
  }
}

const before = anth.messages.reduce((s, m) => s + m.content.filter(b => b.type === 'tool_use' || b.type === 'tool_result').length, 0);
console.log(`\n=== 总结: 原 ${before} 个, 过滤后剩 ${found} 个 ===`);
if (before > 0 && found === 0) {
  console.log('🔥 BUG 复现: 所有 tool_use/tool_result 都被抹去！');
}
