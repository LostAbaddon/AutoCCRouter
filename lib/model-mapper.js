// 模型名映射：根据前缀匹配找到目标 Provider 和 Model
// 按 prefix 长度降序排列，优先命中更具体的前缀
const mapModel = (modelName, modelMapping) => {
	if (!modelName || !modelMapping || modelMapping.length === 0) {
		return null;
	}
	const sorted = [...modelMapping].sort((a, b) => b.prefix.length - a.prefix.length);
	for (const rule of sorted) {
		if (modelName.startsWith(rule.prefix)) {
			return {
				targetModel: rule.target || modelName,
				provider: rule.provider,
			};
		}
	}
	return null;
};

module.exports = { mapModel };
