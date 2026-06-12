const fs = require('fs');
const path = require('path');
const { loadConfig, watchConfig } = require('./lib/config');
const { log } = require('./lib/logger');
const { spawn, exec } = require('child_process');

// 启动时清空 logs 目录下的所有历史文件，确保本次运行的日志独立。
// 注意：进程被守护工具自动重启时，上次崩溃的日志会被清空，无法事后追溯。
const logsDir = path.join(__dirname, 'logs');
try {
	if (fs.existsSync(logsDir)) {
		fs.rmSync(logsDir, { recursive: true, force: true });
	}
	fs.mkdirSync(logsDir, { recursive: true });
}
catch (e) {
	console.error(`[startup] 清空 logs 目录失败: ${e.message}`);
}

const config = loadConfig();
global.cc2llmConfig = config;

const getConfig = () => global.cc2llmConfig;

// config.json 外部变更时热生效：mutate 同一引用，而非替换全局对象。
// 这与 lib/admin/routes.js 中 handlePutConfig 的字段合并方式保持一致，
// 保证 proxy-server、admin routes、providers 等所有持有原引用的模块立刻看到变更。
watchConfig((newConfig) => {
	const cfg = global.cc2llmConfig;
	if (newConfig.server) cfg.server = { ...cfg.server, ...newConfig.server };
	if (newConfig.providers) cfg.providers = newConfig.providers;
	if (newConfig.modelMapping) cfg.modelMapping = newConfig.modelMapping;
	if (newConfig.agents) cfg.agents = newConfig.agents;
	if (newConfig.logLevel) cfg.logLevel = newConfig.logLevel;
	if (newConfig.defaultMaxTokens !== undefined) cfg.defaultMaxTokens = newConfig.defaultMaxTokens;
	if (newConfig.conversationGroups !== undefined) cfg.conversationGroups = newConfig.conversationGroups;
	if (newConfig.modeCacheTtl !== undefined) cfg.modeCacheTtl = newConfig.modeCacheTtl;
	log('info', '[config] 已热重载 config.json');
	// 热加载时重置 Model Router 所有权重和计数
	try {
		const modelRouter = require('./lib/model-router');
		modelRouter.resetAll();
		log('info', '[config] 已重置 Model Router 状态');
	}
	catch (e) {
		log('warn', `[config] 重置 Model Router 失败: ${e.message}`);
	}
});

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
