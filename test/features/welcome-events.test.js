import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMember } from '../../src/features/welcome/index.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
let warn;
let warnings;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings, media_items');
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
      id: '1', user: { username: 'Sam', bot: false, displayAvatarURL: () => '' },
      guild: { id: 'g1', name: 'Home', memberCount: 5, premiumSubscriptionCount: 2 },
      send: async (p) => { dms.push(p); },
    },
    ctx: () => ({ db, client: { channels: { fetch: async () => channel } } }),
  };
}

const cfg = (extra = {}) => ({ join: { enabled: true, channelId: 'c1', style: 'text', text: 'Hi {username}', ...extra } });

test('does nothing when the feature is off', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: false, config: cfg() });
  assert.equal(await handleMember(f.ctx(), f.member, 'join'), 'feature-off');
  assert.equal(f.sent.length, 0);
});

test('does nothing when the event is off', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg({ enabled: false }) });
  assert.equal(await handleMember(f.ctx(), f.member, 'join'), 'event-off');
  assert.equal(await handleMember(f.ctx(), f.member, 'boost'), 'event-off');
  assert.equal(f.sent.length, 0);
});

test('sends the welcome text when on', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  assert.equal(await handleMember(f.ctx(), f.member, 'join'), 'sent');
  assert.equal(f.sent[0].content, 'Hi Sam');
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: ['1'] });
});

test('sends a DM when the dm option is on', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg({ dm: { enabled: true, text: 'Hello {username}' } }) });
  await handleMember(f.ctx(), f.member, 'join');
  assert.equal(f.dms[0].content, 'Hello Sam');
});

test('a deleted channel does not throw and reports no-channel', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  const ctx = { db, client: { channels: { fetch: async () => { throw new Error('Unknown Channel'); } } } };
  assert.equal(await handleMember(ctx, f.member, 'join'), 'no-channel');
});

test('a failing send does not throw and reports send-failed', async () => {
  const f = fakeMember();
  f.channel.send = async () => { throw new Error('Missing Permissions'); };
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  assert.equal(await handleMember(f.ctx(), f.member, 'join'), 'send-failed');
});

test('closed DMs do not throw and do not change the status', async () => {
  const f = fakeMember();
  f.member.send = async () => { throw new Error('Cannot send messages to this user'); };
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg({ dm: { enabled: true, text: 'x' } }) });
  assert.equal(await handleMember(f.ctx(), f.member, 'join'), 'sent');
});

test('a leave event for a member without a user is skipped', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: { leave: { ...cfg().join } } });
  delete f.member.user;
  assert.equal(await handleMember(f.ctx(), f.member, 'leave'), 'send-failed');
  assert.equal(f.sent.length, 0);
});

test('a missing card background falls back to the text message with a warning', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', {
    enabled: true, config: cfg({ style: 'card', background: { type: 'stored', name: 'gone' } }),
  });
  assert.equal(await handleMember(f.ctx(), f.member, 'join'), 'sent');
  assert.deepEqual(Object.keys(f.sent[0]).sort(), ['allowedMentions', 'content']);
  assert.equal(f.sent[0].content, 'Hi Sam');
  assert.ok(warnings.some((w) => /falling back to text/.test(w)));
});

test('an avatar that cannot be loaded falls back to the text message', async () => {
  const f = fakeMember();
  f.member.user.displayAvatarURL = () => join(tmpdir(), 'jalter-no-such-avatar.png');
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg({ style: 'card' }) });
  assert.equal(await handleMember(f.ctx(), f.member, 'join'), 'sent');
  assert.equal(f.sent[0].content, 'Hi Sam');
  assert.equal(f.sent[0].files, undefined);
});
