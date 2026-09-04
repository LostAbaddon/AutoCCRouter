global.cc2llmConfig = { logLevel: 'error' };
const fs = require('fs');

const logPath = '/Users/zhanglei/MyApps/cc2llm/logs/codex-2-1-request.log';
const content = fs.readFileSync(logPath, 'utf-8');
const sep = content.indexOf('\n\n----\n\n');
const bodyStr = sep >= 0 ? content.substring(sep + 7) : content;
const requestBody = JSON.parse(bodyStr);

const { convertResponsesRequestToAnthropic } = require('./lib/handlers/openai-native');
const { convertAnthropicToGemini } = require('./lib/providers/gemini');

console.log('=== Codex request body.tools ===');
console.log('count:', (requestBody.tools || []).length);

const addtl = (requestBody.input || []).filter(it => it && it.type === 'additional_tools');
console.log('=== Codex request body.input[].additional_tools ===');
console.log('count:', addtl.length, 'tools:', addtl.reduce((s, it) => s + (it.tools?.length || 0), 0));

const anthropicBody = convertResponsesRequestToAnthropic(requestBody, 'test-session', 'google');
console.log('\n=== anthropicBody.tools ===');
console.log('count:', (anthropicBody.tools || []).length);
for (const t of anthropicBody.tools || []) {
  console.log(`  - name="${t.name}" desc="${(t.description || '').slice(0, 60)}..."`);
}

const geminiBody = convertAnthropicToGemini(anthropicBody);
console.log('\n=== geminiBody.tools (functionDeclarations) ===');
const fds = geminiBody.tools?.[0]?.functionDeclarations;
if (fds) {
  console.log('count:', fds.length);
  for (const fd of fds) {
    console.log(`  - name="${fd.name}"`);
  }
} else {
  console.log('NO TOOLS FIELD');
}
