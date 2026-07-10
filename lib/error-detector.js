'use strict';

/**
 * 错误探测器 —— 区分 Key 级异常、Provider 级异常、正常响应
 *
 * 规则来源：13 家 AI 服务商官方文档穷举查阅
 * - 仅 50X 判定为 Provider 级异常
 * - 4XX 及 HTTP 200 下的 Body 错误特征判定为 Key 级异常
 */

function hasErrorBody(body) {
	if (!body || typeof body !== 'object') return false;
	return body.error_code != null
		|| body.error != null
		|| (body.Response && body.Response.Error != null)
		|| (body.code != null && body.code !== 0);
}

function classifyResponse(httpStatus, body) {
	const status = typeof httpStatus === 'number' ? httpStatus : 0;

	if (status >= 400 && status < 600) {
		return { isKeyFailure: false, isProviderDown: true };
	}
	if (status === 200 && hasErrorBody(body)) {
		return { isKeyFailure: true, isProviderDown: false };
	}

	return { isKeyFailure: false, isProviderDown: false };
}

function classifyStreamFirstBlock(sseData) {
	if (!sseData || typeof sseData !== 'string') {
		return { isKeyFailure: false };
	}

	let trimmed = sseData.trim();
	if (trimmed === '[DONE]' || trimmed === '') {
		return { isKeyFailure: false };
	}

	// 去除 SSE 前缀: "data: " (OpenAI/Anthropic 风格)
	if (trimmed.startsWith('data:')) {
		trimmed = trimmed.substring(5).trim();
	}
	if (trimmed === '[DONE]' || trimmed === '') {
		return { isKeyFailure: false };
	}

	try {
		const data = JSON.parse(trimmed);
		if (hasErrorBody(data)) {
			return { isKeyFailure: true };
		}
	} catch (_) {
		// 非 JSON SSE 块不判定为错误
	}

	return { isKeyFailure: false };
}

module.exports = { classifyResponse, classifyStreamFirstBlock };
