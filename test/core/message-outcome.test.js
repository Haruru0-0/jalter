import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginOutcome, markActed, finishOutcome, awaitOutcome, outcomeSize, configureOutcome } from '../../src/core/message-outcome.js';

test('acted after markActed and finishOutcome', async () => {
  beginOutcome('a1');
  const p = awaitOutcome('a1');
  markActed('a1');
  finishOutcome('a1');
  assert.equal(await p, 'acted');
});

test('clean after finishOutcome alone', async () => {
  beginOutcome('c1');
  finishOutcome('c1');
  assert.equal(await awaitOutcome('c1'), 'clean');
});

test('clean for an unknown id', async () => {
  assert.equal(await awaitOutcome('nope'), 'clean');
});

test('clean after the timeout when neither markActed nor finishOutcome comes', async () => {
  beginOutcome('t1');
  assert.equal(await awaitOutcome('t1', 20), 'clean');
});

test('the map stays bounded', () => {
  for (let i = 0; i < 2600; i += 1) beginOutcome(`b${i}`);
  assert.ok(outcomeSize() <= 2000);
});

test('markActed resolves acted at once, even when finishOutcome never comes', async () => {
  beginOutcome('slow1');
  const p = awaitOutcome('slow1', 200);
  markActed('slow1');
  assert.equal(await p, 'acted');
  finishOutcome('slow1');
  assert.equal(await awaitOutcome('slow1', 50), 'acted');
});

// Fake timers: records every timer so a test can fire it by hand.
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout: (fn, ms) => { const h = { fn, ms, cleared: false, unrefed: false, unref() { this.unrefed = true; } }; timers.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
    live: (ms) => timers.filter((h) => !h.cleared && h.ms === ms),
  };
}

test('a finished entry is dropped about 5 s after finishOutcome, with an unrefed timer', async (t) => {
  const ft = fakeTimers();
  configureOutcome({ setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout });
  t.after(() => configureOutcome());
  beginOutcome('k1');
  markActed('k1');
  finishOutcome('k1');
  assert.equal(outcomeSize(), 1);
  const keep = ft.live(5000);
  assert.equal(keep.length, 1);
  assert.ok(keep[0].unrefed);
  assert.equal(ft.live(30_000).length, 0); // the 30 s in-progress timer is replaced
  keep[0].fn();
  assert.equal(outcomeSize(), 0);
  assert.equal(await awaitOutcome('k1', 50), 'clean'); // gone: unknown id
});

test('over the cap, finished entries are evicted before in-progress ones', async (t) => {
  configureOutcome({ maxEntries: 3 });
  t.after(() => configureOutcome());
  beginOutcome('e1'); // still being checked
  beginOutcome('e2');
  beginOutcome('e3');
  finishOutcome('e2'); // finished, clean
  beginOutcome('e4'); // over the cap: e2 goes, not e1
  assert.equal(outcomeSize(), 3);
  const p1 = awaitOutcome('e1', 200);
  markActed('e1');
  assert.equal(await p1, 'acted'); // e1 still tracked
  assert.equal(await awaitOutcome('e2', 200), 'clean'); // evicted id reads as clean at once
});

test('with no finished entry left, the oldest in-progress entry is evicted and its waiter gets clean', async (t) => {
  configureOutcome({ maxEntries: 2 });
  t.after(() => configureOutcome());
  beginOutcome('o1');
  const p = awaitOutcome('o1', 500);
  beginOutcome('o2');
  beginOutcome('o3');
  assert.equal(outcomeSize(), 2);
  assert.equal(await p, 'clean');
});
