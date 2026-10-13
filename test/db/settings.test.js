import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../src/db/index.js';
import { getFeature, setFeature, listFeatures } from '../../src/db/settings.js';
import { testDb, TEST_DB_URL } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

test('getFeature on an empty db is disabled with empty config', async () => {
  assert.deepEqual(await getFeature(db, 'g1', 'welcome'), { enabled: false, config: {} });
});

test('setFeature enables a feature', async () => {
  await setFeature(db, 'g1', 'welcome', { enabled: true });
  assert.equal((await getFeature(db, 'g1', 'welcome')).enabled, true);
});

test('setFeature merges config across calls', async () => {
  await setFeature(db, 'g1', 'x', { config: { a: 1 } });
  await setFeature(db, 'g1', 'x', { config: { b: 2 } });
  assert.deepEqual((await getFeature(db, 'g1', 'x')).config, { a: 1, b: 2 });
});

test('setFeature without enabled keeps the existing enabled value', async () => {
  await setFeature(db, 'g1', 'x', { enabled: true });
  await setFeature(db, 'g1', 'x', { config: { a: 1 } });
  assert.equal((await getFeature(db, 'g1', 'x')).enabled, true);
});

test('guilds do not leak into each other', async () => {
  await setFeature(db, 'g1', 'x', { enabled: true });
  assert.equal((await getFeature(db, 'g2', 'x')).enabled, false);
});

test('parallel setFeature calls keep both keys', async () => {
  await Promise.all([
    setFeature(db, 'g1', 'x', { config: { a: 1 } }),
    setFeature(db, 'g1', 'x', { config: { b: 2 } }),
  ]);
  assert.deepEqual((await getFeature(db, 'g1', 'x')).config, { a: 1, b: 2 });
});

test('listFeatures returns a map of all features for a guild', async () => {
  await setFeature(db, 'g1', 'a', { enabled: true });
  await setFeature(db, 'g1', 'b', { config: { k: 1 } });
  const map = await listFeatures(db, 'g1');
  assert.equal(map.get('a').enabled, true);
  assert.deepEqual(map.get('b').config, { k: 1 });
});

test('openDb twice does not re-apply migrations', async () => {
  const again = await openDb(TEST_DB_URL);
  const { rows } = await again.query('SELECT count(*)::int AS n FROM schema_version');
  assert.equal(rows[0].n, 1);
  await again.end();
});
