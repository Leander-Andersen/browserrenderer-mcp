import test from 'node:test';
import assert from 'node:assert/strict';
import { pickEvictable } from '../gateway/evict.mjs';

const S = (id, lastActive, o = {}) => ({ id, lastActive, inflight: 0, upstreamEver: true, closed: false, ...o });

test('pickEvictable: none when empty, busy, or not idle long enough', () => {
  assert.equal(pickEvictable([], 1000, 0), undefined);
  assert.equal(pickEvictable([S('a', 900, { inflight: 1 })], 1000, 0), undefined);
  assert.equal(pickEvictable([S('a', 900), S('b', 950)], 1000, 200), undefined);
  assert.equal(pickEvictable([S('a', 900, { closed: true })], 1000, 0), undefined);
});

test('pickEvictable: least recently active; minIdle 0 allows any idle session', () => {
  assert.equal(pickEvictable([S('a', 900), S('b', 500), S('c', 700)], 1000, 100).id, 'b');
  assert.equal(pickEvictable([S('a', 1000)], 1000, 0).id, 'a');
});

test('pickEvictable: prefers sessions that never opened an upstream connection', () => {
  const list = [S('old', 100), S('fresh', 800, { upstreamEver: false }), S('fresh2', 700, { upstreamEver: false })];
  assert.equal(pickEvictable(list, 1000, 100).id, 'fresh2');
  // a never-connected session that does not qualify is skipped
  assert.equal(pickEvictable([S('old', 100), S('fresh', 990, { upstreamEver: false })], 1000, 100).id, 'old');
  assert.equal(pickEvictable(new Set(list).values(), 1000, 100).id, 'fresh2');
});
