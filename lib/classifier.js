const { getPrompt } = require('./prompt-store');

// 动态构建分类 prompt，包含可用 mode 列表
// 如果 prompt 文件不存在或为空，返回 null，调用方应直接使用 default mode
const buildClassificationPrompt = (availableModes, currentMode, isUser) => {
	const template = getPrompt(isUser ? 'classifier-forUser' : 'classifier-forAssistant');
	if (!template || !template.trim()) {
		return null;
	}
	const modeList = availableModes
		.map((m) => `- name: ${m.name}\n  description: ${m.description}`)
		.join('\n');
	return template
		.replace('{{availableModes}}', modeList)
		.replace('{{currentMode}}', currentMode || 'default');
};

module.exports = {
	buildClassificationPrompt,
};
