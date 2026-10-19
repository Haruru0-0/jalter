import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { setFeature } from '../../src/db/settings.js';
import { scheduleJob, claimDue, MAX_ATTEMPTS } from '../../src/core/scheduler.js';
import { WARN_JOB, KICK_JOB } from '../../src/features/verification/unverified.js';
import { warnJob, kickJob, jobs } from '../../src/features/verification/unverified-jobs.js';
import * as feature from '../../src/features/verification/index.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
  await db.query('DELETE FROM scheduled_jobs');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const NOW = 1_800_000_000_000;
const KICK_AT = NOW + 3600_000;

async function setup(config = {}, enabled = true) {
  await setFeature(db, G, 'verification', {
    enabled,
    config: {
      mode: 'button', roleId: 'rv', channelId: 'cv', state: 'active',
      unverifiedPolicy: 'warn_kick', kickAfterSeconds: 7200, ...config,
    },
  });
}

function makeMember(id = 'u1', { bot = false, roles = [], top = 1, manageGuild = false } = {}) {
  return {
    id,
    user: { id, bot },
    guild: { id: G },
    permissions: { has: (p) => manageGuild && p === 'ManageGuild' },
    roles: { cache: new Map(roles.map((r) => [r, { id: r }])), highest: { position: top } },
  };
}

function makeGuild(members = [], { fetchError = null, ownerId = 'owner' } = {}) {
  const map = new Map(members.map((m) => [m.id, m]));
  return {
    id: G,
    ownerId,
    members: {
      me: { id: 'bot1', roles: { highest: { position: 10 } } },
      fetch: async (id) => {
        if (fetchError) throw fetchError;
        if (!map.has(id)) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return map.get(id);
      },
    },
  };
}

const ctxFor = (guild) => ({ db, client: { user: { id: 'bot1' }, guilds: { cache: new Map(guild ? [[G, guild]] : []) } } });

function fakes(result = { ok: true, modCase: { number: 1 }, warnings: [] }) {
  const calls = [];
  const logs = [];
  return {
    calls,
    logs,
    deps: {
      now: () => NOW,
      runAction: async (ctx, params) => {
        calls.push(params);
        if (typeof result === 'function') return result(params);
        return result;
      },
      logVerification: async (ctx, guildId, lang, entry) => { logs.push(entry); },
    },
  };
}

const basePayload = (policy = 'warn_kick', extra = {}) => ({ policy, kickAt: KICK_AT, kickAfter: 7200, ...extra });

// Puts a real row in the scheduler table and claims it the way the scheduler does.
async function queued(type, { key = 'u1', payload = basePayload(), dueAt = NOW - 1000 } = {}) {
  await scheduleJob(db, { guildId: G, type, key, payload, dueAt });
  const [job] = await claimDue(db, NOW, { types: [type] });
  return job;
}

const rows = async (type) => (await db.query(
  `SELECT key, payload, attempts, (EXTRACT(EPOCH FROM due_at) * 1000)::float8 AS due
   FROM scheduled_jobs WHERE type = $1 ORDER BY key`, [type],
)).rows.map((r) => ({ key: r.key, payload: r.payload, attempts: r.attempts, due: Math.round(r.due) }));

test('the module jobs export holds both handlers and index merges them with the rollout jobs', () => {
  assert.equal(jobs[WARN_JOB], warnJob);
  assert.equal(jobs[KICK_JOB], kickJob);
  assert.deepEqual(Object.keys(feature.jobs).sort(),
    ['verification.gate', 'verification.grant', KICK_JOB, WARN_JOB].sort());
});

test('warn job warns with the bot as actor and a reason naming the verify channel', async () => {
  await setup();
  const m = makeMember();
  const guild = makeGuild([m]);
  const f = fakes();
  await warnJob(ctxFor(guild), await queued(WARN_JOB), f.deps);
  assert.equal(f.calls.length, 1);
  const p = f.calls[0];
  assert.equal(p.type, 'warn');
  assert.equal(p.actor, guild.members.me);
  assert.equal(p.target, m);
  assert.equal(p.targetId, 'u1');
  assert.equal(p.guild, guild);
  assert.equal(p.lang, 'en');
  assert.equal(p.config.reasonRequired, true); // moderation defaults when moderation is not set up
  assert.match(p.reason, /<#cv>/);
  assert.match(p.reason, /1h/); // time left until kickAt
  assert.deepEqual(f.logs, []);
  assert.deepEqual(await rows(WARN_JOB), []); // claimed
});

test('warn job reschedules the kick job with warned ok at the same kickAt', async () => {
  await setup();
  await scheduleJob(db, { guildId: G, type: KICK_JOB, key: 'u1', payload: basePayload(), dueAt: KICK_AT });
  const f = fakes();
  await warnJob(ctxFor(makeGuild([makeMember()])), await queued(WARN_JOB), f.deps);
  assert.deepEqual(await rows(KICK_JOB), [{
    key: 'u1', attempts: 0, due: KICK_AT, payload: { ...basePayload(), warned: 'ok' },
  }]);
});

test('a refused warn logs once and marks warned failed so the kick is skipped', async () => {
  await setup();
  const m = makeMember();
  const ctx = ctxFor(makeGuild([m]));
  const f = fakes({ ok: false, reason: 'bot_hierarchy' });
  await warnJob(ctx, await queued(WARN_JOB), f.deps);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].kind, 'unverified_failed');
  assert.equal(f.logs[0].userId, 'u1');
  assert.match(f.logs[0].detail, /bot_hierarchy/);
  const [kick] = await rows(KICK_JOB);
  assert.equal(kick.payload.warned, 'failed');
  assert.equal(kick.due, KICK_AT);

  const k = fakes();
  const [job] = await claimDue(db, KICK_AT, { types: [KICK_JOB] });
  await kickJob(ctx, job, k.deps);
  assert.equal(k.calls.length, 0);
  assert.equal(k.logs.length, 0); // the warn already logged
});

test('a thrown warn is treated as failed and a second run of the warn job does not warn again', async () => {
  await setup();
  const ctx = ctxFor(makeGuild([makeMember()]));
  const f = fakes(() => { throw new Error('engine down'); });
  const job = await queued(WARN_JOB);
  await warnJob(ctx, job, f.deps); // does not throw
  assert.equal(f.calls.length, 1);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].kind, 'unverified_failed');
  assert.equal((await rows(KICK_JOB))[0].payload.warned, 'failed');

  const again = fakes();
  await warnJob(ctx, job, again.deps);
  assert.equal(again.calls.length, 0);
  assert.equal(again.logs.length, 0);
  assert.equal((await rows(KICK_JOB))[0].payload.warned, 'failed');
});

test('kick job kicks a member who is still unverified after a warn', async () => {
  await setup();
  const m = makeMember();
  const guild = makeGuild([m]);
  const f = fakes();
  await kickJob(ctxFor(guild), await queued(KICK_JOB, { payload: basePayload('warn_kick', { warned: 'ok' }) }), f.deps);
  assert.equal(f.calls.length, 1);
  const p = f.calls[0];
  assert.equal(p.type, 'kick');
  assert.equal(p.actor, guild.members.me);
  assert.equal(p.target, m);
  assert.equal(p.targetId, 'u1');
  assert.match(p.reason, /2h/); // the queued kickAfter (7200 s)
  assert.deepEqual(f.logs, []);
});

test('kick reason uses the queued kickAfter, not the currently saved time', async () => {
  await setup({ kickAfterSeconds: 86400 });
  const f = fakes();
  await kickJob(ctxFor(makeGuild([makeMember()])), await queued(KICK_JOB, { payload: basePayload('kick') }), f.deps);
  assert.match(f.calls[0].reason, /2h/);
  assert.doesNotMatch(f.calls[0].reason, /1d/);
});

test('kick job under policy kick kicks without a warn', async () => {
  await setup({ unverifiedPolicy: 'kick' });
  const f = fakes();
  await kickJob(ctxFor(makeGuild([makeMember()])), await queued(KICK_JOB, { payload: basePayload('kick') }), f.deps);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].type, 'kick');
});

test('kick job under warn_kick with warned undefined does not kick and logs once', async () => {
  await setup();
  const f = fakes();
  await kickJob(ctxFor(makeGuild([makeMember()])), await queued(KICK_JOB), f.deps);
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].kind, 'unverified_failed');
  assert.equal(f.logs[0].userId, 'u1');
});

test('kick job with warned undefined stays quiet while the warn job is still pending', async () => {
  await setup();
  await scheduleJob(db, { guildId: G, type: WARN_JOB, key: 'u1', payload: basePayload(), dueAt: NOW + 60_000 });
  const f = fakes();
  await kickJob(ctxFor(makeGuild([makeMember()])), await queued(KICK_JOB), f.deps);
  assert.equal(f.calls.length, 0);
  assert.equal(f.logs.length, 0);
});

test('warn and kick claimed in the same tick: the stale kick defers to the rescheduled one', async () => {
  await setup();
  const ctx = ctxFor(makeGuild([makeMember()]));
  // Both overdue (the bot was down): the scheduler claims both, warn first (earlier due).
  const payload = basePayload('warn_kick', { kickAt: NOW - 1000 });
  await scheduleJob(db, { guildId: G, type: WARN_JOB, key: 'u1', payload, dueAt: NOW - 2000 });
  await scheduleJob(db, { guildId: G, type: KICK_JOB, key: 'u1', payload, dueAt: NOW - 1000 });
  const [w, k] = await claimDue(db, NOW, { types: [WARN_JOB, KICK_JOB] });
  assert.equal(w.type, WARN_JOB);
  const f = fakes();
  await warnJob(ctx, w, f.deps);
  await kickJob(ctx, k, f.deps);
  assert.deepEqual(f.calls.map((c) => c.type), ['warn']);
  assert.deepEqual(f.logs, []);
  // The next tick runs the rescheduled kick, which now knows the warn succeeded.
  const [next] = await claimDue(db, NOW + 1, { types: [KICK_JOB] });
  await kickJob(ctx, next, f.deps);
  assert.deepEqual(f.calls.map((c) => c.type), ['warn', 'kick']);
});

test('a refused kick logs unverified_failed once and does not reschedule', async () => {
  await setup({ unverifiedPolicy: 'kick' });
  const f = fakes({ ok: false, reason: 'discord_refused' });
  const job = await queued(KICK_JOB, { payload: basePayload('kick') });
  await kickJob(ctxFor(makeGuild([makeMember()])), job, f.deps); // returns: no retry
  assert.equal(f.calls.length, 1);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].kind, 'unverified_failed');
  assert.equal(f.logs[0].userId, 'u1');
  assert.match(f.logs[0].detail, /discord_refused/);
  // Only the claimed row remains (the scheduler deletes it on return); nothing new was queued.
  const left = await rows(KICK_JOB);
  assert.equal(left.length, 1);
  assert.equal(left[0].attempts, job.attempts);
  assert.deepEqual(await rows(WARN_JOB), []);
});

test('a kick refused with not_in_server returns quietly', async () => {
  await setup({ unverifiedPolicy: 'kick' });
  const f = fakes({ ok: false, reason: 'not_in_server' });
  await kickJob(ctxFor(makeGuild([makeMember()])), await queued(KICK_JOB, { payload: basePayload('kick') }), f.deps);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.logs, []);
});

test('a thrown kick is rethrown for a retry, and logged only on the final attempt', async () => {
  await setup({ unverifiedPolicy: 'kick' });
  const ctx = ctxFor(makeGuild([makeMember()]));
  const f = fakes(() => { throw new Error('db down'); });
  const job = await queued(KICK_JOB, { payload: basePayload('kick') });
  await assert.rejects(kickJob(ctx, job, f.deps), /db down/);
  assert.deepEqual(f.logs, []);
  await assert.rejects(kickJob(ctx, { ...job, id: '0', attempts: MAX_ATTEMPTS }, f.deps), /db down/);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].kind, 'unverified_failed');
});

test('a bot, the owner, a member above the bot and a manager are never warned or kicked', async () => {
  const spared = [
    makeMember('bot', { bot: true }),
    makeMember('owner'),
    makeMember('high', { top: 10 }),
    makeMember('higher', { top: 11 }),
    makeMember('admin', { manageGuild: true }),
    makeMember('mgr', { roles: ['rmgr'] }),
  ];
  await setFeature(db, G, 'panel', { config: { managerRoleId: 'rmgr' } });
  for (const [policy, extra] of [['warn_kick', {}], ['warn_kick', { warned: 'ok' }], ['kick', {}]]) {
    await setup({ unverifiedPolicy: policy });
    const ctx = ctxFor(makeGuild(spared));
    const f = fakes();
    for (const m of spared) {
      await db.query('DELETE FROM scheduled_jobs');
      const payload = basePayload(policy, extra);
      if (policy === 'warn_kick' && !extra.warned) {
        await warnJob(ctx, await queued(WARN_JOB, { key: m.id, payload }), f.deps);
      }
      await db.query('DELETE FROM scheduled_jobs');
      await kickJob(ctx, await queued(KICK_JOB, { key: m.id, payload }), f.deps);
    }
    assert.deepEqual(f.calls, [], `${policy} ${JSON.stringify(extra)}`);
    assert.deepEqual(f.logs, []);
  }
});

test('a member who verified or left does nothing', async () => {
  await setup();
  const ctx = ctxFor(makeGuild([makeMember('u1', { roles: ['rv'] })]));
  const f = fakes();
  await warnJob(ctx, await queued(WARN_JOB), f.deps);
  assert.equal((await rows(WARN_JOB)).length, 1); // not claimed: nothing happened
  await kickJob(ctx, await queued(KICK_JOB, { payload: basePayload('warn_kick', { warned: 'ok' }) }), f.deps);
  await warnJob(ctx, await queued(WARN_JOB, { key: 'gone' }), f.deps);
  await kickJob(ctx, await queued(KICK_JOB, { key: 'gone', payload: basePayload('kick') }), f.deps);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, []);
  assert.deepEqual(await rows(KICK_JOB).then((r) => r.map((x) => x.payload.warned)), [undefined, 'ok']);
});

test('feature off, state none or policy none does nothing', async () => {
  const cases = [
    [{}, false],
    [{ state: 'none' }, true],
    [{ unverifiedPolicy: 'none' }, true],
  ];
  for (const [cfg, enabled] of cases) {
    await db.query('DELETE FROM scheduled_jobs');
    await setup(cfg, enabled);
    const ctx = ctxFor(makeGuild([makeMember()]));
    const f = fakes();
    await warnJob(ctx, await queued(WARN_JOB), f.deps);
    await kickJob(ctx, await queued(KICK_JOB, { payload: basePayload('warn_kick', { warned: 'ok' }) }), f.deps);
    await kickJob(ctx, await queued(KICK_JOB, { key: 'u2', payload: basePayload('kick') }), f.deps);
    assert.deepEqual(f.calls, [], JSON.stringify(cfg));
    assert.deepEqual(f.logs, []);
  }
});

test('a guild missing from the cache does nothing', async () => {
  await setup();
  const f = fakes();
  await warnJob(ctxFor(null), await queued(WARN_JOB), f.deps);
  await kickJob(ctxFor(null), await queued(KICK_JOB, { payload: basePayload('kick') }), f.deps);
  assert.deepEqual(f.calls, []);
});

test('a policy change after queueing still uses the queued policy', async () => {
  // Queued under kick, saved policy now warn_kick: kick without a warn.
  await setup({ unverifiedPolicy: 'warn_kick' });
  const ctx = ctxFor(makeGuild([makeMember()]));
  const f = fakes();
  await kickJob(ctx, await queued(KICK_JOB, { payload: basePayload('kick') }), f.deps);
  assert.deepEqual(f.calls.map((c) => c.type), ['kick']);

  // Queued under warn_kick, saved policy now kick: the warn still runs and a kick
  // without a warn result is still refused.
  await db.query('DELETE FROM scheduled_jobs');
  await setup({ unverifiedPolicy: 'kick' });
  const g = fakes();
  await kickJob(ctx, await queued(KICK_JOB, { key: 'u1' }), g.deps);
  assert.equal(g.calls.length, 0);
  await warnJob(ctx, await queued(WARN_JOB), g.deps);
  assert.deepEqual(g.calls.map((c) => c.type), ['warn']);

  // A warn job never warns for a job that was not queued under warn_kick.
  await db.query('DELETE FROM scheduled_jobs');
  const h = fakes();
  await warnJob(ctx, await queued(WARN_JOB, { payload: basePayload('kick') }), h.deps);
  assert.deepEqual(h.calls, []);
});

test('member fetch 10007 returns quietly and another fetch error throws', async () => {
  await setup();
  const gone = Object.assign(new Error('Unknown Member'), { code: 10007 });
  const f = fakes();
  await warnJob(ctxFor(makeGuild([], { fetchError: gone })), await queued(WARN_JOB), f.deps);
  await kickJob(ctxFor(makeGuild([], { fetchError: gone })),
    await queued(KICK_JOB, { payload: basePayload('kick') }), f.deps);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.logs, []);

  const flaky = Object.assign(new Error('Service Unavailable'), { status: 503 });
  const ctx = ctxFor(makeGuild([], { fetchError: flaky }));
  const warn = await queued(WARN_JOB);
  await assert.rejects(warnJob(ctx, warn, f.deps), /Service Unavailable/);
  assert.equal((await rows(WARN_JOB)).length, 1); // not claimed: the retry may still warn
  await assert.rejects(kickJob(ctx, await queued(KICK_JOB, { payload: basePayload('kick') }), f.deps),
    /Service Unavailable/);
  assert.deepEqual(f.calls, []);
});

test('a warn that keeps failing before it is claimed is marked failed on the final attempt', async () => {
  await setup();
  const flaky = Object.assign(new Error('Service Unavailable'), { status: 503 });
  const ctx = ctxFor(makeGuild([], { fetchError: flaky }));
  const job = await queued(WARN_JOB);
  const f = fakes();
  await assert.rejects(warnJob(ctx, { ...job, attempts: MAX_ATTEMPTS }, f.deps), /Service Unavailable/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.logs.length, 1);
  assert.equal(f.logs[0].kind, 'unverified_failed');
  assert.equal((await rows(KICK_JOB))[0].payload.warned, 'failed');
});
