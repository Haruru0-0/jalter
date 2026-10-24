import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, PARSE_ERROR_CODES } from '../../src/features/autoresponder/script/parse.js';

const ok = (s) => {
  const r = parseScript(s);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.nodes;
};
const bad = (s) => {
  const r = parseScript(s);
  assert.equal(r.ok, false);
  return r.errors;
};

test('empty string parses to no nodes', () => {
  assert.deepEqual(parseScript(''), { ok: true, nodes: [] });
});

test('plain text is one text node', () => {
  assert.deepEqual(ok('hello world'), [{ t: 'text', v: 'hello world' }]);
});

test('placeholder is a call with no args', () => {
  assert.deepEqual(ok('Hi {user}!'), [
    { t: 'text', v: 'Hi ' },
    { t: 'call', name: 'user', args: [], pos: 3 },
    { t: 'text', v: '!' },
  ]);
});

test('names are lower-cased', () => {
  assert.equal(ok('{User}')[0].name, 'user');
});

test('single arg', () => {
  assert.deepEqual(ok('{cooldown:30}'), [{ t: 'call', name: 'cooldown', args: ['30'], pos: 0 }]);
});

test('args split on unescaped pipe and are trimmed', () => {
  assert.deepEqual(ok('{requirerole:Mods | Admins}')[0].args, ['Mods', 'Admins']);
});

test('escapes become literals in text', () => {
  assert.deepEqual(ok('a \\{b \\[c] \\| \\\\'), [{ t: 'text', v: 'a {b [c] | \\' }]);
});

test('escapes become literals in args', () => {
  assert.deepEqual(ok('{say:a\\|b|c\\{d|e\\[f|g\\\\h}')[0].args, ['a|b', 'c{d', 'e[f', 'g\\h']);
});

test('hash colour stays one arg', () => {
  assert.deepEqual(ok('{embed:#ec948a}')[0].args, ['#ec948a']);
});

test('text keeps line breaks', () => {
  assert.deepEqual(ok('a\nb {user}\nc'), [
    { t: 'text', v: 'a\nb ' },
    { t: 'call', name: 'user', args: [], pos: 4 },
    { t: 'text', v: '\nc' },
  ]);
});

test('unclosed brace reports its position', () => {
  assert.deepEqual(bad('hi {user'), [{ code: 'UNBALANCED_BRACE', pos: 3 }]);
});

test('stray closing brace is plain text', () => {
  assert.deepEqual(ok('a } b'), [{ t: 'text', v: 'a } b' }]);
});

test('empty braces are EMPTY_NAME', () => {
  assert.equal(bad('x {}')[0].code, 'EMPTY_NAME');
  assert.equal(bad('x {}')[0].pos, 2);
});

test('bad names', () => {
  assert.equal(bad('{bad name}')[0].code, 'BAD_NAME');
  assert.equal(bad('{bad-name:1}')[0].code, 'BAD_NAME');
});

test('trailing backslash', () => {
  assert.deepEqual(bad('abc\\'), [{ code: 'TRAILING_BACKSLASH', pos: 3 }]);
});

test('several errors reported in order', () => {
  const errs = bad('{}  {a b}  \\');
  assert.deepEqual(errs.map((e) => e.code), ['EMPTY_NAME', 'BAD_NAME', 'TRAILING_BACKSLASH']);
  assert.deepEqual(errs.map((e) => e.pos), [0, 4, 11]);
});

test('nested braces are UNBALANCED_BRACE at the inner brace', () => {
  assert.deepEqual(bad('{sendto:{user}}'), [{ code: 'UNBALANCED_BRACE', pos: 8 }]);
});

test('4000 chars of text parses fast', () => {
  const t = Date.now();
  const n = ok('x'.repeat(4000));
  assert.ok(Date.now() - t < 50);
  assert.equal(n[0].v.length, 4000);
});

test('never throws on odd input', () => {
  for (const v of [undefined, null, 5, {}, '\\', '{', '}', '{:', '{a:', '{a:\\']) {
    assert.doesNotThrow(() => parseScript(v));
  }
});

test('error codes are exported', () => {
  assert.deepEqual([...PARSE_ERROR_CODES].sort(), ['BAD_NAME', 'EMPTY_NAME', 'TRAILING_BACKSLASH', 'UNBALANCED_BRACE']);
});
