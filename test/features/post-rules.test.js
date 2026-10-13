import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolesToPing, isHttpUrl } from '../../src/features/post/rules.js';

test('rolesToPing returns nothing unless role pings are allowed', () => {
  assert.deepEqual(rolesToPing('hi <@&1>', false), []);
  assert.deepEqual(rolesToPing('hi <@&1>', null), []);
});

test('rolesToPing dedupes role ids and caps them at 100', () => {
  assert.deepEqual(rolesToPing('<@&1> <@&2> <@&1>', true), ['1', '2']);
  const many = Array.from({ length: 150 }, (_, i) => `<@&${i + 1}>`).join(' ');
  const roles = rolesToPing(many, true);
  assert.equal(roles.length, 100);
  assert.equal(roles[0], '1');
});

test('isHttpUrl accepts only http and https links', () => {
  assert.equal(isHttpUrl('https://example.com/x'), true);
  assert.equal(isHttpUrl('HTTP://example.com'), true);
  assert.equal(isHttpUrl('javascript:alert(1)'), false);
  assert.equal(isHttpUrl('ftp://example.com'), false);
  assert.equal(isHttpUrl('https://'), false);
  assert.equal(isHttpUrl('https://exa mple.com'), false);
});
