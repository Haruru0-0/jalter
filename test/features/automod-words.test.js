import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveWords, findBadWord } from '../../src/features/automod/detect-words.js';
import { BUILTIN_WORDS } from '../../src/features/automod/words-default.js';

const cfg = (o = {}) => ({ custom: [], removedBuiltin: [], useBuiltin: true, ...o });

test('matches whole words only', () => {
  assert.equal(findBadWord('what a class', ['ass']), null);
  assert.equal(findBadWord('you ass!', ['ass']), 'ass');
});

test('ignores case, accents and letter swaps', () => {
  assert.equal(findBadWord('YOU ARE A B4STARD', ['bastard']), 'bastard');
  assert.equal(findBadWord('quel enculé', ['encule']), 'encule');
  assert.equal(findBadWord('shiiiit', ['shit']), 'shit');
  assert.equal(findBadWord('quel CONNARD', ['Connàrd']), 'Connàrd');
});

test('matches a phrase', () => {
  assert.equal(findBadWord('please go away now', ['go away']), 'go away');
  assert.equal(findBadWord('go and away', ['go away']), null);
});

test('matches an Arabic word as a substring', () => {
  assert.equal(findBadWord('أنت حمارٌ كبير', ['حمار']), 'حمار');
  assert.equal(findBadWord('مرحبا بالجميع', ['حمار']), null);
});

test('removedBuiltin removes a builtin word', () => {
  const word = BUILTIN_WORDS.en[0];
  assert.ok(effectiveWords(cfg()).includes(word));
  assert.ok(!effectiveWords(cfg({ removedBuiltin: [word.toUpperCase()] })).includes(word));
});

test('useBuiltin false uses custom only', () => {
  assert.deepEqual(effectiveWords(cfg({ useBuiltin: false, custom: ['Foo', 'foo', 'bar'] })), ['foo', 'bar']);
});

test('builtin lists are about ten entries per language, Arabic at 4+ letters', () => {
  for (const l of ['en', 'fr', 'ar']) assert.ok(BUILTIN_WORDS[l].length >= 8 && BUILTIN_WORDS[l].length <= 15);
  for (const w of BUILTIN_WORDS.ar) assert.ok([...w].length >= 4, w);
});

test('empty text and empty list return null', () => {
  assert.equal(findBadWord('', ['ass']), null);
  assert.equal(findBadWord('hello', []), null);
  assert.equal(findBadWord(undefined, undefined), null);
  assert.equal(findBadWord('x'.repeat(4000), effectiveWords(cfg())), null);
});

test('detects stretched spellings', () => {
  assert.equal(findBadWord('shiiiit', ['shit']), 'shit');
  assert.equal(findBadWord('baaastard', ['bastard']), 'bastard');
  assert.equal(findBadWord('fuuuuck', ['fuck']), 'fuck');
  assert.equal(findBadWord('أنت حمااااار', ['حمار']), 'حمار');
  assert.equal(findBadWord('go awaaaay', ['go away']), 'go away');
});

test('squeeze does not cause false positives', () => {
  assert.equal(findBadWord('as', ['ass']), null);
  assert.equal(findBadWord('class', ['ass']), null);
  assert.equal(findBadWord('you asshole', ['asshole']), 'asshole');
});

test('4000-char input with a 300-word list is fast', () => {
  const words = Array.from({ length: 300 }, (_, i) => 'word' + String.fromCharCode(97 + (i % 26)) + i + 'x');
  const text = 'hello aaaa world '.repeat(235);
  const t = process.hrtime.bigint();
  assert.equal(findBadWord(text, words), null);
  assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 50);
});

test('zero-width, soft hyphen and tatweel do not evade the filter', () => {
  assert.equal(findBadWord('you sh​it', ['shit']), 'shit');
  assert.equal(findBadWord('you s­hit', ['shit']), 'shit');
  assert.equal(findBadWord('ـحـقـير', ['حقير']), 'حقير');
});

test('the built-in Arabic list does not flag the innocent word لعينيك', () => {
  assert.equal(findBadWord('ما أجمل الدنيا لعينيك', BUILTIN_WORDS.ar), null);
});
