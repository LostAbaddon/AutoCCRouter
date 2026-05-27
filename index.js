const { loadConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { spawn, exec } = require('child_process');

const config = loadConfig();
global.cc2llmConfig = config;

const getConfig = () => global.cc2llmConfig;

const cmd = process.argv[2];

if (cmd === 'tui') {
	const env = {
		...process.env,
		ANTHROPIC_BASE_URL: 'http://127.0.0.1:8764',
		ANTHROPIC_AUTH_TOKEN: 'cc2llm',
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
		CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
		CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
		CLAUDE_CODE_EFFORT_LEVEL: 'max',
		CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
		CLAUDE_YOLO: '1',
	};

	const args = [
		'--dangerously-skip-permissions',
		'--allow-dangerously-skip-permissions',
		'--exclude-dynamic-system-prompt-sections',
		'--settings', '{"includeGitInstructions":false}',
	];

	const child = spawn('claude', args, {
		env,
		stdio: 'inherit',
	});

	child.on('error', (err) => {
		log('error', `Failed to start Claude Code: ${err.message}`);
		process.exit(1);
	});

	child.on('exit', (code) => {
		process.exit(code || 0);
	});
}
else if (cmd === 'wui') {
	const adminPort = config.server.adminPort || 8765;
	const adminHost = config.server.host || '127.0.0.1';
	const url = `http://${adminHost}:${adminPort}`;

	log('info', `Opening browser to ${url}`);

	exec(`open "${url}"`, (err) => {
		if (err) {
			log('error', `Failed to open browser: ${err.message}`);
			process.exit(1);
		}
		process.exit(0);
	});
}
else {
	const { createProxyServer } = require('./lib/proxy-server');
	const { createAdminServer } = require('./lib/admin');

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
				if (closer) {
					clearTimeout(closer);
				}
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

	process.on('uncaughtException', (err) => {
		log('error', `Uncaught exception: ${err.message}`, err.stack || '');
	});
	process.on('unhandledRejection', (reason) => {
		log('error', `Unhandled rejection: ${reason}`);
	});

	module.exports = { getConfig, proxyServer, adminServer };
}
