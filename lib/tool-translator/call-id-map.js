// 全局单例:追踪 tool_use id → 上游工具名的映射
// 写入时机:响应 transformer 收到上游 tool_use 时
// 查询时机:下一轮请求转换器中处理 tool_result 时
const callIdMap = new Map();
const MAX_ENTRIES = 10000;

const recordToolCall = (id, meta) => {
	if (callIdMap.size >= MAX_ENTRIES) {
		const firstKey = callIdMap.keys().next().value;
		callIdMap.delete(firstKey);
	}
	callIdMap.set(id, { upstreamName: meta.upstreamName, upstreamType: meta.upstreamType || 'tool_use' });
};

const lookupToolCall = (id) => {
	return callIdMap.get(id) || null;
};

const removeToolCall = (id) => {
	callIdMap.delete(id);
};

module.exports = { recordToolCall, lookupToolCall, removeToolCall };
