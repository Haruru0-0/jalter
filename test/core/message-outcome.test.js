import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginOutcome, markActed, finishOutcome, awaitOutcome, outcomeSize } from '../../src/core/message-outcome.js';

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

test('clean after the timeout when finishOutcome never comes', async () => {
  beginOutcome('t1');
  markActed('t1');
  assert.equal(await awaitOutcome('t1', 20), 'clean');
});

test('the map stays bounded', () => {
  for (let i = 0; i < 2600; i += 1) beginOutcome(`b${i}`);
  assert.ok(outcomeSize() <= 2000);
});
