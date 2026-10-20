import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { readConfig } from '../../src/features/antiraid/config.js';
import { readConfig as readModConfig } from '../../src/features/moderation/config.js';
import { createJoinStore } from '../../src/features/antiraid/joins.js';
import {
  startLockdown, endLockdown, kickYoungJoin, endJob, END_JOB, END_KEY, MAX_KICKS,
} from '../../src/features/antiraid/lockdown.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
  await db.query('DELETE FROM scheduled_jobs');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const NOW = 1_700_000_000_000;
const DAY = 86400 * 1000;
const UNKNOWN_MEMBER = 10007;

function makeMember({
  id, bot = false, createdAt = 0, top = 1, manage = false, managerRole = false, verified = false,
} = {}) {
  const roles = new Map();
  if (managerRole) roles.set('mgr', { id: 'mgr', position: 0 });
  if (verified) roles.set('verified', { id: 'verified', position: 0 });
  return {
    id,
    guild: { id: G },
    user: { id, bot, createdTimestamp: createdAt },
    roles: { cache: roles, highest: { position: top } },
    permissions: { has: (p) => manage && p === 'ManageGuild' },
  };
}

function makeGuild({ ownerId = 'owner', botTop = 10, members = new Map(), incidents = null, failIncident = false } = {}) {
  const incidentCalls = [];
  const guild = {
    id: G,
    ownerId,
    incidentsData: incidents,
    members: {
      me: {
        id: 'bot1',
        guild: { id: G },
        roles: { highest: { position: botTop } },
        permissions: { has: () => true },
      },
      fetch: async (userId) => {
        const member = members.get(userId);
        if (!member) {
          const err = new Error('Unknown Member');
          err.code = UNKNOWN_MEMBER;
          throw err;
        }
        return member;
      },
    },
    setIncidentActions: async (payload) => {
      incidentCalls.push(payload);
      if (failIncident) throw new Error('Missing Permissions');
    },
  };
  return { guild, incidentCalls };
}

// The dependencies the engine uses, with the calls they received.
function makeDeps(overrides = {}) {
  const calls = { run: [], log: [], sent: [] };
  const deps = {
    now: () => NOW,
    runAction: async (ctx, params) => {
      calls.run.push(params);
      return { ok: true, modCase: { number: calls.run.length }, warnings: [] };
    },
    sendLog: async (ctx, guildId, event, embed) => {
      calls.log.push({ guildId, event, embed });
      return { channelId: 'modchan', messageId: 'm1' };
    },
    trySend: async (channel, payload) => {
      calls.sent.push({ channel, payload });
      return { id: 'p1', channelId: channel.id };
    },
    fetchSendable: async (client, channelId) => ({ id: channelId, isTextBased: () => true }),
    joins: createJoinStore(),
    ...overrides,
  };
  return { deps, calls };
}

const ctxFor = (guild, dbOverride = db) => ({
  db: dbOverride,
  client: { guilds: { cache: new Map([[G, guild]]) } },
});

const cfgOf = async () => readConfig((await getFeature(db, G, 'antiraid')).config);
const enable = async (config = {}) => setFeature(db, G, 'antiraid', { enabled: true, config });

const candidates = (...specs) => specs.map(([userId, ageMs]) => ({
  userId, createdAt: NOW - ageMs,
}));

// ---- the start -----------------------------------------------------------------------------

test('start flips state, queues the end job at lockedUntil and returns ok', async () => {
  const { guild } = makeGuild();
  await enable({ durationSeconds: 1800 });
  const { deps } = makeDeps();
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 10, candidates: [],
  }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.kicked, 0);
  const config = await cfgOf();
  assert.equal(config.state, 'locked');
  assert.equal(config.lockedAt, NOW);
  assert.equal(config.lockedUntil, NOW + 1800 * 1000);
  assert.equal(config.startedBy, 'auto');
  assert.equal(config.kicked, 0);
  const { rows } = await db.query('SELECT type, key, due_at FROM scheduled_jobs WHERE guild_id = $1', [G]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, END_JOB);
  assert.equal(rows[0].key, END_KEY);
  assert.equal(Math.round(new Date(rows[0].due_at).getTime()), NOW + 1800 * 1000);
});

test('a second start returns already_locked and changes nothing', async () => {
  const { guild } = makeGuild();
  await enable();
  const { deps } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  const before = await cfgOf();
  const res = await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  assert.deepEqual(res, { ok: false, reason: 'already_locked' });
  const after = await cfgOf();
  assert.equal(after.lockedAt, before.lockedAt);
  assert.equal(after.lockedUntil, before.lockedUntil);
});

test('two concurrent starts: exactly one wins', async () => {
  const { guild } = makeGuild();
  await enable();
  const { deps } = makeDeps();
  const [a, b] = await Promise.all([
    startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps),
    startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps),
  ]);
  const winners = [a, b].filter((r) => r.ok === true);
  const losers = [a, b].filter((r) => r.ok !== true);
  assert.equal(winners.length, 1);
  assert.deepEqual(losers, [{ ok: false, reason: 'already_locked' }]);
});

test('start while the feature is disabled returns disabled', async () => {
  const { guild } = makeGuild();
  await setFeature(db, G, 'antiraid', { enabled: false, config: {} });
  const { deps } = makeDeps();
  const res = await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  assert.deepEqual(res, { ok: false, reason: 'disabled' });
  assert.equal((await cfgOf()).state, 'idle');
});

test('young accounts in the burst are kicked with the bot as actor and a localized reason, older accounts are not', async () => {
  const members = new Map([
    ['u1', makeMember({ id: 'u1', createdAt: NOW - 1000 })],
    ['u2', makeMember({ id: 'u2', createdAt: NOW - 8 * DAY })],
  ]);
  const { guild } = makeGuild({ members });
  await enable();
  const { deps, calls } = makeDeps();
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 2,
    candidates: candidates(['u1', 1000], ['u2', 8 * DAY]),
  }, deps);
  assert.equal(res.kicked, 1);
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0].type, 'kick');
  assert.equal(calls.run[0].targetId, 'u1');
  assert.equal(calls.run[0].actor, guild.members.me);
  assert.equal(calls.run[0].reason, t('en', 'antiraid.kick_reason'));
  assert.equal(calls.run[0].lang, 'en');
  assert.deepEqual(calls.run[0].config, readModConfig({}), 'the moderation settings, even when moderation is off');
});

test('the owner, a member at or above the bot, a manager, a bot and a member who left are never kicked', async () => {
  const members = new Map([
    ['owner', makeMember({ id: 'owner', createdAt: NOW - 1000, top: 1 })],
    ['high', makeMember({ id: 'high', createdAt: NOW - 1000, top: 99 })],
    ['mgr', makeMember({ id: 'mgr', createdAt: NOW - 1000, top: 1, manage: true })],
    ['bot', makeMember({ id: 'bot', bot: true, createdAt: NOW - 1000, top: 1 })],
  ]);
  const { guild } = makeGuild({ members });
  await enable();
  const { deps, calls } = makeDeps();
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 5,
    candidates: candidates(
      ['owner', 1000], ['high', 1000], ['mgr', 1000], ['bot', 1000], ['gone', 1000],
    ),
  }, deps);
  assert.equal(res.kicked, 0);
  assert.equal(calls.run.length, 0);
});

test('a member with the bot manager role is never kicked', async () => {
  const members = new Map([
    ['mgr', makeMember({ id: 'mgr', createdAt: NOW - 1000, top: 1, managerRole: true })],
  ]);
  const { guild } = makeGuild({ members });
  await enable();
  await setFeature(db, G, 'panel', { config: { managerRoleId: 'mgr' } });
  const { deps, calls } = makeDeps();
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 1, candidates: candidates(['mgr', 1000]),
  }, deps);
  assert.equal(res.kicked, 0);
  assert.equal(calls.run.length, 0);
});

test('a verified member is still kicked', async () => {
  const members = new Map([
    ['v1', makeMember({ id: 'v1', createdAt: NOW - 1000, verified: true })],
  ]);
  const { guild } = makeGuild({ members });
  await enable();
  await setFeature(db, G, 'verification', { enabled: true, config: { roleId: 'verified' } });
  const { deps, calls } = makeDeps();
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 1, candidates: candidates(['v1', 1000]),
  }, deps);
  assert.equal(res.kicked, 1);
  assert.equal(calls.run.length, 1);
});

test('no more than 100 are kicked', async () => {
  const members = new Map();
  const list = [];
  for (let i = 0; i < 150; i += 1) {
    members.set(`u${i}`, makeMember({ id: `u${i}`, createdAt: NOW - 1000 }));
    list.push(['u${i}'.replace('${i}', String(i)), 1000]);
  }
  const { guild } = makeGuild({ members });
  await enable();
  const { deps, calls } = makeDeps();
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 150, candidates: candidates(...list),
  }, deps);
  assert.equal(res.kicked, MAX_KICKS);
  assert.equal(calls.run.length, MAX_KICKS);
});

// ---- the alert -----------------------------------------------------------------------------

test('the alert goes through sendLog and the ping message mentions only the configured role', async () => {
  const { guild } = makeGuild();
  await enable({ pingRoleId: 'r9' });
  const { deps, calls } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto', joinedCount: 10 }, deps);
  assert.equal(calls.log.length, 1);
  assert.equal(calls.log[0].event, 'modAction');
  assert.equal(calls.log[0].guildId, G);
  assert.ok(calls.log[0].embed.title);
  assert.equal(calls.sent.length, 1);
  assert.ok(calls.sent[0].payload.content.includes('<@&r9>'));
  assert.deepEqual(calls.sent[0].payload.allowedMentions, { parse: [], roles: ['r9'] });
});

test('the ping falls back to the manager role', async () => {
  const { guild } = makeGuild();
  await enable({ pingRoleId: null });
  await setFeature(db, G, 'panel', { config: { managerRoleId: 'mgr' } });
  const { deps, calls } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  assert.equal(calls.sent.length, 1);
  assert.ok(calls.sent[0].payload.content.includes('<@&mgr>'));
  assert.deepEqual(calls.sent[0].payload.allowedMentions, { parse: [], roles: ['mgr'] });
});

test('the guild id is never pinged', async () => {
  const { guild } = makeGuild();
  await enable({ pingRoleId: null });
  await setFeature(db, G, 'panel', { config: { managerRoleId: G } });
  const { deps, calls } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  assert.equal(calls.sent.length, 0, 'nobody is pinged');
  assert.equal((await cfgOf()).alertResult, 'sent');
});

test('sendLog returning null records alertResult no_channel and the rest still runs', async () => {
  const members = new Map([['u1', makeMember({ id: 'u1', createdAt: NOW - 1000 })]]);
  const { guild } = makeGuild({ members });
  await enable();
  const { deps, calls } = makeDeps({ sendLog: async () => null });
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 1, candidates: candidates(['u1', 1000]),
  }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.kicked, 1, 'the kicks still ran');
  assert.equal((await cfgOf()).alertResult, 'no_channel');
  assert.equal(calls.sent.length, 0);
});

// ---- the invite pause ----------------------------------------------------------------------

test('the invite pause is requested until lockedUntil and recorded paused', async () => {
  const { guild, incidentCalls } = makeGuild();
  await enable({ durationSeconds: 1800 });
  const { deps } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  assert.deepEqual(incidentCalls, [{ invitesDisabledUntil: new Date(NOW + 1800 * 1000) }]);
  const config = await cfgOf();
  assert.equal(config.inviteResult, 'paused');
  assert.equal(config.invitesPausedByUs, true);
});

test('an invite pause already in the future is left alone and recorded already, and end does not lift it', async () => {
  const { guild, incidentCalls } = makeGuild({ incidents: { invitesDisabledUntil: new Date(NOW + 3600_000) } });
  await enable();
  const { deps } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  assert.deepEqual(incidentCalls, [], 'the pause of somebody else is left alone');
  const config = await cfgOf();
  assert.equal(config.inviteResult, 'already');
  assert.equal(config.invitesPausedByUs, false);

  const res = await endLockdown(ctxFor(guild), guild, { by: 'timer' }, deps);
  assert.equal(res.ok, true);
  assert.deepEqual(incidentCalls, [], 'and it is not lifted at the end');
});

test('a refused pause records failed and the kicks still run', async (t) => {
  const members = new Map([['u1', makeMember({ id: 'u1', createdAt: NOW - 1000 })]]);
  const { guild } = makeGuild({ members, failIncident: true });
  await enable();
  const { deps } = makeDeps();
  const warn = t.mock.method(console, 'warn', () => {});
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 1, candidates: candidates(['u1', 1000]),
  }, deps);
  assert.equal(res.ok, true);
  assert.equal(res.kicked, 1);
  const config = await cfgOf();
  assert.equal(config.inviteResult, 'failed');
  assert.equal(config.invitesPausedByUs, false);
  warn.mock.restore();
});

test('a refused kick does not stop the others', async () => {
  const members = new Map([
    ['u1', makeMember({ id: 'u1', createdAt: NOW - 1000 })],
    ['u2', makeMember({ id: 'u2', createdAt: NOW - 1000 })],
  ]);
  const { guild } = makeGuild({ members });
  await enable();
  const calls = [];
  const { deps } = makeDeps({
    runAction: async (ctx, params) => {
      calls.push(params);
      if (params.targetId === 'u1') return { ok: false, reason: 'discord_refused' };
      return { ok: true };
    },
  });
  const res = await startLockdown(ctxFor(guild), guild, {
    trigger: 'auto', startedBy: 'auto', joinedCount: 2, candidates: candidates(['u1', 1000], ['u2', 1000]),
  }, deps);
  assert.equal(res.kicked, 1);
  assert.equal(calls.length, 2);
  assert.equal((await cfgOf()).kicked, 1);
});

// ---- the end -------------------------------------------------------------------------------

test('end flips to idle, cancels the job, lifts only our pause, clears the join store and logs once', async () => {
  const { guild, incidentCalls } = makeGuild();
  await enable();
  const { deps, calls } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  deps.joins.record(G, { userId: 'u9', createdAt: 0 }, NOW, 60_000);

  const res = await endLockdown(ctxFor(guild), guild, { by: 'timer' }, deps);
  assert.equal(res.ok, true);
  const config = await cfgOf();
  assert.equal(config.state, 'idle');
  assert.equal(config.lockedUntil, null);
  assert.equal(config.lockedAt, null);
  assert.equal(config.invitesPausedByUs, false);
  const { rows } = await db.query('SELECT id FROM scheduled_jobs WHERE guild_id = $1', [G]);
  assert.equal(rows.length, 0, 'the end job is cancelled');
  assert.deepEqual(incidentCalls[1], { invitesDisabledUntil: null });
  assert.equal(deps.joins.size(), 0, 'the join list is cleared');
  assert.equal(calls.log.length, 2, 'the alert and the end line');
});

test('end twice: the second returns not_locked and logs nothing', async () => {
  const { guild } = makeGuild();
  await enable();
  const { deps, calls } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  const logsAfterStart = calls.log.length;
  const first = await endLockdown(ctxFor(guild), guild, { by: 'manual', actorId: 'admin' }, deps);
  assert.deepEqual(first, { ok: true });
  const res = await endLockdown(ctxFor(guild), guild, { by: 'manual', actorId: 'admin' }, deps);
  assert.deepEqual(res, { ok: false, reason: 'not_locked' });
  assert.equal(calls.log.length, logsAfterStart + 1, 'only the end line');
});

test('end while idle returns not_locked', async () => {
  const { guild } = makeGuild();
  await enable();
  const { deps, calls } = makeDeps();
  const res = await endLockdown(ctxFor(guild), guild, { by: 'manual', actorId: 'admin' }, deps);
  assert.deepEqual(res, { ok: false, reason: 'not_locked' });
  assert.equal(calls.log.length, 0);
});

test('the end job ends a lockdown and does nothing when already idle', async () => {
  const { guild } = makeGuild();
  await enable();
  const { deps, calls } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  const logsAfterStart = calls.log.length;
  await endJob(ctxFor(guild), { guildId: G, type: END_JOB, key: END_KEY, attempts: 1 }, deps);
  assert.equal((await cfgOf()).state, 'idle');
  assert.equal(calls.log.length, logsAfterStart + 1, 'the end line');
  await endJob(ctxFor(guild), { guildId: G, type: END_JOB, key: END_KEY, attempts: 1 }, deps);
  assert.equal(calls.log.length, logsAfterStart + 1, 'nothing more');
});

test('the end job does nothing for a guild that is not in the cache', async () => {
  const { deps, calls } = makeDeps();
  await endJob({ db, client: { guilds: { cache: new Map() } } }, { guildId: 'other', attempts: 1 }, deps);
  assert.equal(calls.log.length, 0);
});

test('on the last attempt the end job concludes the lockdown even after a thrown error', async () => {
  const { guild } = makeGuild();
  await enable();
  const { deps } = makeDeps();
  let failNext = true;
  const failing = {
    query: async (sql, params) => {
      if (failNext && /SELECT enabled, config/.test(sql)) {
        failNext = false;
        throw new Error('the database is down');
      }
      return db.query(sql, params);
    },
  };
  await setFeature(db, G, 'antiraid', {
    enabled: true, config: { state: 'locked', lockedUntil: NOW + 1000, invitesPausedByUs: false },
  });

  // Not the last attempt: the scheduler will retry, so the lockdown stays.
  await assert.rejects(
    () => endJob(ctxFor(guild, failing), { guildId: G, attempts: 1 }, deps),
    /the database is down/,
  );
  assert.equal((await cfgOf()).state, 'locked');

  failNext = true;
  await assert.rejects(
    () => endJob(ctxFor(guild, failing), { guildId: G, attempts: 5 }, deps),
    /the database is down/,
  );
  assert.equal((await cfgOf()).state, 'idle', 'a lockdown can never stay stuck');
});

// ---- a young join while the lockdown is on --------------------------------------------------

test('kickYoungJoin kicks a young non-spared member and counts it', async () => {
  const member = makeMember({ id: 'u1', createdAt: NOW - 1000 });
  const { guild } = makeGuild({ members: new Map([['u1', member]]) });
  await enable();
  const { deps, calls } = makeDeps();
  const res = await kickYoungJoin(ctxFor(guild), guild, member, deps);
  assert.equal(res, 'kicked');
  assert.equal(calls.run.length, 1);
  assert.equal(calls.run[0].type, 'kick');
  assert.equal(calls.run[0].reason, t('en', 'antiraid.kick_reason'));
  assert.equal((await cfgOf()).kicked, 1);
});

test('kickYoungJoin leaves an old account alone', async () => {
  const member = makeMember({ id: 'u2', createdAt: NOW - 8 * DAY });
  const { guild } = makeGuild({ members: new Map([['u2', member]]) });
  await enable();
  const { deps, calls } = makeDeps();
  const res = await kickYoungJoin(ctxFor(guild), guild, member, deps);
  assert.equal(res, 'old');
  assert.equal(calls.run.length, 0);
  assert.equal((await cfgOf()).kicked, 0);
});

test('kickYoungJoin leaves a spared member alone', async () => {
  const member = makeMember({ id: 'owner', createdAt: NOW - 1000 });
  const { guild } = makeGuild({ members: new Map([['owner', member]]) });
  await enable();
  const { deps, calls } = makeDeps();
  const res = await kickYoungJoin(ctxFor(guild), guild, member, deps);
  assert.equal(res, 'spared');
  assert.equal(calls.run.length, 0);
});

// ---- the config keys -----------------------------------------------------------------------

test('config keys other than the lockdown keys survive start and end', async () => {
  const { guild } = makeGuild();
  await enable({
    joins: 42, windowSeconds: 120, accountAgeSeconds: 3600, durationSeconds: 3600, pingRoleId: 'r9',
  });
  const { deps } = makeDeps();
  await startLockdown(ctxFor(guild), guild, { trigger: 'auto', startedBy: 'auto' }, deps);
  await endLockdown(ctxFor(guild), guild, { by: 'timer' }, deps);
  const config = await cfgOf();
  assert.equal(config.joins, 42);
  assert.equal(config.windowSeconds, 120);
  assert.equal(config.accountAgeSeconds, 3600);
  assert.equal(config.durationSeconds, 3600);
  assert.equal(config.pingRoleId, 'r9');
  assert.equal(config.state, 'idle');
});
