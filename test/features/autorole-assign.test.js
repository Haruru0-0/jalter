import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Events } from 'discord.js';
import {
  assignAutoRole, rememberMemberRoles, runDue, startTicker, events, MEMORY_MAX_AGE_MS,
} from '../../src/features/autorole/assign.js';
import { setFeature } from '../../src/db/settings.js';
import { queueRole, takeRemembered, rememberRoles } from '../../src/features/autorole/store.js';
import { testDb } from '../helpers/db.js';

const realWarn = console.warn;
let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings, pending_roles, remembered_roles'); });
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
  const { rows } = await db.query('SELECT * FROM pending_roles');
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
  let { rows } = await db.query('SELECT * FROM pending_roles');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 'u1');
  assert.equal(rows[0].due_at.getTime(), NOW + 90_000);
  await assignAutoRole(ctxFor(), fakeMember(g), { now: NOW + 5000 });
  ({ rows } = await db.query('SELECT * FROM pending_roles'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].due_at.getTime(), NOW + 95_000);
});

test('(f) runDue gives due roles, skips future ones and removed timed roles', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }, { roleId: 'h2', seconds: 60 }] });
  const g = fakeGuild();
  const m = fakeMember(g);
  await queueRole(db, 'g1', 'u1', 't1', NOW - 1000);
  await queueRole(db, 'g1', 'u1', 'h2', NOW + 60_000);
  await queueRole(db, 'g1', 'u1', 'x1', NOW - 1000); // no longer a timed role
  g.members.fetch = async () => m;
  await runDue(ctxFor([g]), { now: NOW });
  assert.deepEqual(m.added, ['t1']);
  const { rows } = await db.query('SELECT role_id FROM pending_roles');
  assert.deepEqual(rows.map((r) => r.role_id), ['h2']);
});

test('(g) runDue drops a row for a member who left', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] });
  const g = fakeGuild();
  await queueRole(db, 'g1', 'gone', 't1', NOW - 1000);
  await runDue(ctxFor([g]), { now: NOW });
  const { rows } = await db.query('SELECT * FROM pending_roles');
  assert.equal(rows.length, 0);
});

test('runDue warns on an unexpected error and drops the row', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] });
  const g = fakeGuild();
  g.members.fetch = async () => { throw new Error('boom'); };
  await queueRole(db, 'g1', 'u1', 't1', NOW - 1000);
  await withWarnings(async (warnings) => {
    await runDue(ctxFor([g]), { now: NOW });
    assert.equal(warnings.length, 1);
  });
  const { rows } = await db.query('SELECT * FROM pending_roles');
  assert.equal(rows.length, 0);
});

test('(h) reassign off remembers and re-gives nothing', async () => {
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
  assert.equal(rows.length, 1, 'memory is neither read nor consumed');
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

test('(k) partial or only-everyone members do not overwrite a memory', async () => {
  await enable({ reassign: true });
  const g = fakeGuild();
  await rememberRoles(db, 'g1', 'u1', ['h2'], NOW - DAY);
  await rememberMemberRoles(ctxFor(), fakeMember(g, { partial: true, roles: ['g1', 'h1'] }), { now: NOW });
  await rememberMemberRoles(ctxFor(), fakeMember(g, { roles: ['g1'] }), { now: NOW });
  assert.deepEqual(await takeRemembered(db, 'g1', 'u1', NOW, MEMORY_MAX_AGE_MS), ['h2']);
});

test('(l) a deleted role is not re-given', async () => {
  await enable({ reassign: true });
  await rememberRoles(db, 'g1', 'u1', ['h1', 'h2'], NOW - DAY);
  const m = fakeMember(fakeGuild(['g1', 'h2']));
  await assignAutoRole(ctxFor(), m, { now: NOW });
  assert.deepEqual(m.added, ['h2']);
});

test('(m) ticker never overlaps runs, catches errors, and stops', async () => {
  await enable({ timed: [{ roleId: 't1', seconds: 60 }] });
  let fetches = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const g = fakeGuild();
  g.members.fetch = async () => { fetches += 1; await gate; throw new Error('boom'); };
  await queueRole(db, 'g1', 'u1', 't1', Date.now() - 1000);
  await withWarnings(async () => {
    const ticker = startTicker(ctxFor([g]), { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(fetches, 1, 'second tick waits for the first run');
    release();
    await new Promise((r) => setTimeout(r, 50));
    ticker.stop();
  });
  const settled = fetches;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fetches, settled, 'no more runs after stop');
});

test('ticker catches an error thrown by a run', async () => {
  const broken = { db: { query: async () => { throw new Error('db down'); } }, client: { guilds: { cache: new Map() } } };
  await withWarnings(async (warnings) => {
    const ticker = startTicker(broken, { intervalMs: 10 });
    await new Promise((r) => setTimeout(r, 60));
    ticker.stop();
    assert.ok(warnings.length >= 1);
  });
});
