import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript, ESCAPED_BRACKET } from '../../src/features/autoresponder/script/parse.js';

const nodes = (s) => {
  const r = parseScript(s);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.nodes;
};
const text = (v) => ({ t: 'text', v });

test('arg tokens', () => {
  assert.deepEqual(nodes('[$1]'), [{ t: 'arg', from: 1, to: 1, pos: 0, raw: '[$1]' }]);
  assert.deepEqual(nodes('[$2+]'), [{ t: 'arg', from: 2, to: 'end', pos: 0, raw: '[$2+]' }]);
  assert.deepEqual(nodes('a [$1-3]!'), [
    text('a '), { t: 'arg', from: 1, to: 3, pos: 2, raw: '[$1-3]' }, text('!'),
  ]);
  assert.equal(nodes('[$20]')[0].from, 20);
});

test('random tokens', () => {
  assert.deepEqual(nodes('[range]'), [{ t: 'rand', kind: 'range', n: 1, pos: 0, raw: '[range]' }]);
  assert.deepEqual(nodes('[range2]')[0], { t: 'rand', kind: 'range', n: 2, pos: 0, raw: '[range2]' });
  assert.equal(nodes('[choice]')[0].kind, 'choice');
  assert.deepEqual(nodes('x[lockedchoice4]')[1], { t: 'rand', kind: 'lockedchoice', n: 4, pos: 1, raw: '[lockedchoice4]' });
});

test('anything else in brackets stays text', () => {
  for (const s of ['[Note]', '[$0]', '[$21]', '[range5]', '[range1]', '[$3-2]', '[]', '[ $1]', '[$1', '[$', '[', '[$99999999999]', '[Range]']) {
    assert.deepEqual(nodes(s), [text(s)], s);
  }
});

test('escaped brackets are never tokens', () => {
  assert.deepEqual(nodes('\\[$1]'), [text('[$1]')]);
  assert.deepEqual(nodes('\\[range]'), [text('[range]')]);
  assert.deepEqual(nodes('\\[[$1]'), [text('['), { t: 'arg', from: 1, to: 1, pos: 2, raw: '[$1]' }]);
});

test('a token between text and a call', () => {
  assert.deepEqual(nodes('Hi [$1]{cooldown:5}'), [
    text('Hi '),
    { t: 'arg', from: 1, to: 1, pos: 3, raw: '[$1]' },
    { t: 'call', name: 'cooldown', args: ['5'], pos: 7 },
  ]);
});

test('call arguments keep brackets plain; escaped brackets use the sentinel', () => {
  assert.equal(ESCAPED_BRACKET, '');
  assert.deepEqual(nodes('{setnick:Hi [$1]}')[0].args, ['Hi [$1]']);
  assert.deepEqual(nodes('{setnick:Hi \\[$1]}')[0].args, [`Hi ${ESCAPED_BRACKET}$1]`]);
});

test('the parser never throws on odd brackets', () => {
  for (const s of ['[', '[$', '[$1', '[$99999999999]', '{a:[}', '{a:[$1', '\\[', '[[[$1]']) {
    assert.doesNotThrow(() => parseScript(s));
  }
});

test('parsing 4000 characters of brackets is fast', () => {
  const src = '[$1] [x [range] \\[ [$2-3] '.repeat(160).slice(0, 4000);
  const t = performance.now();
  parseScript(src);
  assert.ok(performance.now() - t < 50);
});
