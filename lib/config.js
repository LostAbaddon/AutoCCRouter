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

	if (!config.logLevel) {
		config.logLevel = 'info';
	}

	return config;
};

const saveConfig = (config) => {
	const json = JSON.stringify(config, null, '\t');
	fs.writeFileSync(configPath, json, 'utf-8');
};

module.exports = { loadConfig, saveConfig, configPath };
