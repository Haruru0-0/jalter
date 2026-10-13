import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { assignAutoRole } from '../../src/features/autorole/index.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

const member = (bot, fail = false) => {
  const added = [];
  return {
    added,
    guild: { id: 'g1' },
    user: { bot },
    roles: { add: async (id) => { if (fail) throw new Error('Missing Permissions'); added.push(id); } },
  };
};

const config = { humanRoleId: 'H', botRoleId: 'B' };

test('a human gets the human role', async () => {
  await setFeature(db, 'g1', 'autorole', { enabled: true, config });
  const m = member(false);
  await assignAutoRole({ db }, m);
  assert.deepEqual(m.added, ['H']);
});

test('a bot gets the bot role only', async () => {
  await setFeature(db, 'g1', 'autorole', { enabled: true, config });
  const m = member(true);
  await assignAutoRole({ db }, m);
  assert.deepEqual(m.added, ['B']);
});

test('nothing is added when the feature is off or the role is unset', async () => {
  const m = member(false);
  await assignAutoRole({ db }, m);
  await setFeature(db, 'g1', 'autorole', { enabled: true, config: { botRoleId: 'B' } });
  await assignAutoRole({ db }, m);
  assert.deepEqual(m.added, []);
});

test('a failed role add does not throw', async () => {
  await setFeature(db, 'g1', 'autorole', { enabled: true, config });
  await assignAutoRole({ db }, member(false, true));
});
