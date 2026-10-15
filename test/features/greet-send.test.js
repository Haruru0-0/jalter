import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import { handleMember, events } from '../../src/features/greet/send.js';
import { setFeature, getFeature } from '../../src/db/settings.js';
import { createEmbed, saveEmbed } from '../../src/features/embeds/store.js';
import { resetBackoff } from '../../src/core/auto-channel.js';
import { testDb } from '../helpers/db.js';

let db;
let warn;
let warnings;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings, media_items, embeds');
  resetBackoff();
  warn = console.warn;
  warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
});
after(async () => { console.warn = warn; await db.end(); });

function fakeMember() {
  const sent = [];
  const dms = [];
  const channel = { isTextBased: () => true, send: async (p) => { sent.push(p); return {}; } };
  return {
    sent, dms, channel,
    member: {
      id: '1',
      displayName: 'Sam',
      user: { id: '1', username: 'sam', globalName: 'Sam', bot: false, displayAvatarURL: () => '' },
      guild: {
        id: 'g1', name: 'Home', memberCount: 5, premiumSubscriptionCount: 2, ownerId: '9',
        createdTimestamp: 1_600_000_000_000, iconURL: () => null,
      },
      send: async (p) => { dms.push(p); },
    },
    ctx: () => ({ db, client: { channels: { fetch: async () => channel } } }),
  };
}

const on = (kind, config = {}) => setFeature(db, 'g1', kind, { enabled: true, config: { channelId: 'c1', ...config } });

test('feature off gives off and sends nothing', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'greet', { enabled: false, config: { channelId: 'c1' } });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'off');
  assert.equal(f.sent.length, 0);
});

test('enabled without a channel gives no-channel', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'greet', { enabled: true });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'no-channel');
  assert.equal(f.sent.length, 0);
});

test('default greet message is sent with the member name and limited mentions', async () => {
  const f = fakeMember();
  await on('greet');
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.match(f.sent[0].content, /<@1>/);
  assert.match(f.sent[0].content, /5th/);
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: ['1'] });
});

test('leave uses safe mentions', async () => {
  const f = fakeMember();
  await on('leave', { message: '{user_name} left @everyone' });
  assert.equal(await handleMember(f.ctx(), f.member, 'leave'), 'sent');
  assert.equal(f.sent[0].content, 'Sam left @everyone');
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [] });
});

test('embed tag attaches the stored embed and the rest stays as content', async () => {
  const f = fakeMember();
  await createEmbed(db, 'g1', 'rules');
  await saveEmbed(db, 'g1', 'rules', { title: 'Rules for {server_name}', description: 'Be kind' });
  await on('greet', { message: 'Hi {user_name} {embed:Rules}' });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.equal(f.sent[0].content, 'Hi Sam');
  assert.equal(f.sent[0].embeds.length, 1);
  assert.equal(f.sent[0].embeds[0].title, 'Rules for Home');
});

test('a missing embed name still sends the text and warns', async () => {
  const f = fakeMember();
  await on('greet', { message: 'Hi {user_name} {embed:nope}' });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.equal(f.sent[0].content, 'Hi Sam');
  assert.equal(f.sent[0].embeds, undefined);
  assert.ok(warnings.some((w) => /nope/.test(w)));
});

test('an embed with a missing stored image falls back to text only', async () => {
  const f = fakeMember();
  await createEmbed(db, 'g1', 'pic');
  await saveEmbed(db, 'g1', 'pic', { title: 'T', image: 'gone' });
  await on('greet', { message: 'Hi {user_name} {embed:pic}' });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.equal(f.sent[0].content, 'Hi Sam');
  assert.equal(f.sent[0].embeds, undefined);
  assert.ok(warnings.length > 0);
});

test('a refused embed send is retried once as text only with the same mentions', async () => {
  const f = fakeMember();
  const attempts = [];
  f.channel.send = async (p) => {
    attempts.push(p);
    if (p.embeds) throw new Error('Invalid Form Body');
    return {};
  };
  await createEmbed(db, 'g1', 'rules');
  await saveEmbed(db, 'g1', 'rules', { title: 'Rules', description: 'Be kind' });
  await on('greet', { message: 'Hi {user_name} {embed:rules}' });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].content, 'Hi Sam');
  assert.equal(attempts[1].embeds, undefined);
  assert.equal(attempts[1].files, undefined);
  assert.deepEqual(attempts[1].allowedMentions, attempts[0].allowedMentions);
  assert.ok(warnings.some((w) => /retrying as text only/.test(w)));
});

test('a refused plain text send is not retried', async () => {
  const f = fakeMember();
  let calls = 0;
  f.channel.send = async () => { calls += 1; throw new Error('Missing Permissions'); };
  await on('greet');
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'send-failed');
  assert.equal(calls, 1);
});

test('an embed that is invalid after placeholders still sends the text', async () => {
  const f = fakeMember();
  f.member.displayName = 'x'.repeat(300);
  await createEmbed(db, 'g1', 'long');
  await saveEmbed(db, 'g1', 'long', { title: '{user_name}' });
  await on('greet', { message: 'Hi {embed:long}' });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].content, 'Hi');
  assert.equal(f.sent[0].embeds, undefined);
  assert.ok(warnings.length > 0);
});

test('card true attaches card.png', async () => {
  const f = fakeMember();
  await on('greet', { card: true });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.equal(f.sent[0].files.length, 1);
  assert.equal(f.sent[0].files[0].name, 'card.png');
  assert.ok(Buffer.isBuffer(f.sent[0].files[0].attachment));
});

test('dm sends the same payload; closed DMs do not throw; leave never DMs', async () => {
  const f = fakeMember();
  await on('greet', { dm: true });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.equal(f.dms.length, 1);
  assert.equal(f.dms[0].content, f.sent[0].content);

  f.member.send = async () => { throw new Error('Cannot send messages to this user'); };
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'sent');
  assert.ok(warnings.some((w) => /DM/.test(w)));

  const g = fakeMember();
  await on('leave', { dm: true });
  assert.equal(await handleMember(g.ctx(), g.member, 'leave'), 'sent');
  assert.equal(g.dms.length, 0);
});

test('a deleted channel does not throw', async () => {
  const f = fakeMember();
  await on('greet');
  const ctx = { db, client: { channels: { fetch: async () => { throw new Error('Unknown Channel'); } } } };
  assert.ok(['no-channel', 'send-failed'].includes(await handleMember(ctx, f.member, 'greet')));
});

test('a failing send reports send-failed', async () => {
  const f = fakeMember();
  f.channel.send = async () => { throw new Error('Missing Permissions'); };
  await on('greet');
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'send-failed');
});

test('a partial member without a user returns send-failed', async () => {
  const f = fakeMember();
  await on('leave');
  delete f.member.user;
  assert.equal(await handleMember(f.ctx(), f.member, 'leave'), 'send-failed');
  assert.equal(f.sent.length, 0);
  assert.ok(warnings.length > 0);
});

test('the boost handler fires only when premiumSince goes from null to a date', async () => {
  const f = fakeMember();
  await on('boost');
  const handler = events.find((e) => e.name === Events.GuildMemberUpdate).execute;
  const mk = (premiumSince, extra = {}) => ({ ...f.member, premiumSince, ...extra });
  await handler(f.ctx(), mk(null, { partial: true }), mk(new Date()));
  await handler(f.ctx(), mk(new Date()), mk(new Date()));
  await handler(f.ctx(), mk(null), mk(null));
  assert.equal(f.sent.length, 0);
  await handler(f.ctx(), mk(null), mk(new Date()));
  assert.equal(f.sent.length, 1);
  assert.deepEqual(events.map((e) => e.name),
    [Events.GuildMemberAdd, Events.GuildMemberRemove, Events.GuildMemberUpdate]);
});

test('enabled without a channel creates one lazily, stores it and sends', async () => {
  const f = fakeMember();
  const created = [];
  f.member.guild.channels = { create: async (o) => { created.push(o); return { id: 'c9', ...o }; } };
  const ctx = { db, client: { channels: { fetch: async (id) => (id === 'c9' ? f.channel : null) } } };
  await setFeature(db, 'g1', 'greet', { enabled: true });
  assert.equal(await handleMember(ctx, f.member, 'greet'), 'sent');
  assert.equal(created.length, 1);
  assert.equal(created[0].name, 'welcome');
  assert.equal(f.sent.length, 1);
  const { config } = await getFeature(db, 'g1', 'greet');
  assert.equal(config.channelId, 'c9');
});

test('a deleted configured channel is not recreated', async () => {
  const f = fakeMember();
  let creates = 0;
  f.member.guild.channels = { create: async () => { creates += 1; return { id: 'zz' }; } };
  const ctx = { db, client: { channels: { fetch: async () => null } } };
  await on('greet');
  assert.equal(await handleMember(ctx, f.member, 'greet'), 'no-channel');
  assert.equal(creates, 0);
});

test('lazy creation that fails gives no-channel', async () => {
  const f = fakeMember();
  f.member.guild.channels = { create: async () => { throw new Error('Missing Permissions'); } };
  await setFeature(db, 'g1', 'greet', { enabled: true });
  assert.equal(await handleMember(f.ctx(), f.member, 'greet'), 'no-channel');
});

test('lazy creation backs off after a failure and retries after 10 minutes', async () => {
  let t = 1_000_000;
  resetBackoff(() => t);
  const f = fakeMember();
  let attempts = 0;
  f.member.guild.channels = { create: async () => { attempts += 1; throw new Error('Missing Permissions'); } };
  await setFeature(db, 'g1', 'greet', { enabled: true });
  await handleMember(f.ctx(), f.member, 'greet');
  await handleMember(f.ctx(), f.member, 'greet');
  assert.equal(attempts, 1);
  t += 11 * 60 * 1000;
  await handleMember(f.ctx(), f.member, 'greet');
  assert.equal(attempts, 2);
});
