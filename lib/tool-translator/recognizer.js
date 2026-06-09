const { log } = require('../logger');

const isPresent = (v) => v !== undefined && v !== null;

const matchPath = (obj, path) => {
	const parts = path.split('.');
	let cur = obj;
	for (const p of parts) {
		if (cur == null) return undefined;
		if (p.endsWith('[]')) {
			const key = p.slice(0, -2);
			cur = cur[key];
			if (!Array.isArray(cur)) return undefined;
			return cur;
		}
		cur = cur[p];
	}
	return cur;
};

const matchCondition = (tool, match) => {
	for (const key of Object.keys(match)) {
		const expected = match[key];
		// 数组元素路径(以 "[]" 结尾) - 如 "functionDeclarations[]"
		if (key.endsWith('[]')) {
			const arr = matchPath(tool, key);
			if (!Array.isArray(arr)) return false;
			if (expected === '$present') {
				if (arr.length === 0) return false;
				continue;
			}
			const found = arr.some((item) => true);
			if (!found) return false;
			continue;
		}
		// 数组元素的子字段 - 如 "functionDeclarations[].name"
		const arraySubMatch = key.match(/^(.+?)\[\]\.(.+)$/);
		if (arraySubMatch) {
			const arrPath = arraySubMatch[1] + '[]';
			const subField = arraySubMatch[2];
			const arr = matchPath(tool, arrPath);
			if (!Array.isArray(arr)) return false;
			const found = arr.some((item) => {
				const actual = subField === '' ? item : item[subField];
				if (expected === '$present') return isPresent(actual);
				return actual === expected;
			});
			if (!found) return false;
			continue;
		}
		// 点分路径(如 "function.name") — 用 matchPath
		if (key.includes('.')) {
			const actual = matchPath(tool, key);
			if (expected === '$present') {
				if (!isPresent(actual)) return false;
			}
			else if (actual !== expected) {
				return false;
			}
			continue;
		}
		const actual = tool[key];
		if (expected === '$present') {
			if (!isPresent(actual)) return false;
		}
		else if (actual !== expected) {
			return false;
		}
	}
	return true;
};

const recognizeTools = (tools, copilotId, config) => {
	const copilot = config.copilots[copilotId];
	if (!copilot) {
		log('warn', `[tool-translator] 未知 copilotId: ${copilotId}，按 user tool 处理`);
		return { builtin: [], userTools: Array.isArray(tools) ? tools : [] };
	}

	const builtin = [];
	const userTools = [];
	if (!Array.isArray(tools)) {
		return { builtin, userTools };
	}

	for (const tool of tools) {
		let matched = null;
		for (const strategy of copilot.matchStrategies) {
			if (strategy.isBuiltin === false) continue;
			if (matchCondition(tool, strategy.match)) {
				matched = { key: strategy.key, rawTool: tool };
				break;
			}
		}
		if (matched) {
			builtin.push(matched);
		}
		else {
			userTools.push(tool);
		}
	}
	return { builtin, userTools };
};

module.exports = { recognizeTools, matchCondition, matchPath };
