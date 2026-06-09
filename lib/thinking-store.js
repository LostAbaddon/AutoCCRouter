const store = new Map();

const saveThinking = (toolUseId, thinkingBlocks) => {
	if (!toolUseId || !Array.isArray(thinkingBlocks) || thinkingBlocks.length === 0) {
		return;
	}
	store.set(toolUseId, [...thinkingBlocks]);
};

const getThinking = (toolUseId) => {
	return store.get(toolUseId) || null;
};

module.exports = { saveThinking, getThinking };
