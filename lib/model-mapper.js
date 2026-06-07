// 模型名映射：根据 prefix 匹配找到目标 Provider 和 Model
// 匹配规则：
//   1. 精确前缀（无 *）按字符串长度降序匹配
//   2. 通配规则（含 *）排在精确规则之后；通配符 * 匹配任意字符序列
//      例如 gpt-*-mini 等价于 /^gpt-.*-mini/
const { log } = require('./logger');
const { parseAgentSpec } = require('./providers/auto');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 把 prefix 编译为一个 (modelName) => boolean 的匹配器
// 返回 null 表示该规则被跳过（prefix 不合法）
const buildPrefixMatcher = (prefix) => {
	if (typeof prefix !== 'string' || prefix.length === 0) {
		return null;
	}
	if (prefix.indexOf('*') === -1) {
		// 精确前缀：保持原 startsWith 语义
		return (modelName) => modelName.startsWith(prefix);
	}
	// 通配规则：先按 * 分割，对每段做正则转义，再用 .* 拼接
	const pattern = '^' + prefix.split('*').map(escapeRegExp).join('.*');
	const re = new RegExp(pattern);
	return (modelName) => re.test(modelName);
};

const isWildcardPrefix = (prefix) => typeof prefix === 'string' && prefix.indexOf('*') !== -1;

const mapModel = (modelName, modelMapping) => {
	if (!modelName || !modelMapping || modelMapping.length === 0) {
		return null;
	}
	// 预编译每条规则的 matcher，并按优先级排序：
	// 精确前缀在前、通配规则在后；同组内按 prefix 字符串长度降序
	const prepared = modelMapping
		.map((rule) => ({
			rule,
			matcher: buildPrefixMatcher(rule.prefix),
			isWildcard: isWildcardPrefix(rule.prefix),
			length: typeof rule.prefix === 'string' ? rule.prefix.length : 0,
		}))
		.filter((entry) => entry.matcher !== null)
		.sort((a, b) => {
			if (a.isWildcard !== b.isWildcard) {
				return a.isWildcard ? 1 : -1;
			}
			return b.length - a.length;
		});

	for (const { rule, matcher } of prepared) {
		if (matcher(modelName)) {
			if (rule.provider === 'auto' && Array.isArray(rule.target)) {
				const picked = rule.target[Math.floor(Math.random() * rule.target.length)];
				const spec = parseAgentSpec(picked);
				if (spec) {
					log('info', `[Auto] Pick mode=${modelName} → ${spec.providerName}/${spec.model}`);
					return { targetModel: spec.model, provider: spec.providerName };
				}
			}
			return {
				targetModel: rule.target || modelName,
				provider: rule.provider,
			};
		}
	}
	return null;
};

module.exports = { mapModel, isWildcardPrefix };
