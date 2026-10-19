import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, ChannelType } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { scheduleJob } from '../../src/core/scheduler.js';
import { createVerificationCommand } from '../../src/features/verification/commands.js';
import { handle } from '../../src/features/verification/verify.js';
import { recordOriginal, listRecords } from '../../src/features/verification/store.js';
import { SEND_BITS } from '../../src/features/verification/plan.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE verification_overwrites');
  await db.query('TRUNCATE guild_settings');
  await db.query('DELETE FROM scheduled_jobs');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const ALL_BOT = P.ManageRoles | P.ManageChannels | P.ViewChannel | P.SendMessages | P.EmbedLinks | P.AttachFiles;
const has = (bits) => ({ bitfield: bits, has: (bit) => (bits & bit) === bit });
const ow = (id, allow = 0n, deny = 0n, type = 0) => ({ id, type, allow: { bitfield: allow }, deny: { bitfield: deny } });

function fakeChannel(id, overwrites = [], extra = {}) {
  const cache = new Map(overwrites.map((o) => [o.id, o]));
  const calls = [];
  const sent = [];
  const deleted = [];
  return {
    id, type: ChannelType.GuildText, permissionsLocked: false, parent: null, isThread: () => false, ...extra,
    calls, sent, deleted,
    send: async (p) => { sent.push(p); return { id: `msg-${id}` }; },
    messages: { delete: async (mid) => { deleted.push(mid); } },
    delete: async () => { calls.push({ op: 'channel-delete' }); },
    permissionOverwrites: {
      cache,
      edit: async (target, options) => {
        calls.push({ op: 'edit', target, options });
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

function makeGuild({
  botPerms = ALL_BOT, everyoneBase = P.ViewChannel, channels = [], roles = [], botTop = 5, memberCount = 7,
} = {}) {
  const chans = new Map(channels.map((c) => [c.id, c]));
  const rolesMap = new Map(roles.map((r) => [r.id, r]));
  const created = { roles: [], channels: [] };
  return {
    id: G, memberCount, created,
    members: { me: { id: 'bot1', permissions: has(botPerms), roles: { highest: { position: botTop } } }, cache: new Map() },
    roles: {
      everyone: { id: G, permissions: has(everyoneBase) },
      cache: rolesMap,
      fetch: async (id) => rolesMap.get(id) ?? null,
      create: async (o) => {
        const r = { id: 'newrole', position: o.position, managed: false, opts: o, delete: async () => {} };
        created.roles.push(r);
        rolesMap.set(r.id, r);
        return r;
      },
    },
    channels: {
      cache: chans,
      fetch: async (id) => (id === undefined ? new Map(chans) : (chans.get(id) ?? null)),
      create: async (o) => {
        const c = fakeChannel('newchan', [], { name: o.name });
        created.channels.push(c);
        chans.set(c.id, c);
        return c;
      },
    },
  };
}

function makeInteraction(guild, { sub, customId, options = {}, userId = 'admin', manage = true, actorTop = 10 } = {}) {
  const replies = [];
  const state = { updated: [] };
  return {
    replies, state, customId, guild, guildId: G,
    user: { id: userId },
    member: {
      id: userId, guild: { id: G }, permissions: { has: () => manage },
      roles: { cache: new Map(), highest: { position: actorTop } },
    },
    inGuild: () => true,
    isButton: () => true,
    options: {
      getSubcommand: () => sub,
      getString: (n) => options[n] ?? null,
      getRole: (n) => (options[n] ? { id: options[n] } : null),
      getChannel: (n) => (options[n] ? { id: options[n] } : null),
    },
    reply: async (p) => { replies.push(p); },
    deferReply: async () => {},
    editReply: async (p) => { replies.push(p); },
    deferUpdate: async () => {},
    update: async (p) => { state.updated.push(p); replies.push(p); },
  };
}

const ctxFor = (guild) => ({ db, client: { guilds: { cache: new Map([[G, guild]]) } } });
const cmd = createVerificationCommand();
const run = async (guild, args) => {
  const i = makeInteraction(guild, args);
  await cmd.execute(i, ctxFor(guild));
  return i;
};
const last = (i) => i.replies[i.replies.length - 1];
const buttonIds = (i) => last(i).components[0].components.map((b) => b.data.custom_id);
const raw = async () => (await getFeature(db, G, 'verification')).config;

async function preview(guild, args = {}) {
  const i = await run(guild, { sub: 'setup', options: {}, ...args });
  return { i, ok: buttonIds(i)[0] };
}
const press = async (guild, customId, userId = 'admin') => {
  const i = makeInteraction(guild, { customId, userId });
  await handle(i, ctxFor(guild));
  return i;
};

test('setup refuses when state is not none', async () => {
  await setFeature(db, G, 'verification', { enabled: true, config: { state: 'active' } });
  const i = await run(makeGuild(), { sub: 'setup' });
  assert.match(last(i).content, /already|set up/i);
  assert.equal(last(i).components, undefined);
  assert.equal(last(i).flags, 64);
});

const leftover = () => recordOriginal(db, G, 'c1', {
  everyone: { existed: false, allow: '0', deny: '0' }, verified: { existed: false, allow: '0', deny: '0' }, bot: null,
});

test('setup refuses while undo records are left (a remove running or interrupted), and works once they are gone', async () => {
  // remove sets state none before restoring; a restart mid-remove leaves records behind too.
  await setFeature(db, G, 'verification', { enabled: false, config: { state: 'none', roleId: 'rv' } });
  await leftover();
  const guild = makeGuild();
  const i = await run(guild, { sub: 'setup' });
  assert.match(last(i).content, /\/verification remove/);
  assert.match(last(i).content, /removal/i);
  assert.equal(last(i).components, undefined);
  assert.equal(last(i).flags, 64);

  await db.query('TRUNCATE verification_overwrites');
  const { i: again } = await preview(guild);
  assert.equal(last(again).components.length, 1);
});

test('confirm refuses when a remove started between the preview and Confirm', async () => {
  const guild = makeGuild();
  const { ok } = await preview(guild);
  await leftover();
  const i = await press(guild, ok);
  assert.match(last(i).content, /\/verification remove/);
  assert.equal(guild.created.roles.length, 0);
  assert.equal(guild.created.channels.length, 0);
  assert.equal((await raw()).state ?? 'none', 'none');
});

test('setup refuses when the bot lacks Manage Roles', async () => {
  const i = await run(makeGuild({ botPerms: ALL_BOT & ~P.ManageRoles }), { sub: 'setup' });
  assert.match(last(i).content, /ManageRoles/);
  assert.equal(last(i).components, undefined);
});

test('setup refuses when @everyone has Administrator, or the role/channel cannot work', async () => {
  let i = await run(makeGuild({ everyoneBase: P.Administrator }), { sub: 'setup' });
  assert.match(last(i).content, /Administrator/);
  const high = { id: 'r9', position: 9, managed: false };
  i = await run(makeGuild({ roles: [high] }), { sub: 'setup', options: { role: 'r9' } });
  assert.match(last(i).content, /role/i);
  assert.equal(last(i).components, undefined);
  const priv = fakeChannel('c9', [ow(G, 0n, P.ViewChannel)]);
  i = await run(makeGuild({ channels: [priv] }), { sub: 'setup', options: { channel: 'c9' } });
  assert.match(last(i).content, /@everyone/);
  assert.equal(last(i).components, undefined);
});

test('setup refuses a chosen role with staff permissions or not below the caller', async () => {
  const staff = { id: 'r2', position: 2, managed: false, permissions: { has: (p) => p === 'BanMembers' } };
  let i = await run(makeGuild({ roles: [staff] }), { sub: 'setup', options: { role: 'r2' } });
  assert.match(last(i).content, /staff permissions/);
  assert.equal(last(i).components, undefined);

  const mid = { id: 'r3', position: 3, managed: false };
  i = await run(makeGuild({ roles: [mid] }), { sub: 'setup', options: { role: 'r3' }, actorTop: 3 });
  assert.match(last(i).content, /below your highest role/);
  assert.equal(last(i).components, undefined);

  // Strictly below the caller (or the caller is the owner): the preview is shown.
  i = await run(makeGuild({ roles: [mid] }), { sub: 'setup', options: { role: 'r3' }, actorTop: 4 });
  assert.equal(last(i).components.length, 1);
});

test('confirm re-checks the role: one that gained staff permissions meanwhile is refused', async () => {
  const perms = new Set();
  const role = { id: 'r3', position: 3, managed: false, permissions: { has: (p) => perms.has(p) } };
  const guild = makeGuild({ roles: [role] });
  const { ok } = await preview(guild, { options: { role: 'r3' } });
  perms.add('ManageRoles');
  const i = await press(guild, ok);
  assert.match(last(i).content, /staff permissions/);
  assert.equal((await raw()).state ?? 'none', 'none');
});

test('setup preview counts channels and names a leaking role', async () => {
  const guild = makeGuild({
    channels: [
      fakeChannel('a'),
      fakeChannel('b', [ow('staff', P.ViewChannel, 0n)]),
      fakeChannel('p', [ow(G, 0n, P.ViewChannel)]),
    ],
  });
  await setFeature(db, G, 'verification', { config: { skippedChannels: ['a'] } });
  const { i } = await preview(guild);
  const text = last(i).content;
  assert.match(text, /<#b>/);
  assert.doesNotMatch(text, /<#a>/);
  assert.match(text, /Channels to gate: 1/);
  assert.match(text, /Skipped: 1/);
  assert.match(text, /Already private: 1/);
  assert.match(text, /Members to grant: 7/);
  assert.deepEqual(buttonIds(i).map((c) => c.split(':').slice(0, 3).join(':')), ['verification:setup:ok', 'verification:setup:no']);
  assert.equal(guild.created.roles.length, 0, 'nothing is created before Confirm');
});

test('setup preview counts a synced child of a category as its own channel to gate', async () => {
  const cat = fakeChannel('cat', [], { type: ChannelType.GuildCategory });
  const kid = fakeChannel('kid', [], { permissionsLocked: true, parent: cat, parentId: 'cat' });
  const { i } = await preview(makeGuild({ channels: [cat, kid] }));
  assert.match(last(i).content, /Channels to gate: 2/);
});

test('confirm by another admin or after 2 minutes does nothing', async () => {
  const guild = makeGuild();
  const { ok } = await preview(guild);
  const other = await press(guild, ok, 'someone-else');
  assert.match(last(other).content, /not yours|another|only/i);
  assert.equal(guild.created.roles.length, 0);

  const late = await press(guild, `verification:setup:ok:admin:${Date.now() - 121_000}`);
  assert.equal(guild.created.roles.length, 0);
  assert.equal(last(late).components.length, 0);
  assert.equal((await raw()).state ?? 'none', 'none');
});

test('confirm creates what is missing, posts the panel and starts the rollout', async () => {
  const guild = makeGuild({ everyoneBase: 0n });
  const { ok } = await preview(guild);
  const i = await press(guild, ok);
  assert.equal(guild.created.roles.length, 1);
  const role = guild.created.roles[0];
  assert.equal(role.opts.name, 'Verified');
  assert.equal(role.opts.position, 4);
  assert.equal(role.opts.hoist, false);
  assert.equal(guild.created.channels.length, 1);
  const chan = guild.created.channels[0];
  assert.equal(chan.sent.length, 1);
  // @everyone cannot view by default here: setup opened the verify channel.
  assert.deepEqual(chan.calls[0], { op: 'edit', target: G, options: { ViewChannel: true } });
  const { enabled, config } = await getFeature(db, G, 'verification');
  assert.equal(enabled, true);
  assert.equal(config.state, 'rolling_out');
  assert.equal(config.roleId, 'newrole');
  assert.equal(config.channelId, 'newchan');
  assert.equal(config.messageId, 'msg-newchan');
  assert.equal(config.mode, 'button');
  const jobs = await db.query('SELECT type FROM scheduled_jobs WHERE guild_id = $1', [G]);
  assert.deepEqual(jobs.rows.map((r) => r.type), ['verification.grant']);
  assert.equal(last(i).components.length, 0);

  // A second confirm (state is no longer none) changes nothing more.
  const again = await press(guild, ok);
  assert.equal(guild.created.roles.length, 1);
  assert.ok(again.replies.length > 0);
});

test('cancel changes nothing', async () => {
  const guild = makeGuild();
  await preview(guild);
  const i = await press(guild, 'verification:setup:no:admin');
  assert.equal(guild.created.roles.length, 0);
  assert.equal(last(i).components.length, 0);
  const { enabled, config } = await getFeature(db, G, 'verification');
  assert.equal(enabled, false);
  assert.equal(config.state ?? 'none', 'none');
  const other = await press(guild, 'verification:setup:no:admin', 'intruder');
  assert.equal(other.state.updated.length, 0);
});

test('status shows the state, progress and a stuck rollout', async () => {
  await setFeature(db, G, 'verification', {
    enabled: true, config: { roleId: 'r1', channelId: 'c1', state: 'rolling_out', grantDone: false, cutoff: 1 },
  });
  let i = await run(makeGuild(), { sub: 'status' });
  const stuck = last(i).content;
  assert.match(stuck, /<@&r1>/);
  assert.match(stuck, /<#c1>/);
  assert.match(stuck, /\/verification remove/);

  await scheduleJob(db, { guildId: G, type: 'verification.grant', key: 'rollout', payload: {}, dueAt: Date.now() });
  i = await run(makeGuild(), { sub: 'status' });
  assert.doesNotMatch(last(i).content, /\/verification remove/);
  assert.match(last(i).content, /granting/i);
  assert.equal(last(i).flags, 64);
});

test('status of a failed rollout names the channels that could not be gated', async () => {
  await setFeature(db, G, 'verification', {
    enabled: true, config: { roleId: 'r1', state: 'failed', failedChannels: 12, failedChannelIds: ['111', '222'] },
  });
  const i = await run(makeGuild(), { sub: 'status' });
  assert.match(last(i).content, /could not be gated: 12/);
  assert.match(last(i).content, /<#111> <#222>/);
  assert.equal(last(i).flags, 64);
});

async function removable() {
  const gated = fakeChannel('c1', [ow(G, 0n, P.ViewChannel), ow('rv', P.ViewChannel, 0n)]);
  const pub = fakeChannel('c2', [ow(G, 0n, SEND_BITS), ow('rv', SEND_BITS, 0n)]);
  await setFeature(db, G, 'verification', {
    enabled: true, config: { roleId: 'rv', channelId: 'cv', messageId: 'm1', state: 'active' },
  });
  const orig = { everyone: { existed: false, allow: '0', deny: '0' }, verified: { existed: false, allow: '0', deny: '0' }, bot: null };
  await recordOriginal(db, G, 'c1', orig);
  await recordOriginal(db, G, 'c2', orig);
  return { gated, pub, verify: fakeChannel('cv', []) };
}

test('remove restores every recorded channel and reports failures', async () => {
  const { gated, pub, verify } = await removable();
  const okEdit = pub.permissionOverwrites.edit;
  const okDelete = pub.permissionOverwrites.delete;
  const boom = async () => { throw new Error('Missing Permissions'); };
  pub.permissionOverwrites.edit = boom;
  pub.permissionOverwrites.delete = boom;
  const guild = makeGuild({ channels: [gated, pub, verify], roles: [{ id: 'rv', position: 1, managed: false }] });
  const i = await run(guild, { sub: 'remove' });
  assert.match(last(i).content, /<#c2>/);
  assert.doesNotMatch(last(i).content, /<#c1>/);
  assert.deepEqual((await listRecords(db, G)).map((r) => r.channelId), ['c2']);
  const { enabled, config } = await getFeature(db, G, 'verification');
  assert.equal(enabled, true);
  assert.equal(config.state, 'active');
  assert.deepEqual(verify.deleted, [], 'the panel stays while something failed');

  pub.permissionOverwrites.edit = okEdit;
  pub.permissionOverwrites.delete = okDelete;
  const again = await run(guild, { sub: 'remove' });
  assert.doesNotMatch(last(again).content, /<#c2>/);
  assert.equal((await listRecords(db, G)).length, 0);
  const done = await getFeature(db, G, 'verification');
  assert.equal(done.enabled, false);
  assert.equal(done.config.state, 'none');
  assert.deepEqual(verify.deleted, ['m1']);
});

test('remove turns verification off before restoring, and restores a record an in-flight gate wrote', async () => {
  const { gated, pub, verify } = await removable();
  const late = fakeChannel('c3', [ow(G, 0n, P.ViewChannel), ow('rv', P.ViewChannel, 0n)]);
  const seen = [];
  const del = gated.permissionOverwrites.delete;
  gated.permissionOverwrites.delete = async (target) => {
    const { enabled, config } = await getFeature(db, G, 'verification');
    seen.push({ enabled, state: config.state });
    // A gate batch that read rolling_out just before remove finishes this channel now.
    await recordOriginal(db, G, 'c3', {
      everyone: { existed: false, allow: '0', deny: '0' }, verified: { existed: false, allow: '0', deny: '0' }, bot: null,
    });
    return del(target);
  };
  const guild = makeGuild({ channels: [gated, pub, verify, late], roles: [{ id: 'rv', position: 1, managed: false }] });
  const i = await run(guild, { sub: 'remove' });
  assert.deepEqual(seen[0], { enabled: false, state: 'none' });
  assert.equal((await listRecords(db, G)).length, 0);
  assert.equal(late.permissionOverwrites.cache.has(G), false, 'the late channel is open again');
  assert.equal(late.permissionOverwrites.cache.has('rv'), false);
  assert.doesNotMatch(last(i).content, /<#/);
  const done = await getFeature(db, G, 'verification');
  assert.equal(done.enabled, false);
  assert.equal(done.config.state, 'none');
});

test('a remove that fails part-way during a rollout leaves a retryable failed state', async () => {
  const { gated, pub, verify } = await removable();
  await setFeature(db, G, 'verification', { config: { state: 'rolling_out', cutoff: 1, grantDone: true } });
  const boom = async () => { throw new Error('Missing Permissions'); };
  const okEdit = pub.permissionOverwrites.edit;
  const okDelete = pub.permissionOverwrites.delete;
  pub.permissionOverwrites.edit = boom;
  pub.permissionOverwrites.delete = boom;
  const guild = makeGuild({ channels: [gated, pub, verify], roles: [{ id: 'rv', position: 1, managed: false }] });
  const i = await run(guild, { sub: 'remove' });
  assert.match(last(i).content, /<#c2>/);
  let { enabled, config } = await getFeature(db, G, 'verification');
  assert.equal(enabled, true);
  assert.equal(config.state, 'failed');
  assert.equal((await db.query('SELECT 1 FROM scheduled_jobs WHERE guild_id = $1', [G])).rowCount, 0);
  const status = await run(guild, { sub: 'status' });
  assert.match(last(status).content, /Channels with a saved undo record: 1/);

  pub.permissionOverwrites.edit = okEdit;
  pub.permissionOverwrites.delete = okDelete;
  await run(guild, { sub: 'remove' });
  ({ enabled, config } = await getFeature(db, G, 'verification'));
  assert.equal(enabled, false);
  assert.equal(config.state, 'none');
  assert.equal((await listRecords(db, G)).length, 0);
});

test('remove leaves the role and verify channel, and stops the rollout jobs', async () => {
  const { gated, pub, verify } = await removable();
  await setFeature(db, G, 'verification', { config: { state: 'rolling_out', cutoff: 1 } });
  await scheduleJob(db, { guildId: G, type: 'verification.gate', key: 'rollout', payload: {}, dueAt: Date.now() });
  const role = { id: 'rv', position: 1, managed: false, deleted: false, delete: async () => { role.deleted = true; } };
  const guild = makeGuild({ channels: [gated, pub, verify], roles: [role] });
  await run(guild, { sub: 'remove' });
  assert.equal(role.deleted, false);
  assert.equal(verify.calls.some((c) => c.op === 'channel-delete'), false);
  const cfg = await raw();
  assert.equal(cfg.roleId, 'rv');
  assert.equal(cfg.channelId, 'cv');
  assert.equal(cfg.state, 'none');
  const jobs = await db.query('SELECT 1 FROM scheduled_jobs WHERE guild_id = $1', [G]);
  assert.equal(jobs.rowCount, 0);
});

test('non-managers and unknown setup actions are answered privately', async () => {
  const guild = makeGuild();
  const denied = await run(guild, { sub: 'status', manage: false });
  assert.equal(last(denied).flags, 64);
  const unknown = await press(guild, 'verification:setup:zzz:admin');
  assert.equal(last(unknown).flags, 64);
});
