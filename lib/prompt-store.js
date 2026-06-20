const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const promptsDir = path.join(__dirname, '..', 'prompts');

// 内存存储: name → { description, content, filePath }
const prompts = new Map();

// 记录每个文件最近一次由本进程写入的 mtimeMs。
// 用于 fs.watch 回调中识别自身写盘触发的回环事件，避免无意义重复加载。
const lastSaveMtime = new Map();

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
		try {
			const stat = fs.statSync(filePath);
			lastSaveMtime.set(filePath, stat.mtimeMs);
		}
		catch {}
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

// 判断文件名是否为 prompts 目录下的有效 .md 文件
const isPromptFile = (fileName) => {
	if (!fileName || !fileName.endsWith('.md')) {
		return false;
	}
	const filePath = path.join(promptsDir, fileName);
	try {
		const stat = fs.statSync(filePath);
		return stat.isFile();
	}
	catch (e) {
		return false;
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
		// 内容刷新交给 fs.watch 回调统一处理，避免双写。
		// 若写盘后 watch 未触发（极端情况），stat 记录的 mtimeMs 也能保证不会再次加载旧版本。
		log('info', `[Prompt] Written: ${name}, waiting for fs.watch reload`);
		return true;
	}
	catch (e) {
		log('warn', `[Prompt] Failed to write ${p.filePath}: ${e.message}`);
		return false;
	}
};

// 监听 prompts 目录变动，实现文件级热重载
const watchPrompts = () => {
	try {
		const watcher = fs.watch(promptsDir, (eventType, fileName) => {
			if (!fileName || !isPromptFile(fileName)) {
				return;
			}

			const filePath = path.join(promptsDir, fileName);

			// 通过 mtimeMs 过滤掉 fs.watch 常见的重复事件以及本进程自身写盘触发的回环。
			let mtimeMs = 0;
			try {
				const stat = fs.statSync(filePath);
				mtimeMs = stat.mtimeMs;
			}
			catch (e) {
				return;
			}

			const savedMtime = lastSaveMtime.get(filePath);
			if (savedMtime === mtimeMs) {
				return;
			}

			loadPromptFile(filePath);
			log('info', `[Prompt] Hot reloaded: ${fileName}`);
		});
		log('info', '[Prompt] Hot reload watcher enabled');
		return watcher;
	}
	catch (e) {
		log('warn', `[Prompt] Failed to enable hot reload watcher: ${e.message}`);
		return null;
	}
};

// 启动时自动加载
loadAllPrompts();
watchPrompts();

module.exports = {
	getPrompt,
	getAllPrompts,
	updatePrompt,
};
