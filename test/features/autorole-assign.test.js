import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import {
  assignAutoRole, rememberMemberRoles, grantTimedRole, purgeRememberedRoles, events, MEMORY_MAX_AGE_MS,
} from '../../src/features/autorole/assign.js';
import { setFeature } from '../../src/db/settings.js';
import { runDueJobs } from '../../src/core/scheduler.js';
import { collectModules } from '../../src/core/loader.js';
import * as autorole from '../../src/features/autorole/index.js';
import { queueRole, takeRemembered, rememberRoles } from '../../src/features/autorole/store.js';
import { testDb } from '../helpers/db.js';

const realWarn = console.warn;
let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings, scheduled_jobs, remembered_roles'); });
after(async () => { console.warn = realWarn; await db.end(); });

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const ROLE_DEFS = {
  g1: { id: 'g1', managed: false, position: 0 },
  h1: { id: 'h1', managed: false, position: 1 },
  h2: { id: 'h2', managed: false, position: 2 },
  b1: { id: 'b1', managed: false, position: 1 },
  t1: { id: 't1', managed: false, position: 3 },
  m1: { id: 'm1', managed: true, position: 1 },
  hi: { id: 'hi', managed: false, position: 50 },
  bl: { id: 'bl', managed: false, position: 2 },
  x1: { id: 'x1', managed: false, position: 2 },
};

function fakeGuild(roleIds = Object.keys(ROLE_DEFS), members = new Map()) {
  return {
    id: 'g1',
    roles: { cache: new Map(roleIds.map((id) => [id, ROLE_DEFS[id]])) },
    members: {
      me: { roles: { highest: { position: 10 } } },
      fetch: async (id) => {
        const m = members.get(id);
        if (!m) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return m;
      },
    },
  };
}

function fakeMember(guild, { id = 'u1', bot = false, roles = ['g1'], partial = false, failOn } = {}) {
  const added = [];
  return {
    id, partial, guild, user: { bot }, added,
    roles: {
      cache: new Map(roles.map((r) => [r, ROLE_DEFS[r] ?? { id: r }])),
      add: async (rid) => {
        if (rid === failOn) throw new Error('Missing Permissions');
        added.push(rid);
      },
    },
  };
}

const enable = (config, enabled = true) => setFeature(db, 'g1', 'autorole', { enabled, config });
const ctxFor = (guilds = []) => ({
  db, client: { guilds: { cache: new Map(guilds.map((g) => [g.id, g])) } },
});

async function withWarnings(fn) {
  const warnings = [];
  console.warn = (...a) => { warnings.push(a.join(' ')); };
  try { await fn(warnings); } finally { console.warn = realWarn; }
}

test('events wire member add and remove', () => {
  assert.deepEqual(events.map((e) => e.name), [Events.GuildMemberAdd, Events.GuildMemberRemove]);
  assert.equal(events[0].execute, assignAutoRole);
  assert.equal(events[1].execute, rememberMemberRoles);
});

test('(a) humans get roles, bots get bot roles only', async () => {
  await enable({ roles: ['h1', 'h2'], botRoles: ['b1'] });
  const g = fakeGuild();
  const human = fakeMember(g);
  const bot = fakeMember(g, { id: 'u2', bot: true });
  await assignAutoRole(ctxFor(), human);
  await assignAutoRole(ctxFor(), bot);
  assert.deepEqual(human.added, ['h1', 'h2']);
  assert.deepEqual(bot.added, ['b1']);
});

test('(b) legacy single-role config works', async () => {
  await enable({ humanRoleId: 'h1', botRoleId: 'b1' });
  const g = fakeGuild();
  const human = fakeMember(g);
  const bot = fakeMember(g, { id: 'u2', bot: true });
  await assignAutoRole(ctxFor(), human);
  await assignAutoRole(ctxFor(), bot);
  assert.deepEqual(human.added, ['h1']);
  assert.deepEqual(bot.added, ['b1']);
});

test('(c) feature off adds nothing', async () => {
  await enable({ roles: ['h1'], timed: [{ roleId: 't1', seconds: 60 }] }, false);
  const m = fakeMember(fakeGuild());
  await assignAutoRole(ctxFor(), m);
  assert.deepEqual(m.added, []);
  const { rows } = await db.query("SELECT * FROM scheduled_jobs WHERE type = 'autorole.grant'");
  assert.equal(rows.length, 0);
});

test('(d) one failing add warns and the others still go', async () => {
  await enable({ roles: ['h1', 'h2'] });
  const m = fakeMember(fakeGuild(), { failOn: 'h1' });
  await withWarnings(async (warnings) => {
    await assignAutoRole(ctxFor(), m);
    assert.deepEqual(m.added, ['h2']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Auto role failed in g1: Missing Permissions/);
  });
});

test('(e) timed roles queue for humans only; rejoin keeps one row', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 90 }] });
  const g = fakeGuild();
  const human = fakeMember(g);
  await assignAutoRole(ctxFor(), human, { now: NOW });
  await assignAutoRole(ctxFor(), fakeMember(g, { id: 'u2', bot: true }), { now: NOW });
  let { rows } = await db.query("SELECT * FROM scheduled_jobs WHERE type = 'autorole.grant'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.userId, 'u1');
  assert.equal(rows[0].due_at.getTime(), NOW + 90_000);
  await assignAutoRole(ctxFor(), fakeMember(g), { now: NOW + 5000 });
  ({ rows } = await db.query("SELECT * FROM scheduled_jobs WHERE type = 'autorole.grant'"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].due_at.getTime(), NOW + 95_000);
});

const jobFor = (userId, roleId, guildId = 'g1') =>
  ({ id: 1, guildId, type: 'autorole.grant', key: `${userId}:${roleId}`, attempts: 1, payload: { userId, roleId } });

test('(f) grantTimedRole gives the role and ignores a role removed from the timed list', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }, { roleId: 'h2', seconds: 60 }] });
  const g = fakeGuild();
  const m = fakeMember(g);
  g.members.fetch = async () => m;
  await grantTimedRole(ctxFor([g]), jobFor('u1', 't1'));
  await grantTimedRole(ctxFor([g]), jobFor('u1', 'x1')); // no longer a timed role
  assert.deepEqual(m.added, ['t1']);
});

test('(g) grantTimedRole finishes quietly for a member who left', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] });
  const g = fakeGuild();
  await withWarnings(async (warnings) => {
    await grantTimedRole(ctxFor([g]), jobFor('gone', 't1'));
    assert.deepEqual(warnings, []);
  });
});

test('grantTimedRole finishes quietly for an unknown role', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] });
  const g = fakeGuild();
  const m = fakeMember(g);
  m.roles.add = async () => { throw Object.assign(new Error('Unknown Role'), { code: 10011, status: 404 }); };
  g.members.fetch = async () => m;
  await withWarnings(async (warnings) => {
    await grantTimedRole(ctxFor([g]), jobFor('u1', 't1'));
    assert.deepEqual(warnings, []);
  });
});

test('grantTimedRole returns after a warning on a 403 (missing permission or role above the bot)', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] });
  const g = fakeGuild();
  const m = fakeMember(g);
  m.roles.add = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013, status: 403 }); };
  g.members.fetch = async () => m;
  await withWarnings(async (warnings) => {
    await grantTimedRole(ctxFor([g]), jobFor('u1', 't1'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Missing Permissions/);
  });
});

test('grantTimedRole rethrows a network error and a 500 so the scheduler retries', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] });
  for (const err of [new Error('ECONNRESET'), Object.assign(new Error('Server error'), { status: 500 }),
    Object.assign(new Error('Rate limited'), { status: 429 })]) {
    const g = fakeGuild();
    g.members.fetch = async () => { throw err; };
    await assert.rejects(grantTimedRole(ctxFor([g]), jobFor('u1', 't1')), err);
  }
});

test('(h) reassign off remembers and re-gives nothing, and clears an old memory at join', async () => {
  await enable({ roles: ['h1'], reassign: false });
  const g = fakeGuild();
  await rememberMemberRoles(ctxFor(), fakeMember(g, { roles: ['g1', 'h2'] }), { now: NOW });
  let { rows } = await db.query('SELECT * FROM remembered_roles');
  assert.equal(rows.length, 0);
  await rememberRoles(db, 'g1', 'u1', ['h2'], NOW);
  const m = fakeMember(g);
  await assignAutoRole(ctxFor(), m, { now: NOW + 1000 });
  assert.deepEqual(m.added, ['h1']);
  ({ rows } = await db.query('SELECT * FROM remembered_roles'));
  assert.equal(rows.length, 0, 'memory is not used and is cleared');
});

test('(i) reassign remembers filtered roles and gives them back without duplicates', async () => {
  await enable({ roles: ['h1'], reassign: true, blacklist: ['bl'] });
  const g = fakeGuild();
  const leaver = fakeMember(g, { roles: ['g1', 'h1', 'h2', 'm1', 'bl', 'hi'] });
  await rememberMemberRoles(ctxFor(), leaver, { now: NOW });
  const { rows } = await db.query('SELECT role_ids FROM remembered_roles');
  assert.deepEqual(rows[0].role_ids, ['h1', 'h2']);
  const back = fakeMember(g);
  await assignAutoRole(ctxFor(), back, { now: NOW + DAY });
  assert.deepEqual(back.added, ['h1', 'h2']);
});

test('reassign does not remember bots', async () => {
  await enable({ reassign: true });
  await rememberMemberRoles(ctxFor(), fakeMember(fakeGuild(), { bot: true, roles: ['g1', 'h1'] }), { now: NOW });
  const { rows } = await db.query('SELECT * FROM remembered_roles');
  assert.equal(rows.length, 0);
});

test('(j) memory older than 30 days is ignored', async () => {
  assert.equal(MEMORY_MAX_AGE_MS, 30 * DAY);
  await enable({ reassign: true });
  await rememberRoles(db, 'g1', 'u1', ['h2'], NOW - 31 * DAY);
  const m = fakeMember(fakeGuild());
  await assignAutoRole(ctxFor(), m, { now: NOW });
  assert.deepEqual(m.added, []);
});

test('(k) partial members do not overwrite a memory, even with only @everyone cached', async () => {
  await enable({ reassign: true });
  const g = fakeGuild();
  await rememberRoles(db, 'g1', 'u1', ['h2'], NOW - DAY);
  await rememberMemberRoles(ctxFor(), fakeMember(g, { partial: true, roles: ['g1', 'h1'] }), { now: NOW });
  await rememberMemberRoles(ctxFor(), fakeMember(g, { partial: true, roles: ['g1'] }), { now: NOW });
  assert.deepEqual(await takeRemembered(db, 'g1', 'u1', NOW, MEMORY_MAX_AGE_MS), ['h2']);
});

test('a full member with only @everyone overwrites the memory with an empty list', async () => {
  await enable({ reassign: true });
  await rememberRoles(db, 'g1', 'u1', ['h2'], NOW - DAY);
  await rememberMemberRoles(ctxFor(), fakeMember(fakeGuild(), { roles: ['g1'] }), { now: NOW });
  const { rows } = await db.query('SELECT role_ids, left_at FROM remembered_roles');
  assert.deepEqual(rows[0].role_ids, []);
  assert.equal(rows[0].left_at.getTime(), NOW);
});

test('stale memory: a role lost while away is not given back later', async () => {
  await enable({ reassign: true });
  const g = fakeGuild();
  // Leaves holding h2 (say Mod): it is remembered.
  await rememberMemberRoles(ctxFor(), fakeMember(g, { roles: ['g1', 'h2'] }), { now: NOW });
  // Rejoins while the feature is off, so the memory is neither read nor deleted.
  await enable({ reassign: true }, false);
  const quiet = fakeMember(g);
  await assignAutoRole(ctxFor(), quiet, { now: NOW + DAY });
  assert.deepEqual(quiet.added, []);
  await enable({ reassign: true });
  // Leaves again with no roles (a full, non-partial member).
  await rememberMemberRoles(ctxFor(), fakeMember(g, { roles: ['g1'] }), { now: NOW + 2 * DAY });
  // Rejoins within 30 days of the first leave: h2 must not come back.
  const back = fakeMember(g);
  await assignAutoRole(ctxFor(), back, { now: NOW + 3 * DAY });
  assert.deepEqual(back.added, []);
});

test('(l) a deleted role is not re-given', async () => {
  await enable({ reassign: true });
  await rememberRoles(db, 'g1', 'u1', ['h1', 'h2'], NOW - DAY);
  const m = fakeMember(fakeGuild(['g1', 'h2']));
  await assignAutoRole(ctxFor(), m, { now: NOW });
  assert.deepEqual(m.added, ['h2']);
});

test('grantTimedRole finishes quietly when the guild is not in the cache', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] });
  const ctx = { db, client: { isReady: () => true, guilds: { cache: new Map() } } };
  await withWarnings(async (warnings) => {
    await grantTimedRole(ctx, jobFor('u1', 't1'));
    assert.deepEqual(warnings, []);
  });
});

test('grantTimedRole finishes without granting when the feature is disabled', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] }, false);
  const g = fakeGuild();
  const m = fakeMember(g);
  g.members.fetch = async () => m;
  await grantTimedRole(ctxFor([g]), jobFor('u1', 't1'));
  assert.deepEqual(m.added, []);
});

test('purgeRememberedRoles removes memories older than 30 days', async () => {
  await rememberRoles(db, 'g1', 'old', ['h1'], NOW - 31 * DAY);
  await rememberRoles(db, 'g1', 'new', ['h2'], NOW - DAY);
  await purgeRememberedRoles(ctxFor(), { now: NOW });
  const { rows } = await db.query('SELECT user_id FROM remembered_roles');
  assert.deepEqual(rows.map((r) => r.user_id), ['new']);
});

test('purgeRememberedRoles warns instead of throwing when the database fails', async () => {
  const broken = { db: { query: async () => { throw new Error('db down'); } } };
  await withWarnings(async (warnings) => {
    await purgeRememberedRoles(broken, { now: NOW });
    assert.equal(warnings.length, 1);
  });
});

test('the scheduler grants a due timed role through the autorole jobs and housekeeping', async () => {
  assert.equal(autorole.jobs['autorole.grant'], grantTimedRole);
  assert.deepEqual(autorole.housekeeping, [purgeRememberedRoles]);
  await enable({ timed: [{ roleId: 't1', seconds: 60 }, { roleId: 'h2', seconds: 60 }] });
  const g = fakeGuild();
  const m = fakeMember(g);
  g.members.fetch = async () => m;
  await queueRole(db, 'g1', 'u1', 't1', NOW - 1000);
  await queueRole(db, 'g1', 'u1', 'h2', NOW + 60_000);
  await rememberRoles(db, 'g1', 'stale', ['h1'], NOW - 31 * DAY);
  const registry = collectModules([autorole]);
  const ctx = { ...ctxFor([g]) };
  ctx.client.isReady = () => true;
  await runDueJobs(ctx, registry, { now: NOW });
  assert.deepEqual(m.added, ['t1']);
  const { rows } = await db.query("SELECT payload->>'roleId' AS role_id FROM scheduled_jobs");
  assert.deepEqual(rows.map((r) => r.role_id), ['h2']);
  assert.equal((await db.query('SELECT * FROM remembered_roles')).rows.length, 0);
});

test('a remembered role that is also timed is given and not queued', async () => {
  await enable({ reassign: true, timed: [{ roleId: 't1', seconds: 60 }, { roleId: 'h2', seconds: 60 }] });
  await rememberRoles(db, 'g1', 'u1', ['t1'], NOW - DAY);
  const m = fakeMember(fakeGuild());
  await assignAutoRole(ctxFor(), m, { now: NOW });
  assert.deepEqual(m.added, ['t1']);
  const { rows } = await db.query("SELECT payload->>'roleId' AS role_id FROM scheduled_jobs WHERE type = 'autorole.grant'");
  assert.deepEqual(rows.map((r) => r.role_id), ['h2']);
});

test('a memory holding the guild id never gives @everyone', async () => {
  await enable({ reassign: true });
  await rememberRoles(db, 'g1', 'u1', ['g1', 'h2'], NOW - DAY);
  const m = fakeMember(fakeGuild());
  await assignAutoRole(ctxFor(), m, { now: NOW });
  assert.deepEqual(m.added, ['h2']);
});
