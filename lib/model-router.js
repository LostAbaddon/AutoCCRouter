// Provider/Model 加权随机选择器 + 带重试的派发器
//
// 职责:
//   - selectModel:从 modelsArray 中按权重抽取一个 provider/model
//   - startTask/finishTask:维护 provider/model 的 num_done/num_doing 和 provider 的 link_weight
//   - executeWithRetry:统一的"加权选取 → 执行 → 失败重试"派发器
//     业务请求和 classifier quick 请求都共用同一套重试规则。
//
// 权重计算综合考虑:
//   1. provider 的 link_weight (每次"不可用"事件 ×0.9,每次"从不可用恢复"事件 ×1.1)
//   2. 每个 provider/model 的 num_done (成功完成任务数) 越大概率越高
//   3. 每个 provider/model 的 num_doing (正在执行任务数) 越大概率越低
//
// 所有数据仅在内存,热加载时通过 resetAll() 全量清空。
// 不污染 config.json,不动 provider 对象。

const { log } = require('./logger');
const { getProviderState } = require('./key-state-manager');

// ── 可调参数(方便未来手动调节)─────────────────────────────
const LINK_WEIGHT_DOWN_FACTOR = 0.9;   // provider 不可用时,link_weight 乘以该系数
const LINK_WEIGHT_UP_FACTOR = 1.1;     // provider 从不可用恢复时,link_weight 乘以该系数
const MAX_RETRY_ATTEMPTS = 3;          // 单个任务最大尝试次数(含首次)
const INITIAL_LINK_WEIGHT = 100;       // provider 的初始 link_weight
// ─────────────────────────────────────────────────────────

// providerName → link_weight
const providerWeights = new Map();

// providerName → 上次报告的"是否不可用"状态(仅用于检测 down→up 转换)
const providerLastDown = new Map();

// "providerName/modelName" → { num_done, num_doing }
const taskStats = new Map();

// 解析 "provider/model" 字符串
const parseModelSpec = (spec) => {
	if (!spec || typeof spec !== 'string') {
		return null;
	}
	const idx = spec.indexOf('/');
	if (idx <= 0 || idx >= spec.length - 1) {
		return null;
	}
	return {
		providerName: spec.substring(0, idx),
		model: spec.substring(idx + 1),
	};
};

const statKey = (providerName, model) => `${providerName}|${model}`;

// 确保 provider 权重已初始化
const ensureProviderWeight = (providerName) => {
	if (!providerWeights.has(providerName)) {
		providerWeights.set(providerName, INITIAL_LINK_WEIGHT);
		providerLastDown.set(providerName, false);
	}
	return providerWeights.get(providerName);
};

/**
 * 加权随机选择:从 modelsArray 中按权重抽取一个 provider/model。
 * 不去重 —— 数组中重复的字符串会被自然加权。
 * @param {string[]} modelsArray - 例如 ["deepseek/deepseek-v4-pro", "google/gemini-3.1-pro"]
 * @returns {{providerName: string, model: string, spec: string}}
 */
const selectModel = (modelsArray) => {
	if (!Array.isArray(modelsArray) || modelsArray.length === 0) {
		throw new Error('[model-router] selectModel: empty array');
	}

	// 1. 解析 + 收集所有候选项的 (spec, link_weight, num_done, num_doing)
	const candidates = [];
	for (const spec of modelsArray) {
		const parsed = parseModelSpec(spec);
		if (!parsed) {
			continue;
		}
		const linkWeight = ensureProviderWeight(parsed.providerName);
		const s = taskStats.get(statKey(parsed.providerName, parsed.model)) || { num_done: 0, num_doing: 0 };
		candidates.push({
			spec,
			providerName: parsed.providerName,
			model: parsed.model,
			linkWeight,
			numDone: s.num_done,
			numDoing: s.num_doing,
		});
	}

	if (candidates.length === 0) {
		throw new Error('[model-router] selectModel: no valid specs in array');
	}

	// 2. 计算 max_done 和 max_doing
	let maxDone = 0;
	let maxDoing = 0;
	for (const c of candidates) {
		if (c.numDone > maxDone) { maxDone = c.numDone; }
		if (c.numDoing > maxDoing) { maxDoing = c.numDoing; }
	}

	// 3. 计算每个候选项的权重
	const weighted = candidates.map((c) => {
		const w = c.linkWeight / (maxDone + 1) * (c.numDone + 1) * (maxDoing + 1) / (c.numDoing + 1);
		return { ...c, weight: w };
	});

	// 4. 加权随机抽取
	let totalWeight = 0;
	for (const w of weighted) { totalWeight += w.weight; }

	const target = Math.random() * totalWeight;
	let cumulative = 0;
	for (const w of weighted) {
		cumulative += w.weight;
		if (target < cumulative) {
			return { providerName: w.providerName, model: w.model, spec: w.spec };
		}
	}
	const last = weighted[weighted.length - 1];
	return { providerName: last.providerName, model: last.model, spec: last.spec };
};

/**
 * 开始一个任务:增加 num_doing。
 * 应在请求发起前调用。
 */
const startTask = (providerName, model) => {
	if (!providerName || !model) { return; }
	ensureProviderWeight(providerName);
	const key = statKey(providerName, model);
	let s = taskStats.get(key);
	if (!s) {
		s = { num_done: 0, num_doing: 0 };
		taskStats.set(key, s);
	}
	s.num_doing += 1;
};

/**
 * 结束一个任务:减少 num_doing,成功则 num_done++,并按 provider 状态调整 link_weight。
 *
 * isProviderDown 的判定来源(优先级):
 *   1. key-state-manager.getProviderState() 的 isProviderDown(权威)
 *   2. 调用方传入的 isProviderDown 参数(兜底,适用于 KSM 还未追踪该 provider 的场景)
 *
 * @param {string} providerName
 * @param {string} model
 * @param {boolean} isSuccess - 任务是否成功
 * @param {boolean} isProviderDown - 兜底,仅在 KSM 无记录时使用
 */
const finishTask = (providerName, model, isSuccess, isProviderDown) => {
	if (!providerName || !model) { return; }
	ensureProviderWeight(providerName);

	const key = statKey(providerName, model);
	const s = taskStats.get(key);
	if (s) {
		if (s.num_doing > 0) { s.num_doing -= 1; }
		if (isSuccess) { s.num_done += 1; }
	}

	// 权威来源:key-state-manager 的 provider 状态。forward 函数内的 settleKey 已先于 onComplete 调用,
	// 所以到这里 KSM 已经反映了最近一次成功/失败的 provider 判定。
	// 4xx key-failure 不会被 KSM 标记为 provider down,这样失败不再被一刀切当作"不可用",link_weight 也就不必下调
	const ksmState = getProviderState(providerName);
	const effectiveDown = ksmState ? !!ksmState.isProviderDown : !!isProviderDown;

	// 调整 link_weight:
	// effectiveDown=true → *= 0.9 (重复乘,持续压低)
	// 仅当从 down 转回 up → *= 1.1
	// 其他情况不动
	const lastDown = !!providerLastDown.get(providerName);
	if (effectiveDown) {
		const w = providerWeights.get(providerName) || INITIAL_LINK_WEIGHT;
		providerWeights.set(providerName, w * LINK_WEIGHT_DOWN_FACTOR);
		providerLastDown.set(providerName, true);
	}
	else if (!effectiveDown && lastDown) {
		const w = providerWeights.get(providerName) || INITIAL_LINK_WEIGHT;
		providerWeights.set(providerName, w * LINK_WEIGHT_UP_FACTOR);
		providerLastDown.set(providerName, false);
	}
};

/**
 * 统一的"加权选取 → 执行 → 失败重试"派发器。
 *
 * 适用场景:
 *   1. provider=auto + target 为数组:从数组中选一个 spec 直接派发
 *   2. classifier 选出的 workingMode 的 models 为数组:从数组中选一个 spec 派发
 *   3. 单字符串 (非数组) 路径:把字符串包装成单元素数组后传入,统一走同一套加权/统计/重试逻辑
 *
 * 调用方职责:
 *   - 准备 modelsArray(数组或单字符串均可,本函数会做归一化)
 *   - 提供 buildBody(selected, provider) → string,负责 set model + max_tokens
 *   - 提供 dispatch(provider, model, providerName, body, onAttemptDone),负责实际转发;
 *     onAttemptDone(err) 在请求完成(成功或失败)时调用,err=null 表示成功
 *   - 提供 onDone(err),所有重试用完/无候选时调用,err=null 表示成功
 *
 * @param {object} opts
 * @param {string[]|string} opts.modelsArray - 候选 spec 数组,或单个 spec 字符串
 * @param {object} opts.config - 全局 config (用于 config.providers 查表)
 * @param {(selected: {providerName, model, spec}, provider: object) => string} opts.buildBody
 *   - 构造本次尝试的请求体(每次重试都调用,不能复用之前的对象)
 * @param {(provider: object, model: string, providerName: string, body: string, onAttemptDone: (err: Error|null) => void) => void} opts.dispatch
 *   - 实际派发,完成后必须回调 onAttemptDone
 * @param {(err: Error|null) => void} opts.onDone
 *   - 全部重试完成后调用,err 为 null 表示成功,否则为最后一次失败的错误
 */
const executeWithRetry = ({ modelsArray, config, buildBody, dispatch, onDone }) => {
	const arr = Array.isArray(modelsArray)
		? modelsArray.slice()
		: (typeof modelsArray === 'string' && modelsArray ? [modelsArray] : []);

	let attempt = 0;
	let lastError = null;
	let settled = false;

	const tryOnce = () => {
		if (settled) { return; }

		if (arr.length === 0) {
			settled = true;
			onDone(new Error('[model-router] executeWithRetry: empty candidates'));
			return;
		}

		let selected;
		try {
			selected = selectModel(arr);
		}
		catch (e) {
			settled = true;
			onDone(e);
			return;
		}

		const provider = config && config.providers && config.providers[selected.providerName];
		if (!provider) {
			log('warn', `[model-router] Provider not found: ${selected.providerName}, retrying`);
			attempt++;
			if (attempt < MAX_RETRY_ATTEMPTS) {
				tryOnce();
			}
			else {
				settled = true;
				onDone(lastError || new Error(`[model-router] Provider not found: ${selected.providerName}`));
			}
			return;
		}

		if (provider.type === 'auto') {
			log('warn', `[model-router] Circular: spec points to auto provider (${selected.providerName}), retrying`);
			attempt++;
			if (attempt < MAX_RETRY_ATTEMPTS) {
				tryOnce();
			}
			else {
				settled = true;
				onDone(lastError || new Error(`[model-router] Circular auto reference: ${selected.providerName}`));
			}
			return;
		}

		// 构造请求体
		let body;
		try {
			body = buildBody(selected, provider);
		}
		catch (e) {
			settled = true;
			onDone(e);
			return;
		}

		const onAttemptDone = (err) => {
			if (settled) { return; }
			finishTask(selected.providerName, selected.model, !err, !!err);

			if (err) {
				lastError = err;
				attempt++;
				if (attempt < MAX_RETRY_ATTEMPTS) {
					log('info', `[model-router] retry ${attempt}/${MAX_RETRY_ATTEMPTS} (${selected.providerName}/${selected.model}) after: ${err.message}`);
					tryOnce();
				}
				else {
					log('error', `[model-router] all ${MAX_RETRY_ATTEMPTS} attempts exhausted. Last: ${lastError.message}`);
					settled = true;
					onDone(lastError);
				}
			}
			else {
				settled = true;
				onDone(null);
			}
		};

		startTask(selected.providerName, selected.model);

		// provider 上 _name 属性的设置:
		// forward 函数依赖 provider._name 作 key-state-manager 的查找键和 recordUsage 的标识,
		// 必须在 dispatch 之前确保设置上,避免在多 provider 路由场景下 _name 缺失
		if (!provider._name) {
			Object.defineProperty(provider, '_name', { value: selected.providerName, writable: true, enumerable: false, configurable: true });
		}

		dispatch(provider, selected.model, selected.providerName, body, onAttemptDone);
	};

	tryOnce();
};

/**
 * 全量重置:清空所有权重和计数。热加载时调用。
 */
const resetAll = () => {
	providerWeights.clear();
	providerLastDown.clear();
	taskStats.clear();
	log('info', '[model-router] resetAll: all weights and stats cleared');
};

/**
 * 当前状态快照:供 admin UI 展示。
 */
const getSnapshot = () => {
	const providers = {};
	for (const [name, weight] of providerWeights) {
		providers[name] = {
			linkWeight: weight,
			lastDown: !!providerLastDown.get(name),
			liveIsProviderDown: false,
		};
	}
	const tasks = {};
	for (const [key, val] of taskStats) {
		tasks[key] = { num_done: val.num_done, num_doing: val.num_doing };
	}
	return {
		linkWeightDownFactor: LINK_WEIGHT_DOWN_FACTOR,
		linkWeightUpFactor: LINK_WEIGHT_UP_FACTOR,
		maxRetryAttempts: MAX_RETRY_ATTEMPTS,
		initialLinkWeight: INITIAL_LINK_WEIGHT,
		providers,
		tasks,
	};
};

module.exports = {
	selectModel,
	startTask,
	finishTask,
	resetAll,
	getSnapshot,
	parseModelSpec,
	executeWithRetry,
	// 暴露常量供测试与调用方
	_LIMITS: {
		LINK_WEIGHT_DOWN_FACTOR,
		LINK_WEIGHT_UP_FACTOR,
		MAX_RETRY_ATTEMPTS,
		INITIAL_LINK_WEIGHT,
	},
};
