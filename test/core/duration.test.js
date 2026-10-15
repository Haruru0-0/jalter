import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, formatDuration, MIN_DELAY, MAX_DELAY } from '../../src/core/duration.js';

test('parseDuration reads single and combined units', () => {
  assert.equal(parseDuration('30m'), 1800);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1d12h'), 129600);
  assert.equal(parseDuration('1H 30M'), 5400);
  assert.equal(parseDuration('1d'), 86400);
  assert.equal(parseDuration('45s'), 45);
});

test('parseDuration does not range-check', () => {
  assert.equal(parseDuration('45d'), 3888000);
});

test('parseDuration rejects bad input', () => {
  for (const bad of ['', '2', '2x', '0m', 'h', '1h junk', '   ']) {
    assert.equal(parseDuration(bad), null, JSON.stringify(bad));
  }
});

test('formatDuration skips zero units', () => {
  assert.equal(formatDuration(90), '1m30s');
  assert.equal(formatDuration(90000), '1d1h');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(0), '0s');
});

test('delay bounds', () => {
  assert.equal(MIN_DELAY, 60);
  assert.equal(MAX_DELAY, 2592000);
});
