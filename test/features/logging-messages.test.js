import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';
import { formatPurge, formatInvite } from '../../src/features/logging/format.js';
import { events, INVITE_RE } from '../../src/features/logging/handlers-messages.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

const handler = (name) => events.find((e) => e.name === name).execute;

function ctxWith(sent) {
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(p); } };
  return { db, client: { channels: { fetch: async () => channel } } };
}
const enable = () => setFeature(db, 'g1', 'logging', { enabled: true, config: { channels: { messages: 'LOG' } } });

test('formatPurge shows the count in a field', () => {
  const e = formatPurge(7, 'c1', 'en');
  assert.match(e.title, /purge/i);
  assert.match(e.description, /c1/);
  assert.ok(e.fields.some((f) => f.value === '7'));
});

test('formatInvite shows author, channel and jump link', () => {
  const e = formatInvite({
    author: { username: 'Sam', id: 'u1' }, channelId: 'c1', url: 'https://discord.com/x', content: 'join discord.gg/abc',
  }, 'en');
  assert.match(e.description, /Sam/);
  assert.match(e.description, /c1/);
  assert.match(e.description, /https:\/\/discord\.com\/x/);
  assert.ok(e.fields.some((f) => f.value.includes('discord.gg/abc')));
});

test('invite regex matches invites, not a bare domain', () => {
  assert.ok(INVITE_RE.test('discord.gg/abc'));
  assert.ok(INVITE_RE.test('https://discord.com/invite/abc'));
  assert.ok(INVITE_RE.test('discordapp.com/invite/abc'));
  assert.ok(!INVITE_RE.test('discord.gg'));
});

test('messages without a guild are ignored', async () => {
  const sent = [];
  await enable();
  await handler('messageCreate')(ctxWith(sent), { content: 'discord.gg/abc', author: { bot: false, id: 'u' }, channelId: 'c' });
  assert.equal(sent.length, 0);
});

test('invite posted by a member is logged, by a bot is not', async () => {
  const sent = [];
  await enable();
  const base = { guildId: 'g1', channelId: 'c1', content: 'x discord.gg/abc', url: 'u' };
  await handler('messageCreate')(ctxWith(sent), { ...base, author: { bot: false, id: 'u', username: 'S' } });
  await handler('messageCreate')(ctxWith(sent), { ...base, author: { bot: true, id: 'b', username: 'B' } });
  assert.equal(sent.length, 1);
});

test('purge of an empty cache still logs the count', async () => {
  const sent = [];
  await enable();
  await handler('messageDeleteBulk')(ctxWith(sent), new Collection(), { id: 'c1', guildId: 'g1' });
  assert.equal(sent.length, 1);
});

test('messageDelete adds a By field from the audit log, skips lookup when uncached', async () => {
  const sent = [];
  await enable();
  let calls = 0;
  const guild = {
    fetchAuditLogs: async () => {
      calls += 1;
      return { entries: new Collection([['1', { target: { id: 'u1' }, createdTimestamp: Date.now(), executor: { id: 'mod1' } }]]) };
    },
  };
  await handler('messageDelete')(ctxWith(sent), {
    guildId: 'g1', guild, channelId: 'c1', content: 'hi', author: { id: 'u1', username: 'S', bot: false },
  });
  assert.equal(calls, 1);
  assert.ok(sent[0].embeds[0].fields.some((f) => f.value === '<@mod1>'));
  await handler('messageDelete')(ctxWith(sent), { guildId: 'g1', guild, channelId: 'c1', content: null, partial: true });
  assert.equal(calls, 1);
  assert.equal(sent.length, 2);
});
