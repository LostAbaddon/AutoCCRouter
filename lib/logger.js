const fs = require('fs');
const path = require('path');

const log = (level, ...args) => {
	const levels = { debug: 0, info: 1, warn: 2, error: 3 };
	const configLevel = global.cc2llmConfig && global.cc2llmConfig.logLevel || 'info';
	if (levels[level] >= levels[configLevel]) {
		const ts = new Date().toISOString();
		console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
	}
};

// 交互日志计数器
let interactionCounter = 0;

// 日志目录
const LOGS_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) {
	fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const getNextInteractionId = () => {
	return ++interactionCounter;
};

const logCodexStage = (interactionId, stage, label, data) => {
	const configLevel = global.cc2llmConfig?.logLevel || 'info';
	if (configLevel === 'info') {
		return;
	}

	try {
		const filename = path.join(LOGS_DIR, `codex-${interactionId}-${stage}-${label}.log`);
		const content = typeof data === 'string' ? data : JSON.stringify(data, null, '	');
		fs.writeFileSync(filename, content, 'utf-8');
		log('info', `[Codex-Log] #${interactionId} stage=${stage}(${label}) → ${filename}`);
	}
	catch (e) {
		log('warn', `[Codex-Log] Failed to write log: ${e.message}`);
	}
};

module.exports = { log, getNextInteractionId, logCodexStage };
