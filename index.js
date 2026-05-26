const { loadConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { createProxyServer } = require('./lib/proxy-server');
const { createAdminServer } = require('./lib/admin');

const config = loadConfig();

global.cc2llmConfig = config;

const getConfig = () => global.cc2llmConfig;

const proxyServer = createProxyServer(getConfig);
const adminServer = createAdminServer(getConfig);

const proxyPort = config.server.port || 8765;
const proxyHost = config.server.host || '127.0.0.1';
const adminPort = config.server.adminPort || 8766;

proxyServer.listen(proxyPort, proxyHost, () => {
	log('info', `Proxy server started on http://${proxyHost}:${proxyPort}`);
	log('info', `Providers: ${Object.keys(config.providers || {}).join(', ') || '(none)'}`);
	log('info', 'Model mappings:');
	(config.modelMapping || []).forEach((rule) => {
		log('info', `  ${rule.prefix}* → ${rule.target} (${rule.provider})`);
	});
});

adminServer.listen(adminPort, proxyHost, () => {
	log('info', `Admin server started on http://${proxyHost}:${adminPort}`);
});

const shutdown = () => {
	log('info', 'Shutting down...');
	let closer = setTimeout(() => {
		log('info', 'Shutted down forcely');
		process.exit(0);
	}, 1000);
	proxyServer.close(() => {
		adminServer.close(() => {
			if (closer) clearTimeout(closer);
			log('info', 'Shutted down');
			process.exit(0);
		});
	});
};

process.on('SIGINT', () => {
	log('info', 'Received SIGINT, shutting down');
	shutdown();
});
process.on('SIGTERM', () => {
	log('warn', `Received SIGTERM (pid=${process.pid}, ppid=${process.ppid}) — ignored. Use Ctrl+C (SIGINT) to stop.`);
	shutdown();
});

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (err) => {
	log('error', `Uncaught exception: ${err.message}`, err.stack || '');
});

process.on('unhandledRejection', (reason) => {
	log('error', `Unhandled rejection: ${reason}`);
});

module.exports = { getConfig, proxyServer, adminServer };
