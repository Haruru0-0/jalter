import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendLog } from '../../src/features/logging/send-log.js';
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
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messageDelete', embed, { sourceChannelId: 'other' });
  assert.equal(sent.length, 1);
});

test('ignores events that happen inside a log channel (no feedback loop)', async () => {
  const sent = [];
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messageDelete', embed, { sourceChannelId: 'LOG' });
  assert.equal(sent.length, 0);
});

test('does nothing when logging is off or the category is unset', async () => {
  const sent = [];
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'roleCreate', embed, { sourceChannelId: 'x' });
  assert.equal(sent.length, 0);
});

test('a failing send does not throw', async () => {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctxWith(async () => { throw new Error('Missing Permissions'); }), 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
});

test('a deleted log channel does not throw', async () => {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  const ctx = { db, client: { channels: { fetch: async () => { throw new Error('Unknown Channel'); } } } };
  await sendLog(ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
});

test('a database failure does not throw', async () => {
  const ctx = { db: { query: async () => { throw new Error('db down'); } }, client: {} };
  await sendLog(ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
});

test('an event listed in disabledEvents sends nothing', async () => {
  const sent = [];
  await setFeature(db, 'g1', 'logging', { enabled: true, config: { ...logCfg, disabledEvents: ['messageDelete'] } });
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messageDelete', embed);
  await sendLog(ctxWith(async (p) => { sent.push(p); }), 'g1', 'messageEdit', embed);
  assert.equal(sent.length, 1);
});

test('memberJoin falls back to the members channel', async () => {
  const fetched = [];
  const channel = { isTextBased: () => true, send: async () => {} };
  const ctx = { db, client: { channels: { fetch: async (id) => { fetched.push(id); return channel; } } } };
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  await sendLog(ctx, 'g1', 'memberJoin', embed);
  assert.deepEqual(fetched, ['LOG2']);
});

test('an unset category falls back to the default channel', async () => {
  const fetched = [];
  const channel = { isTextBased: () => true, send: async () => {} };
  const ctx = { db, client: { channels: { fetch: async (id) => { fetched.push(id); return channel; } } } };
  await setFeature(db, 'g1', 'logging', { enabled: true, config: { channels: { default: 'DEF' } } });
  await sendLog(ctx, 'g1', 'voiceJoin', embed);
  assert.deepEqual(fetched, ['DEF']);
});

test('an ignore hit sends nothing', async () => {
  const sent = [];
  const cfg = { ...logCfg, ignore: { channels: ['C1'], members: ['U1'], prefixes: ['!'] } };
  await setFeature(db, 'g1', 'logging', { enabled: true, config: cfg });
  const ctx = ctxWith(async (p) => { sent.push(p); });
  await sendLog(ctx, 'g1', 'messageDelete', embed, { ignore: { channelId: 'C1' } });
  await sendLog(ctx, 'g1', 'messageDelete', embed, { ignore: { userId: 'U1' } });
  await sendLog(ctx, 'g1', 'messageDelete', embed, { ignore: { content: '!ping' } });
  assert.equal(sent.length, 0);
  await sendLog(ctx, 'g1', 'messageDelete', embed, { ignore: { channelId: 'C2', userId: 'U2', content: 'hi' } });
  assert.equal(sent.length, 1);
});

test('sendLog returns channelId and messageId of the posted message', async () => {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  const ctx = ctxWith(async () => ({ id: 'M1', channelId: 'LOG' }));
  const res = await sendLog(ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  assert.deepEqual(res, { channelId: 'LOG', messageId: 'M1' });
});

test('sendLog returns null when logging is off, the event is disabled, no channel resolves, or sending fails', async () => {
  const ok = async () => ({ id: 'M1', channelId: 'LOG' });
  assert.equal(await sendLog(ctxWith(ok), 'g1', 'messageDelete', embed), null);
  await setFeature(db, 'g1', 'logging', { enabled: true, config: { ...logCfg, disabledEvents: ['messageDelete'] } });
  assert.equal(await sendLog(ctxWith(ok), 'g1', 'messageDelete', embed), null);
  await setFeature(db, 'g1', 'logging', { enabled: true, config: logCfg });
  assert.equal(await sendLog(ctxWith(ok), 'g1', 'roleCreate', embed), null);
  const failing = async () => { throw new Error('Missing Permissions'); };
  assert.equal(await sendLog(ctxWith(failing), 'g1', 'messageDelete', embed), null);
});

test('modAction posts to the mod channel', async () => {
  await setFeature(db, 'g1', 'logging', { enabled: true, config: { channels: { mod: 'MODCH', default: 'DEF' } } });
  const fetched = [];
  const channel = { isTextBased: () => true, send: async () => ({ id: 'M2', channelId: 'MODCH' }) };
  const ctx = { db, client: { channels: { fetch: async (id) => { fetched.push(id); return channel; } } } };
  const res = await sendLog(ctx, 'g1', 'modAction', embed);
  assert.deepEqual(fetched, ['MODCH']);
  assert.deepEqual(res, { channelId: 'MODCH', messageId: 'M2' });
});
