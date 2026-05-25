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
	proxyServer.close(() => {
		adminServer.close(() => {
			process.exit(0);
		});
	});
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = { getConfig, proxyServer, adminServer };
