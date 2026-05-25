const http = require('http');
const https = require('https');
const { URL } = require('url');
const { log } = require('./logger');

const proxyRequest = (proxyUrl, options, requestBody, callback) => {
	if (!proxyUrl) {
		const transport = options._isHttps ? https : http;
		const req = transport.request(options, (proxyRes) => {
			callback(null, proxyRes);
		});
		req.on('error', (err) => { callback(err); });
		if (requestBody) {
			req.write(requestBody);
		}
		req.end();
		return req;
	}

	let proxy;
	try {
		proxy = new URL(proxyUrl);
	}
	catch (e) {
		log('warn', `Invalid proxy URL: ${proxyUrl}`);
		const transport = options._isHttps ? https : http;
		const req = transport.request(options, (proxyRes) => {
			callback(null, proxyRes);
		});
		req.on('error', (err) => { callback(err); });
		if (requestBody) {
			req.write(requestBody);
		}
		req.end();
		return req;
	}

	const proxyHost = proxy.hostname;
	const proxyPort = parseInt(proxy.port, 10) || 8080;
	const targetHost = options.hostname;
	const targetPort = options.port || (options._isHttps ? 443 : 80);

	log('debug', `[Proxy] CONNECT ${targetHost}:${targetPort} via ${proxyHost}:${proxyPort}`);

	const connectReq = http.request({
		host: proxyHost,
		port: proxyPort,
		method: 'CONNECT',
		path: `${targetHost}:${targetPort}`,
		headers: {
			'Host': `${targetHost}:${targetPort}`,
		},
	});

	connectReq.on('connect', (res, socket) => {
		log('debug', `[Proxy] CONNECT response: HTTP ${res.statusCode}`);

		if (res.statusCode !== 200) {
			socket.destroy();
			callback(new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
			return;
		}

		log('debug', `[Proxy] Tunnel established, starting TLS via https.request...`);

		const isHttps = options._isHttps;
		delete options._isHttps;
		options.socket = socket;
		options.agent = false;

		const transport = isHttps ? https : http;
		const req = transport.request(options, (proxyRes) => {
			log('debug', `[Proxy] Got response: HTTP ${proxyRes.statusCode}`);
			callback(null, proxyRes);
		});

		req.on('error', (err) => {
			log('error', `[Proxy] Request error through tunnel: ${err.message}`);
			callback(err);
		});

		if (requestBody) {
			req.write(requestBody);
		}
		req.end();
	});

	connectReq.on('error', (err) => {
		log('error', `[Proxy] CONNECT error: ${err.message} (code=${err.code})`);
		callback(err);
	});

	connectReq.on('timeout', () => {
		log('error', `[Proxy] CONNECT timeout (30s)`);
		connectReq.destroy();
		callback(new Error('Proxy CONNECT timeout'));
	});

	connectReq.setTimeout(30000);
	connectReq.end();

	return connectReq;
};

module.exports = { proxyRequest };
