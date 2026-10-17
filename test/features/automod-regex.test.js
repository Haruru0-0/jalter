import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePattern, compilePatterns, matchPatterns, getCompiled } from '../../src/features/automod/regex-safe.js';
import { findPattern } from '../../src/features/automod/detect-words.js';
import { addToList, readConfig } from '../../src/features/automod/config.js';

test('accepts a plain pattern', () => {
  assert.deepEqual(validatePattern('free\\s+nitro'), { ok: true });
});

test('rejects over 250 characters', () => {
  assert.deepEqual(validatePattern('a'.repeat(251)), { ok: false, reason: 'too_long' });
  assert.deepEqual(validatePattern('a'.repeat(250)), { ok: true });
});

test('(a+)+$ against 50000 a characters plus ! returns in under 100 ms', () => {
  const regexes = compilePatterns(['(a+)+$']);
  assert.equal(regexes.length, 1);
  const text = 'a'.repeat(50_000) + '!';
  const start = performance.now();
  matchPatterns(text, regexes);
  assert.ok(performance.now() - start < 100);
});

test('rejects backreferences and lookarounds as invalid', () => {
  for (const p of ['(a)\\1', '(?=a)b', '(?!a)b', '(?<=a)b', '(?<!a)b']) {
    assert.deepEqual(validatePattern(p), { ok: false, reason: 'invalid' }, p);
  }
});

test('rejects a syntax error', () => {
  assert.deepEqual(validatePattern('('), { ok: false, reason: 'invalid' });
  assert.deepEqual(validatePattern('[a-'), { ok: false, reason: 'invalid' });
});

test('matching is case-insensitive', () => {
  assert.equal(matchPatterns('Get FREE Nitro now', compilePatterns(['free\\s+nitro'])), 'free\\s+nitro');
  assert.equal(matchPatterns('nothing here', compilePatterns(['free\\s+nitro'])), null);
});

test('only the first 1000 characters are tested', () => {
  const regexes = compilePatterns(['needle']);
  assert.equal(matchPatterns('x'.repeat(1000) + 'needle', regexes), null);
  assert.equal(matchPatterns('x'.repeat(994) + 'needle', regexes), 'needle');
});

test('compilePatterns skips a stored invalid pattern', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const regexes = compilePatterns(['(a)\\1', 'ok+']);
  assert.equal(regexes.length, 1);
  assert.equal(matchPatterns('okkk', regexes), 'ok+');
  assert.equal(warn.mock.callCount(), 1);
});

test('getCompiled reuses the compiled patterns until the sources change', () => {
  const a = getCompiled('g1', ['foo', 'bar']);
  assert.equal(getCompiled('g1', ['foo', 'bar']), a);
  const b = getCompiled('g1', ['foo']);
  assert.notEqual(b, a);
  assert.notEqual(getCompiled('g2', ['foo']), b);
});

test('findPattern uses the stored patterns of the guild', () => {
  const cfg = { patterns: ['dis+cord\\.gg'] };
  assert.equal(findPattern('join DISSCORD.gg now', cfg, 'g9'), 'dis+cord\\.gg');
  assert.equal(findPattern('hello', cfg, 'g9'), null);
  assert.equal(findPattern('hello', {}, 'g9'), null);
});

test('addToList words.patterns refuses an invalid pattern and the 11th pattern', () => {
  assert.deepEqual(addToList({}, 'words.patterns', '(a)\\1'), { ok: false, reason: 'invalid' });
  assert.deepEqual(addToList({}, 'words.patterns', 'a'.repeat(251)), { ok: false, reason: 'too_long' });
  let config = {};
  for (let i = 0; i < 10; i++) {
    const r = addToList(config, 'words.patterns', `p${i}`);
    assert.equal(r.ok, true);
    config = r.config;
  }
  assert.equal(readConfig(config).rules.words.patterns.length, 10);
  assert.deepEqual(addToList(config, 'words.patterns', 'p10'), { ok: false, reason: 'full' });
});
