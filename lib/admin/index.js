const http = require('http');
const fs = require('fs');
const path = require('path');
const { createApiRoutes } = require('./routes');
const { log } = require('../logger');

const MIME_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

const serveStaticFile = (res, filePath) => {
	const ext = path.extname(filePath);
	const contentType = MIME_TYPES[ext] || 'application/octet-stream';

	try {
		const content = fs.readFileSync(filePath);
		res.writeHead(200, { 'Content-Type': contentType });
		res.end(content);
	}
	catch (e) {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'File not found' }));
	}
};

const createAdminServer = (getConfig) => {
	const api = createApiRoutes(getConfig);
	const frontendDir = path.join(__dirname, '..', '..', 'frontend');

	const server = http.createServer((req, res) => {
		req.on('error', () => {});
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', '*');

		if (req.method === 'OPTIONS') {
			res.writeHead(200);
			res.end();
			return;
		}

		const url = req.url || '/';

		if (url === '/api/config' && req.method === 'GET') {
			api.handleGetConfig(res);
			return;
		}

		if (url === '/api/config' && req.method === 'PUT') {
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => { api.handlePutConfig(req, res, body); });
			return;
		}

		if (url === '/api/providers' && req.method === 'GET') {
			api.handleGetProviders(res);
			return;
		}

		if (url === '/api/providers' && req.method === 'POST') {
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => { api.handleAddProvider(req, res, body); });
			return;
		}

		if (url.startsWith('/api/providers/') && req.method === 'DELETE') {
			const providerName = decodeURIComponent(url.split('/').pop());
			api.handleDeleteProvider(res, providerName);
			return;
		}

		if (url === '/api/mappings' && req.method === 'GET') {
			api.handleGetMappings(res);
			return;
		}

		if (url === '/api/mappings' && req.method === 'POST') {
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => { api.handleAddMapping(req, res, body); });
			return;
		}

		if (url.startsWith('/api/mappings/') && req.method === 'PUT') {
			const index = parseInt(url.split('/').pop(), 10);
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => { api.handleUpdateMapping(req, res, index, body); });
			return;
		}

		if (url.startsWith('/api/mappings/') && req.method === 'DELETE') {
			const index = parseInt(url.split('/').pop(), 10);
			api.handleDeleteMapping(res, index);
			return;
		}

		if (url === '/api/prompts' && req.method === 'GET') {
			api.handleGetPrompts(res);
			return;
		}

		if (url.startsWith('/api/prompts/') && req.method === 'PUT') {
			const promptName = decodeURIComponent(url.split('/').pop());
			let body = '';
			req.on('data', (chunk) => { body += chunk; });
			req.on('end', () => { api.handlePutPrompt(res, promptName, body); });
			return;
		}

		if (url === '/api/models' && req.method === 'GET') {
			api.handleModels(res);
			return;
		}

		if (url.startsWith('/api/usage')) {
			api.handleUsage(res, url);
			return;
		}

		if (url === '/api/status') {
			api.handleStatus(res);
			return;
		}

		if (url === '/api/key-states') {
			api.handleGetKeyStates(res);
			return;
		}

		if (url === '/api/model-router') {
			api.handleGetModelRouter(res);
			return;
		}

		if (url === '/api/git-status') {
			api.handleGetGitStatus(res);
			return;
		}

		let filePath = url === '/' ? '/index.html' : url;
		filePath = path.join(frontendDir, filePath);

		if (filePath.startsWith(frontendDir)) {
			serveStaticFile(res, filePath);
		}
		else {
			res.writeHead(403);
			res.end();
		}
	});

	return server;
};

module.exports = { createAdminServer };
