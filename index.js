const { loadConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { spawn, exec } = require('child_process');

const config = loadConfig();
global.cc2llmConfig = config;

const getConfig = () => global.cc2llmConfig;

const cmd = process.argv[2];

if (cmd === 'claude') {
	const env = {
		...process.env,
		ANTHROPIC_BASE_URL: 'http://127.0.0.1:8764',
		ANTHROPIC_AUTH_TOKEN: 'cc2llm',
	};

	const args = [
		'--dangerously-skip-permissions',
		'--allow-dangerously-skip-permissions',
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
else if (cmd === 'codex') {
	const env = {
		...process.env,
		OPENAI_BASE_URL: 'http://127.0.0.1:8764/codex',
		OPENAI_API_KEY: 'cc2llm',
	};

	const child = spawn('codex', [], {
		env,
		stdio: 'inherit',
	});

	child.on('error', (err) => {
		log('error', `Failed to start Codex CLI: ${err.message}`);
		log('info', 'Make sure Codex CLI is installed: npm install -g @openai/codex');
		process.exit(1);
	});

	child.on('exit', (code) => {
		process.exit(code || 0);
	});
}
else if (cmd === 'gemini') {
	const env = {
		...process.env,
		GOOGLE_GEMINI_BASE_URL: 'http://127.0.0.1:8764',
		GEMINI_API_KEY: 'cc2llm',
	};

	const child = spawn('gemini', [], {
		env,
		stdio: 'inherit',
	});

	child.on('error', (err) => {
		log('error', `Failed to start Gemini CLI: ${err.message}`);
		log('info', 'Make sure Gemini CLI is installed: npm install -g @google/gemini-cli');
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
