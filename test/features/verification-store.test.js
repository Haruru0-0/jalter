import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordOriginal, getRecord, listRecords, deleteRecord, countRecords,
} from '../../src/features/verification/store.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE verification_overwrites'); });
after(async () => { await db.end(); });

const ov = (allow, deny) => ({ existed: true, allow, deny });

test('recordOriginal inserts once and keeps the first record', async () => {
  const inserted = await recordOriginal(db, 'g1', 'c1', {
    everyone: ov('1024', '2048'), verified: null, bot: ov('8', '0'),
  });
  assert.equal(inserted, true);
  const rec = await getRecord(db, 'g1', 'c1');
  assert.deepEqual(rec.everyone, ov('1024', '2048'));
  assert.equal(rec.verified, null);
  assert.deepEqual(rec.bot, ov('8', '0'));
  assert.equal(await countRecords(db, 'g1'), 1);
});

test('a second call returns false and changes nothing', async () => {
  await recordOriginal(db, 'g1', 'c1', { everyone: ov('1', '2'), verified: null, bot: null });
  const again = await recordOriginal(db, 'g1', 'c1', { everyone: ov('9', '9'), verified: ov('1', '1'), bot: null });
  assert.equal(again, false);
  const rec = await getRecord(db, 'g1', 'c1');
  assert.deepEqual(rec.everyone, ov('1', '2'));
  assert.equal(rec.verified, null);
});

test('existed false round-trips', async () => {
  const none = { existed: false, allow: '0', deny: '0' };
  await recordOriginal(db, 'g1', 'c1', { everyone: none, verified: none, bot: null });
  const rec = await getRecord(db, 'g1', 'c1');
  assert.deepEqual(rec.everyone, none);
  assert.deepEqual(rec.verified, none);
  assert.equal(await getRecord(db, 'g1', 'missing'), null);
});

test('listRecords is per guild', async () => {
  await recordOriginal(db, 'g1', 'c1', { everyone: null, verified: null, bot: null });
  await recordOriginal(db, 'g1', 'c2', { everyone: null, verified: null, bot: null });
  await recordOriginal(db, 'g2', 'c3', { everyone: null, verified: null, bot: null });
  const rows = await listRecords(db, 'g1');
  assert.deepEqual(rows.map((r) => r.channelId).sort(), ['c1', 'c2']);
  assert.equal(await countRecords(db, 'g1'), 2);
  assert.equal(await countRecords(db, 'g2'), 1);
});

test('deleteRecord removes one', async () => {
  await recordOriginal(db, 'g1', 'c1', { everyone: null, verified: null, bot: null });
  await recordOriginal(db, 'g1', 'c2', { everyone: null, verified: null, bot: null });
  await deleteRecord(db, 'g1', 'c1');
  assert.equal(await getRecord(db, 'g1', 'c1'), null);
  assert.equal(await countRecords(db, 'g1'), 1);
});
