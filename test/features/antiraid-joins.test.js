import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJoinStore, joins, startAntiraidSweep, stopAntiraidSweep, MAX_WINDOW_MS,
} from '../../src/features/antiraid/joins.js';

afterEach(() => stopAntiraidSweep());

const entry = (userId, createdAt = 0) => ({ userId, createdAt });

test('record counts joins inside the window and ignores older ones', () => {
  const store = createJoinStore();
  assert.equal(store.record('g1', entry('u1'), 1000, 60_000), 1);
  assert.equal(store.record('g1', entry('u2'), 2000, 60_000), 2);
  assert.equal(store.record('g1', entry('u3'), 100_000, 60_000), 1, 'the old ones fell out');
});

test('a join exactly windowMs old is no longer live', () => {
  const store = createJoinStore();
  store.record('g1', entry('u1'), 1000, 60_000);
  assert.equal(store.record('g1', entry('u2'), 61_000, 60_000), 1, 'u1 is exactly 60s old: out');
  assert.deepEqual(store.recent('g1', 61_000, 60_000).map((e) => e.userId), ['u2']);
});

test('recent returns the live entries in join order with userId, createdAt and joinedAt', () => {
  const store = createJoinStore();
  store.record('g1', entry('u1', 111), 1000, 60_000);
  store.record('g1', entry('u2', 222), 2000, 60_000);
  assert.deepEqual(store.recent('g1', 3000, 60_000), [
    { userId: 'u1', createdAt: 111, joinedAt: 1000 },
    { userId: 'u2', createdAt: 222, joinedAt: 2000 },
  ]);
  assert.deepEqual(store.recent('g1', 3000, 1500), [{ userId: 'u2', createdAt: 222, joinedAt: 2000 }]);
  assert.deepEqual(store.recent('g9', 3000, 60_000), []);
});

test('guilds are separate', () => {
  const store = createJoinStore();
  store.record('g1', entry('u1'), 1000, 60_000);
  store.record('g2', entry('u2'), 1000, 60_000);
  assert.deepEqual(store.recent('g1', 2000, 60_000).map((e) => e.userId), ['u1']);
  assert.deepEqual(store.recent('g2', 2000, 60_000).map((e) => e.userId), ['u2']);
  assert.equal(store.size(), 2);
});

test('clear empties one guild', () => {
  const store = createJoinStore();
  store.record('g1', entry('u1'), 1000, 60_000);
  store.record('g2', entry('u2'), 1000, 60_000);
  store.clear('g1');
  assert.deepEqual(store.recent('g1', 2000, 60_000), []);
  assert.equal(store.recent('g2', 2000, 60_000).length, 1);
  assert.equal(store.size(), 1);
});

test('prune drops old entries and empty guilds so size() shrinks', () => {
  const store = createJoinStore();
  store.record('g1', entry('u1'), 1000, MAX_WINDOW_MS);
  store.record('g2', entry('u2'), 1000, MAX_WINDOW_MS);
  assert.equal(store.size(), 2);
  store.prune(1000 + MAX_WINDOW_MS, MAX_WINDOW_MS);
  assert.equal(store.size(), 0);
  assert.deepEqual(store.recent('g1', 1000 + MAX_WINDOW_MS, MAX_WINDOW_MS), []);
});

test('prune keeps the entries that are still inside the window', () => {
  const store = createJoinStore();
  const now = 1_000_000;
  store.record('g1', entry('old'), 1000, MAX_WINDOW_MS);
  store.record('g1', entry('new'), now, MAX_WINDOW_MS);
  store.prune(now, MAX_WINDOW_MS);
  assert.equal(store.size(), 1);
  assert.deepEqual(store.recent('g1', now, MAX_WINDOW_MS).map((e) => e.userId), ['new']);
});

test('the sweep prunes on the timer and start is idempotent', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const store = createJoinStore();
  store.record('g1', entry('u1'), Date.now() - MAX_WINDOW_MS - 1000, 60_000);
  assert.equal(store.size(), 1);
  const first = startAntiraidSweep(store);
  assert.equal(startAntiraidSweep(store), first, 'the timer is created once');
  t.mock.timers.tick(60_000);
  assert.equal(store.size(), 0, 'the sweep dropped the old entry');
  stopAntiraidSweep();
  t.mock.timers.tick(120_000);
  assert.equal(store.size(), 0);
});

test('the same user joining twice is counted once', () => {
  const store = createJoinStore();
  assert.equal(store.record('g1', entry('a'), 1000, 60_000), 1);
  assert.equal(store.record('g1', entry('a'), 2000, 60_000), 1, 'a rejoin is not a new user');
  const recent = store.recent('g1', 2000, 60_000);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].userId, 'a');
});

test('a rejoin refreshes joinedAt so the user stays live', () => {
  const store = createJoinStore();
  store.record('g1', entry('a'), 0, 60_000);
  store.record('g1', entry('a'), 50_000, 60_000);
  assert.equal(store.record('g1', entry('b'), 70_000, 60_000), 2);
});

test('the process singleton is a store of its own', () => {
  assert.equal(typeof joins.record, 'function');
  assert.equal(typeof joins.recent, 'function');
  assert.equal(typeof joins.clear, 'function');
  assert.equal(typeof joins.prune, 'function');
  assert.equal(typeof joins.size, 'function');
  assert.notEqual(joins, createJoinStore());
});
