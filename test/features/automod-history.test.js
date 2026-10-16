import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { addHistory, listHistory } from '../../src/features/automod/history.js';

let db;
before(async () => {
  db = await testDb();
});
after(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetDb(db);
});

const entry = (over = {}) => ({
  guildId: 'g1',
  userId: 'u1',
  rules: ['spam'],
  messageId: 'm1',
  actions: ['delete'],
  caseNumber: null,
  ...over,
});

test('adds and lists newest first', async () => {
  await addHistory(db, entry({ messageId: 'a' }));
  await addHistory(db, entry({ messageId: 'b', rules: ['links', 'caps'], caseNumber: 4 }));
  const rows = await listHistory(db, 'g1', {});
  assert.equal(rows.length, 2);
  assert.equal(rows[0].messageId, 'b');
  assert.deepEqual(rows[0].rules, ['links', 'caps']);
  assert.deepEqual(rows[0].actions, ['delete']);
  assert.equal(rows[0].caseNumber, 4);
  assert.equal(rows[0].userId, 'u1');
  assert.ok(rows[0].createdAt instanceof Date);
  assert.equal(rows[1].messageId, 'a');
  assert.equal(rows[1].caseNumber, null);
});

test('filters by user', async () => {
  await addHistory(db, entry({ userId: 'u1' }));
  await addHistory(db, entry({ userId: 'u2', messageId: null }));
  const rows = await listHistory(db, 'g1', { userId: 'u2' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, 'u2');
  assert.equal(rows[0].messageId, null);
});

test('keeps only the newest 200 rows per guild', async () => {
  for (let i = 0; i < 205; i++) await addHistory(db, entry({ messageId: `m${i}` }));
  const rows = await listHistory(db, 'g1', { limit: 500 });
  assert.equal(rows.length, 200);
  const ids = new Set(rows.map((r) => r.messageId));
  for (let i = 0; i < 5; i++) assert.ok(!ids.has(`m${i}`));
  assert.ok(ids.has('m5'));
  assert.ok(ids.has('m204'));
});

test('guilds are separate', async () => {
  await addHistory(db, entry({ guildId: 'g1' }));
  await addHistory(db, entry({ guildId: 'g2' }));
  assert.equal((await listHistory(db, 'g1', {})).length, 1);
  assert.equal((await listHistory(db, 'g2', {})).length, 1);
});
