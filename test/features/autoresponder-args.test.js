import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triggerRemainder, matchRule } from '../../src/features/autoresponder/match.js';
import {
  MAX_ARG_INDEX, parseWords, renderArg, renderArgsInText, checkArgType,
} from '../../src/features/autoresponder/script/args.js';
import { ESCAPED_BRACKET } from '../../src/features/autoresponder/script/parse.js';

const rule = (trigger, matchMode) => ({ id: 1, trigger, matchMode });

test('triggerRemainder for the five modes', () => {
  assert.equal(triggerRemainder(rule('!say', 'startswith'), '!SAY  Hello'), '  Hello');
  assert.equal(triggerRemainder(rule('!say', 'startswith'), '!sayhello'), 'hello');
  assert.equal(triggerRemainder(rule('!say', 'startswith'), '   !say hi'), ' hi');
  assert.equal(triggerRemainder(rule('!say', 'startswith'), 'x !say hi'), null);
  assert.equal(triggerRemainder(rule('hug', 'includes'), 'please HUG sam and hug lee'), ' sam and hug lee');
  assert.equal(triggerRemainder(rule('hug', 'includes'), 'nothing'), null);
  assert.equal(triggerRemainder(rule('!a', 'startswith'), '!a\n\tb\nc'), '\n\tb\nc');
  for (const m of ['exact', 'endswith', 'regex']) assert.equal(triggerRemainder(rule('a', m), 'a b'), null);
});

test('parseWords', () => {
  assert.deepEqual(parseWords('').list, []);
  assert.deepEqual(parseWords(null).list, []);
  assert.equal(parseWords(null).rest(1), '');
  assert.deepEqual(parseWords('  a    b\n\tc ').list, ['a', 'b', 'c']);
  const w = parseWords('  a    b   c ');
  assert.equal(w.rest(1), 'a    b   c');
  assert.equal(w.rest(2), 'b   c');
  assert.equal(w.rest(4), '');
  assert.equal(w.rest(0), '');
  assert.equal(MAX_ARG_INDEX, 20);
});

test('renderArg', () => {
  const w = parseWords(' one  two   three');
  assert.equal(renderArg({ from: 2, to: 2 }, w), 'two');
  assert.equal(renderArg({ from: 5, to: 5 }, w), '');
  assert.equal(renderArg({ from: 2, to: 'end' }, w), 'two   three');
  assert.equal(renderArg({ from: 1, to: 2 }, w), 'one two');
  assert.equal(renderArg({ from: 2, to: 9 }, w), 'two three');
  assert.equal(renderArg({ from: 6, to: 'end' }, w), '');
});

test('renderArgsInText renders tokens and restores escaped brackets', () => {
  const w = parseWords('Sam Lee Kim');
  assert.equal(renderArgsInText('Hi [$1] and [$2+] / [$1-2]', w), 'Hi Sam and Lee Kim / Sam Lee');
  assert.equal(renderArgsInText(`${ESCAPED_BRACKET}$1] [$9] [Note] [$3-2]`, w), '[$1]  [Note] [$3-2]');
});

const U = '123456789012345678';
const C = '223456789012345678';
const R = '323456789012345678';
const guild = {
  members: {
    fetch: async (id) => {
      if (id === U) return { id };
      throw new Error('Unknown Member');
    },
  },
  channels: { cache: new Map([[C, { id: C }]]) },
  roles: { cache: new Map([[R, { id: R }]]) },
};

test('checkArgType', async () => {
  assert.deepEqual(await checkArgType('user', `<@${U}>`, guild), { ok: true, id: U });
  assert.deepEqual(await checkArgType('user', `<@!${U}>`, guild), { ok: true, id: U });
  assert.deepEqual(await checkArgType('user', U, guild), { ok: true, id: U });
  assert.equal((await checkArgType('user', '999999999999999999', guild)).ok, false);
  assert.equal((await checkArgType('user', 'sam', guild)).ok, false);
  assert.deepEqual(await checkArgType('channel', `<#${C}>`, guild), { ok: true, id: C });
  assert.deepEqual(await checkArgType('channel', C, guild), { ok: true, id: C });
  assert.equal((await checkArgType('channel', U, guild)).ok, false);
  assert.deepEqual(await checkArgType('role', `<@&${R}>`, guild), { ok: true, id: R });
  assert.deepEqual(await checkArgType('role', R, guild), { ok: true, id: R });
  assert.equal((await checkArgType('role', C, guild)).ok, false);
  for (const ok of ['-3.5', '12', '0', '-7']) assert.equal((await checkArgType('number', ok, guild)).ok, true, ok);
  for (const bad of ['1,000', 'abc', '1.', '.5', '--1', '1e3']) assert.equal((await checkArgType('number', bad, guild)).ok, false, bad);
  assert.equal((await checkArgType('color', '#aabbcc', guild)).ok, true);
  assert.equal((await checkArgType('color', 'aabbcc', guild)).ok, false);
  assert.equal((await checkArgType('color', '#abc', guild)).ok, false);
  assert.equal((await checkArgType(null, 'x', guild)).ok, true);
  assert.equal((await checkArgType(null, undefined, guild)).ok, false);
  assert.equal((await checkArgType('number', undefined, guild)).ok, false);
});

test('2000 characters / 500 words is fast', () => {
  const rem = 'abc '.repeat(500);
  const t = performance.now();
  const w = parseWords(rem);
  w.rest(250);
  renderArg({ from: 1, to: 'end' }, w);
  assert.equal(w.list.length, 500);
  assert.ok(performance.now() - t < 50);
});

test('triggerRemainder survives case-folding length changes', () => {
  assert.equal(triggerRemainder(rule('hug', 'includes'), 'İİİ hug sam'), ' sam');
  assert.equal(triggerRemainder(rule('hi', 'includes'), 'İhi there'), ' there');
  assert.equal(triggerRemainder(rule('İhi', 'startswith'), 'İHI there'), ' there');
  assert.equal(triggerRemainder(rule('hug', 'includes'), 'İİİ HUG sam'), ' sam');
  assert.equal(triggerRemainder(rule('hug', 'includes'), 'ß ẞ hug sam'), ' sam');
  assert.equal(triggerRemainder(rule('!say', 'startswith'), '!SAY  Hello'), '  Hello');
  assert.equal(triggerRemainder(rule('hug', 'includes'), 'oh HUG you'), ' you');
});

test('triggerRemainder on 2000 characters / 500 words is quick', () => {
  const msg = '!say ' + 'abc '.repeat(499);
  const t = performance.now();
  const r = triggerRemainder(rule('!say', 'startswith'), msg);
  assert.equal(parseWords(r).list.length, 499);
  assert.ok(performance.now() - t < 200);
});

test('triggerRemainder uses the same case fold as the match (final sigma)', () => {
  assert.equal(triggerRemainder(rule('ΟΔΟΣ', 'startswith'), 'ΟΔΟΣ x'), ' x');
  assert.equal(triggerRemainder(rule('ΟΔΟΣ', 'includes'), 'foo ΟΔΟΣ bar'), ' bar');
  assert.equal(triggerRemainder(rule('hug', 'includes'), 'İİİ hug sam'), ' sam');
  assert.equal(triggerRemainder(rule('hi', 'includes'), 'İhi there'), ' there');
});

test('matchRule true implies triggerRemainder non-null for startswith and includes', () => {
  const pieces = ['İ', 'ß', 'ẞ', 'Σ', 'ς', 'σ', 'ŉ', '😀', 'a', 'A', ' '];
  const texts = [];
  for (const a of pieces) for (const b of pieces) texts.push(a + b, `${a} ${b}x`, `${a}${b} tail`);
  const triggers = [...pieces.filter((p) => p !== ' '), 'ΟΔΟΣ', 'iσ', 'İa', 'ßσ'];
  for (const mode of ['startswith', 'includes']) {
    for (const trig of triggers) {
      const r = rule(trig, mode);
      for (const t of texts) {
        if (matchRule(r, t)) {
          assert.notEqual(triggerRemainder(r, t), null, `${mode} ${JSON.stringify(trig)} on ${JSON.stringify(t)}`);
        }
      }
    }
  }
});
