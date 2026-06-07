const { log } = require('./logger');

// 会话状态: sessionKey → { mode, lastAccess, lastModeObtainedAt }
const sessions = new Map();

// 1 小时未访问则清理
const SESSION_TTL_MS = 60 * 60 * 1000;
// 每 30 分钟清理一次
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
// 默认 mode 缓存 TTL: 60 秒
const DEFAULT_MODE_CACHE_TTL_MS = 60 * 1000;

const cleanupStaleSessions = () => {
	const now = Date.now();
	let cleaned = 0;
	for (const [key, val] of sessions) {
		if (now - val.lastAccess > SESSION_TTL_MS) {
			sessions.delete(key);
			cleaned++;
		}
	}
	if (cleaned > 0) {
		log('debug', `[Session] Cleaned ${cleaned} stale session(s), ${sessions.size} remaining`);
	}
};

// 启动定时清理
const cleanupTimer = setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);
// 允许 timer 不阻止进程退出
if (cleanupTimer.unref) {
	cleanupTimer.unref();
}

// 归一化 sessionKey, 确保始终是字符串
const normalizeKey = (key) => {
	if (key === null || key === undefined) {
		return null;
	}
	return typeof key === 'string' ? key : String(key);
};

const getSession = (sessionKey) => {
	const key = normalizeKey(sessionKey);
	if (!key) {
		return null;
	}
	const entry = sessions.get(key);
	if (!entry) {
		return null;
	}
	entry.lastAccess = Date.now();
	return entry.mode;
};

const setSession = (sessionKey, mode) => {
	const key = normalizeKey(sessionKey);
	if (!key) {
		return;
	}
	const prev = sessions.get(key);
	sessions.set(key, { mode, lastAccess: Date.now(), lastModeObtainedAt: Date.now() });
	if (!prev || prev.mode !== mode) {
		log('info', `[Session] ${key.substring(0, 40)} → mode=${mode}${prev ? ` (was ${prev.mode})` : ' (new)'}`);
	}
};

const getSessionStats = () => {
	const modes = {};
	for (const [, val] of sessions) {
		modes[val.mode] = (modes[val.mode] || 0) + 1;
	}
	return { count: sessions.size, modes };
};

// 检查 session 的 mode 缓存是否有效
// ttlMs: 缓存有效期（毫秒），未传则使用默认 60 秒
// 返回缓存的 mode 或 null
const getCachedMode = (sessionKey, ttlMs) => {
	const key = normalizeKey(sessionKey);
	if (!key) {
		return null;
	}
	const entry = sessions.get(key);
	if (!entry || !entry.lastModeObtainedAt) {
		return null;
	}
	const effectiveTtl = ttlMs ?? DEFAULT_MODE_CACHE_TTL_MS;
	if (Date.now() - entry.lastModeObtainedAt < effectiveTtl) {
		return entry.mode;
	}
	return null;
};

// 从 messages 数组提取 session key: 第一个 user text 消息的内容
const deriveSessionKey = (messages) => {
	if (!Array.isArray(messages) || messages.length === 0) {
		return null;
	}
	for (const msg of messages) {
		if (msg.role !== 'user') {
			continue;
		}
		const blocks = Array.isArray(msg.content) ? msg.content : [];
		for (const block of blocks) {
			if (block.type === 'text' && block.text && block.text.trim()) {
				return block.text.trim();
			}
		}
		if (typeof msg.content === 'string' && msg.content.trim()) {
			return msg.content.trim();
		}
	}
	return null;
};

module.exports = {
	getSession,
	setSession,
	getCachedMode,
	getSessionStats,
	deriveSessionKey,
};
