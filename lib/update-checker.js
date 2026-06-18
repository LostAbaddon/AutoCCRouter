const { exec } = require('child_process');
const { promisify } = require('util');
const { log } = require('./logger');

const execAsync = promisify(exec);

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 分钟
const BRANCHES = ['master', 'develop'];

let gitUpdateState = {
	hasUpdate: false,
	branchesWithUpdate: [],
	lastCheckTime: null,
	error: null,
};

let timer = null;
let running = false;

const parseLsRemote = (stdout) => {
	const map = {};
	const lines = stdout.split('\n').filter((line) => line.trim());
	for (const line of lines) {
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 2) {
			const ref = parts[1];
			const branch = ref.replace('refs/heads/', '');
			map[branch] = parts[0];
		}
	}
	return map;
};

const getLocalCommit = async (branch) => {
	try {
		const { stdout } = await execAsync(`git rev-parse ${branch}`, {
			timeout: 10000,
		});
		return stdout.trim();
	}
	catch (e) {
		return null;
	}
};

const checkGitUpdates = async () => {
	if (running) {
		return;
	}
	running = true;

	try {
		const repoDir = process.cwd();
		const { stdout: remoteStdout } = await execAsync(
			'git ls-remote origin refs/heads/master refs/heads/develop',
			{ timeout: 30000, cwd: repoDir }
		);
		const remoteHashes = parseLsRemote(remoteStdout);

		const branchesWithUpdate = [];
		for (const branch of BRANCHES) {
			const remoteHash = remoteHashes[branch];
			if (!remoteHash) {
				continue;
			}
			const localHash = await getLocalCommit(branch);
			if (!localHash) {
				continue;
			}
			log('info', `[update-checker] Git Hash for Branch "${branch}": ${localHash} → ${remoteHash}`);
			if (remoteHash !== localHash) {
				branchesWithUpdate.push(branch);
			}
		}

		gitUpdateState = {
			hasUpdate: branchesWithUpdate.length > 0,
			branchesWithUpdate,
			lastCheckTime: new Date().toISOString(),
			error: null,
		};

		if (branchesWithUpdate.length > 0) {
			log('info', `[update-checker] 发现远程分支有更新: ${branchesWithUpdate.join(', ')}`);
		}
	}
	catch (e) {
		gitUpdateState = {
			...gitUpdateState,
			lastCheckTime: new Date().toISOString(),
			error: e.message,
		};
		log('warn', `[update-checker] 检查失败: ${e.message}`);
	}
	finally {
		running = false;
	}
};

const start = (intervalMs = DEFAULT_INTERVAL_MS) => {
	if (timer) {
		return;
	}

	checkGitUpdates();
	timer = setInterval(checkGitUpdates, intervalMs);

	log('info', `[update-checker] 已启动，每 ${intervalMs / 60000} 分钟检查一次 master/develop 更新`);
};

const getState = () => gitUpdateState;

module.exports = { start, checkGitUpdates, getState };
