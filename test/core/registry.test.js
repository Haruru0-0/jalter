import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, isEnabled } from '../../src/core/registry.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

test('FEATURES has unique keys and covers all phase 1 features', () => {
  const keys = FEATURES.map((f) => f.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const k of ['panel', 'language', 'media', 'embeds', 'post', 'welcome', 'autorole', 'logging', 'info']) {
    assert.ok(keys.includes(k), k);
  }
});

test('isEnabled is false by default and true after enabling', async () => {
  assert.equal(await isEnabled(db, 'g1', 'welcome'), false);
  await setFeature(db, 'g1', 'welcome', { enabled: true });
  assert.equal(await isEnabled(db, 'g1', 'welcome'), true);
});
