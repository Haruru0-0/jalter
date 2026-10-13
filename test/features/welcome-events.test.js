import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleMember } from '../../src/features/welcome/index.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
let warn;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
  warn = console.warn;
  console.warn = () => {};
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
  await handleMember(f.ctx(), f.member, 'join');
  assert.equal(f.sent.length, 0);
});

test('sends the welcome text when on', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  await handleMember(f.ctx(), f.member, 'join');
  assert.equal(f.sent[0].content, 'Hi Sam');
  assert.deepEqual(f.sent[0].allowedMentions, { parse: [], users: ['1'] });
});

test('sends a DM when the dm option is on', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg({ dm: { enabled: true, text: 'Hello {username}' } }) });
  await handleMember(f.ctx(), f.member, 'join');
  assert.equal(f.dms[0].content, 'Hello Sam');
});

test('a deleted channel does not throw', async () => {
  const f = fakeMember();
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  const ctx = { db, client: { channels: { fetch: async () => { throw new Error('Unknown Channel'); } } } };
  await handleMember(ctx, f.member, 'join');
});

test('a failing send does not throw', async () => {
  const f = fakeMember();
  f.channel.send = async () => { throw new Error('Missing Permissions'); };
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg() });
  await handleMember(f.ctx(), f.member, 'join');
});

test('closed DMs do not throw', async () => {
  const f = fakeMember();
  f.member.send = async () => { throw new Error('Cannot send messages to this user'); };
  await setFeature(db, 'g1', 'welcome', { enabled: true, config: cfg({ dm: { enabled: true, text: 'x' } }) });
  await handleMember(f.ctx(), f.member, 'join');
});
