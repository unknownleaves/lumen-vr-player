import assert from 'node:assert/strict';
import { Queue } from '../src/queue.js';
const it = (n) => ({ name: 'v' + n, path: '/v' + n });
let q;

// sequential + repeat off
q = new Queue(); q.add([it(0), it(1), it(2)]);
q.select(0);
assert.equal(q.nextIndex(true), 1); q.select(1);
assert.equal(q.nextIndex(true), 2); q.select(2);
assert.equal(q.nextIndex(true), -1, 'stops at end');
assert.equal(q.prevIndex(), 1);
// repeat all wraps, repeat one repeats on auto but skips on manual next
q.setRepeat('all'); assert.equal(q.nextIndex(true), 0);
q.setRepeat('one'); assert.equal(q.nextIndex(true), 2); assert.equal(q.nextIndex(false), 0);
assert.equal(q.cycleRepeat(), 'off');

// shuffle visits every item exactly once per round, current item first
let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
q = new Queue(rand); q.add([...Array(10).keys()].map(it)); q.select(4); q.setShuffle(true);
assert.equal(q.order[0], 4);
const seen = [4]; let i = 4;
for (;;) { const n = q.nextIndex(true); if (n < 0) break; seen.push(n); q.select(n); i = n; }
assert.deepEqual([...seen].sort((a, b) => a - b), [...Array(10).keys()]);
q.setRepeat('all'); const wrap = q.nextIndex(true);
assert.ok(wrap >= 0 && wrap !== i, 'new round does not repeat last item');

// add "play next" while shuffled
q = new Queue(rand); q.add([it(0), it(1), it(2)]); q.select(0); q.setShuffle(true);
const at = q.add(it(9), { after: true });
assert.equal(at, 1); assert.equal(q.nextIndex(true), 1); assert.equal(q.items[1].name, 'v9');

// move & remove keep the current item
q = new Queue(); q.add([it(0), it(1), it(2), it(3)]); q.select(2);
q.move(2, 0); assert.equal(q.current.name, 'v2'); assert.equal(q.index, 0);
q.move(3, 1); assert.deepEqual(q.items.map((x) => x.name), ['v2', 'v3', 'v0', 'v1']);
q.remove(1); assert.equal(q.current.name, 'v2'); assert.equal(q.items.length, 3);
q.remove(0); assert.equal(q.current, null);

// serialization drops session-only File items
q = new Queue(); q.add([it(0), { name: 'local.mp4', file: {} , url: 'blob:x' }, { name: 'nas.mkv', lib: '/Movies/nas.mkv' }]); q.select(2);
const j = JSON.parse(JSON.stringify(q));
assert.equal(j.items.length, 2); assert.equal(j.index, 1);
const r = new Queue(); r.restore(j); assert.equal(r.current.lib, '/Movies/nas.mkv');
console.log('queue: all checks passed');
