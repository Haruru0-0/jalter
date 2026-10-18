import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, ChannelType } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { createVerificationCommand } from '../../src/features/verification/commands.js';
import { gateChannel } from '../../src/features/verification/apply.js';
import { readConfig } from '../../src/features/verification/config.js';
import { listRecords, recordOriginal } from '../../src/features/verification/store.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE verification_overwrites');
  await db.query('TRUNCATE guild_settings');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const VR = 'vrole';
const has = (bits) => ({ bitfield: bits, has: (bit) => (bits & bit) === bit });
const ow = (id, allow = 0n, deny = 0n, type = 0) => ({ id, type, allow: { bitfield: allow }, deny: { bitfield: deny } });

function fakeChannel(id, overwrites = []) {
  const cache = new Map(overwrites.map((o) => [o.id, o]));
  const calls = [];
  return {
    id, type: ChannelType.GuildText, permissionsLocked: false, parent: null, isThread: () => false, calls,
    permissionOverwrites: {
      cache,
      edit: async (target, options) => {
        calls.push({ op: 'edit', target });
        const cur = cache.get(target) ?? ow(target);
        let allow = cur.allow.bitfield;
        let deny = cur.deny.bitfield;
        for (const [name, v] of Object.entries(options)) {
          const bit = P[name];
          allow &= ~bit; deny &= ~bit;
          if (v === true) allow |= bit;
          if (v === false) deny |= bit;
        }
        cache.set(target, ow(target, allow, deny, cur.type));
      },
      delete: async (target) => { calls.push({ op: 'delete', target }); cache.delete(target); },
    },
  };
}

// Like discord.js: edit() merges onto the CACHED overwrite and only writes Discord's copy
// (`server`); the cache changes on a channel update event (sync) or a forced fetch.
function staleChannel(id, overwrites = []) {
  const server = new Map(overwrites.map((o) => [o.id, o]));
  const cache = new Map(server);
  const calls = [];
  return {
    id, type: ChannelType.GuildText, parent: null, isThread: () => false, calls, server,
    sync: () => { cache.clear(); for (const [k, v] of server) cache.set(k, v); },
    permissionOverwrites: {
      cache,
      edit: async (target, options) => {
        calls.push({ op: 'edit', target });
        const cur = cache.get(target) ?? ow(target);
        let allow = cur.allow.bitfield;
        let deny = cur.deny.bitfield;
        for (const [name, v] of Object.entries(options)) {
          const bit = P[name];
          allow &= ~bit; deny &= ~bit;
          if (v === true) allow |= bit;
          if (v === false) deny |= bit;
        }
        server.set(target, ow(target, allow, deny, cur.type));
      },
      delete: async (target) => { calls.push({ op: 'delete', target }); server.delete(target); },
    },
  };
}

function fakeMember(id, { bot = false, roles = [], top = 1 } = {}) {
  const set = new Set(roles);
  const m = {
    id, user: { bot }, added: [], removed: [],
    roles: {
      cache: { has: (r) => set.has(r) },
      highest: { position: top },
      add: async (r) => { m.added.push(r); set.add(r); },
      remove: async (r) => { m.removed.push(r); set.delete(r); },
    },
  };
  return m;
}

function makeGuild({ channels = [], members = [], roleTop = 3, botTop = 5, ownerId = 'owner' } = {}) {
  const chans = new Map(channels.map((c) => [c.id, c]));
  const mem = new Map(members.map((m) => [m.id, m]));
  const role = { id: VR, position: roleTop, managed: false };
  return {
    id: G, ownerId,
    members: {
      me: { id: 'bot1', permissions: has(0n), roles: { highest: { position: botTop } } },
      cache: mem,
      fetch: async ({ user }) => { const m = mem.get(user); if (!m) throw new Error('Unknown Member'); return m; },
    },
    roles: { everyone: { id: G, permissions: has(P.ViewChannel) }, cache: new Map([[VR, role]]), fetch: async () => role },
    channels: {
      cache: chans,
      fetch: async (id, { force } = {}) => {
        if (id === undefined) return new Map(chans);
        const c = chans.get(id) ?? null;
        if (force) c?.sync?.();
        return c;
      },
    },
  };
}

function makeInteraction(guild, { group = null, sub, options = {}, manage = true, actorTop = 10, actorId = 'admin' } = {}) {
  const replies = [];
  const i = {
    replies, guild, guildId: G, user: { id: actorId },
    member: { id: actorId, guild: { id: G }, permissions: { has: () => manage }, roles: { cache: new Map(), highest: { position: actorTop } } },
    inGuild: () => true,
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => sub,
      getString: (n) => options[n] ?? null,
      getChannel: (n) => (options[n] ? { id: options[n] } : null),
      getUser: (n) => (options[n] ? { id: options[n] } : null),
      getMember: (n) => (options[n] ? { id: options[n] } : null),
    },
    reply: async (p) => { replies.push(p); },
    deferReply: async (o) => { i.deferred = o; },
    editReply: async (p) => { replies.push(p); },
  };
  return i;
}

const logs = [];
const deps = { logVerification: async (_c, _g, _l, entry) => { logs.push(entry); } };
const cmd = createVerificationCommand();
const run = async (guild, args) => {
  logs.length = 0;
  const i = makeInteraction(guild, args);
  await cmd.execute(i, { db, client: { user: { id: 'bot1' } } }, deps);
  return i;
};
const last = (i) => i.replies[i.replies.length - 1];
const cfgNow = async () => readConfig((await getFeature(db, G, 'verification')).config);
const active = (extra = {}) => setFeature(db, G, 'verification', {
  enabled: true, config: { state: 'active', roleId: VR, channelId: 'vc', ...extra },
});

test('mode saves captcha and keeps the other config keys', async () => {
  await setFeature(db, G, 'verification', { config: { state: 'active', grantDone: true, roleId: VR } });
  const i = await run(makeGuild(), { sub: 'mode', options: { mode: 'captcha' } });
  assert.equal(last(i).flags, 64);
  const raw = (await getFeature(db, G, 'verification')).config;
  assert.equal(raw.mode, 'captcha');
  assert.equal(raw.grantDone, true);
  assert.equal(raw.state, 'active');
});

test('mode is admin only', async () => {
  await run(makeGuild(), { sub: 'mode', options: { mode: 'captcha' }, manage: false });
  assert.equal((await cfgNow()).mode, 'button');
});

test('public add applies the channel when active', async () => {
  await active();
  const chan = fakeChannel('a');
  const i = await run(makeGuild({ channels: [chan] }), { group: 'public', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).publicChannels, ['a']);
  assert.equal((await listRecords(db, G)).length, 1);
  assert.ok(chan.calls.length > 0);
  assert.ok(chan.permissionOverwrites.cache.get(G).deny.bitfield & P.SendMessages);
  assert.equal(last(i).flags, 64);
});

test('public add of a private channel is refused', async () => {
  await active();
  const chan = fakeChannel('p', [ow(G, 0n, P.ViewChannel)]);
  const i = await run(makeGuild({ channels: [chan] }), { group: 'public', sub: 'add', options: { channel: 'p' } });
  assert.deepEqual((await cfgNow()).publicChannels, []);
  assert.equal(chan.calls.length, 0);
  assert.match(last(i).content, /@everyone/);
});

test('a channel cannot be in both lists or be the verify channel; lists are capped', async () => {
  await active({ publicChannels: ['a'] });
  const g = makeGuild({ channels: [fakeChannel('a'), fakeChannel('vc'), fakeChannel('z')] });
  let i = await run(g, { group: 'skip', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).skippedChannels, []);
  assert.match(last(i).content, /public/i);
  i = await run(g, { group: 'public', sub: 'add', options: { channel: 'vc' } });
  assert.deepEqual((await cfgNow()).publicChannels, ['a']);
  assert.match(last(i).content, /verify channel/i);
  await setFeature(db, G, 'verification', {
    config: { skippedChannels: Array.from({ length: 200 }, (_, n) => `s${n}`) },
  });
  i = await run(g, { group: 'skip', sub: 'add', options: { channel: 'z' } });
  assert.equal((await cfgNow()).skippedChannels.length, 200);
  assert.match(last(i).content, /200/);
});

test('skip add reverts a gated channel to its original', async () => {
  await active();
  const chan = fakeChannel('a', [ow(G, P.SendMessages, 0n)]);
  const g = makeGuild({ channels: [chan] });
  const cfg = await cfgNow();
  assert.equal(await gateChannel({ db, client: {} }, g, chan, cfg), 'changed');
  assert.equal((await listRecords(db, G)).length, 1);
  await run(g, { group: 'skip', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).skippedChannels, ['a']);
  assert.equal((await listRecords(db, G)).length, 0);
  assert.equal(chan.permissionOverwrites.cache.get(G).allow.bitfield, P.SendMessages);
  assert.equal(chan.permissionOverwrites.cache.get(G).deny.bitfield, 0n);
  assert.equal(chan.permissionOverwrites.cache.has(VR), false);
});

test('skip remove gates the channel again when active', async () => {
  await active({ skippedChannels: ['a'] });
  const chan = fakeChannel('a');
  await run(makeGuild({ channels: [chan] }), { group: 'skip', sub: 'remove', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).skippedChannels, []);
  assert.equal((await listRecords(db, G)).length, 1);
  assert.ok(chan.permissionOverwrites.cache.get(G).deny.bitfield & P.ViewChannel);
});

test('removing a channel that is not listed or adding twice says so', async () => {
  await active({ skippedChannels: ['a'] });
  const g = makeGuild({ channels: [fakeChannel('a'), fakeChannel('b')] });
  let i = await run(g, { group: 'skip', sub: 'remove', options: { channel: 'b' } });
  assert.match(last(i).content, /not in/i);
  i = await run(g, { group: 'skip', sub: 'add', options: { channel: 'a' } });
  assert.match(last(i).content, /already/i);
});

test('rolling_out only saves the list unless the channel is already gated', async () => {
  await setFeature(db, G, 'verification', { config: { state: 'rolling_out', roleId: VR, grantDone: true } });
  const fresh = fakeChannel('a');
  const g = makeGuild({ channels: [fresh] });
  await run(g, { group: 'skip', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).skippedChannels, ['a']);
  assert.equal(fresh.calls.length, 0);
  assert.equal((await getFeature(db, G, 'verification')).config.grantDone, true);

  const done = fakeChannel('b');
  const g2 = makeGuild({ channels: [done] });
  assert.equal(await gateChannel({ db, client: {} }, g2, done, await cfgNow()), 'changed');
  await run(g2, { group: 'skip', sub: 'add', options: { channel: 'b' } });
  assert.equal((await listRecords(db, G)).length, 0);
  assert.equal(done.permissionOverwrites.cache.has(VR), false);
});

test('a failed re-apply rolls the list change back and says so', async () => {
  // A record that holds a Verified overwrite but no Verified role id in config: revert cannot finish.
  await setFeature(db, G, 'verification', { enabled: true, config: { state: 'active' } });
  await recordOriginal(db, G, 'a', {
    everyone: { existed: false, allow: '0', deny: '0' },
    verified: { existed: false, allow: '0', deny: '0' },
    bot: null,
  });
  const chan = fakeChannel('a');
  const i = await run(makeGuild({ channels: [chan] }), { group: 'skip', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).skippedChannels, []);
  assert.equal((await listRecords(db, G)).length, 1);
  assert.match(last(i).content, /could not|not saved|unchanged/i);
});

test('list shows ids', async () => {
  await active({ publicChannels: ['111', '222'] });
  const i = await run(makeGuild(), { group: 'public', sub: 'list' });
  assert.match(last(i).content, /<#111>/);
  assert.match(last(i).content, /<#222>/);
  const empty = await run(makeGuild(), { group: 'skip', sub: 'list' });
  assert.match(last(empty).content, /no |none/i);
});

test('verify grants and logs manual_verify once with the actor', async () => {
  await active();
  const m = fakeMember('u1');
  const i = await run(makeGuild({ members: [m] }), { sub: 'verify', options: { member: 'u1' } });
  assert.deepEqual(m.added, [VR]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'manual_verify');
  assert.equal(logs[0].userId, 'u1');
  assert.equal(logs[0].actorId, 'admin');
  assert.equal(i.deferred.flags, 64);
});

test('unverify removes the role and logs', async () => {
  await active();
  const m = fakeMember('u1', { roles: [VR] });
  await run(makeGuild({ members: [m] }), { sub: 'unverify', options: { member: 'u1' } });
  assert.deepEqual(m.removed, [VR]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].kind, 'manual_unverify');
  assert.equal(logs[0].actorId, 'admin');
});

test('unverify refuses a bot, a member without the role, and a role above the bot', async () => {
  await active();
  const bot = fakeMember('b1', { bot: true, roles: [VR] });
  const plain = fakeMember('u2');
  let i = await run(makeGuild({ members: [bot, plain] }), { sub: 'unverify', options: { member: 'b1' } });
  assert.deepEqual(bot.removed, []);
  assert.equal(logs.length, 0);
  assert.match(last(i).content, /bot/i);
  i = await run(makeGuild({ members: [plain] }), { sub: 'unverify', options: { member: 'u2' } });
  assert.equal(logs.length, 0);
  assert.match(last(i).content, /not verified/i);
  const m = fakeMember('u3', { roles: [VR] });
  i = await run(makeGuild({ members: [m], roleTop: 9 }), { sub: 'unverify', options: { member: 'u3' } });
  assert.deepEqual(m.removed, []);
  assert.equal(logs.length, 0);
});

test('both refuse when state is none', async () => {
  const m = fakeMember('u1', { roles: [VR] });
  const g = makeGuild({ members: [m] });
  for (const sub of ['verify', 'unverify']) {
    const i = await run(g, { sub, options: { member: 'u1' } });
    assert.match(last(i).content, /set up|not active/i);
  }
  assert.deepEqual(m.added, []);
  assert.deepEqual(m.removed, []);
  assert.equal(logs.length, 0);
});

test('a gated channel can become public (visibility is judged from the recorded original)', async () => {
  await active();
  const chan = fakeChannel('a');
  const g = makeGuild({ channels: [chan] });
  assert.equal(await gateChannel({ db, client: {} }, g, chan, await cfgNow()), 'changed');
  assert.ok(chan.permissionOverwrites.cache.get(G).deny.bitfield & P.ViewChannel);
  const i = await run(g, { group: 'public', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).publicChannels, ['a']);
  assert.equal((await listRecords(db, G)).length, 1);
  assert.doesNotMatch(last(i).content, /cannot see/i);
  assert.equal((chan.permissionOverwrites.cache.get(G).deny.bitfield & P.ViewChannel), 0n);
});

test('a recorded channel that was private originally is still refused as public', async () => {
  await active();
  await recordOriginal(db, G, 'p', {
    everyone: { existed: true, allow: '0', deny: String(P.ViewChannel) },
    verified: { existed: false, allow: '0', deny: '0' },
    bot: null,
  });
  const chan = fakeChannel('p', [ow(G, 0n, P.ViewChannel)]);
  await run(makeGuild({ channels: [chan] }), { group: 'public', sub: 'add', options: { channel: 'p' } });
  assert.deepEqual((await cfgNow()).publicChannels, []);
});

async function gatedWithBreakage(brokenTargets, { everyoneOnce = false } = {}) {
  await active();
  const chan = fakeChannel('a');
  const g = makeGuild({ channels: [chan] });
  assert.equal(await gateChannel({ db, client: {} }, g, chan, await cfgNow()), 'changed');
  const edit = chan.permissionOverwrites.edit;
  const del = chan.permissionOverwrites.delete;
  let everyoneDone = false;
  const broken = (target) => brokenTargets.includes(target) || (everyoneOnce && target === G && everyoneDone);
  chan.permissionOverwrites.edit = async (target, o) => {
    if (broken(target)) throw new Error('boom');
    if (target === G) everyoneDone = true;
    return edit(target, o);
  };
  chan.permissionOverwrites.delete = async (target) => {
    if (broken(target)) throw new Error('boom');
    if (target === G) everyoneDone = true;
    return del(target);
  };
  return { chan, g };
}

test('a revert that fails part-way re-closes the channel and rolls the list back', async () => {
  const { chan, g } = await gatedWithBreakage([VR]);
  const i = await run(g, { group: 'skip', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).skippedChannels, []);
  assert.ok(chan.permissionOverwrites.cache.get(G).deny.bitfield & P.ViewChannel, '@everyone is denied again');
  assert.equal((await listRecords(db, G)).length, 1);
  assert.doesNotMatch(last(i).content, /may have lost/i);
  assert.match(last(i).content, /<#a>/);
});

test('a revert that fails and cannot re-close the channel says it may be open', async () => {
  const { g } = await gatedWithBreakage([VR], { everyoneOnce: true });
  const i = await run(g, { group: 'skip', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).skippedChannels, []);
  assert.match(last(i).content, /<#a>/);
  assert.match(last(i).content, /may have lost/i);
});

test('lists are re-applied when a rollout failed and the channel has a record', async () => {
  await setFeature(db, G, 'verification', { enabled: true, config: { state: 'failed', roleId: VR } });
  const chan = fakeChannel('a');
  const g = makeGuild({ channels: [chan] });
  assert.equal(await gateChannel({ db, client: {} }, g, chan, await cfgNow()), 'changed');
  await run(g, { group: 'skip', sub: 'add', options: { channel: 'a' } });
  assert.equal((await listRecords(db, G)).length, 0);
});

test('an unexpected error still gives a private reply', async () => {
  await active();
  const bad = { id: 'a', get permissionOverwrites() { throw new Error('boom'); } };
  const i = await run(makeGuild({ channels: [bad] }), { group: 'public', sub: 'add', options: { channel: 'a' } });
  assert.equal(i.replies.length, 1);
  assert.equal(last(i).flags, 64);
  assert.deepEqual((await cfgNow()).publicChannels, []);
});

test('verify and unverify respect the actor hierarchy', async () => {
  await active();
  const high = fakeMember('u1', { roles: [VR], top: 10 });
  const owner = fakeMember('owner', { roles: [VR], top: 1 });
  const low = fakeMember('u3', { roles: [VR], top: 2 });
  const g = makeGuild({ members: [high, owner, low] });
  let i = await run(g, { sub: 'unverify', options: { member: 'u1' }, actorTop: 10 });
  assert.deepEqual(high.removed, []);
  assert.match(last(i).content, /role|higher|equal/i);
  i = await run(g, { sub: 'unverify', options: { member: 'owner' } });
  assert.deepEqual(owner.removed, []);
  assert.match(last(i).content, /owner/i);
  const unverified = fakeMember('u4', { top: 10 });
  await run(makeGuild({ members: [unverified] }), { sub: 'verify', options: { member: 'u4' }, actorTop: 10 });
  assert.deepEqual(unverified.added, []);
  assert.equal(logs.length, 0);
  // The owner may act on anyone but themselves being the target of others.
  await run(makeGuild({ members: [high], ownerId: 'admin' }), { sub: 'unverify', options: { member: 'u1' }, actorTop: 1 });
  assert.deepEqual(high.removed, [VR]);
  await run(g, { sub: 'unverify', options: { member: 'u3' }, actorTop: 10 });
  assert.deepEqual(low.removed, [VR]);
});

// ---- a list change right after a write: the cache is stale until the update event ----------

const serverOf = (ch, id) => {
  const o = ch.server.get(id);
  return o ? [o.allow.bitfield, o.deny.bitfield] : null;
};
const SEND = P.SendMessages | P.SendMessagesInThreads | P.CreatePublicThreads | P.CreatePrivateThreads
  | P.AddReactions | P.UseApplicationCommands;

test('public add on a gated channel (stale cache) ends public, recorded, and says added', async () => {
  await active();
  const chan = staleChannel('a');
  const g = makeGuild({ channels: [chan] });
  assert.equal(await gateChannel({ db, client: {} }, g, chan, await cfgNow()), 'changed');
  chan.sync(); // the update event for the gate arrived long ago
  const i = await run(g, { group: 'public', sub: 'add', options: { channel: 'a' } });
  assert.deepEqual((await cfgNow()).publicChannels, ['a']);
  const [, evDeny] = serverOf(chan, G);
  assert.equal(evDeny & P.ViewChannel, 0n, 'visible again');
  assert.equal(evDeny & SEND, SEND, 'read-only for @everyone');
  const recs = await listRecords(db, G);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].everyone, { existed: false, allow: '0', deny: '0' });
  assert.match(last(i).content, /<#a>/);
});

test('public remove (stale cache) gates from the live state and keeps the first record', async () => {
  await active({ publicChannels: ['a'] });
  const chan = staleChannel('a', [ow(G, P.AttachFiles, 0n)]);
  const g = makeGuild({ channels: [chan] });
  assert.equal(await gateChannel({ db, client: {} }, g, chan, await cfgNow()), 'changed');
  chan.sync();
  await run(g, { group: 'public', sub: 'remove', options: { channel: 'a' } });
  const recs = await listRecords(db, G);
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0].everyone, { existed: true, allow: String(P.AttachFiles), deny: '0' });
  assert.deepEqual(recs[0].verified, { existed: false, allow: '0', deny: '0' });
  assert.deepEqual(serverOf(chan, G), [P.AttachFiles, P.ViewChannel]);
  assert.deepEqual(serverOf(chan, VR), [P.ViewChannel, 0n]);
});
