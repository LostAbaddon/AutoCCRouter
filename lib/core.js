const { log } = require('./logger');

globalThis.wait = (delay=0) => new Promise(res => setTimeout(res, delay));

globalThis.executeWithRetry = (task, maxAttempts=3) => async (...args) => {
	let lastError = null;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		lastError = null;
		try {
			const result = await task(...args);
			return result;
		}
		catch (err) {
			log('error', `Execute task failed:\n`, err);
			lastError = err;
		}
	}
	if (lastError) throw lastError;
};