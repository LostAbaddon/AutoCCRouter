const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

const USAGE_DIR = path.join(__dirname, '..', 'data', 'usage');
const FLUSH_INTERVAL_MS = 30 * 1000;

// 所有日期字符串 "YYYY-MM-DD" 一律表示机器本地时间的"日历日"。
// 这样写入时的文件名、读取时的过滤、游标迭代都基于同一个时间基准。
const pad2 = (n) => String(n).padStart(2, '0');

// Date -> "YYYY-MM-DD"（本地时间）
const toLocalDateStr = (d) => {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

// "YYYY-MM-DD" -> Date（本地时间 00:00:00）
const fromLocalDateStr = (s) => {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
		return null;
	}
	const [y, m, d] = s.split('-').map(Number);
	return new Date(y, m - 1, d);
};

// 内存中的用量数据: "YYYY-MM-DD" → { "provider:model" → { calls, inputTokens, outputTokens, cacheTokens } }
const dailyUsage = new Map();

// 启动时加载今天的已有数据
const loadDayFile = (dateStr) => {
	const filePath = path.join(USAGE_DIR, `${dateStr}.json`);
	try {
		if (fs.existsSync(filePath)) {
			const raw = fs.readFileSync(filePath, 'utf-8');
			const data = JSON.parse(raw);
			for (const [key, val] of Object.entries(data)) {
				if (!dailyUsage.has(dateStr)) {
					dailyUsage.set(dateStr, new Map());
				}
				dailyUsage.get(dateStr).set(key, { ...val });
			}
			log('debug', `[Usage] Loaded ${Object.keys(data).length} entries from ${dateStr}`);
		}
	}
	catch (e) {
		log('warn', `[Usage] Failed to load ${dateStr}: ${e.message}`);
	}
};

// 保存一天的数据到磁盘
const saveDayFile = (dateStr) => {
	const dayData = dailyUsage.get(dateStr);
	if (!dayData || dayData.size === 0) {
		return;
	}
	const filePath = path.join(USAGE_DIR, `${dateStr}.json`);
	try {
		const obj = {};
		for (const [key, val] of dayData) {
			obj[key] = val;
		}
		fs.writeFileSync(filePath, JSON.stringify(obj, null, '\t'), 'utf-8');
	}
	catch (e) {
		log('warn', `[Usage] Failed to save ${dateStr}: ${e.message}`);
	}
};

// 确保目录存在
if (!fs.existsSync(USAGE_DIR)) {
	fs.mkdirSync(USAGE_DIR, { recursive: true });
}

// 加载今天的文件
const today = toLocalDateStr(new Date());
loadDayFile(today);

// 定时 flush 到磁盘
const flushTimer = setInterval(() => {
	const now = toLocalDateStr(new Date());
	saveDayFile(now);
}, FLUSH_INTERVAL_MS);
if (flushTimer.unref) {
	flushTimer.unref();
}

// 记录一次调用
const recordUsage = (providerName, model, usage, clientSource = 'claudecode', rawData) => {
	console.log('*'.repeat(80));
	console.log(`
Provider: ${providerName}
Model:    ${model}
Client:   ${clientSource}
Input:    ${usage?.input_tokens ?? 'UNDEFINED'}
Output:   ${usage?.output_tokens ?? 'UNDEFINED'}
Cached:   ${usage?.cache_read_tokens ?? 'UNDEFINED'}
RawUsage:
${JSON.stringify(rawData || usage, null, '\t')}
`.trim());
	console.log('+'.repeat(80));

	if (!providerName || !model) {
		return;
	}
	const dateStr = toLocalDateStr(new Date());
	if (!dailyUsage.has(dateStr)) {
		dailyUsage.set(dateStr, new Map());
	}
	const dayData = dailyUsage.get(dateStr);
	const key = `${providerName}|${model}|${clientSource}`;

	const existing = dayData.get(key) || { calls: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 };
	existing.calls += 1;
	existing.inputTokens += (usage && usage.input_tokens) || 0;
	existing.outputTokens += (usage && usage.output_tokens) || 0;
	existing.cacheTokens += (usage && usage.cache_read_tokens || 0);// + (usage && usage.cache_creation_tokens || 0); // 创建Cache和命中Cache必须分开
	dayData.set(key, existing);
};

// 记录一次 working mode 激活
const recordModeActivation = (mode) => {
	if (!mode) {
		return;
	}
	const dateStr = toLocalDateStr(new Date());
	if (!dailyUsage.has(dateStr)) {
		dailyUsage.set(dateStr, new Map());
	}
	const dayData = dailyUsage.get(dateStr);
	const key = `__mode__|${mode}`;

	const existing = dayData.get(key) || { activations: 0 };
	existing.activations += 1;
	dayData.set(key, existing);
};

// 查询用量数据
// 返回: { entries: [{period, provider, model, calls, inputTokens, outputTokens, cacheTokens}], modes: [{period, mode, activations}] }
const getUsage = (from, to, unit) => {
	const result = { entries: [], modes: [] };

	if (!from && !to) {
		// 默认返回最近 7 天（本地时间）
		const end = new Date();
		const start = new Date();
		start.setDate(start.getDate() - 7);
		from = toLocalDateStr(start);
		to = toLocalDateStr(end);
	}

	// 收集日期范围内的所有日文件
	// 全部基于本地时间：startDate 为本地 00:00:00，endDate 为本地 23:59:59.999
	const startDate = from ? fromLocalDateStr(from) : new Date(0, 0, 1);
	const endDate = to ? fromLocalDateStr(to) : new Date(9999, 11, 31);
	if (startDate) {
		startDate.setHours(0, 0, 0, 0);
	}
	if (endDate) {
		endDate.setHours(23, 59, 59, 999);
	}

	const dateEntries = [];
	for (const [dateStr, dayData] of dailyUsage) {
		const d = fromLocalDateStr(dateStr);
		if (!d) {
			continue;
		}
		if (d >= startDate && d <= endDate) {
			dateEntries.push({ dateStr, dayData });
		}
	}

	// 也尝试加载范围内但不在内存中的日文件
	const cursor = new Date(startDate);
	while (cursor <= endDate) {
		const ds = toLocalDateStr(cursor);
		if (!dailyUsage.has(ds)) {
			const filePath = path.join(USAGE_DIR, `${ds}.json`);
			if (fs.existsSync(filePath)) {
				loadDayFile(ds);
				const loadedData = dailyUsage.get(ds);
				if (loadedData) {
					dateEntries.push({ dateStr: ds, dayData: loadedData });
				}
			}
		}
		cursor.setDate(cursor.getDate() + 1);
	}

	const processDayData = (dateStr, dayData, periodKey, targetEntries, targetModes) => {
		for (const [key, val] of dayData) {
			if (key.startsWith('__mode__|')) {
				const mode = key.substring(9);
				targetModes.push({ period: periodKey, mode, activations: val.activations || 0 });
			}
			else {
				const [provider, model, clientSourceStr] = key.split('|');
				targetEntries.push({
					period: periodKey,
					provider,
					model,
					clientSource: clientSourceStr || 'claudecode',
					calls: val.calls || 0,
					inputTokens: val.inputTokens || 0,
					outputTokens: val.outputTokens || 0,
					cacheTokens: val.cacheTokens || 0,
				});
			}
		}
	};

	if (unit === 'day' || !unit) {
		dateEntries.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
		for (const { dateStr, dayData } of dateEntries) {
			processDayData(dateStr, dayData, dateStr, result.entries, result.modes);
		}
	}
	else {
		const aggEntries = new Map();
		const aggModes = new Map();
		for (const { dateStr, dayData } of dateEntries) {
			const d = fromLocalDateStr(dateStr);
			if (!d) {
				continue;
			}
			let periodKey;
			if (unit === 'week') {
				const dayOfWeek = d.getDay();
				const monday = new Date(d);
				monday.setDate(d.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1));
				periodKey = toLocalDateStr(monday);
			}
			else if (unit === 'month') {
				periodKey = dateStr.substring(0, 7);
			}
			else if (unit === 'year') {
				periodKey = dateStr.substring(0, 4);
			}
			else {
				periodKey = dateStr;
			}

			for (const [key, val] of dayData) {
				if (key.startsWith('__mode__|')) {
					const mode = key.substring(9);
					const mk = `${periodKey}|${mode}`;
					const agg = aggModes.get(mk) || { activations: 0 };
					agg.activations += val.activations || 0;
					aggModes.set(mk, agg);
				}
				else {
					const aggKey = `${periodKey}|${key}`;
					const agg = aggEntries.get(aggKey) || { calls: 0, inputTokens: 0, outputTokens: 0, cacheTokens: 0 };
					agg.calls += val.calls || 0;
					agg.inputTokens += val.inputTokens || 0;
					agg.outputTokens += val.outputTokens || 0;
					agg.cacheTokens += val.cacheTokens || 0;
					aggEntries.set(aggKey, agg);
				}
			}
		}

		for (const [aggKey, val] of aggEntries) {
			const [period, provider, model, clientSourceStr] = aggKey.split('|');
			result.entries.push({ period, provider, model, clientSource: clientSourceStr || 'claudecode', ...val });
		}
		for (const [mk, val] of aggModes) {
			const idx = mk.indexOf('|');
			result.modes.push({ period: mk.substring(0, idx), mode: mk.substring(idx + 1), activations: val.activations });
		}
	}

	result.entries.sort((a, b) => {
		const pa = a.period.localeCompare(b.period);
		if (pa !== 0) return pa;
		const pn = a.provider.localeCompare(b.provider);
		if (pn !== 0) return pn;
		return a.model.localeCompare(b.model);
	});
	result.modes.sort((a, b) => {
		const pa = a.period.localeCompare(b.period);
		if (pa !== 0) return pa;
		return a.mode.localeCompare(b.mode);
	});

	return result;
};

module.exports = {
	recordUsage,
	recordModeActivation,
	getUsage,
};
