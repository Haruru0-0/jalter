import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { t, createT, getLang, isRtl } from '../src/i18n/index.js';
import { setFeature } from '../src/db/settings.js';
import { testDb } from './helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

test('t returns each language', () => {
  assert.equal(t('en', 'common.on'), 'On');
  assert.equal(t('fr', 'common.on'), 'Activé');
  assert.equal(t('ar', 'common.on'), 'مفعّل');
});

test('missing translation falls back to English, then to the key', () => {
  const tt = createT({ en: { only: 'English only' }, ar: {}, fr: {} });
  assert.equal(tt('ar', 'only'), 'English only');
  assert.equal(tt('ar', 'nope'), 'nope');
});

test('placeholders are substituted, unknown ones kept', () => {
  const tt = createT({ en: { k: 'Hi {name} {other}' }, ar: {}, fr: {} });
  assert.equal(tt('en', 'k', { name: 'Sam' }), 'Hi Sam {other}');
});

test('getLang defaults to en and reads the saved language', async () => {
  assert.equal(await getLang(db, 'g1'), 'en');
  await setFeature(db, 'g1', 'language', { config: { lang: 'fr' } });
  assert.equal(await getLang(db, 'g1'), 'fr');
  await setFeature(db, 'g2', 'language', { config: { lang: 'xx' } });
  assert.equal(await getLang(db, 'g2'), 'en');
});

test('isRtl is true only for Arabic', () => {
  assert.equal(isRtl('ar'), true);
  assert.equal(isRtl('en'), false);
});

test('ar.json and fr.json contain every key in en.json', () => {
  const load = (l) => JSON.parse(readFileSync(new URL(`../src/i18n/${l}.json`, import.meta.url), 'utf8'));
  const en = Object.keys(load('en'));
  for (const lang of ['ar', 'fr']) {
    const keys = new Set(Object.keys(load(lang)));
    const missing = en.filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${lang}.json is missing keys`);
  }
});
