const log = (level, ...args) => {
	const levels = { debug: 0, info: 1, warn: 2, error: 3 };
	const configLevel = global.cc2llmConfig && global.cc2llmConfig.logLevel || 'info';
	if (levels[level] >= levels[configLevel]) {
		const ts = new Date().toISOString();
		console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
	}
};

module.exports = { log };
