import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import {
  startRollout, grantBatch, gateBatch, GRANT_JOB, GATE_JOB, GRANT_BATCH, GATE_BATCH, jobs,
} from '../../src/features/verification/rollout.js';
import * as feature from '../../src/features/verification/index.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end?.(); });

const G = 'g1';
const CUTOFF = 1_000_000;

async function config(extra = {}) {
  await db.query('DELETE FROM scheduled_jobs');
  await setFeature(db, G, 'verification', {
    enabled: true,
    config: { roleId: '900', channelId: '800', state: 'rolling_out', cutoff: CUTOFF, grantDone: false, ...extra },
  });
}
const raw = async () => (await getFeature(db, G, 'verification')).config;
const pending = async (type) =>
  (await db.query('SELECT payload FROM scheduled_jobs WHERE guild_id = $1 AND type = $2', [G, type])).rows;

function makeMember(id, { joined = CUTOFF - 1, roles = [], addError = null } = {}) {
  const cache = new Map(roles.map((r) => [r, { id: r }]));
  const added = [];
  return {
    id, joinedTimestamp: joined, added,
    roles: {
      cache,
      add: async (rid) => {
        if (addError) throw addError;
        added.push(rid);
        cache.set(rid, { id: rid });
      },
    },
  };
}

function makeGuild({ members = [], channels = [], botTop = 5, role = { id: '900', position: 1, managed: false } } = {}) {
  const mcache = new Map(members.map((m) => [m.id, m]));
  return {
    id: G,
    memberCount: mcache.size,
    roles: { cache: new Map(role ? [[role.id, role]] : []), fetch: async () => role },
    members: { me: { roles: { highest: { position: botTop } } }, cache: mcache, fetch: async () => mcache },
    channels: { fetch: async () => new Map(channels.map((c) => [c.id, c])) },
  };
}

const ctxFor = (guild) => ({ db, client: { guilds: { cache: new Map([[G, guild]]) } } });
const logger = () => {
  const calls = [];
  return { calls, logVerification: async (...a) => { calls.push(a); } };
};
const gater = (results = {}) => {
  const seen = [];
  return { seen, gateChannel: async (ctx, guild, ch) => { seen.push(ch.id); return results[ch.id] ?? 'changed'; } };
};
const job = (type, payload = {}) => ({ guildId: G, type, key: 'rollout', payload, attempts: 1 });
const chan = (id, type = 0) => ({ id, type, isThread: () => false });

beforeEach(async () => { await config(); });

test('startRollout sets rolling_out and schedules the grant job', async () => {
  await db.query('DELETE FROM guild_settings');
  await setFeature(db, G, 'verification', { enabled: true, config: { roleId: '900', state: 'none' } });
  const before = Date.now();
  await startRollout({ db }, { id: G }, 'en', 'admin1');
  const c = await raw();
  assert.equal(c.state, 'rolling_out');
  assert.ok(c.cutoff >= before && c.cutoff <= Date.now());
  assert.equal(c.grantDone, false);
  assert.equal((await pending(GRANT_JOB)).length, 1);
  assert.equal((await pending(GATE_JOB)).length, 0);
  // a second call while the rollout is pending changes nothing (cutoff included)
  await startRollout({ db }, { id: G }, 'en', 'admin2');
  assert.equal((await raw()).cutoff, c.cutoff);
  assert.equal((await raw()).rolloutBy, 'admin1');
  assert.equal((await pending(GRANT_JOB)).length, 1);
});

test('startRollout restarts a rolling_out guild whose jobs are gone', async () => {
  await startRollout({ db }, { id: G }, 'en', 'admin1');
  assert.equal((await pending(GRANT_JOB)).length, 1);
  await db.query('DELETE FROM scheduled_jobs');
  await startRollout({ db }, { id: G }, 'en', 'admin1');
  assert.equal((await pending(GRANT_JOB)).length, 1);
});

test('grantBatch grants members present at the cutoff and skips later joiners', async () => {
  const early = makeMember('1');
  const bot = makeMember('2');
  const late = makeMember('3', { joined: CUTOFF + 1 });
  const has = makeMember('4', { roles: ['900'] });
  const guild = makeGuild({ members: [early, bot, late, has] });
  await grantBatch(ctxFor(guild), job(GRANT_JOB), logger());
  assert.deepEqual(early.added, ['900']);
  assert.deepEqual(bot.added, ['900']);
  assert.deepEqual(late.added, []);
  assert.deepEqual(has.added, []);
});

test('grantBatch is idempotent on a rerun', async () => {
  const m = makeMember('1');
  const guild = makeGuild({ members: [m] });
  await grantBatch(ctxFor(guild), job(GRANT_JOB), logger());
  await grantBatch(ctxFor(guild), job(GRANT_JOB), logger());
  assert.deepEqual(m.added, ['900']);
  assert.equal((await pending(GATE_JOB)).length, 1);
});

test('grantBatch reschedules until the last batch then schedules gate', async () => {
  const members = Array.from({ length: GRANT_BATCH + 5 }, (_, i) => makeMember(String(100 + i)));
  const guild = makeGuild({ members });
  const ctx = ctxFor(guild);
  await grantBatch(ctx, job(GRANT_JOB), { ...logger(), budgetMs: 0 });
  assert.equal(members.filter((m) => m.added.length).length, GRANT_BATCH);
  const next = await pending(GRANT_JOB);
  assert.equal(next.length, 1);
  assert.equal(next[0].payload.after, String(100 + GRANT_BATCH - 1));
  assert.equal((await pending(GATE_JOB)).length, 0);
  assert.equal((await raw()).grantDone, false);
  await grantBatch(ctx, job(GRANT_JOB, next[0].payload), { ...logger(), budgetMs: 0 });
  assert.ok(members.every((m) => m.added.length === 1));
  assert.equal((await raw()).grantDone, true);
  assert.equal((await pending(GATE_JOB)).length, 1);
});

test('a member who left mid-batch is skipped', async () => {
  const gone = makeMember('1', { addError: Object.assign(new Error('Unknown Member'), { code: 10007 }) });
  const ok = makeMember('2');
  const guild = makeGuild({ members: [gone, ok] });
  await grantBatch(ctxFor(guild), job(GRANT_JOB), logger());
  assert.deepEqual(ok.added, ['900']);
  assert.equal((await raw()).grantDone, true);
});

test('a grant error that is not a departure retries and never finishes the grant', async () => {
  const bad = makeMember('1', { addError: new Error('boom') });
  const ok = makeMember('2');
  const guild = makeGuild({ members: [bad, ok] });
  await assert.rejects(grantBatch(ctxFor(guild), job(GRANT_JOB), logger()), /boom/);
  assert.deepEqual(ok.added, ['900']);
  assert.equal((await raw()).grantDone, false);
  assert.equal((await pending(GATE_JOB)).length, 0);
});

test('a missing Verified role fails the rollout and logs once', async () => {
  const guild = makeGuild({ members: [makeMember('1')], role: null });
  const log = logger();
  await grantBatch(ctxFor(guild), job(GRANT_JOB), log);
  await grantBatch(ctxFor(guild), job(GRANT_JOB), log);
  assert.equal((await raw()).state, 'failed');
  assert.equal(log.calls.length, 1);
  assert.equal((await pending(GATE_JOB)).length, 0);
});

test('a Verified role with staff permissions is never granted: the rollout fails and logs once', async () => {
  const m = makeMember('1');
  const role = { id: '900', position: 1, managed: false, permissions: { has: (p) => p === 'Administrator' } };
  const guild = makeGuild({ members: [m], role });
  const log = logger();
  await grantBatch(ctxFor(guild), job(GRANT_JOB), log);
  assert.deepEqual(m.added, []);
  assert.equal((await raw()).state, 'failed');
  assert.equal(log.calls.length, 1);
  assert.match(log.calls[0][3].detail, /staff permissions/);
  assert.equal((await pending(GATE_JOB)).length, 0);
});

test('gateBatch never runs gating while the grant job is still pending', async () => {
  const guild = makeGuild({ channels: [chan('10')] });
  const g = gater();
  const log = logger();
  await gateBatch(ctxFor(guild), job(GATE_JOB), { ...log, ...g });
  assert.deepEqual(g.seen, []);
  assert.equal((await raw()).state, 'rolling_out');
  assert.equal(log.calls.length, 0);
});

test('gateBatch does not gate when the state is not rolling_out', async () => {
  await config({ state: 'active', grantDone: true });
  const g = gater();
  await gateBatch(ctxFor(makeGuild({ channels: [chan('10')] })), job(GATE_JOB), { ...logger(), ...g });
  assert.deepEqual(g.seen, []);
});

test('gateBatch gates categories first, in batches, then sets active and logs once', async () => {
  await config({ grantDone: true, rolloutBy: 'adm' });
  const channels = [chan('50'), chan('51'), chan('60', 4), chan('2'), chan('3'), chan('4'), chan('5'), chan('6'),
    chan('7'), chan('8'), chan('9'), chan('11'), chan('12')];
  const guild = makeGuild({ channels });
  const ctx = ctxFor(guild);
  const g = gater();
  const log = logger();
  await gateBatch(ctx, job(GATE_JOB), { ...log, ...g, budgetMs: 0 });
  assert.equal(g.seen.length, GATE_BATCH);
  assert.equal(g.seen[0], '60'); // the category first
  assert.equal((await raw()).state, 'rolling_out');
  const next = await pending(GATE_JOB);
  assert.equal(next.length, 1);
  await gateBatch(ctx, job(GATE_JOB, next[0].payload), { ...log, ...g, budgetMs: 0 });
  assert.equal(g.seen.length, channels.length);
  assert.equal(new Set(g.seen).size, channels.length);
  assert.equal((await raw()).state, 'active');
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0][3].kind, 'rollout');
});

test('a channel that fails marks failed with a count and the rest still gate', async () => {
  await config({ grantDone: true });
  const guild = makeGuild({ channels: [chan('1'), chan('2'), chan('3')] });
  const g = gater({ 2: 'failed' });
  const log = logger();
  await gateBatch(ctxFor(guild), job(GATE_JOB), { ...log, ...g });
  assert.deepEqual(g.seen, ['1', '2', '3']);
  const c = await raw();
  assert.equal(c.state, 'failed');
  assert.equal(c.failedChannels, 1);
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0][3].kind, 'rollout_failed');
  assert.match(log.calls[0][3].detail, /1/);
});

test('a rerun of gateBatch changes nothing twice', async () => {
  await config({ grantDone: true });
  const guild = makeGuild({ channels: [chan('1'), chan('2')] });
  const g = gater();
  const log = logger();
  await gateBatch(ctxFor(guild), job(GATE_JOB), { ...log, ...g });
  await gateBatch(ctxFor(guild), job(GATE_JOB), { ...log, ...g });
  assert.equal(g.seen.length, 2);
  assert.equal(log.calls.length, 1);
  assert.equal((await raw()).state, 'active');
});

test('the failed count carries across batches', async () => {
  await config({ grantDone: true });
  const channels = Array.from({ length: GATE_BATCH + 2 }, (_, i) => chan(String(100 + i)));
  const guild = makeGuild({ channels });
  const g = gater({ 100: 'failed', [100 + GATE_BATCH]: 'failed' });
  const log = logger();
  await gateBatch(ctxFor(guild), job(GATE_JOB), { ...log, ...g, budgetMs: 0 });
  const next = await pending(GATE_JOB);
  await gateBatch(ctxFor(guild), job(GATE_JOB, next[0].payload), { ...log, ...g, budgetMs: 0 });
  assert.equal((await raw()).failedChannels, 2);
  assert.equal((await raw()).state, 'failed');
});

test('the feature exports both jobs for the loader', () => {
  assert.equal(feature.jobs[GRANT_JOB], jobs[GRANT_JOB]);
  assert.equal(typeof feature.jobs[GATE_JOB], 'function');
});

// ---- fix round 1 ----
const FINAL = 5; // the scheduler drops a job whose attempts reached MAX_ATTEMPTS
const jobAt = (type, attempts, payload = {}) => ({ ...job(type, payload), attempts });

test('a grant error on the final attempt concludes failed and logs; earlier attempts only retry', async () => {
  const bad = makeMember('1', { addError: new Error('boom') });
  const guild = makeGuild({ members: [bad] });
  const log = logger();
  await assert.rejects(grantBatch(ctxFor(guild), jobAt(GRANT_JOB, FINAL - 1), log), /boom/);
  assert.equal((await raw()).state, 'rolling_out');
  assert.equal(log.calls.length, 0);
  await grantBatch(ctxFor(guild), jobAt(GRANT_JOB, FINAL), log);
  assert.equal((await raw()).state, 'failed');
  assert.equal(log.calls.length, 1);
  assert.equal(log.calls[0][3].kind, 'rollout_failed');
  assert.match(log.calls[0][3].detail, /boom/);
});

test('a gate error on the final attempt concludes failed and logs', async () => {
  await config({ grantDone: true });
  const guild = makeGuild();
  guild.channels.fetch = async () => { throw new Error('net down'); };
  const log = logger();
  await assert.rejects(gateBatch(ctxFor(guild), jobAt(GATE_JOB, 1), { ...log, ...gater() }), /net down/);
  assert.equal((await raw()).state, 'rolling_out');
  await gateBatch(ctxFor(guild), jobAt(GATE_JOB, FINAL), { ...log, ...gater() });
  assert.equal((await raw()).state, 'failed');
  assert.equal(log.calls.length, 1);
});

test('a guild missing from the cache retries, then fails on the final attempt', async () => {
  const ctx = { db, client: { guilds: { cache: new Map() } } };
  const log = logger();
  await assert.rejects(grantBatch(ctx, jobAt(GRANT_JOB, 2), log));
  assert.equal((await raw()).state, 'rolling_out');
  await grantBatch(ctx, jobAt(GRANT_JOB, FINAL), log);
  assert.equal((await raw()).state, 'failed');
  assert.equal(log.calls.length, 1);
});

async function plain(extra) {
  await db.query('DELETE FROM scheduled_jobs');
  await db.query('DELETE FROM guild_settings');
  await setFeature(db, G, 'verification', { enabled: true, config: { roleId: '900', ...extra } });
}

test('restarting a rolling_out guild with no jobs keeps cutoff and rolloutBy', async () => {
  await plain({ state: 'rolling_out', cutoff: 5555, grantDone: false, rolloutBy: 'first' });
  await startRollout({ db }, { id: G }, 'en', 'second');
  const c = await raw();
  assert.equal(c.cutoff, 5555);
  assert.equal(c.rolloutBy, 'first');
  assert.equal((await pending(GRANT_JOB)).length, 1);
});

test('restarting a rolling_out guild whose grant is done schedules only the gate', async () => {
  await plain({ state: 'rolling_out', cutoff: 5555, grantDone: true, rolloutBy: 'first' });
  await startRollout({ db }, { id: G }, 'en', 'second');
  assert.equal((await pending(GRANT_JOB)).length, 0);
  assert.equal((await pending(GATE_JOB)).length, 1);
});

test('retrying from failed with grantDone re-runs only the gate and keeps the cutoff', async () => {
  await plain({ state: 'failed', cutoff: 5555, grantDone: true, failedChannels: 3 });
  await startRollout({ db }, { id: G }, 'en', 'adm');
  const c = await raw();
  assert.equal(c.state, 'rolling_out');
  assert.equal(c.cutoff, 5555);
  assert.equal(c.failedChannels, 0);
  assert.equal(c.grantDone, true);
  assert.equal((await pending(GRANT_JOB)).length, 0);
  assert.deepEqual((await pending(GATE_JOB)).map((r) => r.payload), [{}]);
});

test('retrying from failed without grantDone restarts the grant with the original cutoff', async () => {
  await plain({ state: 'failed', cutoff: 5555, grantDone: false });
  await startRollout({ db }, { id: G }, 'en', 'adm');
  const c = await raw();
  assert.equal(c.state, 'rolling_out');
  assert.equal(c.cutoff, 5555);
  assert.equal((await pending(GRANT_JOB)).length, 1);
  assert.equal((await pending(GATE_JOB)).length, 0);
});

test('a fresh start from none or active sets a new cutoff', async () => {
  for (const state of ['none', 'active']) {
    await plain({ state, cutoff: 5555, grantDone: true });
    await startRollout({ db }, { id: G }, 'en', 'adm');
    const c = await raw();
    assert.ok(c.cutoff > 5555, state);
    assert.equal(c.grantDone, false);
    assert.equal((await pending(GRANT_JOB)).length, 1);
    assert.equal((await pending(GATE_JOB)).length, 0);
  }
});

test('a restart removes a stale gate row so an old cursor cannot resume', async () => {
  await plain({ state: 'failed', cutoff: 5555, grantDone: false });
  await db.query(
    `INSERT INTO scheduled_jobs (guild_id, type, key, payload, due_at) VALUES ($1, $2, 'rollout', '{"after":"7"}', now())`,
    [G, GATE_JOB],
  );
  await startRollout({ db }, { id: G }, 'en', 'adm');
  assert.equal((await pending(GATE_JOB)).length, 0);
});

test('a transient role fetch error retries; only Unknown Role (10011) fails the rollout', async () => {
  const guild = makeGuild({ members: [makeMember('1')], role: null });
  const log = logger();
  guild.roles.fetch = async () => { throw Object.assign(new Error('503'), { status: 503 }); };
  await assert.rejects(grantBatch(ctxFor(guild), job(GRANT_JOB), log), /503/);
  assert.equal((await raw()).state, 'rolling_out');
  guild.roles.fetch = async () => { throw Object.assign(new Error('Unknown Role'), { code: 10011 }); };
  await grantBatch(ctxFor(guild), job(GRANT_JOB), log);
  assert.equal((await raw()).state, 'failed');
  assert.match(log.calls[0][3].detail, /role/i);
});

test('a missing cutoff is reported as a missing cutoff', async () => {
  await plain({ state: 'rolling_out', grantDone: false });
  const log = logger();
  await grantBatch(ctxFor(makeGuild({ members: [makeMember('1')] })), job(GRANT_JOB), log);
  assert.equal((await raw()).state, 'failed');
  assert.match(log.calls[0][3].detail, /cutoff/i);
});

test('a role above the bot is reported as too high', async () => {
  const guild = makeGuild({ members: [makeMember('1')], role: { id: '900', position: 9, managed: false } });
  const log = logger();
  await grantBatch(ctxFor(guild), job(GRANT_JOB), log);
  assert.match(log.calls[0][3].detail, /above/i);
});

test('several grant batches run in one handler call within the time budget', async () => {
  const members = Array.from({ length: GRANT_BATCH * 3 + 1 }, (_, i) => makeMember(String(100 + i)));
  await grantBatch(ctxFor(makeGuild({ members })), job(GRANT_JOB), logger());
  assert.ok(members.every((m) => m.added.length === 1));
  assert.equal((await pending(GRANT_JOB)).length, 0);
  assert.equal((await raw()).grantDone, true);
  assert.equal((await pending(GATE_JOB)).length, 1);
});

test('several gate batches run in one handler call within the time budget', async () => {
  await config({ grantDone: true });
  const channels = Array.from({ length: GATE_BATCH * 3 + 1 }, (_, i) => chan(String(100 + i)));
  const g = gater();
  await gateBatch(ctxFor(makeGuild({ channels })), job(GATE_JOB), { ...logger(), ...g });
  assert.equal(g.seen.length, channels.length);
  assert.equal((await raw()).state, 'active');
  assert.equal((await pending(GATE_JOB)).length, 0);
});

test('snowflakes of different length sort numerically', async () => {
  const members = [makeMember('99'), makeMember('100'), makeMember('9')];
  await grantBatch(ctxFor(makeGuild({ members })), job(GRANT_JOB, { after: '99' }), logger());
  assert.deepEqual(members.map((m) => m.added.length), [0, 1, 0]);
});

test('a list change made between channels is honored by the running gate job', async () => {
  await config({ grantDone: true });
  const channels = ['2', '3', '4', '5', '6', '7', '8', '9', '11', '12', '13', '14'].map((id) => chan(id));
  const guild = makeGuild({ channels });
  const seenSkips = {};
  const gateChannel = async (ctx, g, ch, cfg) => {
    seenSkips[ch.id] = [...cfg.skippedChannels];
    if (ch.id === '2') await setFeature(db, G, 'verification', { config: { skippedChannels: ['14'] } });
    return 'changed';
  };
  await gateBatch(ctxFor(guild), job(GATE_JOB), { ...logger(), gateChannel });
  assert.deepEqual(seenSkips['14'], ['14']);
  assert.deepEqual(seenSkips['11'], ['14']);
  assert.equal((await raw()).state, 'active');
  assert.equal((await raw()).grantDone, true);
});
