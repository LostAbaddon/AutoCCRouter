'use strict';

/**
 * KeyStateManager —— API Key 多密钥负载均衡状态管理器
 *
 * 设计文档: ./docs/multi_key_balancer_design.md (v2.0)
 *
 * 核心职责:
 *   1. 维护每个 Provider 及其所有 API Key 的内存级状态 (available / inFlight / completed)
 *   2. 严格按 7 步动态权重算法选取 Key
 *   3. 在调用结束时结算状态
 *   4. 不污染 provider 对象，不修改 config.json
 */

const { log } = require('./logger');

const providerStates = new Map();
const keyStates = new Map();

// 统计: 总请求数 (调试用)
let totalAcquires = 0;

function maskKey(key) {
	if (!key || typeof key !== 'string') return '***';
	if (key.length <= 8) return key[0] + '***' + key[key.length - 1];
	return key.substring(0, 4) + '...' + key.substring(key.length - 4);
}

function ensureProvider(providerName, apiKeys) {
	if (!providerStates.has(providerName)) {
		providerStates.set(providerName, {
			isProviderDown: false,
			lastErrorAt: 0,
		});
	}
	if (!keyStates.has(providerName)) {
		keyStates.set(providerName, new Map());
	}
	const keyMap = keyStates.get(providerName);

	const newKeySet = new Set(apiKeys);
	for (const k of newKeySet) {
		if (!keyMap.has(k)) {
			keyMap.set(k, { available: true, inFlight: 0, completed: 0 });
		}
	}
	// 不立刻删除已移除的 key,留给后续读取/查看后再 GC;此处只在新 key 缺失时补
}

function getKeysArray(providerName) {
	const keyMap = keyStates.get(providerName);
	if (!keyMap) return [];
	return Array.from(keyMap.entries()).map(([k, v]) => ({ key: k, state: v }));
}

function selectKeyByWeight(providerName, apiKeys) {
	const keys = getKeysArray(providerName).filter(({ key }) => apiKeys.includes(key));

	if (keys.length === 0) {
		throw new Error(`[key-mgr] No keys available for provider ${providerName}`);
	}
	if (keys.length === 1) {
		return { key: keys[0].key, weight: 100 };
	}

	let maxInFlight = 0;
	let maxCompleted = 0;
	for (const { state } of keys) {
		if (state.inFlight > maxInFlight) maxInFlight = state.inFlight;
		if (state.completed > maxCompleted) maxCompleted = state.completed;
	}

	const weightedKeys = keys.map(({ key, state }) => {
		const baseWeight = state.available ? 100 : 30;
		const tempWeight = baseWeight * (maxInFlight + 1) / (state.inFlight + 1);
		const finalWeight = tempWeight * (maxCompleted + 1) / (state.completed + 1);
		return { key, weight: finalWeight };
	});

	let totalWeight = 0;
	for (const { weight } of weightedKeys) totalWeight += weight;

	const target = Math.random() * totalWeight;
	let cumulative = 0;
	for (const { key, weight } of weightedKeys) {
		cumulative += weight;
		if (target < cumulative) {
			return { key, weight };
		}
	}
	return { key: weightedKeys[weightedKeys.length - 1].key, weight: weightedKeys[weightedKeys.length - 1].weight };
}

/**
 * 入口 1: 选取 Key 并立即将 inFlight 加 1
 * @param {string} providerName
 * @param {string|string[]} apiKeyOrKeys —— 支持单字符串或字符串数组
 * @returns {{ key: string, keyMasked: string }}
 */
function acquireKey(providerName, apiKeyOrKeys) {
	const apiKeys = Array.isArray(apiKeyOrKeys) ? apiKeyOrKeys : [apiKeyOrKeys];
	const validKeys = apiKeys.filter(k => typeof k === 'string' && k.length > 0);

	if (validKeys.length === 0) {
		throw new Error(`[key-mgr] No valid keys for provider ${providerName}`);
	}

	ensureProvider(providerName, validKeys);

	const { key } = selectKeyByWeight(providerName, validKeys);
	const state = keyStates.get(providerName).get(key);
	state.inFlight++;

	totalAcquires++;
	log('info', `[key-mgr] provider=${providerName} key=${maskKey(key)}`);

	return { key, keyMasked: maskKey(key), providerName };
}

/**
 * 入口 2: 释放 Key 状态
 * 必须保证 inFlight 与 1 次 acquire 配对
 * @param {string} providerName
 * @param {string} key
 * @param {{ isSuccess?: boolean, isKeyFailure?: boolean, isProviderDown?: boolean }} opts
 */
function releaseKey(providerName, key, opts = {}) {
	const keyMap = keyStates.get(providerName);
	if (!keyMap) return;
	const state = keyMap.get(key);
	if (!state) return;

	if (state.inFlight > 0) state.inFlight--;
	state.completed++;

	const now = Date.now();

	if (opts.isProviderDown) {
		const pState = providerStates.get(providerName);
		pState.isProviderDown = true;
		pState.lastErrorAt = now;
	}

	if (opts.isKeyFailure) {
		state.available = false;
	}

	if (opts.isSuccess) {
		state.available = true;
	}
}

/**
 * 状态快照: 供 admin UI 展示
 */
function getSnapshot(providerName) {
	const keyMap = keyStates.get(providerName);
	const pState = providerStates.get(providerName);
	if (!keyMap || !pState) {
		return { providerDown: false, keys: [] };
	}
	const keys = Array.from(keyMap.entries()).map(([k, v]) => ({
		keyMasked: maskKey(k),
		available: v.available,
		inFlight: v.inFlight,
		completed: v.completed,
	}));
	return {
		providerDown: pState.isProviderDown,
		lastErrorAt: pState.lastErrorAt,
		keys,
	};
}

/**
 * 获取所有 Provider 的状态快照
 */
function getAllSnapshots() {
	const result = {};
	for (const name of keyStates.keys()) {
		result[name] = getSnapshot(name);
	}
	return result;
}

module.exports = {
	acquireKey,
	releaseKey,
	getSnapshot,
	getAllSnapshots,
	maskKey,
};
