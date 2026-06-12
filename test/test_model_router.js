// Self-test for model-router.js
// Run: node test/test_model_router.js

const mr = require('../lib/model-router');
const assert = require('assert');

const LIMITS = mr._LIMITS;
console.log('Limits:', LIMITS);

let passed = 0;
let failed = 0;
const check = (name, fn) => {
	try {
		fn();
		console.log(`  ✓ ${name}`);
		passed++;
	}
	catch (e) {
		console.error(`  ✗ ${name}: ${e.message}`);
		failed++;
	}
};

console.log('\n--- Test 1: selectModel with single item ---');
mr.resetAll();
check('single item always returned', () => {
	for (let i = 0; i < 100; i++) {
		const r = mr.selectModel(['deepseek/deepseek-v4-pro']);
		assert.strictEqual(r.providerName, 'deepseek');
		assert.strictEqual(r.model, 'deepseek-v4-pro');
	}
});

console.log('\n--- Test 2: selectModel with multiple items, equal weight ---');
mr.resetAll();
check('multiple items distributed roughly equally', () => {
	const counts = {};
	for (let i = 0; i < 10000; i++) {
		const r = mr.selectModel(['a/m1', 'b/m2', 'c/m3']);
		counts[r.providerName] = (counts[r.providerName] || 0) + 1;
	}
	// Each should be ~3333, allow 30% variance
	for (const p of ['a', 'b', 'c']) {
		assert(counts[p] > 2000 && counts[p] < 5000, `${p}: ${counts[p]}`);
	}
});

console.log('\n--- Test 3: selectModel with duplicate items (no dedup) ---');
mr.resetAll();
check('duplicates get multiplied probability', () => {
	const counts = {};
	for (let i = 0; i < 10000; i++) {
		const r = mr.selectModel(['a/m1', 'a/m1', 'b/m2']);
		counts[r.providerName] = (counts[r.providerName] || 0) + 1;
	}
	// a should have ~2x probability of b
	console.log('  counts:', counts);
	assert(counts.a > counts.b * 1.5, `a (${counts.a}) should be > b (${counts.b}) * 1.5`);
});

console.log('\n--- Test 4: startTask/finishTask update num_doing/num_done ---');
mr.resetAll();
check('startTask increments num_doing', () => {
	mr.startTask('p1', 'm1');
	const s = mr.getSnapshot();
	assert.strictEqual(s.tasks['p1|m1'].num_doing, 1);
	assert.strictEqual(s.tasks['p1|m1'].num_done, 0);
});
check('finishTask success increments num_done and decrements num_doing', () => {
	mr.finishTask('p1', 'm1', true, false);
	const s = mr.getSnapshot();
	assert.strictEqual(s.tasks['p1|m1'].num_doing, 0);
	assert.strictEqual(s.tasks['p1|m1'].num_done, 1);
});
check('finishTask failure does not increment num_done', () => {
	mr.startTask('p1', 'm1');
	mr.finishTask('p1', 'm1', false, true);
	const s = mr.getSnapshot();
	assert.strictEqual(s.tasks['p1|m1'].num_done, 1); // unchanged from before
	assert.strictEqual(s.tasks['p1|m1'].num_doing, 0);
});

console.log('\n--- Test 5: provider down multiplies link_weight by 0.9 each time ---');
mr.resetAll();
// 需要先触发一次 finishTask 来初始化 provider state(getSnapshot 只返回有记录的 provider)
mr.finishTask('p2', 'm2', true, false);
check('link_weight starts at 100 (after initial success)', () => {
	const s = mr.getSnapshot();
	assert.strictEqual(s.providers['p2'].linkWeight, 100);
});
check('down event multiplies by 0.9 (cumulative)', () => {
	mr.finishTask('p2', 'm2', false, true);  // first down: 100*0.9=90
	mr.finishTask('p2', 'm2', false, true);  // second down: 90*0.9=81
	mr.finishTask('p2', 'm2', false, true);  // third down: 81*0.9=72.9
	const s = mr.getSnapshot();
	const expected = 100 * Math.pow(0.9, 3);
	assert(Math.abs(s.providers['p2'].linkWeight - expected) < 0.01,
		`linkWeight=${s.providers['p2'].linkWeight}, expected ${expected}`);
});

console.log('\n--- Test 6: provider up (down->up) multiplies by 1.1 ---');
mr.resetAll();
mr.finishTask('p3', 'm3', false, true);  // down: 100 * 0.9 = 90
check('after one down, link_weight is 90', () => {
	const s = mr.getSnapshot();
	assert(Math.abs(s.providers['p3'].linkWeight - 90) < 0.01);
});
mr.finishTask('p3', 'm3', true, false);  // up: 90 * 1.1 = 99
check('after recovery, link_weight is 90*1.1=99', () => {
	const s = mr.getSnapshot();
	assert(Math.abs(s.providers['p3'].linkWeight - 99) < 0.01);
});
mr.finishTask('p3', 'm3', true, false);  // already up, no change
check('no change when already up', () => {
	const s = mr.getSnapshot();
	assert(Math.abs(s.providers['p3'].linkWeight - 99) < 0.01);
});

console.log('\n--- Test 7: successful tasks with more num_done get more weight ---');
mr.resetAll();
// Give 'a/m1' more successful completions
for (let i = 0; i < 100; i++) { mr.startTask('a', 'm1'); mr.finishTask('a', 'm1', true, false); }
mr.startTask('b', 'm2'); mr.finishTask('b', 'm2', true, false);

check('a/m1 selected more often than b/m2 due to higher num_done', () => {
	const counts = { a: 0, b: 0 };
	for (let i = 0; i < 5000; i++) {
		const r = mr.selectModel(['a/m1', 'b/m2']);
		counts[r.providerName]++;
	}
	console.log('  counts:', counts);
	assert(counts.a > counts.b * 1.5, `a (${counts.a}) should be > b (${counts.b}) * 1.5`);
});

console.log('\n--- Test 8: tasks with num_doing get less weight ---');
mr.resetAll();
mr.startTask('a', 'm1'); mr.startTask('a', 'm1'); mr.startTask('a', 'm1');
// 'a' has 3 doing, 'b' has 0
check('a/m1 with high num_doing selected less than b/m2', () => {
	const counts = { a: 0, b: 0 };
	for (let i = 0; i < 5000; i++) {
		const r = mr.selectModel(['a/m1', 'b/m2']);
		counts[r.providerName]++;
	}
	console.log('  counts:', counts);
	assert(counts.b > counts.a * 1.5, `b (${counts.b}) should be > a (${counts.a}) * 1.5`);
});

console.log('\n--- Test 9: resetAll clears everything ---');
mr.resetAll();
check('after reset, all empty', () => {
	const s = mr.getSnapshot();
	assert.deepStrictEqual(s.providers, {});
	assert.deepStrictEqual(s.tasks, {});
});

console.log('\n--- Test 10: throws on empty/invalid array ---');
mr.resetAll();
check('empty array throws', () => {
	assert.throws(() => mr.selectModel([]), /empty/);
});
check('all invalid specs throws', () => {
	assert.throws(() => mr.selectModel(['', 'no-slash', 'a/']), /no valid specs/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
