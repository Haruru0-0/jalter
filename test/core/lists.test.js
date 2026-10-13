import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capList } from '../../src/core/lists.js';

const more = (n) => `+${n} more`;

test('a short list is joined unchanged', () => {
  assert.equal(capList(['a', 'b', 'c'], { more }), 'a, b, c');
  assert.equal(capList([], { more }), '');
});

test('a long list keeps whole items and ends with +N more within the limit', () => {
  const items = Array.from({ length: 10 }, (_, i) => `item${i}`);
  const text = capList(items, { max: 30, more });
  assert.ok(text.length <= 30, text);
  assert.equal(text, 'item0, item1, item2, +7 more');
});

test('the default limit is 2000 characters', () => {
  const items = Array.from({ length: 500 }, (_, i) => `\`name-${String(i).padStart(3, '0')}\``);
  const text = capList(items, { more });
  assert.ok(text.length <= 2000);
  const m = text.match(/\+(\d+) more$/);
  assert.ok(m);
  const shown = text.split(', ').slice(0, -1);
  assert.equal(shown.length + Number(m[1]), 500);
  assert.ok(shown.every((s) => /^`name-\d{3}`$/.test(s)));
});

test('when even one item does not fit, only the suffix is shown', () => {
  assert.equal(capList(['x'.repeat(50), 'y'], { max: 20, more }), '+2 more');
});
