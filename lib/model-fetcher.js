const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { log } = require('./logger');

// 加载独立过滤文件 model-filter.json，每个 provider 有独立的排除规则
const filterPath = path.join(__dirname, '..', 'config', 'model-filter.json');
const providerExcludeRegexes = new Map();
try {
	const filterConfig = JSON.parse(fs.readFileSync(filterPath, 'utf-8'));
	for (const [providerName, patterns] of Object.entries(filterConfig)) {
		if (!Array.isArray(patterns)) {
			continue;
		}
		const regexes = [];
		for (const pattern of patterns) {
			try {
				regexes.push(new RegExp(pattern, 'i'));
			}
			catch (e) {
				log('warn', `[ModelFetcher] Invalid exclude pattern "${pattern}" for ${providerName}: ${e.message}`);
			}
		}
		if (regexes.length > 0) {
			providerExcludeRegexes.set(providerName, regexes);
			log('info', `[ModelFetcher] ${providerName}: ${regexes.length} exclude patterns`);
		}
	}
}
catch (e) {
	log('warn', `[ModelFetcher] Failed to load model-filter.json: ${e.message}`);
}

// 排除非语言模型：根据 provider 名称应用对应的排除规则
const excludeNonLanguageModels = (models, providerName) => {
	const regexes = providerExcludeRegexes.get(providerName);
	if (!regexes || regexes.length === 0) {
		return models;
	}
	return models.filter((m) => {
		for (const regex of regexes) {
			if (regex.test(m)) {
				return false;
			}
		}
		return true;
	});
};

// 为每个 provider type 获取可用 model 列表
// 返回 { providerName: [modelName, ...] }

const fetchUrl = (url, proxyUrl, apiKey, timeout = 15000) => {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const isHttps = parsed.protocol === 'https:';
		const transport = isHttps ? https : http;

		const options = {
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: parsed.pathname + parsed.search,
			method: 'GET',
			headers: {},
			rejectUnauthorized: false,
		};

		if (apiKey) {
			options.headers['Authorization'] = `Bearer ${apiKey}`;
		}

		// 如果配置了 proxy，走 proxy tunnel
		const doRequest = () => {
			const req = transport.request(options, (res) => {
				let data = '';
				res.on('data', (chunk) => { data += chunk; });
				res.on('end', () => {
					if (res.statusCode !== 200) {
						reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
						return;
					}
					try {
						resolve(JSON.parse(data));
					}
					catch (e) {
						reject(new Error(`Failed to parse response: ${e.message}`));
					}
				});
			});

			req.on('error', reject);
			req.setTimeout(timeout, () => {
				req.destroy();
				reject(new Error('Request timeout'));
			});
			req.end();
		};

		if (proxyUrl) {
			const proxyParsed = new URL(proxyUrl);
			const connectReq = http.request({
				host: proxyParsed.hostname,
				port: parseInt(proxyParsed.port, 10) || 8080,
				method: 'CONNECT',
				path: `${parsed.hostname}:${parsed.port || (isHttps ? 443 : 80)}`,
				headers: { 'Host': `${parsed.hostname}:${parsed.port || (isHttps ? 443 : 80)}` },
			});

			connectReq.on('connect', (res, socket) => {
				if (res.statusCode !== 200) {
					socket.destroy();
					reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
					return;
				}
				options.socket = socket;
				options.agent = false;
				doRequest();
			});

			connectReq.on('error', reject);
			connectReq.setTimeout(15000, () => {
				connectReq.destroy();
				reject(new Error('Proxy CONNECT timeout'));
			});
			connectReq.end();
		}
		else {
			doRequest();
		}
	});
};

// OpenAI-compatible: GET {baseUrl}/models → { data: [{ id }] }
const fetchOpenAIModels = async (provider) => {
	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const url = `${baseUrl}/models`;

	log('debug', `[ModelFetcher] Fetching OpenAI models from ${url}`);

	const result = await fetchUrl(url, provider.proxy, provider.apiKey);
	if (result && Array.isArray(result.data)) {
		return result.data.map((item) => item.id);
	}
	return [];
};

// Gemini: GET {baseUrl}/models?key={apiKey} → { models: [{ name, displayName }] }
const fetchGeminiModels = async (provider) => {
	const baseUrl = provider.baseUrl.replace(/\/+$/, '');
	const url = `${baseUrl}/models?key=${encodeURIComponent(provider.apiKey)}`;

	log('debug', `[ModelFetcher] Fetching Gemini models from ${url.replace(provider.apiKey, '***')}`);

	const result = await fetchUrl(url, provider.proxy, null);
	if (result && Array.isArray(result.models)) {
		return result.models.map((item) => item.name.replace(/^models\//, ''));
	}
	return [];
};

// Anthropic-compatible: 尝试 GET {baseUrl}/models (非标准，部分 provider 支持)
// 如果 baseUrl 以 /anthropic 结尾，去掉该路径后缀（如 DeepSeek 的模型 API 在根路径）
const fetchAnthropicModels = async (provider) => {
	let baseUrl = provider.baseUrl.replace(/\/+$/, '');
	baseUrl = baseUrl.replace(/\/anthropic$/, '');
	const url = `${baseUrl}/models`;

	log('debug', `[ModelFetcher] Fetching Anthropic-compatible models from ${url}`);

	const result = await fetchUrl(url, provider.proxy, provider.apiKey);
	if (result && Array.isArray(result.data)) {
		return result.data.map((item) => item.id);
	}
	if (result && Array.isArray(result.models)) {
		return result.models.map((item) => item.name || item.id);
	}
	return [];
};

// 应用 modelFilter 规则，筛选出匹配的模型 (whitelist keep filter)
const applyFilter = (models, filterRegex) => {
	if (!filterRegex || !filterRegex.trim()) {
		return models;
	}
	try {
		const regex = new RegExp(filterRegex, 'i');
		return models.filter((m) => regex.test(m));
	}
	catch (e) {
		log('warn', `[ModelFetcher] Invalid filter regex "${filterRegex}": ${e.message}`);
		return models;
	}
};

// 为单个 provider 获取 model 列表
const fetchProviderModels = async (providerName, provider) => {
	try {
		let models = [];

		if (provider.type === 'gemini') {
			models = await fetchGeminiModels(provider);
		}
		else if (provider.type === 'openai') {
			models = await fetchOpenAIModels(provider);
		}
		else {
			// anthropic 或其他
			models = await fetchAnthropicModels(provider);
		}

		// 排除非语言模型（根据 provider 的独立规则）
		const beforeExclude = models.length;
		models = excludeNonLanguageModels(models, providerName);
		if (models.length < beforeExclude) {
			log('debug', `[ModelFetcher] ${providerName}: ${beforeExclude} → ${models.length} models after excluding non-language models`);
		}

		// 应用 provider 自定义 modelFilter 白名单
		if (provider.modelFilter) {
			const before = models.length;
			models = applyFilter(models, provider.modelFilter);
			log('debug', `[ModelFetcher] ${providerName}: ${before} → ${models.length} models after filter "${provider.modelFilter}"`);
		}

		return models;
	}
	catch (e) {
		log('warn', `[ModelFetcher] Failed to fetch models for ${providerName}: ${e.message}`);
		return [];
	}
};

// 获取所有 provider 的 model 列表
const fetchAllModels = async (config) => {
	const providers = config.providers || {};
	const result = {};

	for (const [name, provider] of Object.entries(providers)) {
		if (name === 'auto') {
			continue;
		}
		if (!provider.apiKey || !provider.baseUrl) {
			log('debug', `[ModelFetcher] Skipping ${name}: no apiKey or baseUrl`);
			continue;
		}
		result[name] = await fetchProviderModels(name, provider);
	}

	// 添加 auto provider: models = agents 的顶层 key（config set 名称）
	const agentKeys = [];
	if (config.agents) {
		for (const setName of Object.keys(config.agents)) {
			if (typeof config.agents[setName] === 'object' && !Array.isArray(config.agents[setName])) {
				agentKeys.push(setName);
			}
		}
	}
	result['auto'] = agentKeys;

	return result;
};

module.exports = { fetchAllModels, fetchProviderModels };
