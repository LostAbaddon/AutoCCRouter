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

const saveConfig = (config) => {
	const json = JSON.stringify(config, null, '\t');
	fs.writeFileSync(configPath, json, 'utf-8');
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

module.exports = { loadConfig, saveConfig, configPath, resolveMaxTokens };
