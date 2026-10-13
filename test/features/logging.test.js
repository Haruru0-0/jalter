import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendLog } from '../../src/features/logging/index.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

function ctxWith(send) {
  const channel = { isTextBased: () => true, send };
  return { db, client: { channels: { fetch: async () => channel } } };
}
const embed = { title: 't' };
const logCfg = { channels: { messages: 'LOG', members: 'LOG2' } };

test('sends to the category channel', async () => {
  const sent = [];
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messages', embed, 'other');
  assert.equal(sent.length, 1);
});

test('ignores events that happen inside a log channel (no feedback loop)', async () => {
  const sent = [];
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messages', embed, 'LOG');
  assert.equal(sent.length, 0);
});

test('does nothing when logging is off or the category is unset', async () => {
  const sent = [];
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messages', embed, 'x');
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'server', embed, 'x');
  assert.equal(sent.length, 0);
});

test('a failing send does not throw', async () => {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async () => { throw new Error('Missing Permissions'); }), 'g1', 'messages', embed, 'x');
});

test('a deleted log channel does not throw', async () => {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  const ctx = { db, client: { channels: { fetch: async () => { throw new Error('Unknown Channel'); } } } };
  await sendLog(ctx, 'g1', 'messages', embed, 'x');
});

test('a database failure does not throw', async () => {
  const ctx = { db: { query: async () => { throw new Error('db down'); } }, client: {} };
  await sendLog(ctx, 'g1', 'messages', embed, 'x');
});
