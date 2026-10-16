import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStrikeStore, stepReached, isTopStep } from '../../src/features/automod/strikes.js';

const W = 600_000;
const steps = [
  { strikes: 1, action: 'delete', timeoutSeconds: 0 },
  { strikes: 3, action: 'timeout', timeoutSeconds: 60 },
  { strikes: 5, action: 'kick', timeoutSeconds: 0 },
];

test('counts strikes inside the window only', () => {
  const s = createStrikeStore();
  assert.deepEqual(s.add('g', 'u', 'spam', 0, W), { previous: 0, count: 1 });
  assert.deepEqual(s.add('g', 'u', 'spam', 1000, W), { previous: 1, count: 2 });
  assert.deepEqual(s.add('g', 'u', 'spam', W + 500, W), { previous: 1, count: 2 });
  assert.deepEqual(s.add('g', 'u', 'spam', W + 1000 + 1, W), { previous: 1, count: 2 });
});

test('separate per guild, user and rule', () => {
  const s = createStrikeStore();
  s.add('g', 'u', 'spam', 0, W);
  assert.equal(s.add('g2', 'u', 'spam', 1, W).count, 1);
  assert.equal(s.add('g', 'u2', 'spam', 1, W).count, 1);
  assert.equal(s.add('g', 'u', 'links', 1, W).count, 1);
  assert.equal(s.add('g', 'u', 'spam', 1, W).count, 2);
});

test('stepReached returns the highest step reached', () => {
  assert.equal(stepReached(steps, 2, 3).strikes, 3);
  assert.equal(stepReached(steps, 0, 1).strikes, 1);
});

test('stepReached returns null when no new step is crossed', () => {
  assert.equal(stepReached(steps, 1, 2), null);
  assert.equal(stepReached(steps, 3, 4), null);
  assert.equal(stepReached([], 0, 5), null);
});

test('a jump over two steps fires only the highest', () => {
  assert.equal(stepReached(steps, 0, 5).strikes, 5);
  assert.equal(stepReached(steps, 0, 3).strikes, 3);
});

test('isTopStep identifies the last step', () => {
  assert.equal(isTopStep(steps, steps[2]), true);
  assert.equal(isTopStep(steps, steps[1]), false);
  assert.equal(isTopStep(steps, null), false);
});

test('reset clears the count', () => {
  const s = createStrikeStore();
  s.add('g', 'u', 'spam', 0, W);
  s.add('g', 'u', 'spam', 1, W);
  s.reset('g', 'u', 'spam');
  assert.deepEqual(s.add('g', 'u', 'spam', 2, W), { previous: 0, count: 1 });
});

test('prune drops expired entries', () => {
  const s = createStrikeStore();
  s.add('g', 'u', 'spam', 0, W);
  s.add('g', 'u2', 'spam', W, W);
  s.prune(W + 10, W);
  assert.equal(s.size(), 1);
  s.prune(3 * W, W);
  assert.equal(s.size(), 0);
});
