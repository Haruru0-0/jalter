// Restart-safe rollout: grant Verified to everyone present at the cutoff, THEN gate channels.
//
// Ordering guarantee ("grant finished"): config.grantDone (raw JSON, no migration) is set to true
// only by the last grant batch, right before it schedules the gate job. A fresh start resets it to
// false. gateBatch refuses to gate unless state is `rolling_out` AND grantDone is true, so a gate
// job that is scheduled early, twice, or by mistake can never gate before the grant has finished.
//
// Idempotency: every step is safe to repeat. Members holding the role are skipped; gateChannel
// answers 'skipped' for an already gated channel; cursors only move forward (snowflake order);
// the final state change is one conditional UPDATE, so a second run neither re-logs nor re-gates.
// Both jobs use key `rollout`, so scheduling one twice replaces the row instead of duplicating it.
//
// Never stuck: the scheduler drops a job once attempts reach MAX_ATTEMPTS. On that final attempt
// an error (or a guild missing from the cache) concludes the rollout as `failed` and logs it, so
// state never stays `rolling_out` with no job left. Earlier attempts just rethrow to retry.
//
// Throughput: one handler run processes batches (20 members / 10 channels) back to back until a
// time budget is spent, then persists the cursor and reschedules itself.
import { getFeature, setFeature } from '../../db/settings.js';
import { getLang } from '../../i18n/index.js';
import { scheduleJob, cancelJobs, MAX_ATTEMPTS } from '../../core/scheduler.js';
import { botCanGive, isDangerousRole } from '../../core/role-safety.js';
import { readConfig } from './config.js';
import { gateChannel, revertChannel } from './apply.js';
import { logVerification } from './log.js';

export const GRANT_JOB = 'verification.grant';
export const GATE_JOB = 'verification.gate';
export const ROLLOUT_KEY = 'rollout';
export const GRANT_BATCH = 20;
export const GATE_BATCH = 10;
export const BUDGET_MS = 20000;
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;
const CATEGORY = 4;
const FEATURE = 'verification';

// Snowflakes compare numerically as (length, string): no BigInt in the sort.
const cmpId = (a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
const schedule = (ctx, guildId, type, payload) =>
  scheduleJob(ctx.db, { guildId, type, key: ROLLOUT_KEY, payload, dueAt: Date.now() });

/**
 * Starts a rollout (the `lang` argument is kept for the caller's signature; the jobs read the
 * guild language themselves). One atomic statement:
 * - rolling_out with jobs pending: nothing (a double call keeps the first run).
 * - rolling_out without jobs (lost/dropped), or failed: resume with the ORIGINAL cutoff; if the
 *   grant had finished only the gate is re-run (failedChannels reset), else the grant restarts.
 * - anything else: a fresh rollout with a new cutoff.
 */
export async function startRollout(ctx, guild, lang, adminId) {
  const fresh = {
    state: 'rolling_out', cutoff: Date.now(), grantDone: false, failedChannels: 0, rolloutBy: adminId ?? null,
  };
  const { rows } = await ctx.db.query(
    `INSERT INTO guild_settings (guild_id, feature, enabled, config)
     VALUES ($1, $2, false, $3::jsonb)
     ON CONFLICT (guild_id, feature) DO UPDATE SET config = guild_settings.config ||
       CASE WHEN guild_settings.config->>'state' IN ('rolling_out', 'failed')
                 AND jsonb_typeof(guild_settings.config->'cutoff') = 'number'
            THEN jsonb_build_object(
              'state', 'rolling_out',
              'failedChannels', 0,
              'grantDone', (guild_settings.config->>'grantDone') = 'true',
              'rolloutBy', CASE WHEN guild_settings.config->>'state' = 'rolling_out'
                                THEN COALESCE(guild_settings.config->'rolloutBy', 'null'::jsonb)
                                ELSE $6::jsonb END)
            ELSE $3::jsonb END
     WHERE COALESCE(guild_settings.config->>'state', 'none') <> 'rolling_out'
        OR NOT EXISTS (SELECT 1 FROM scheduled_jobs j
                       WHERE j.guild_id = $1 AND j.type IN ($4, $5))
     RETURNING (config->>'grantDone') = 'true' AS grant_done`,
    [guild.id, FEATURE, JSON.stringify(fresh), GRANT_JOB, GATE_JOB, JSON.stringify(adminId ?? null)],
  );
  if (rows.length === 0) return;
  // Drop any stale row first so an old cursor can never resume.
  await cancelJobs(ctx.db, { guildId: guild.id, type: GRANT_JOB, key: ROLLOUT_KEY });
  await cancelJobs(ctx.db, { guildId: guild.id, type: GATE_JOB, key: ROLLOUT_KEY });
  await schedule(ctx, guild.id, rows[0].grant_done ? GATE_JOB : GRANT_JOB, {});
}

async function load(ctx, job) {
  const { config } = await getFeature(ctx.db, job.guildId, FEATURE);
  const cfg = readConfig(config);
  if (cfg.state !== 'rolling_out') return null;
  const guild = ctx.client.guilds.cache.get(job.guildId);
  if (!guild) throw new Error('guild not available');
  return { guild, cfg, raw: config ?? {} };
}

// Leaves `rolling_out` exactly once; false means another run already did.
async function conclude(ctx, guildId, state, extra) {
  const { rowCount } = await ctx.db.query(
    `UPDATE guild_settings SET config = config || $3::jsonb
     WHERE guild_id = $1 AND feature = $2 AND config->>'state' = 'rolling_out'`,
    [guildId, FEATURE, JSON.stringify({ state, ...extra })],
  );
  return rowCount === 1;
}

async function failRollout(ctx, guildId, raw, detail, log) {
  if (!(await conclude(ctx, guildId, 'failed', {}))) return;
  const lang = await getLang(ctx.db, guildId);
  await log(ctx, guildId, lang, { kind: 'rollout_failed', actorId: raw?.rolloutBy ?? undefined, detail });
}

// Rethrows to retry, except on the scheduler's final attempt, where the rollout is concluded.
function guarded(run) {
  return async (ctx, job, deps = {}) => {
    try {
      await run(ctx, job, deps);
    } catch (err) {
      if (!(job.attempts >= MAX_ATTEMPTS)) throw err;
      const { config } = await getFeature(ctx.db, job.guildId, FEATURE);
      await failRollout(ctx, job.guildId, config, `Gave up after ${job.attempts} attempts: ${err?.message ?? err}`,
        deps.logVerification ?? logVerification);
    }
  };
}

const grantRun = async (ctx, job, deps) => {
  const log = deps.logVerification ?? logVerification;
  const budget = deps.budgetMs ?? BUDGET_MS;
  const cur = await load(ctx, job);
  if (!cur) return;
  const { guild, cfg, raw } = cur;
  if (raw.grantDone === true) {
    // A crash between grantDone and the gate schedule: just make sure the gate is scheduled.
    await schedule(ctx, guild.id, GATE_JOB, {});
    return;
  }
  if (cfg.cutoff == null) return failRollout(ctx, guild.id, raw, 'Rollout cutoff is missing', log);
  let role = cfg.roleId ? (guild.roles.cache.get(cfg.roleId) ?? null) : null;
  if (!role && cfg.roleId) {
    try {
      role = await guild.roles.fetch(cfg.roleId);
    } catch (err) {
      if (err?.code !== UNKNOWN_ROLE) throw err; // transient: retry
    }
  }
  if (!role) return failRollout(ctx, guild.id, raw, 'The Verified role no longer exists', log);
  if (!botCanGive(guild, role)) {
    return failRollout(ctx, guild.id, raw, 'The Verified role is above my highest role', log);
  }
  // Checked at grant time too: the role may have gained staff permissions since setup.
  if (isDangerousRole(role)) {
    return failRollout(ctx, guild.id, raw, 'The Verified role has staff permissions', log);
  }
  if (guild.members.cache.size < (guild.memberCount ?? 0)) await guild.members.fetch();
  const after = job.payload?.after ?? null;
  const todo = [...guild.members.cache.values()]
    .filter((m) => after === null || cmpId(m.id, after) > 0)
    .sort((a, b) => cmpId(a.id, b.id));
  const started = Date.now();
  for (let i = 0; i < todo.length; i += GRANT_BATCH) {
    const batch = todo.slice(i, i + GRANT_BATCH);
    let failure = null;
    for (const member of batch) {
      const m = guild.members.cache.get(member.id);
      if (!m) continue; // left mid-batch
      if (m.joinedTimestamp != null && m.joinedTimestamp > cfg.cutoff) continue;
      if (m.roles.cache.has(role.id)) continue;
      try {
        await m.roles.add(role.id, 'Verification rollout');
      } catch (err) {
        if (err?.code === UNKNOWN_MEMBER || /unknown member/i.test(err?.message ?? '')) continue;
        failure = err;
      }
    }
    // A member we could not grant (and who has not left) must not be skipped: retry.
    if (failure) throw failure;
    if (i + GRANT_BATCH < todo.length && Date.now() - started >= budget) {
      await schedule(ctx, guild.id, GRANT_JOB, { after: batch[batch.length - 1].id });
      return;
    }
  }
  await setFeature(ctx.db, guild.id, FEATURE, { config: { grantDone: true } });
  await schedule(ctx, guild.id, GATE_JOB, {});
};

// Categories first, then everything else; snowflake order inside each group.
const rank = (c) => (c.type === CATEGORY ? 0 : 1);
const order = (a, b) => rank(a) - rank(b) || cmpId(a.id, b.id);

const gateRun = async (ctx, job, deps) => {
  const log = deps.logVerification ?? logVerification;
  const gate = deps.gateChannel ?? gateChannel;
  const revert = deps.revertChannel ?? revertChannel;
  const budget = deps.budgetMs ?? BUDGET_MS;
  const cur = await load(ctx, job);
  if (!cur) return;
  const { guild, raw } = cur;
  if (raw.grantDone !== true) return; // the grant job schedules the gate when it is done
  const p = job.payload ?? {};
  const cursor = p.after ? { id: p.after, type: p.afterCat ? CATEGORY : 0 } : null;
  let failed = Number(p.failed) || 0;

  const fetched = await guild.channels.fetch();
  const all = [...fetched.values()].filter((c) => c && !c.isThread?.()).sort(order);
  const todo = cursor ? all.filter((c) => order(cursor, c) < 0) : all;
  const started = Date.now();
  for (let i = 0; i < todo.length; i += GATE_BATCH) {
    const batch = todo.slice(i, i + GATE_BATCH);
    for (const channel of batch) {
      // Re-read the lists for every channel: an admin may change them mid-run.
      const { config: latest } = await getFeature(ctx.db, guild.id, FEATURE);
      const fresh = readConfig(latest);
      if (fresh.state !== 'rolling_out') return; // undone or concluded meanwhile
      const result = await gate(ctx, guild, channel, fresh);
      // `/verification remove` sets state none first and may have listed the records before this
      // gate wrote one: undo this channel ourselves and stop.
      if (result !== 'skipped') {
        const { config: after } = await getFeature(ctx.db, guild.id, FEATURE);
        if (readConfig(after).state === 'none') {
          await revert(ctx, guild, channel);
          return;
        }
      }
      if (result === 'failed') failed += 1;
    }
    if (i + GATE_BATCH < todo.length && Date.now() - started >= budget) {
      const last = batch[batch.length - 1];
      await schedule(ctx, guild.id, GATE_JOB, { after: last.id, afterCat: last.type === CATEGORY, failed });
      return;
    }
  }
  if (!(await conclude(ctx, guild.id, failed > 0 ? 'failed' : 'active', { failedChannels: failed }))) return;
  const lang = await getLang(ctx.db, guild.id);
  await log(ctx, guild.id, lang, {
    kind: failed > 0 ? 'rollout_failed' : 'rollout',
    actorId: raw.rolloutBy ?? undefined,
    detail: failed > 0 ? `${failed} channel(s) could not be gated` : undefined,
  });
};

export const grantBatch = guarded(grantRun);
export const gateBatch = guarded(gateRun);

export const jobs = { [GRANT_JOB]: grantBatch, [GATE_JOB]: gateBatch };
