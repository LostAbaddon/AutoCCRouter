const { log } = require('../logger');

// 解析 $alias:返回 alias 指向的最终渲染对象(可能嵌套)
// 同时检测循环引用
const resolveAlias = (renderTable, key, visited = new Set()) => {
	if (visited.has(key)) {
		log('warn', `[tool-translator] 检测到循环 alias: ${[...visited].join(' → ')} → ${key}`);
		return null;
	}
	visited.add(key);
	const r = renderTable[key];
	if (!r) return null;
	if (r.$alias) return resolveAlias(renderTable, r.$alias, visited);
	// 去掉 $alias / _note 等元字段,只保留真正渲染字段
	const out = {};
	for (const k of Object.keys(r)) {
		if (k === '$alias' || k === '_note') continue;
		out[k] = r[k];
	}
	return Object.keys(out).length > 0 ? out : null;
};

// 收集 builtin key 在某 provider 的最终渲染目标(用于 url_context 和 web_fetch 互斥去重)
// 若 url_context 解析到与 web_fetch 同一渲染对象,则认为它们互斥
const resolveFinalRender = (renderTable, key) => {
	const visited = new Set();
	let cur = key;
	while (cur) {
		if (visited.has(cur)) return null;
		visited.add(cur);
		const r = renderTable[cur];
		if (!r) return null;
		if (r.$alias) {
			cur = r.$alias;
			continue;
		}
		// 找到终态
		const out = {};
		for (const k of Object.keys(r)) {
			if (k === '$alias' || k === '_note') continue;
			out[k] = r[k];
		}
		return Object.keys(out).length > 0 ? out : null;
	}
	return null;
};

const renderBuiltin = (key, targetProvider, config) => {
	// 严格只查 providerRender[targetProvider]
	// provider 没声明 = provider 不支持 = 返回 null(不能渲染)
	// defaultRender 仅作未知 provider 兜底(理论上不该用,留个口子而已)
	const provRenders = config.providerRender || {};
	const provRender = provRenders[targetProvider];
	if (!provRender || !(key in provRender)) {
		return null;
	}
	return resolveAlias(provRender, key);
};

const convertUserToolToAnthropic = (tool) => {
	const name = tool.name || (tool.function && tool.function.name) || tool.type || '';
	const safe = String(name).replace(/[^a-zA-Z0-9_.:\/\-]/g, '_').replace(/^[^a-zA-Z_]+/, '').slice(0, 128);
	return {
		name: safe || '_unnamed',
		description: tool.description || (tool.function && tool.function.description) || '',
		input_schema: tool.parameters || (tool.function && tool.function.parameters) || { type: 'object', properties: {} },
	};
};

const renderTools = (recognized, targetProvider, config) => {
	const result = [];
	const usedNames = new Set();

	// 第一遍:渲染 builtin,记录它们的 name(key 去重)
	for (const { key, rawTool } of recognized.builtin) {
		const rendered = renderBuiltin(key, targetProvider, config);
		if (!rendered) {
			log('warn', `[tool-translator] provider "${targetProvider}" 找不到 "${key}" 的渲染规则,已丢弃`);
			continue;
		}
		// 去重:若不同 builtin key 渲染后 name 相同(如 url_context→web_fetch),只保留第一个
		if (rendered.name && usedNames.has(rendered.name)) {
			log('debug', `[tool-translator] builtin "${key}" 渲染后与已有工具名重复(${rendered.name}),跳过`);
			continue;
		}
		result.push(rendered);
		if (rendered.name) usedNames.add(rendered.name);
	}

	// 第二遍:渲染 user tool,跳过与 builtin 已渲染 name 重复的
	for (const userTool of recognized.userTools) {
		const ut = convertUserToolToAnthropic(userTool);
		if (ut.name && usedNames.has(ut.name)) {
			// user tool 叫 "web_fetch" 但 builtin url_context 已经渲染了一个 web_fetch → 跳过
			log('debug', `[tool-translator] user tool 与 builtin "${ut.name}" 重名,跳过`);
			continue;
		}
		result.push(ut);
		if (ut.name) usedNames.add(ut.name);
	}

	return result;
};

module.exports = { renderTools, renderBuiltin, resolveAlias, resolveFinalRender, convertUserToolToAnthropic };
