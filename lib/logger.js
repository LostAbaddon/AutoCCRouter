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

const logClientStage = (client, interactionId, stage, label, data, append) => {
	const configLevel = global.cc2llmConfig?.logLevel || 'info';

	if (append !== true && append !== false) append = stage > 2;

	try {
		const filename = path.join(LOGS_DIR, `${client}-${interactionId}-${stage}-${label}.log`);
		const content = typeof data === 'string' ? data : JSON.stringify(data, null, '	');
		if (append) fs.appendFileSync(filename, content, 'utf-8');
		else fs.writeFileSync(filename, content, 'utf-8');
		// log('debug', `[${client.charAt(0).toUpperCase() + client.slice(1)}-Log] #${interactionId} stage=${stage}(${label}) → ${filename}`);
	}
	catch (e) {
		log('warn', `[${client}-Log] Failed to write log: ${e.message}`);
	}
};

module.exports = { log, getNextInteractionId, logClientStage };
