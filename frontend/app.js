const API_BASE = '';

const api = {
	get: async (url) => {
		const res = await fetch(`${API_BASE}${url}`);
		return res.json();
	},
	put: async (url, data) => {
		const res = await fetch(`${API_BASE}${url}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data),
		});
		return res.json();
	},
	post: async (url, data) => {
		const res = await fetch(`${API_BASE}${url}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data),
		});
		return res.json();
	},
	del: async (url) => {
		const res = await fetch(`${API_BASE}${url}`, { method: 'DELETE' });
		return res.json();
	},
};

const tabs = () => {
	const btns = document.querySelectorAll('.tab');
	const contents = document.querySelectorAll('.tab-content');

	btns.forEach((btn) => {
		btn.addEventListener('click', () => {
			const tab = btn.dataset.tab;
			btns.forEach((b) => b.classList.remove('active'));
			contents.forEach((c) => c.classList.remove('active'));
			btn.classList.add('active');
			const content = document.getElementById(`tab-${tab}`);
			if (content) {
				content.classList.add('active');
			}

			if (tab === 'agents') {
				loadAgents();
			}
			else if (tab === 'prompts') {
				loadPrompts();
			}
			else if (tab === 'config') {
				loadConfigEditor();
			}
			else if (tab === 'usage') {
				loadUsage();
			}
		});
	});
};

const loadDashboard = async (full = true) => {
	try {
		const status = await api.get('/api/status');
		const indicator = document.getElementById('status-indicator');
		if (status.status === 'ok') {
			indicator.textContent = 'Online';
			indicator.className = 'status-badge online';
		}
		else {
			indicator.textContent = 'Offline';
			indicator.className = 'status-badge offline';
		}

		document.getElementById('uptime').textContent = formatUptime(status.uptime || 0);
		document.getElementById('memory').textContent = `${status.memory ? status.memory.rss : '--'} MB`;
		document.getElementById('provider-count').textContent = (status.providers || []).length;
		document.getElementById('mapping-count').textContent = status.mappings || 0;

		if (!full) {
			return;
		}

		const providers = await api.get('/api/providers');
		const provOverview = document.getElementById('provider-overview');
		provOverview.innerHTML = '';
		for (const [name, p] of Object.entries(providers)) {
			provOverview.innerHTML += `<tr>
				<td><code>${esc(name)}</code></td>
				<td>${esc(p.type || 'anthropic')}</td>
				<td style="font-size:12px;color:#8b949e">${esc(p.baseUrl || '')}</td>
				<td style="font-size:12px;color:#8b949e">${esc(p.apiKey || '')}</td>
			</tr>`;
		}

		const mappings = await api.get('/api/mappings');
		const mapOverview = document.getElementById('mapping-overview');
		mapOverview.innerHTML = '';
		mappings.forEach((m) => {
			mapOverview.innerHTML += `<tr>
				<td><code>${esc(m.prefix)}*</code></td>
				<td><code>${esc(m.target)}</code></td>
				<td>${esc(m.provider)}</td>
			</tr>`;
		});

		const providersTable = document.getElementById('providers-table');
		providersTable.innerHTML = '';
		for (const [name, p] of Object.entries(providers)) {
			const proxyInfo = p.proxy ? ` via ${esc(p.proxy)}` : '';
			providersTable.innerHTML += `<tr>
				<td><code>${esc(name)}</code></td>
				<td>${esc(p.type || 'anthropic')}</td>
				<td style="font-size:12px;max-width:300px;overflow:hidden;text-overflow:ellipsis">${esc(p.baseUrl || '')}${proxyInfo}</td>
				<td style="font-size:12px">${esc(p.apiKey || '')}</td>
				<td class="actions">
					<button class="btn-secondary btn-sm" data-action="edit-provider" data-name="${esc(name)}">Edit</button>
					<button class="btn-danger" data-action="delete-provider" data-name="${esc(name)}">Delete</button>
				</td>
			</tr>`;
		}

		const mappingsTable = document.getElementById('mappings-table');
		mappingsTable.innerHTML = '';
		mappings.forEach((m, i) => {
			mappingsTable.innerHTML += `<tr>
				<td>${i}</td>
				<td><code>${esc(m.prefix)}*</code></td>
				<td><code>${esc(m.target)}</code></td>
				<td>${esc(m.provider)}</td>
				<td class="actions">
					<button class="btn-secondary btn-sm" data-action="edit-mapping" data-index="${i}">Edit</button>
					<button class="btn-danger" data-action="delete-mapping" data-index="${i}">Delete</button>
				</td>
			</tr>`;
		});

		bindTableActions();
	}
	catch (e) {
		console.error('Dashboard load error:', e);
	}
};

const formatUptime = (seconds) => {
	if (seconds < 60) {
		return `${seconds}s`;
	}
	if (seconds < 3600) {
		return `${Math.floor(seconds / 60)}m`;
	}
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	return `${h}h ${m}m`;
};

const esc = (str) => {
	const s = String(str || '');
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};

// 从 sessionStorage 获取 modelList，如果没有则从后台获取
// 从 sessionStorage 获取 modelList，如果没有或过期（1天）则从后台获取
const getModelList = async () => {
	const TTL = 86400000;
	let modelList = null;
	try {
		const cached = sessionStorage.getItem("modelList");
		if (cached) {
			const parsed = JSON.parse(cached);
			if (parsed.data && parsed.ts && (Date.now() - parsed.ts < TTL)) {
				modelList = parsed.data;
			}
		}
	}
	catch (e) {
		// ignore
	}
	if (!modelList) {
		try {
			modelList = await api.get("/api/models");
			sessionStorage.setItem("modelList", JSON.stringify({ data: modelList, ts: Date.now() }));
		}
		catch (e) {
			console.error("Failed to fetch model list:", e);
			modelList = {};
		}
	}
	return modelList;
};

// 根据选中的 provider 生成 Target Model 下拉选项
const buildModelOptions = (modelList, selectedProvider, selectedModel) => {
	if (!selectedProvider || !modelList[selectedProvider]) {
		return '<option value="">-- Select a model --</option>';
	}
	const models = modelList[selectedProvider] || [];
	return models.map((m) =>
		`<option value="${esc(m)}" ${m === selectedModel ? 'selected' : ''}>${esc(m)}</option>`
	).join('');
};

const showModal = (title, bodyHtml, onSave) => {
	const modal = document.getElementById('modal');
	document.getElementById('modal-title').textContent = title;
	document.getElementById('modal-body').innerHTML = bodyHtml;
	modal.classList.remove('hidden');

	const saveBtn = document.getElementById('modal-save');
	const cancelBtn = document.getElementById('modal-cancel');

	const closeModal = () => {
		modal.classList.add('hidden');
		saveBtn.replaceWith(saveBtn.cloneNode(true));
		cancelBtn.replaceWith(cancelBtn.cloneNode(true));
	};

	const newSaveBtn = document.getElementById('modal-save');
	const newCancelBtn = document.getElementById('modal-cancel');

	newCancelBtn.addEventListener('click', closeModal);
	newSaveBtn.addEventListener('click', async () => {
		await onSave();
		closeModal();
		loadDashboard();
	});
};

const providerFormHtml = (provider) => {
	const p = provider || {};
	return `
		<div class="form-group">
			<label>Provider Name</label>
			<input id="form-name" value="${esc(p.name || '')}" ${p.name ? 'disabled' : ''} placeholder="e.g. deepseek">
		</div>
		<div class="form-group">
			<label>Type</label>
			<select id="form-type">
				<option value="anthropic" ${(p.type || 'anthropic') === 'anthropic' ? 'selected' : ''}>Anthropic-compatible</option>
				<option value="openai" ${p.type === 'openai' ? 'selected' : ''}>OpenAI-compatible</option>
				<option value="gemini" ${p.type === 'gemini' ? 'selected' : ''}>Google Gemini</option>
			</select>
		</div>
		<div class="form-group">
			<label>Base URL</label>
			<input id="form-baseurl" value="${esc(p.baseUrl || '')}" placeholder="https://api.example.com/v1">
		</div>
		<div class="form-group">
			<label>API Key</label>
			<input id="form-apikey" value="${esc(p.apiKey || '')}" placeholder="sk-xxx">
		</div>
		<div class="form-group">
			<label>Proxy <span style="font-weight:400;color:#8b949e">(optional, e.g. http://127.0.0.1:7890)</span></label>
			<input id="form-proxy" value="${esc(p.proxy || '')}" placeholder="Leave empty for direct connection">
		</div>
	`;
};

const mappingFormHtml = (mapping, providers, modelList) => {
	const m = mapping || {};
	const providerOptions = providers.map((prov) =>
		`<option value="${esc(prov)}" ${m.provider === prov ? 'selected' : ''}>${esc(prov)}</option>`
	).join('');

	const currentProvider = m.provider || '';
	const currentModel = m.target || '';
	const modelOptions = buildModelOptions(modelList || {}, currentProvider, currentModel);

	return `
		<div class="form-group">
			<label>Claude Model Prefix</label>
			<input id="form-prefix" value="${esc(m.prefix || '')}" placeholder="e.g. claude-opus">
		</div>
		<div class="form-group">
			<label>Provider</label>
			<select id="form-provider">
				<option value="">Select a provider...</option>
				${providerOptions}
			</select>
		</div>
		<div class="form-group">
			<label>Target Model</label>
			<select id="form-target">
				${modelOptions}
			</select>
		</div>
	`;
};

// 为 mapping/agent 表单中的 provider 下拉框绑定 change 事件
const bindProviderChange = (modelList) => {
	const providerSelect = document.getElementById('form-provider');
	const targetSelect = document.getElementById('form-target');
	if (!providerSelect || !targetSelect) {
		return;
	}
	providerSelect.addEventListener('change', () => {
		const selectedProvider = providerSelect.value;
		targetSelect.innerHTML = buildModelOptions(modelList, selectedProvider, '');
	});
};

// -------------------- Agent (Working Mode) forms and handlers --------------------

let currentAgentConfigSet = 'defaults';

const agentModeFormHtml = (mode, spec, modelList, providers) => {
	// spec 是 "provider/model" 字符串或数组 ["provider/model", ...]
	const firstSpec = Array.isArray(spec) ? spec[0] : (spec || '');
	let currentProvider = '';
	let currentModel = '';
	if (firstSpec && typeof firstSpec === 'string') {
		const idx = firstSpec.indexOf('/');
		if (idx > 0) {
			currentProvider = firstSpec.substring(0, idx);
			currentModel = firstSpec.substring(idx + 1);
		}
	}

	const providerOptions = providers.map((prov) =>
		`<option value="${esc(prov)}" ${currentProvider === prov ? 'selected' : ''}>${esc(prov)}</option>`
	).join('');

	const modelOptions = buildModelOptions(modelList || {}, currentProvider, currentModel);

	return `
		<div class="form-group">
			<label>Mode Name</label>
			<input id="form-mode" value="${esc(mode || '')}" ${mode ? 'disabled' : ''} placeholder="e.g. coding, writing, research">
			<span style="font-size:11px;color:#8b949e">Special modes: "default" (fallback), "quick" (classifier model)</span>
		</div>
		<div class="form-group">
			<label>Provider</label>
			<select id="form-provider">
				<option value="">Select a provider...</option>
				${providerOptions}
			</select>
		</div>
		<div class="form-group">
			<label>Target Model</label>
			<select id="form-target">
				${modelOptions}
			</select>
		</div>
	`;
};

const loadAgents = async () => {
	const config = await api.get('/api/config');
	const allAgents = config.agents || {};

	// Populate config set dropdown
	const select = document.getElementById('agent-config-set');
	select.innerHTML = '';
	const configSets = Object.keys(allAgents).filter((k) => typeof allAgents[k] === 'object' && !Array.isArray(allAgents[k]));
	if (configSets.length === 0) {
		// 向后兼容：扁平 agents → 当作 defaults
		const flatKeys = Object.keys(allAgents).filter((k) => typeof allAgents[k] === 'string' || Array.isArray(allAgents[k]));
		if (flatKeys.length > 0) {
			configSets.push('defaults');
		}
	}
	configSets.forEach((name) => {
		select.innerHTML += `<option value="${esc(name)}" ${name === currentAgentConfigSet ? 'selected' : ''}>${esc(name)}</option>`;
	});
	if (!configSets.includes(currentAgentConfigSet)) {
		currentAgentConfigSet = configSets[0] || 'defaults';
		if (configSets.length > 0) {
			select.value = currentAgentConfigSet;
		}
	}

	// Show/hide delete button
	const delBtn = document.getElementById('delete-config-set-btn');
	if (currentAgentConfigSet === 'defaults' || configSets.length <= 1) {
		delBtn.style.display = 'none';
	}
	else {
		delBtn.style.display = '';
	}

	// Get current config set's modes
	const agentSet = allAgents[currentAgentConfigSet] || {};
	const table = document.getElementById('agents-table');
	table.innerHTML = '';

	for (const [mode, spec] of Object.entries(agentSet)) {
		if (typeof spec !== 'string' && !Array.isArray(spec)) {
			continue;
		}
		const displaySpec = Array.isArray(spec) ? spec.join(', ') : spec;
		let providerName = '';
		let modelName = '';
		const firstSpec = Array.isArray(spec) ? spec[0] : spec;
		if (firstSpec && typeof firstSpec === 'string') {
			const idx = firstSpec.indexOf('/');
			if (idx > 0) {
				providerName = firstSpec.substring(0, idx);
				modelName = firstSpec.substring(idx + 1);
			}
		}
		const isArray = Array.isArray(spec);
		table.innerHTML += `<tr>
			<td><code>${esc(mode)}</code></td>
			<td>${esc(providerName)}${isArray ? ' <span style="color:#d29922">+more</span>' : ''}</td>
			<td><code>${esc(modelName)}${isArray ? ' <span style="color:#d29922">+more</span>' : ''}</code></td>
			<td title="${esc(displaySpec)}" style="font-size:11px;color:#8b949e;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(displaySpec)}</td>
			<td class="actions">
				<button class="btn-secondary btn-sm" data-action="edit-agent-mode" data-mode="${esc(mode)}">Edit</button>
				<button class="btn-danger" data-action="delete-agent-mode" data-mode="${esc(mode)}">Delete</button>
			</td>
		</tr>`;
	}

	// modeCacheTtl
	const ttlInput = document.getElementById('mode-cache-ttl');
	if (ttlInput) {
		ttlInput.value = config.modeCacheTtl != null ? config.modeCacheTtl : 60;
	}
	// conversationGroups
	const cgInput = document.getElementById('conversation-groups');
	if (cgInput) {
		cgInput.value = config.conversationGroups != null ? config.conversationGroups : 5;
	}

	bindAgentActions();
};

const bindAgentActions = () => {
	// Config set selector change
	const select = document.getElementById('agent-config-set');
	if (select) {
		select.onchange = () => {
			currentAgentConfigSet = select.value;
			loadAgents();
		};
	}

	document.querySelectorAll('[data-action="edit-agent-mode"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const mode = btn.dataset.mode;
			const [config, modelList] = await Promise.all([
				api.get('/api/config'),
				getModelList(),
			]);
			const allAgents = config.agents || {};
			const agentSet = allAgents[currentAgentConfigSet] || {};
			const spec = agentSet[mode] || '';

			showModal(`Edit Mode: ${mode}`, agentModeFormHtml(mode, spec, modelList, Object.keys(config.providers || {})), async () => {
				const provider = document.getElementById('form-provider').value;
				const model = document.getElementById('form-target').value;
				if (!provider || !model) {
					alert('Provider and model are required');
					return;
				}
				const specValue = provider + '/' + model;
				agentSet[mode] = specValue;
				await api.put('/api/config', { agents: allAgents });
			});

			bindProviderChange(modelList);
		});
	});

	// Delete mode
	document.querySelectorAll('[data-action="delete-agent-mode"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const mode = btn.dataset.mode;
			if (confirm(`Delete mode "${mode}" from "${currentAgentConfigSet}"?`)) {
				const config = await api.get('/api/config');
				const allAgents = config.agents || {};
				const agentSet = allAgents[currentAgentConfigSet] || {};
				delete agentSet[mode];
				await api.put('/api/config', { agents: allAgents });
				loadAgents();
			}
		});
	});
};

// -------------------- Prompt editing --------------------

const loadPrompts = async () => {
	const prompts = await api.get('/api/prompts');
	const table = document.getElementById('prompts-table');
	table.innerHTML = '';

	prompts.forEach((p) => {
		const preview = p.content ? p.content.substring(0, 120).replace(/\n/g, ' ') + '...' : '(empty)';
		table.innerHTML += `<tr>
			<td><code>${esc(p.name)}</code></td>
			<td style="font-size:12px;color:#8b949e">${esc(p.description || '')}</td>
			<td style="font-size:12px;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(preview)}</td>
			<td class="actions">
				<button class="btn-secondary btn-sm" data-action="edit-prompt" data-name="${esc(p.name)}">Edit</button>
			</td>
		</tr>`;
	});

	bindPromptActions();
};

const bindPromptActions = () => {
	document.querySelectorAll('[data-action="edit-prompt"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const name = btn.dataset.name;
			const prompts = await api.get('/api/prompts');
			const prompt = prompts.find((p) => p.name === name);
			if (!prompt) {
				return;
			}

			const bodyHtml = `
				<div class="form-group">
					<label>Name</label>
					<input value="${esc(prompt.name)}" disabled>
				</div>
				<div class="form-group">
					<label>Description</label>
					<input value="${esc(prompt.description || '')}" disabled>
				</div>
				<div class="form-group">
					<label>Content</label>
					<textarea id="form-prompt-content" style="width:100%;height:300px;background:#0f1117;border:1px solid #30363d;border-radius:6px;color:#e1e4e8;font-family:'SF Mono','Menlo',monospace;font-size:13px;padding:12px;resize:vertical">${esc(prompt.content || '')}</textarea>
				</div>
			`;

			showModal(`Edit Prompt: ${name}`, bodyHtml, async () => {
				const content = document.getElementById('form-prompt-content').value;
				await api.put(`/api/prompts/${encodeURIComponent(name)}`, { content });
			});
		});
	});
};

const bindTableActions = () => {
	document.querySelectorAll('[data-action="edit-provider"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const name = btn.dataset.name;
			const providers = await api.get('/api/providers');
			const provider = providers[name];
			if (!provider) {
				return;
			}

			provider.name = name;
			showModal('Edit Provider', providerFormHtml(provider), async () => {
				const newName = document.getElementById('form-name').value.trim() || name;
				const config = await api.get('/api/config');
				const updatedProviders = {};
				for (const [k, v] of Object.entries(config.providers)) {
					const key = k === name ? newName : k;
					updatedProviders[key] = v;
				}
				updatedProviders[name] = {
					type: document.getElementById('form-type').value,
					apiKey: document.getElementById('form-apikey').value,
					baseUrl: document.getElementById('form-baseurl').value,
					proxy: document.getElementById('form-proxy').value,
				};
				await api.put('/api/config', { providers: updatedProviders });
			});
		});
	});

	document.querySelectorAll('[data-action="delete-provider"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const name = btn.dataset.name;
			if (confirm(`Delete provider "${name}"? This will also remove all mappings using this provider.`)) {
				await api.del(`/api/providers/${encodeURIComponent(name)}`);
				loadDashboard();
			}
		});
	});

	document.querySelectorAll('[data-action="edit-mapping"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const index = parseInt(btn.dataset.index, 10);
			const [mappings, config, modelList] = await Promise.all([
				api.get('/api/mappings'),
				api.get('/api/config'),
				getModelList(),
			]);
			const mapping = mappings[index];
			if (!mapping) {
				return;
			}

			showModal('Edit Mapping', mappingFormHtml(mapping, Object.keys(config.providers || {}), modelList), async () => {
				const updatedMapping = {
					prefix: document.getElementById('form-prefix').value.trim(),
					target: document.getElementById('form-target').value,
					provider: document.getElementById('form-provider').value,
				};
				await api.del(`/api/mappings/${index}`);
				await api.post('/api/mappings', updatedMapping);
			});

			bindProviderChange(modelList);
		});
	});

	document.querySelectorAll('[data-action="delete-mapping"]').forEach((btn) => {
		btn.addEventListener('click', async () => {
			const index = parseInt(btn.dataset.index, 10);
			if (confirm(`Delete mapping at index ${index}?`)) {
				await api.del(`/api/mappings/${index}`);
				loadDashboard();
			}
		});
	});
};

// -------------------- Usage --------------------

let usageCharts = {};

const formatTokens = (n) => {
	if (n >= 1000000) {
		return (n / 1000000).toFixed(1) + 'M';
	}
	if (n >= 1000) {
		return (n / 1000).toFixed(1) + 'K';
	}
	return String(n);
};

const chartColors = [
	'#58a6ff', '#3fb950', '#d29922', '#f78166', '#a371f7',
	'#8b949e', '#79c0ff', '#56d364', '#e3b341', '#ff7b72',
	'#bc8cff', '#6e7681', '#388bfd', '#2ea043', '#9e6a03',
];

const destroyUsageCharts = () => {
	Object.values(usageCharts).forEach((c) => c.destroy());
	usageCharts = {};
};

const loadUsage = async () => {
	const fromInput = document.getElementById('usage-from');
	const toInput = document.getElementById('usage-to');
	const unitSelect = document.getElementById('usage-unit');

	const from = fromInput ? fromInput.value : '';
	const to = toInput ? toInput.value : '';
	const unit = unitSelect ? unitSelect.value : 'day';

	const params = new URLSearchParams();
	if (from) {
		params.set('from', from);
	}
	if (to) {
		params.set('to', to);
	}
	params.set('unit', unit);

	const data = await api.get(`/api/usage?${params.toString()}`);
	const summary = document.getElementById('usage-summary');
	if (summary) {
		summary.innerHTML = '';
	}

	destroyUsageCharts();

	if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
		document.getElementById('usage-chart-overall').parentElement.parentElement.style.display = '';
		document.getElementById('usage-chart-models').parentElement.parentElement.style.display = '';
		document.getElementById('usage-chart-providers').parentElement.parentElement.style.display = '';
		document.getElementById('usage-chart-calls').parentElement.style.display = '';
		document.getElementById('usage-chart-tokens').parentElement.style.display = '';
		if (summary) {
			summary.innerHTML = '<div class="card" style="text-align:center;color:#8b949e;padding:48px">No usage data in the selected range</div>';
		}
		return;
	}

	// 聚合: 按 provider|model 汇总 (忽略 period)
	const aggMap = new Map();
	let totalCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCache = 0;

	data.entries.forEach((entry) => {
		const key = `${entry.provider}|${entry.model}`;
		const agg = aggMap.get(key) || { provider: entry.provider, model: entry.model, calls: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 };
		agg.calls += entry.calls || 0;
		agg.inputTokens += entry.inputTokens || 0;
		agg.outputTokens += entry.outputTokens || 0;
		agg.cacheTokens += entry.cacheTokens || 0;
		aggMap.set(key, agg);

		totalCalls += entry.calls || 0;
		totalInput += entry.inputTokens || 0;
		totalOutput += entry.outputTokens || 0;
		totalCache += entry.cacheTokens || 0;
	});

	const aggregated = [...aggMap.values()].sort((a, b) => b.calls - a.calls);

	let totalModeActivations = 0;
	if (data.modes) {
		data.modes.forEach((m) => { totalModeActivations += m.activations || 0; });
	}

	// 摘要卡片
	if (summary) {
		const modeCard = totalModeActivations > 0
			? `<div class="card" style="flex:1;min-width:120px;text-align:center"><div style="font-size:11px;color:#8b949e;text-transform:uppercase">Mode Switches</div><div class="big-number">${totalModeActivations.toLocaleString()}</div></div>`
			: '';
		summary.innerHTML = `
			<div style="display:flex;gap:16px;flex-wrap:wrap">
				<div class="card" style="flex:1;min-width:120px;text-align:center"><div style="font-size:11px;color:#8b949e;text-transform:uppercase">Calls</div><div class="big-number">${totalCalls.toLocaleString()}</div></div>
				<div class="card" style="flex:1;min-width:120px;text-align:center"><div style="font-size:11px;color:#8b949e;text-transform:uppercase">Input</div><div class="big-number">${formatTokens(totalInput)}</div></div>
				<div class="card" style="flex:1;min-width:120px;text-align:center"><div style="font-size:11px;color:#8b949e;text-transform:uppercase">Output</div><div class="big-number">${formatTokens(totalOutput)}</div></div>
				<div class="card" style="flex:1;min-width:120px;text-align:center"><div style="font-size:11px;color:#8b949e;text-transform:uppercase">Cache</div><div class="big-number">${formatTokens(totalCache)}</div></div>
				${modeCard}
			</div>
		`;
	}

	// 按 period 聚合 (用于折线图)
	const periodAgg = new Map();
	data.entries.forEach((entry) => {
		const p = periodAgg.get(entry.period) || { calls: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 };
		p.calls += entry.calls || 0;
		p.inputTokens += entry.inputTokens || 0;
		p.outputTokens += entry.outputTokens || 0;
		p.cacheTokens += entry.cacheTokens || 0;
		periodAgg.set(entry.period, p);
	});
	const periods = [...periodAgg.keys()].sort();
	const callsByPeriod = periods.map((p) => periodAgg.get(p).calls);
	const inputByPeriod = periods.map((p) => periodAgg.get(p).inputTokens);
	const outputByPeriod = periods.map((p) => periodAgg.get(p).outputTokens);
	const cacheByPeriod = periods.map((p) => periodAgg.get(p).cacheTokens);

	const maxCalls = Math.max(...callsByPeriod, 1);
	const maxInput = Math.max(...inputByPeriod, 1);
	const maxOutput = Math.max(...outputByPeriod, 1);
	const maxCache = Math.max(...cacheByPeriod, 1);
	const normalize = (arr, max) => arr.map((v) => (v / max) * 100);

	// Chart.js 暗色主题默认配置
	const darkGrid = '#21262d';
	const darkText = '#8b949e';

	// --- 折线图 1: 总体使用量百分比 ---
	const overallCanvas = document.getElementById('usage-chart-overall');
	const overallCtx = overallCanvas.getContext('2d');
	usageCharts.overall = new Chart(overallCtx, {
		type: 'line',
		data: {
			labels: periods,
			datasets: [
				{
					label: 'Calls',
					data: normalize(callsByPeriod, maxCalls),
					borderColor: '#58a6ff',
					backgroundColor: '#58a6ff',
					tension: 0.2,
					pointRadius: 3,
					fill: false,
				},
				{
					label: 'Input',
					data: normalize(inputByPeriod, maxInput),
					borderColor: '#3fb950',
					backgroundColor: '#3fb950',
					tension: 0.2,
					pointRadius: 3,
					fill: false,
				},
				{
					label: 'Output',
					data: normalize(outputByPeriod, maxOutput),
					borderColor: '#d29922',
					backgroundColor: '#d29922',
					tension: 0.2,
					pointRadius: 3,
					fill: false,
				},
				{
					label: 'Cache',
					data: normalize(cacheByPeriod, maxCache),
					borderColor: '#f78166',
					backgroundColor: '#f78166',
					tension: 0.2,
					pointRadius: 3,
					fill: false,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			plugins: {
				legend: {
					labels: { color: darkText, usePointStyle: true, padding: 16 },
				},
				tooltip: {
					callbacks: {
						label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toFixed(1)}%`,
					},
				},
			},
			scales: {
				x: {
					ticks: { color: darkText, maxRotation: 45, font: { size: 10 } },
					grid: { color: darkGrid },
				},
				y: {
					ticks: { color: darkText, beginAtZero: true, max: 100, callback: (v) => v + '%' },
					grid: { color: darkGrid },
				},
			},
		},
	});

	// --- 折线图 2: 每个模型的调用次数 ---
	const modelPeriodAgg = new Map();
	const modelTotalsMap = new Map();
	data.entries.forEach((entry) => {
		const key = `${entry.model}|${entry.period}`;
		const cur = modelPeriodAgg.get(key) || 0;
		modelPeriodAgg.set(key, cur + (entry.calls || 0));
		const total = modelTotalsMap.get(entry.model) || 0;
		modelTotalsMap.set(entry.model, total + (entry.calls || 0));
	});

	const TOP_N = 8;
	const sortedModels = [...modelTotalsMap.entries()].sort((a, b) => b[1] - a[1]);
	const topModels = sortedModels.slice(0, TOP_N);
	const othersModels = sortedModels.slice(TOP_N);
	const hasOtherModels = othersModels.length > 0;

	const modelDatasets = topModels.map(([model], i) => ({
		label: model.length > 30 ? model.substring(0, 28) + '...' : model,
		data: periods.map((p) => modelPeriodAgg.get(`${model}|${p}`) || 0),
		borderColor: chartColors[i % chartColors.length],
		backgroundColor: chartColors[i % chartColors.length],
		tension: 0.2,
		pointRadius: 2,
		fill: false,
	}));

	if (hasOtherModels) {
		const othersData = periods.map((p) => {
			let sum = 0;
			for (const [model] of othersModels) {
				sum += modelPeriodAgg.get(`${model}|${p}`) || 0;
			}
			return sum;
		});
		modelDatasets.push({
			label: 'Others',
			data: othersData,
			borderColor: '#6e7681',
			backgroundColor: '#6e7681',
			borderDash: [4, 4],
			tension: 0.2,
			pointRadius: 2,
			fill: false,
		});
	}

	const modelsCanvas = document.getElementById('usage-chart-models');
	const modelsCtx = modelsCanvas.getContext('2d');
	usageCharts.models = new Chart(modelsCtx, {
		type: 'line',
		data: { labels: periods, datasets: modelDatasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			plugins: {
				legend: {
					labels: { color: darkText, usePointStyle: true, padding: 16, font: { size: 10 } },
				},
				tooltip: {
					callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} calls` },
				},
			},
			scales: {
				x: {
					ticks: { color: darkText, maxRotation: 45, font: { size: 10 } },
					grid: { color: darkGrid },
				},
				y: {
					ticks: { color: darkText, beginAtZero: true },
					grid: { color: darkGrid },
				},
			},
		},
	});

	// --- 折线图 3: 每个 Provider 的调用次数 ---
	const provPeriodAgg = new Map();
	const provTotalsMap = new Map();
	data.entries.forEach((entry) => {
		const key = `${entry.provider}|${entry.period}`;
		const cur = provPeriodAgg.get(key) || 0;
		provPeriodAgg.set(key, cur + (entry.calls || 0));
		const total = provTotalsMap.get(entry.provider) || 0;
		provTotalsMap.set(entry.provider, total + (entry.calls || 0));
	});

	const sortedProvs = [...provTotalsMap.entries()].sort((a, b) => b[1] - a[1]);

	const provDatasets = sortedProvs.map(([prov], i) => ({
		label: prov,
		data: periods.map((p) => provPeriodAgg.get(`${prov}|${p}`) || 0),
		borderColor: chartColors[i % chartColors.length],
		backgroundColor: chartColors[i % chartColors.length],
		tension: 0.2,
		pointRadius: 2,
		fill: false,
	}));

	const provCanvas = document.getElementById('usage-chart-providers');
	const provCtx = provCanvas.getContext('2d');
	usageCharts.providers = new Chart(provCtx, {
		type: 'line',
		data: { labels: periods, datasets: provDatasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			plugins: {
				legend: {
					labels: { color: darkText, usePointStyle: true, padding: 16, font: { size: 10 } },
				},
				tooltip: {
					callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw.toLocaleString()} calls` },
				},
			},
			scales: {
				x: {
					ticks: { color: darkText, maxRotation: 45, font: { size: 10 } },
					grid: { color: darkGrid },
				},
				y: {
					ticks: { color: darkText, beginAtZero: true },
					grid: { color: darkGrid },
				},
			},
		},
	});


	// 汇总柱状图: Calls by Provider/Model (忽略 period)
	const labels = aggregated.map((a) => a.model.length > 30 ? a.model.substring(0, 28) + '...' : a.model);
	const providerLabels = aggregated.map((a) => a.provider);

	const callsCanvas = document.getElementById('usage-chart-calls');
	const callsCtx = callsCanvas.getContext('2d');
	usageCharts.calls = new Chart(callsCtx, {
		type: 'bar',
		data: {
			labels,
			datasets: [{
				label: 'Calls',
				data: aggregated.map((a) => a.calls),
				backgroundColor: aggregated.map((_, i) => chartColors[i % chartColors.length]),
				borderColor: '#0f1117',
				borderWidth: 1,
			}],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			plugins: {
				legend: { display: false },
				tooltip: {
					callbacks: {
						label: (ctx) => `${ctx.raw.toLocaleString()} calls`,
						afterLabel: (ctx) => `${providerLabels[ctx.dataIndex]}`,
					},
				},
			},
			scales: {
				x: {
					ticks: { color: darkText, maxRotation: 45, font: { size: 10 } },
					grid: { color: darkGrid },
				},
				y: {
					ticks: { color: darkText, beginAtZero: true },
					grid: { color: darkGrid },
				},
			},
		},
	});

	// 汇总柱状图: Tokens by Provider/Model
	const tokensCanvas = document.getElementById('usage-chart-tokens');
	const tokensCtx = tokensCanvas.getContext('2d');
	usageCharts.tokens = new Chart(tokensCtx, {
		type: 'bar',
		data: {
			labels,
			datasets: [
				{
					label: 'Input',
					data: aggregated.map((a) => a.inputTokens),
					backgroundColor: '#58a6ff',
					borderColor: '#0f1117',
					borderWidth: 1,
				},
				{
					label: 'Output',
					data: aggregated.map((a) => a.outputTokens),
					backgroundColor: '#3fb950',
					borderColor: '#0f1117',
					borderWidth: 1,
				},
				{
					label: 'Cache',
					data: aggregated.map((a) => a.cacheTokens),
					backgroundColor: '#d29922',
					borderColor: '#0f1117',
					borderWidth: 1,
				},
			],
		},
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: false,
			plugins: {
				legend: {
					labels: { color: darkText, usePointStyle: true, padding: 16 },
				},
				tooltip: {
					callbacks: {
						label: (ctx) => `${ctx.dataset.label}: ${formatTokens(ctx.raw)} tokens`,
						afterLabel: (ctx) => `${providerLabels[ctx.dataIndex]}`,
					},
				},
			},
			scales: {
				x: {
					ticks: { color: darkText, maxRotation: 45, font: { size: 10 } },
					grid: { color: darkGrid },
				},
				y: {
					ticks: { color: darkText, beginAtZero: true, callback: (v) => formatTokens(v) },
					grid: { color: darkGrid },
				},
			},
		},
	});

	// Mode activations chart
	const modesCanvas = document.getElementById('usage-chart-modes');
	if (modesCanvas && data.modes && data.modes.length > 0) {
		modesCanvas.parentElement.parentElement.style.display = '';
		const modeAgg = new Map();
		data.modes.forEach((m) => {
			const cur = modeAgg.get(m.mode) || 0;
			modeAgg.set(m.mode, cur + m.activations);
		});
		const modeLabels = [...modeAgg.keys()];
		const modeData = [...modeAgg.values()];
		const modeColors = [...chartColors].slice(0, modeLabels.length);
		usageCharts.modes = new Chart(modesCanvas.getContext('2d'), {
			type: 'bar',
			data: {
				labels: modeLabels,
				datasets: [{
					label: 'Activations',
					data: modeData,
					backgroundColor: modeColors,
					borderColor: '#0f1117',
					borderWidth: 1,
				}],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				plugins: {
					legend: { display: false },
					tooltip: {
						callbacks: { label: (ctx) => `${ctx.raw.toLocaleString()} activations` },
					},
				},
				scales: {
					x: { ticks: { color: darkText }, grid: { color: darkGrid } },
					y: { ticks: { color: darkText, beginAtZero: true }, grid: { color: darkGrid } },
				},
			},
		});
	}
	else if (modesCanvas) {
		modesCanvas.parentElement.parentElement.style.display = 'none';
	}
};

const loadConfigEditor = async () => {
	const config = await api.get('/api/config');
	const editor = document.getElementById('config-editor');
	editor.value = JSON.stringify(config, null, '\t');
};

const init = () => {
	tabs();

	document.getElementById('add-provider-btn').addEventListener('click', async () => {
		showModal('Add Provider', providerFormHtml(), async () => {
			const name = document.getElementById('form-name').value.trim();
			if (!name) {
				alert('Provider name is required');
				return;
			}
			const config = await api.get('/api/config');
			config.providers = config.providers || {};
			config.providers[name] = {
				type: document.getElementById('form-type').value,
				apiKey: document.getElementById('form-apikey').value,
				baseUrl: document.getElementById('form-baseurl').value,
				proxy: document.getElementById('form-proxy').value,
			};
			await api.put('/api/config', { providers: config.providers });
		});
	});

	document.getElementById('add-mapping-btn').addEventListener('click', async () => {
		const [config, modelList] = await Promise.all([
			api.get('/api/config'),
			getModelList(),
		]);
		showModal('Add Mapping', mappingFormHtml(null, Object.keys(config.providers || {}), modelList), async () => {
			const prefix = document.getElementById('form-prefix').value.trim();
			const target = document.getElementById('form-target').value;
			const provider = document.getElementById('form-provider').value;
			if (!prefix || !target || !provider) {
				alert('All fields are required');
				return;
			}
			await api.post('/api/mappings', { prefix, target, provider });
		});

		bindProviderChange(modelList);
	});

	// Add mode to current config set
	document.getElementById('add-agent-btn').addEventListener('click', async () => {
		const [config, modelList] = await Promise.all([
			api.get('/api/config'),
			getModelList(),
		]);
		showModal('Add Mode', agentModeFormHtml('', '', modelList, Object.keys(config.providers || {})), async () => {
			const mode = document.getElementById('form-mode').value.trim();
			const provider = document.getElementById('form-provider').value;
			const model = document.getElementById('form-target').value;
			if (!mode || !provider || !model) {
				alert('Mode name, provider, and model are required');
				return;
			}
			const allAgents = config.agents || {};
			const agentSet = allAgents[currentAgentConfigSet] || {};
			agentSet[mode] = provider + '/' + model;
			allAgents[currentAgentConfigSet] = agentSet;
			await api.put('/api/config', { agents: allAgents });
		});

		bindProviderChange(modelList);
	});

	// Add new config set
	document.getElementById('add-config-set-btn').addEventListener('click', async () => {
		showModal('New Config Set', `
			<div class="form-group">
				<label>Config Set Name</label>
				<input id="form-config-name" placeholder="e.g. coding-only, research">
			</div>
		`, async () => {
			const name = document.getElementById('form-config-name').value.trim();
			if (!name) {
				alert('Name is required');
				return;
			}
			const config = await api.get('/api/config');
			const allAgents = config.agents || {};
			if (allAgents[name]) {
				alert(`Config set "${name}" already exists`);
				return;
			}
			allAgents[name] = { default: 'deepseek/deepseek-v4-pro' };
			await api.put('/api/config', { agents: allAgents });
			currentAgentConfigSet = name;
			loadAgents();
		});
	});

	// Delete current config set
	document.getElementById('delete-config-set-btn').addEventListener('click', async () => {
		if (currentAgentConfigSet === 'defaults') {
			alert('Cannot delete the defaults config set');
			return;
		}
		if (confirm(`Delete config set "${currentAgentConfigSet}" and all its modes?`)) {
			const config = await api.get('/api/config');
			const allAgents = config.agents || {};
			delete allAgents[currentAgentConfigSet];
			await api.put('/api/config', { agents: allAgents });
			currentAgentConfigSet = 'defaults';
			loadAgents();
		}
	});

	document.getElementById('save-config-btn').addEventListener('click', async () => {
		try {
			const editor = document.getElementById('config-editor');
			const config = JSON.parse(editor.value);
			await api.put('/api/config', config);
			const status = document.getElementById('config-save-status');
			status.textContent = 'Saved!';
			setTimeout(() => { status.textContent = ''; }, 3000);
		}
		catch (e) {
			alert(`Invalid JSON: ${e.message}`);
		}
	});

	document.getElementById('save-mode-cache-ttl').addEventListener('click', async () => {
		const ttlInput = document.getElementById('mode-cache-ttl');
		const ttl = parseInt(ttlInput.value, 10);
		if (isNaN(ttl) || ttl < 0) {
			alert('Please enter a valid number (0 or greater)');
			return;
		}
		await api.put('/api/config', { modeCacheTtl: ttl });
		const status = document.getElementById('mode-cache-ttl-status');
		status.textContent = 'Saved!';
		setTimeout(() => { status.textContent = ''; }, 3000);
	});

	document.getElementById('save-conversation-groups').addEventListener('click', async () => {
		const cgInput = document.getElementById('conversation-groups');
		const cg = parseInt(cgInput.value, 10);
		if (isNaN(cg) || cg < 1) {
			alert('Please enter a valid number (1 or greater)');
			return;
		}
		await api.put('/api/config', { conversationGroups: cg });
		const status = document.getElementById('conversation-groups-status');
		status.textContent = 'Saved!';
		setTimeout(() => { status.textContent = ''; }, 3000);
	});

	// Usage tab controls
	const refreshUsageBtn = document.getElementById('refresh-usage-btn');
	if (refreshUsageBtn) {
		refreshUsageBtn.addEventListener('click', () => { loadUsage(); });
	}

	// 预加载 modelList 到 sessionStorage
	getModelList();

	loadDashboard();
	setInterval(() => {
		loadDashboard(false);
	}, 15000);
};

document.addEventListener('DOMContentLoaded', init);
