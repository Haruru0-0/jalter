import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { testDb } from '../helpers/db.js';

let db;
let sql;
before(async () => {
  db = await testDb();
  sql = await readFile(new URL('../../src/db/migrations/005_autorole_to_scheduler.sql', import.meta.url), 'utf8');
});
beforeEach(async () => {
  await db.query('DROP TABLE IF EXISTS pending_roles');
  await db.query('TRUNCATE scheduled_jobs');
  await db.query(`CREATE TABLE pending_roles (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL, due_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (guild_id, user_id, role_id))`);
});
after(async () => { await db.query('DROP TABLE IF EXISTS pending_roles'); await db.end(); });

const tableExists = async () =>
  (await db.query("SELECT to_regclass('public.pending_roles') AS t")).rows[0].t !== null;

test('005 moves pending_roles rows into scheduled_jobs and drops the table', async () => {
  await db.query(`INSERT INTO pending_roles VALUES
    ('g1', 'u1', 'r1', '2026-01-01T10:00:00Z'), ('g2', 'u2', 'r2', '2026-02-02T11:30:00Z')`);
  await db.query(sql);
  const { rows } = await db.query(
    'SELECT guild_id, type, key, payload, due_at, attempts FROM scheduled_jobs ORDER BY guild_id');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.guild_id, r.type, r.key, r.payload]), [
    ['g1', 'autorole.grant', 'u1:r1', { userId: 'u1', roleId: 'r1' }],
    ['g2', 'autorole.grant', 'u2:r2', { userId: 'u2', roleId: 'r2' }],
  ]);
  assert.equal(rows[0].due_at.toISOString(), '2026-01-01T10:00:00.000Z');
  assert.equal(rows[1].due_at.toISOString(), '2026-02-02T11:30:00.000Z');
  assert.equal(rows[0].attempts, 0);
  assert.equal(await tableExists(), false);
});

test('005 tolerates an empty pending_roles', async () => {
  await db.query(sql);
  assert.equal((await db.query('SELECT * FROM scheduled_jobs')).rows.length, 0);
  assert.equal(await tableExists(), false);
});
