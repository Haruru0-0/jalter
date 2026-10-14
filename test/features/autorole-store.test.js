import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  queueRole, cancelRole, rememberRoles, takeRemembered, forgetRoles, purgeOld,
} from '../../src/features/autorole/store.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE scheduled_jobs, remembered_roles'); });
after(async () => { await db.end(); });

const count = async (table) => Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

const jobs = async () => (await db.query(
  "SELECT guild_id, key, payload, due_at FROM scheduled_jobs WHERE type = 'autorole.grant'")).rows;

test('queueRole twice keeps one row with the new due time', async () => {
  await queueRole(db, 'g1', 'u1', 'r1', 1000);
  await queueRole(db, 'g1', 'u1', 'r1', 5000);
  const rows = await jobs();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'u1:r1');
  assert.deepEqual(rows[0].payload, { userId: 'u1', roleId: 'r1' });
  assert.equal(rows[0].due_at.getTime(), 5000);
});

test('cancelRole removes only that role in that guild', async () => {
  await queueRole(db, 'g1', 'u1', 'r1', 1000);
  await queueRole(db, 'g1', 'u2', 'r1', 1000);
  await queueRole(db, 'g1', 'u1', 'r2', 1000);
  await queueRole(db, 'g2', 'u1', 'r1', 1000);
  assert.equal(await cancelRole(db, 'g1', 'r1'), 2);
  assert.equal((await jobs()).length, 2);
});

test('rememberRoles then takeRemembered returns the ids once', async () => {
  await rememberRoles(db, 'g1', 'u1', ['a', 'b'], 1000);
  assert.deepEqual(await takeRemembered(db, 'g1', 'u1', 2000, 5000), ['a', 'b']);
  assert.deepEqual(await takeRemembered(db, 'g1', 'u1', 2000, 5000), []);
});

test('rememberRoles upserts and allows an empty list', async () => {
  await rememberRoles(db, 'g1', 'u1', ['a'], 1000);
  await rememberRoles(db, 'g1', 'u1', [], 1500);
  assert.equal(await count('remembered_roles'), 1);
  assert.deepEqual(await takeRemembered(db, 'g1', 'u1', 2000, 5000), []);
});

test('takeRemembered gives [] and deletes a row older than maxAgeMs', async () => {
  await rememberRoles(db, 'g1', 'u1', ['a'], 1000);
  assert.deepEqual(await takeRemembered(db, 'g1', 'u1', 7000, 5000), []);
  assert.equal(await count('remembered_roles'), 0);
});

test('purgeOld removes only the old rows', async () => {
  await rememberRoles(db, 'g1', 'old', ['a'], 1000);
  await rememberRoles(db, 'g1', 'new', ['b'], 9000);
  assert.equal(await purgeOld(db, 10000, 5000), 1);
  assert.deepEqual(await takeRemembered(db, 'g1', 'new', 10000, 5000), ['b']);
});

test('forgetRoles deletes only that member in that guild', async () => {
  await rememberRoles(db, 'g1', 'u1', ['a'], 1000);
  await rememberRoles(db, 'g1', 'u2', ['b'], 1000);
  await rememberRoles(db, 'g2', 'u1', ['c'], 1000);
  await forgetRoles(db, 'g1', 'u1');
  await forgetRoles(db, 'g1', 'nobody');
  assert.equal(await count('remembered_roles'), 2);
  assert.deepEqual(await takeRemembered(db, 'g1', 'u2', 2000, 5000), ['b']);
  assert.deepEqual(await takeRemembered(db, 'g2', 'u1', 2000, 5000), ['c']);
});

test('rows of two guilds do not mix', async () => {
  await rememberRoles(db, 'g1', 'u1', ['a'], 1000);
  await rememberRoles(db, 'g2', 'u1', ['b'], 1000);
  assert.deepEqual(await takeRemembered(db, 'g2', 'u1', 2000, 5000), ['b']);
  assert.deepEqual(await takeRemembered(db, 'g1', 'u1', 2000, 5000), ['a']);
});
