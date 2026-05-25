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

			if (tab === 'config') {
				loadConfigEditor();
			}
		});
	});
};

const loadDashboard = async () => {
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

const mappingFormHtml = (mapping, providers) => {
	const m = mapping || {};
	const providerOptions = providers.map((prov) =>
		`<option value="${esc(prov)}" ${m.provider === prov ? 'selected' : ''}>${esc(prov)}</option>`
	).join('');

	return `
		<div class="form-group">
			<label>Claude Model Prefix</label>
			<input id="form-prefix" value="${esc(m.prefix || '')}" placeholder="e.g. claude-opus">
		</div>
		<div class="form-group">
			<label>Target Model</label>
			<input id="form-target" value="${esc(m.target || '')}" placeholder="e.g. deepseek-v4-pro">
		</div>
		<div class="form-group">
			<label>Provider</label>
			<select id="form-provider">
				<option value="">Select a provider...</option>
				${providerOptions}
			</select>
		</div>
	`;
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
			const [mappings, config] = await Promise.all([
				api.get('/api/mappings'),
				api.get('/api/config'),
			]);
			const mapping = mappings[index];
			if (!mapping) {
				return;
			}

			showModal('Edit Mapping', mappingFormHtml(mapping, Object.keys(config.providers || {})), async () => {
				const updatedMapping = {
					prefix: document.getElementById('form-prefix').value.trim(),
					target: document.getElementById('form-target').value.trim(),
					provider: document.getElementById('form-provider').value,
				};
				await api.del(`/api/mappings/${index}`);
				await api.post('/api/mappings', updatedMapping);
			});
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
		const config = await api.get('/api/config');
		showModal('Add Mapping', mappingFormHtml(null, Object.keys(config.providers || {})), async () => {
			const prefix = document.getElementById('form-prefix').value.trim();
			const target = document.getElementById('form-target').value.trim();
			const provider = document.getElementById('form-provider').value;
			if (!prefix || !target || !provider) {
				alert('All fields are required');
				return;
			}
			await api.post('/api/mappings', { prefix, target, provider });
		});
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

	loadDashboard();
	setInterval(loadDashboard, 15000);
};

document.addEventListener('DOMContentLoaded', init);
