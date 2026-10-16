import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, tokens } from '../../src/features/automod/normalize.js';

test('lowercases and strips accents', () => {
  assert.equal(normalizeText('Ĥéĺĺó'), 'hello');
});

test('maps simple letter swaps', () => {
  assert.equal(normalizeText('h3ll0'), 'hello');
  assert.equal(normalizeText('$pam'), 'spam');
});

test('collapses 3+ repeated characters to 2', () => {
  assert.equal(normalizeText('heeeello'), 'heello');
});

test('collapses whitespace', () => {
  assert.equal(normalizeText('  a \n\t b   c '), 'a b c');
});

test('keeps Arabic letters and removes Arabic diacritics', () => {
  assert.equal(normalizeText('مَرْحَبًا'), 'مرحبا');
});

test('empty and non-string input return empty string', () => {
  assert.equal(normalizeText(''), '');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
  assert.equal(normalizeText(42), '');
});

test('tokens splits on punctuation', () => {
  assert.deepEqual(tokens('Hello, w0rld!! foo-bar'), ['hello', 'world', 'foo', 'bar']);
  assert.deepEqual(tokens('...'), []);
  assert.deepEqual(tokens(null), []);
});

test('strips zero-width characters, soft hyphen and tatweel', () => {
  assert.equal(normalizeText('fu​ck'), 'fuck');
  assert.equal(normalizeText('f­uck'), 'fuck');
  assert.equal(normalizeText('fu‍⁠﻿ck'), 'fuck');
  assert.equal(normalizeText('ـلعـين'), 'لعين');
  assert.deepEqual(tokens('sh​it now'), ['shit', 'now']);
});

test('real Arabic text and long input still normalise', () => {
  assert.equal(normalizeText('مرحبا بكم'), 'مرحبا بكم');
  assert.equal(normalizeText('a'.repeat(4000)), 'aa');
});
