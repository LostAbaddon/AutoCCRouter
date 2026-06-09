const fs = require('fs');
const path = require('path');
const { log } = require('../logger');
const { recognizeTools } = require('./recognizer');
const { renderTools } = require('./renderer');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'tool-translator.json');

let cachedConfig = null;
let cachedMtime = 0;

const loadConfig = (forceReload = false) => {
	try {
		const stat = fs.statSync(CONFIG_PATH);
		if (!forceReload && cachedConfig && stat.mtimeMs === cachedMtime) {
			return cachedConfig;
		}
		const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
		cachedConfig = JSON.parse(raw);
		cachedMtime = stat.mtimeMs;
		log('info', `[tool-translator] 配置已加载 (version=${cachedConfig.version})`);
		return cachedConfig;
	}
	catch (e) {
		log('error', `[tool-translator] 配置加载失败: ${e.message}，使用空配置`);
		cachedConfig = { copilots: {}, providerRender: {}, defaultRender: {} };
		cachedMtime = 0;
		return cachedConfig;
	}
};

let watcher = null;
const enableHotReload = () => {
	if (watcher) return;
	try {
		watcher = fs.watch(CONFIG_PATH, (eventType) => {
			if (eventType === 'change' || eventType === 'rename') {
				log('info', `[tool-translator] 检测到配置文件变更，热重载中...`);
				loadConfig(true);
			}
		});
		log('info', `[tool-translator] 热重载已启用`);
	}
	catch (e) {
		log('warn', `[tool-translator] 热重载启用失败: ${e.message}`);
	}
};

const translateTools = (tools, copilotId, targetProvider) => {
	const config = loadConfig();
	const recognized = recognizeTools(tools, copilotId, config);
	return renderTools(recognized, targetProvider, config);
};

const collectBuiltinKeys = (tools, copilotId) => {
	const config = loadConfig();
	const recognized = recognizeTools(tools, copilotId, config);
	return recognized.builtin.map((b) => b.key);
};

module.exports = {
	loadConfig,
	enableHotReload,
	translateTools,
	collectBuiltinKeys,
	recognizeTools,
	renderTools,
	CONFIG_PATH,
};
