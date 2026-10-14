import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { timeoutTransition } from '../../src/features/logging/format.js';
import { events } from '../../src/features/logging/handlers-members.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

const handler = (name) => events.find((e) => e.name === name).execute;
const NOW = 1_000_000;

test('timeoutTransition covers each case', () => {
  assert.equal(timeoutTransition(null, NOW + 5000, NOW), 'timeout');
  assert.equal(timeoutTransition(NOW + 5000, null, NOW), 'timeoutRemoved');
  assert.equal(timeoutTransition(NOW - 5000, null, NOW), null);
  assert.equal(timeoutTransition(NOW + 5000, NOW + 9000, NOW), 'timeout');
  assert.equal(timeoutTransition(null, null, NOW), null);
  assert.equal(timeoutTransition(NOW + 5000, NOW + 5000, NOW), null);
  assert.equal(timeoutTransition(NOW + 5000, NOW - 1, NOW), 'timeoutRemoved');
});

function ctxWith(sent, guilds) {
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(p); } };
  return { db, client: { guilds: { cache: new Map(guilds) }, channels: { fetch: async () => channel } } };
}
const enable = (id) => setFeature(db, id, 'logging', { enabled: true, config: { channels: { default: 'LOG' } } });
const guild = (id, hasMember) => [id, { id, members: { cache: { has: () => hasMember } }, fetchAuditLogs: async () => { throw new Error('no'); } }];

test('UserUpdate avatar change logs only in guilds caching the member', async () => {
  const sent = [];
  await enable('g1'); await enable('g2');
  const ctx = ctxWith(sent, [guild('g1', true), guild('g2', false)]);
  await handler('userUpdate')(ctx, { id: 'u1', avatar: 'a', username: 'sam' }, { id: 'u1', avatar: 'b', username: 'sam' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].description, /u1/);
});

test('UserUpdate username change logs a name change; no change logs nothing', async () => {
  const sent = [];
  await enable('g1');
  const ctx = ctxWith(sent, [guild('g1', true)]);
  await handler('userUpdate')(ctx, { id: 'u1', avatar: 'a', username: 'sam' }, { id: 'u1', avatar: 'a', username: 'samuel' });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].embeds[0].fields.some((f) => f.value === 'samuel'));
  await handler('userUpdate')(ctx, { id: 'u1', avatar: 'a', username: 'sam' }, { id: 'u1', avatar: 'a', username: 'sam' });
  assert.equal(sent.length, 1);
});

test('ban and unban log the user without audit permission', async () => {
  const sent = [];
  await enable('g1');
  const ctx = ctxWith(sent, []);
  const g = guild('g1', true)[1];
  await handler('guildBanAdd')(ctx, { guild: g, user: { id: 'u1', username: 'sam' }, partial: false });
  await handler('guildBanRemove')(ctx, { guild: g, user: { id: 'u1', username: 'sam' }, partial: false });
  assert.equal(sent.length, 2);
});

test('timeout set in GuildMemberUpdate logs with end time', async () => {
  const sent = [];
  await enable('g1');
  const ctx = ctxWith(sent, []);
  const g = guild('g1', true)[1];
  const mk = (ts) => ({ partial: false, guild: g, nickname: null, avatar: null, communicationDisabledUntilTimestamp: ts, user: { id: 'u1' }, roles: { cache: new Map() } });
  await handler('guildMemberUpdate')(ctx, mk(null), mk(Date.now() + 60_000));
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].fields.map((f) => f.value).join(' '), /<t:\d+:F>/);
});
