import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_MODES, checkTrigger, matchRule, chooseRule } from '../../src/features/autoresponder/match.js';

const rule = (id, trigger, matchMode, enabled = true) => ({ id, trigger, matchMode, enabled });

test('MATCH_MODES lists the five modes', () => {
  assert.deepEqual(MATCH_MODES, ['exact', 'startswith', 'endswith', 'includes', 'regex']);
});

test('exact matches the whole message, ignoring case and surrounding whitespace', () => {
  const r = rule(1, 'Hello', 'exact');
  assert.equal(matchRule(r, '  hello '), true);
  assert.equal(matchRule(r, 'HELLO'), true);
  assert.equal(matchRule(r, 'hello there'), false);
});

test('startswith, endswith, includes match their position', () => {
  assert.equal(matchRule(rule(1, '!hug', 'startswith'), '!hug @sam'), true);
  assert.equal(matchRule(rule(1, '!hug', 'startswith'), 'oh !hug'), false);
  assert.equal(matchRule(rule(1, 'bye', 'endswith'), 'ok BYE '), true);
  assert.equal(matchRule(rule(1, 'bye', 'endswith'), 'bye now'), false);
  assert.equal(matchRule(rule(1, 'dumb', 'includes'), 'dumbo'), true);
  assert.equal(matchRule(rule(1, 'dumb', 'includes'), 'smart'), false);
});

test('regex matches through RE2', () => {
  const r = rule(1, '^h(i|ello)\\b', 'regex');
  assert.equal(matchRule(r, 'Hello world'), true);
  assert.equal(matchRule(r, 'oh hello'), false);
});

test('unsupported, invalid and oversized patterns are refused by checkTrigger', () => {
  // RE2 accepts (a+)+$ (it runs in linear time), so that one is covered by the no-hang test below.
  const bad = checkTrigger('(?=a)b', 'regex');
  assert.deepEqual(bad, { ok: false, code: 'BAD_REGEX' });
  assert.deepEqual(checkTrigger('a'.repeat(251), 'regex'), { ok: false, code: 'BAD_REGEX' });
  assert.deepEqual(checkTrigger('(', 'regex'), { ok: false, code: 'BAD_REGEX' });
});

test('a catastrophic pattern does not hang matching', () => {
  const r = rule(1, '(a+)+$', 'regex');
  const start = Date.now();
  matchRule(r, 'a'.repeat(900) + '!');
  assert.ok(Date.now() - start < 1000);
});

test('regex text over MAX_TEST_LENGTH does not match and does not throw', () => {
  const r = rule(1, 'needle', 'regex');
  assert.equal(matchRule(r, 'x'.repeat(1001) + 'needle'), false);
  assert.equal(matchRule(r, 'x'.repeat(5000)), false);
});

test('checkTrigger validates empty, long and mode', () => {
  assert.deepEqual(checkTrigger('', 'exact'), { ok: false, code: 'EMPTY_TRIGGER' });
  assert.deepEqual(checkTrigger('   ', 'includes'), { ok: false, code: 'EMPTY_TRIGGER' });
  assert.deepEqual(checkTrigger('a'.repeat(101), 'exact'), { ok: false, code: 'TRIGGER_TOO_LONG' });
  assert.deepEqual(checkTrigger('a'.repeat(100), 'exact'), { ok: true });
  assert.deepEqual(checkTrigger('hi', 'fuzzy'), { ok: false, code: 'BAD_MODE' });
  assert.deepEqual(checkTrigger('hi', 'regex'), { ok: true });
});

test('chooseRule prefers the longest non-regex trigger', () => {
  const rules = [rule(1, 'hug', 'includes'), rule(2, '!hug', 'startswith')];
  assert.equal(chooseRule(rules, '!hug sam').id, 2);
});

test('chooseRule ties go to the lower id', () => {
  const rules = [rule(5, 'abc', 'includes'), rule(3, 'xyz', 'includes')];
  assert.equal(chooseRule(rules, 'abc xyz').id, 3);
});

test('a regex rule loses to any matching non-regex rule, wins alone', () => {
  const rules = [rule(1, 'h.*', 'regex'), rule(2, 'h', 'startswith')];
  assert.equal(chooseRule(rules, 'hello').id, 2);
  assert.equal(chooseRule([rules[0]], 'hello').id, 1);
});

test('chooseRule returns null with no match and ignores disabled rules', () => {
  assert.equal(chooseRule([rule(1, 'zzz', 'exact')], 'hello'), null);
  assert.equal(chooseRule([rule(1, 'hello', 'exact', false)], 'hello'), null);
  assert.equal(chooseRule([], 'hello'), null);
});
