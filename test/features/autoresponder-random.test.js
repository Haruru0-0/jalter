import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawRandom, weightedPick, renderRand } from '../../src/features/autoresponder/script/random.js';

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const fixed = (v) => () => v;

test('range is inclusive of both ends, deterministic, handles min=max and negatives', () => {
  const spec = { ranges: [{ min: 1, max: 6 }], choosers: [], locked: [] };
  assert.equal(drawRandom(spec, fixed(0)).range[0], 1);
  assert.equal(drawRandom(spec, fixed(0.999999)).range[0], 6);
  assert.deepEqual(drawRandom(spec, seeded(7)), drawRandom(spec, seeded(7)));
  assert.equal(drawRandom({ ranges: [{ min: 4, max: 4 }] }, seeded(1)).range[0], 4);
  const seen = new Set();
  const rng = seeded(3);
  for (let i = 0; i < 500; i++) seen.add(drawRandom({ ranges: [{ min: -2, max: 2 }] }, rng).range[0]);
  assert.deepEqual([...seen].sort((a, b) => a - b), [-2, -1, 0, 1, 2]);
});

test('choose picks by index', () => {
  const spec = { ranges: [], choosers: [{ kind: 'choose', options: ['a', 'b', 'c'] }], locked: [] };
  assert.equal(drawRandom(spec, fixed(0)).choice[0], 'a');
  assert.equal(drawRandom(spec, fixed(0.5)).choice[0], 'b');
  assert.equal(drawRandom(spec, fixed(0.99)).choice[0], 'c');
  assert.deepEqual(drawRandom(spec, fixed(0.5)).picked, [1]);
});

test('weightedPick honors relative weights and never picks zero weights', () => {
  const rng = seeded(42);
  const counts = [0, 0, 0];
  for (let i = 0; i < 10000; i++) counts[weightedPick([60, 0, 40], rng)]++;
  assert.equal(counts[1], 0);
  assert.ok(Math.abs(counts[0] / 10000 - 0.6) < 0.03, String(counts));
  assert.ok(Math.abs(counts[2] / 10000 - 0.4) < 0.03, String(counts));
  for (const v of [0, 0.5, 0.999999999]) assert.equal(weightedPick([0, 0, 5, 0], fixed(v)), 2);
  assert.equal(weightedPick([1, 1], fixed(0)), 0);
  assert.equal(weightedPick([0, 0], fixed(0.5)), -1);
});

test('drawRandom gives one draw per entry; locked follows the chooser index', () => {
  const spec = {
    ranges: [{ min: 1, max: 10 }, { min: 5, max: 5 }],
    choosers: [
      { kind: 'choose', options: ['x', 'y'] },
      { kind: 'weighted', weights: [1, 0, 0] },
    ],
    locked: [['one', 'two'], ['A', 'B', 'C']],
  };
  const d = drawRandom(spec, fixed(0.9));
  assert.equal(d.range.length, 2);
  assert.equal(d.choice.length, 2);
  assert.equal(d.choice[0], 'y');
  assert.equal(d.choice[1], 1);
  assert.deepEqual(d.lockedchoice, ['two', 'A']);
  assert.deepEqual(d.picked, [1, 0]);
});

test('renderRand renders each kind and empty for a missing index', () => {
  const d = { range: [3, 8], choice: ['a', 2], lockedchoice: ['z'], picked: [0, 1] };
  const tok = (kind, n = 1) => ({ t: 'rand', kind, n });
  assert.equal(renderRand(tok('range'), d), '3');
  assert.equal(renderRand(tok('range', 2), d), '8');
  assert.equal(renderRand(tok('choice', 2), d), '2');
  assert.equal(renderRand(tok('lockedchoice'), d), 'z');
  assert.equal(renderRand(tok('lockedchoice', 2), d), '');
  assert.equal(renderRand(tok('range', 4), d), '');
});
