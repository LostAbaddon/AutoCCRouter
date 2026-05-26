const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const promptsDir = path.join(__dirname, '..', 'prompts');

// 内存存储: name → { description, content, filePath }
const prompts = new Map();

// 解析 Markdown 文件的 YAML frontmatter
// 格式: ---\nkey: value\n---\n\nbody
const parseFrontmatter = (raw) => {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('---')) {
		return { metadata: {}, content: trimmed };
	}
	const endIdx = trimmed.indexOf('---', 3);
	if (endIdx === -1) {
		return { metadata: {}, content: trimmed };
	}
	const fmBlock = trimmed.substring(3, endIdx).trim();
	const content = trimmed.substring(endIdx + 3).trim();

	const metadata = {};
	for (const line of fmBlock.split('\n')) {
		const colonIdx = line.indexOf(':');
		if (colonIdx > 0) {
			const key = line.substring(0, colonIdx).trim();
			const value = line.substring(colonIdx + 1).trim();
			metadata[key] = value;
		}
	}
	return { metadata, content };
};

// 加载单个 .md 文件
const loadPromptFile = (filePath) => {
	const name = path.basename(filePath, '.md');
	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		const { metadata, content } = parseFrontmatter(raw);
		prompts.set(name, {
			description: metadata.description || name,
			content,
			filePath,
		});
		log('debug', `[Prompt] Loaded: ${name}`);
	}
	catch (e) {
		log('warn', `[Prompt] Failed to load ${filePath}: ${e.message}`);
	}
};

// 启动时加载所有 prompts/*.md 文件
const loadAllPrompts = () => {
	try {
		const files = fs.readdirSync(promptsDir);
		for (const file of files) {
			if (file.endsWith('.md')) {
				loadPromptFile(path.join(promptsDir, file));
			}
		}
		log('info', `[Prompt] Loaded ${prompts.size} prompt(s)`);
	}
	catch (e) {
		log('warn', `[Prompt] Failed to read prompts directory: ${e.message}`);
	}
};

// 获取单个 prompt 的原始内容
const getPrompt = (name) => {
	const p = prompts.get(name);
	return p ? p.content : null;
};

// 获取所有 prompt 的元数据和内容
const getAllPrompts = () => {
	const result = [];
	for (const [name, p] of prompts) {
		result.push({
			name,
			description: p.description,
			content: p.content,
		});
	}
	return result;
};

// 更新 prompt 内容，同时写回文件
const updatePrompt = (name, newContent) => {
	const p = prompts.get(name);
	if (!p) {
		return false;
	}

	// 重新构建完整的 Markdown 文件（保留 frontmatter）
	const fmBlock = [
		'---',
		`description: ${p.description}`,
		'---',
		'',
	].join('\n');
	const fullFile = fmBlock + newContent.trim() + '\n';

	try {
		fs.writeFileSync(p.filePath, fullFile, 'utf-8');
		p.content = newContent.trim();
		log('info', `[Prompt] Updated: ${name}`);
		return true;
	}
	catch (e) {
		log('warn', `[Prompt] Failed to write ${p.filePath}: ${e.message}`);
		return false;
	}
};

// 启动时自动加载
loadAllPrompts();

module.exports = {
	getPrompt,
	getAllPrompts,
	updatePrompt,
};
