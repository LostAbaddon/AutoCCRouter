const { saveConfig, configPath } = require('../config');
const { log } = require('../logger');
const { getAllPrompts, updatePrompt } = require('../prompt-store');
const { getUsage } = require('../usage-tracker');
const { fetchAllModels } = require('../model-fetcher');
const { getAllSnapshots } = require('../key-state-manager');

const createApiRoutes = (getConfig) => {
	const handleGetConfig = (res) => {
		const config = getConfig();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		const safeConfig = JSON.parse(JSON.stringify(config));
		res.end(JSON.stringify(safeConfig));
	};

	const maskApiKey = (apiKey) => {
		if (typeof apiKey === 'string' && apiKey.length > 8) {
			return `${apiKey.substring(0, 8)}...${apiKey.substring(apiKey.length - 4)}`;
		}
		if (Array.isArray(apiKey)) {
			return apiKey.map((k) => maskApiKey(k));
		}
		return '';
	};

	const handleGetProviders = (res) => {
		const config = getConfig();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		const providers = {};
		for (const [name, p] of Object.entries(config.providers || {})) {
			providers[name] = {
				type: p.type || 'anthropic',
				baseUrl: p.baseUrl,
				apiKey: maskApiKey(p.apiKey),
				proxy: p.proxy || '',
			};
		}
		res.end(JSON.stringify(providers));
	};

	const handleGetKeyStates = (res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(getAllSnapshots()));
	};

	const handleGetMappings = (res) => {
		const config = getConfig();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(config.modelMapping || []));
	};

	const handlePutConfig = (req, res, body) => {
		try {
			const newConfig = JSON.parse(body);
			const currentConfig = getConfig();

			if (newConfig.server) {
				currentConfig.server = { ...currentConfig.server, ...newConfig.server };
			}
			if (newConfig.providers) {
				currentConfig.providers = newConfig.providers;
			}
			if (newConfig.modelMapping) {
				currentConfig.modelMapping = newConfig.modelMapping;
			}
			if (newConfig.agents) {
				currentConfig.agents = newConfig.agents;
			}
			if (newConfig.logLevel) {
				currentConfig.logLevel = newConfig.logLevel;
			}
			if (newConfig.modeCacheTtl !== undefined) {
				currentConfig.modeCacheTtl = newConfig.modeCacheTtl;
			}

			saveConfig(currentConfig);
			log('info', 'Config updated via admin API');

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		}
		catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: e.message }));
		}
	};

	const handleAddProvider = (req, res, body) => {
		try {
			const { name, type, apiKey, baseUrl } = JSON.parse(body);
			if (!name) {
				throw new Error('Provider name is required');
			}

			const config = getConfig();
			if (!config.providers) {
				config.providers = {};
			}
			config.providers[name] = { type: type || 'anthropic', apiKey: apiKey || '', baseUrl: baseUrl || '' };
			saveConfig(config);
			log('info', `Provider added: ${name}`);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		}
		catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: e.message }));
		}
	};

	const handleDeleteProvider = (res, providerName) => {
		const config = getConfig();
		if (config.providers && config.providers[providerName]) {
			delete config.providers[providerName];
			config.modelMapping = (config.modelMapping || []).filter((m) => m.provider !== providerName);
			saveConfig(config);
			log('info', `Provider deleted: ${providerName}`);
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true }));
	};

	const handleAddMapping = (req, res, body) => {
		try {
			const { prefix, target, provider } = JSON.parse(body);
			if (!prefix || !target || !provider) {
				throw new Error('prefix, target, and provider are required');
			}

			const config = getConfig();
			if (!config.modelMapping) {
				config.modelMapping = [];
			}
			config.modelMapping.push({ prefix, target, provider });
			saveConfig(config);
			log('info', `Mapping added: ${prefix} → ${target} (${provider})`);

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		}
		catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: e.message }));
		}
	};

	const handleDeleteMapping = (res, index) => {
		const config = getConfig();
		if (config.modelMapping && index >= 0 && index < config.modelMapping.length) {
			config.modelMapping.splice(index, 1);
			saveConfig(config);
			log('info', `Mapping deleted at index ${index}`);
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ success: true }));
	};

	const handleUpdateMapping = (req, res, index, body) => {
		try {
			const { prefix, target, provider } = JSON.parse(body);
			const config = getConfig();
			if (config.modelMapping && index >= 0 && index < config.modelMapping.length) {
				const mapping = config.modelMapping[index];
				if (prefix !== undefined) {
					mapping.prefix = prefix;
				}
				if (target !== undefined) {
					mapping.target = target;
				}
				if (provider !== undefined) {
					mapping.provider = provider;
				}
				saveConfig(config);
				log('info', `Mapping updated at index ${index}`);
			}

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		}
		catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: e.message }));
		}
	};

	const handleGetPrompts = (res) => {
		const prompts = getAllPrompts();
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(prompts.map((p) => ({
			name: p.name,
			description: p.description,
			content: p.content,
		}))));
	};

	const handlePutPrompt = (res, name, body) => {
		try {
			const { content } = JSON.parse(body);
			if (typeof content !== 'string') {
				throw new Error('content must be a string');
			}
			const ok = updatePrompt(name, content);
			if (!ok) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: `Prompt not found: ${name}` }));
				return;
			}
			log('info', `Prompt updated via admin: ${name}`);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ success: true }));
		}
		catch (e) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: e.message }));
		}
	};

	const handleStatus = (res) => {
		const config = getConfig();
		const uptime = process.uptime();
		const memUsage = process.memoryUsage();

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			status: 'ok',
			uptime: Math.floor(uptime),
			memory: {
				rss: Math.round(memUsage.rss / 1024 / 1024),
				heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
				heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
			},
			providers: Object.keys(config.providers || {}),
			mappings: (config.modelMapping || []).length,
			configPath,
		}));
	};

	const handleModels = async (res) => {
		const config = getConfig();
		try {
			const models = await fetchAllModels(config);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(models));
		}
		catch (e) {
			log('warn', `[Admin] Failed to fetch models: ${e.message}`);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: e.message }));
		}
	};

	const handleUsage = (res, url) => {
		const parsed = new URL(url, 'http://localhost');
		const from = parsed.searchParams.get('from') || '';
		const to = parsed.searchParams.get('to') || '';
		const unit = parsed.searchParams.get('unit') || 'day';
		const result = getUsage(from, to, unit);
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result));
	};

	return {
		handleGetConfig,
		handleGetProviders,
		handleGetMappings,
		handlePutConfig,
		handleAddProvider,
		handleDeleteProvider,
		handleAddMapping,
		handleDeleteMapping,
		handleUpdateMapping,
		handleGetPrompts,
		handlePutPrompt,
		handleStatus,
		handleUsage,
		handleModels,
		handleGetKeyStates,
	};
};

module.exports = { createApiRoutes };
