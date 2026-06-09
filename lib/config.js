const { log } = require('./logger');

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');

const loadConfig = () => {
	if (!fs.existsSync(configPath)) {
		console.error('config.json not found. Copy config.template.json to config.json and fill in your API keys.');
		process.exit(1);
	}

	const raw = fs.readFileSync(configPath, 'utf-8');
	const config = JSON.parse(raw);

	if (!config.server) {
		config.server = { port: 8765, host: '127.0.0.1', adminPort: 8766 };
	}

	if (!config.providers) {
		config.providers = {};
	}

	if (!config.modelMapping) {
		config.modelMapping = [];
	}

	if (!config.agents) {
		config.agents = {};
	}

	// 向后兼容：如果 agents 是扁平结构（没有 defaults key，且 value 是字符串），自动迁移
	const agentKeys = Object.keys(config.agents);
	if (agentKeys.length > 0) {
		const hasDefaults = config.agents.defaults !== undefined;
		if (!hasDefaults) {
			const allStrings = agentKeys.every((k) => typeof config.agents[k] === 'string');
			if (allStrings) {
				config.agents = { defaults: config.agents };
			}
		}
	}

	if (!config.logLevel) {
		config.logLevel = 'info';
	}

	if (config.conversationGroups == null) {
		config.conversationGroups = 5;
	}

	return config;
};

// 记录 saveConfig 写入后的 mtime，供 watcher 跳过自身写入触发的回环事件
let lastSaveMtime = 0;

const saveConfig = (config) => {
	const json = JSON.stringify(config, null, '\t');
	fs.writeFileSync(configPath, json, 'utf-8');
	try {
		lastSaveMtime = fs.statSync(configPath).mtimeMs;
	}
	catch (e) {
		lastSaveMtime = 0;
	}
};

// 三层查找 maxTokens: 模型级 → provider 默认 → 全局默认 → 131072
const resolveMaxTokens = (config, provider, model) => {
	const modelEntry = Array.isArray(provider.models)
		? provider.models.find((m) => m.name === model)
		: null;
	return (modelEntry && modelEntry.maxTokens)
		|| provider.defaultMaxTokens
		|| config.defaultMaxTokens
		|| 131072;
};

// 监听 config.json 变动，回调收到 (newConfig) 完整解析后的对象。
// 与 admin routes 的 handlePutConfig 一样：消费方应 mutate 同一引用而非替换全局对象，
// 这样所有持有原引用的模块（如 proxy-server、admin routes 闭包）都能看到变更。
// 通过 lastSaveMtime 跳过自身 saveConfig 写入触发的回环事件。
const watchConfig = (onChange) => {
	try {
		const watcher = fs.watch(configPath, (eventType) => {
			if (eventType !== 'change' && eventType !== 'rename') return;

			try {
				const stat = fs.statSync(configPath);
				if (stat.mtimeMs === lastSaveMtime) return; // 自身写盘，跳过
			}
			catch (e) {
				return;
			}

			try {
				const raw = fs.readFileSync(configPath, 'utf-8');
				const newConfig = JSON.parse(raw);
				onChange(newConfig);
			}
			catch (e) {
				log('warn', `[config] 热重载失败: ${e.message}`);
			}
		});
		log('info', '[config] 热重载已启用');
		return watcher;
	}
	catch (e) {
		log('warn', `[config] 热重载启用失败: ${e.message}`);
		return null;
	}
};

module.exports = { loadConfig, saveConfig, watchConfig, configPath, resolveMaxTokens };
