// Restart-safe rollout: grant Verified to everyone present at the cutoff, THEN gate channels.
//
// Ordering guarantee ("grant finished"): config.grantDone (raw JSON, no migration) is set to true
// only by the last grant batch, right before it schedules the gate job. startRollout resets it to
// false. gateBatch refuses to gate unless state is `rolling_out` AND grantDone is true, so a gate
// job that is scheduled early, twice, or by mistake can never gate before the grant has finished.
//
// Idempotency: every step is safe to repeat. Members holding the role are skipped; gateChannel
// answers 'skipped' for an already gated channel; cursors only move forward (snowflake order);
// the final state change is one conditional UPDATE, so a second run neither re-logs nor re-gates.
// Both jobs use key `rollout`, so scheduling one twice replaces the row instead of duplicating it.
import { getFeature, setFeature } from '../../db/settings.js';
import { getLang } from '../../i18n/index.js';
import { scheduleJob } from '../../core/scheduler.js';
import { botCanGive } from '../../core/role-safety.js';
import { readConfig } from './config.js';
import { gateChannel } from './apply.js';
import { logVerification } from './log.js';

export const GRANT_JOB = 'verification.grant';
export const GATE_JOB = 'verification.gate';
export const ROLLOUT_KEY = 'rollout';
export const GRANT_BATCH = 20;
export const GATE_BATCH = 10;
const UNKNOWN_MEMBER = 10007;
const CATEGORY = 4;
const FEATURE = 'verification';

const big = (id) => BigInt(id);
const cmpId = (a, b) => (big(a) < big(b) ? -1 : big(a) > big(b) ? 1 : 0);
const schedule = (ctx, guildId, type, payload) =>
  scheduleJob(ctx.db, { guildId, type, key: ROLLOUT_KEY, payload, dueAt: Date.now() });

/**
 * Starts a rollout. One atomic statement: it does nothing while a rollout is already running with
 * jobs pending (so a double call keeps the first cutoff), but restarts one whose jobs were lost.
 */
export async function startRollout(ctx, guild, lang, adminId) {
  const patch = {
    state: 'rolling_out', cutoff: Date.now(), grantDone: false, failedChannels: 0, rolloutBy: adminId ?? null,
  };
  const { rowCount } = await ctx.db.query(
    `INSERT INTO guild_settings (guild_id, feature, enabled, config)
     VALUES ($1, $2, false, $3::jsonb)
     ON CONFLICT (guild_id, feature) DO UPDATE SET config = guild_settings.config || $3::jsonb
     WHERE COALESCE(guild_settings.config->>'state', 'none') <> 'rolling_out'
        OR NOT EXISTS (SELECT 1 FROM scheduled_jobs j
                       WHERE j.guild_id = $1 AND j.type IN ($4, $5))`,
    [guild.id, FEATURE, JSON.stringify(patch), GRANT_JOB, GATE_JOB],
  );
  if (rowCount === 0) return;
  await schedule(ctx, guild.id, GRANT_JOB, {});
}

async function load(ctx, job) {
  const guild = ctx.client.guilds.cache.get(job.guildId);
  if (!guild) return null;
  const { config } = await getFeature(ctx.db, job.guildId, FEATURE);
  const cfg = readConfig(config);
  if (cfg.state !== 'rolling_out') return null;
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

export async function grantBatch(ctx, job, deps = { logVerification }) {
  const cur = await load(ctx, job);
  if (!cur) return;
  const { guild, cfg, raw } = cur;
  if (raw.grantDone === true) {
    // A crash between grantDone and the gate schedule: just make sure the gate is scheduled.
    await schedule(ctx, guild.id, GATE_JOB, {});
    return;
  }
  let role = cfg.roleId ? (guild.roles.cache.get(cfg.roleId) ?? null) : null;
  if (!role && cfg.roleId) role = await guild.roles.fetch(cfg.roleId).catch(() => null);
  if (!role || !botCanGive(guild, role) || cfg.cutoff == null) {
    if (await conclude(ctx, guild.id, 'failed', {})) {
      const lang = await getLang(ctx.db, guild.id);
      await deps.logVerification(ctx, guild.id, lang, {
        kind: 'rollout_failed',
        actorId: raw.rolloutBy ?? undefined,
        detail: 'Verified role missing or above my highest role',
      });
    }
    return;
  }
  if (guild.members.cache.size < (guild.memberCount ?? 0)) await guild.members.fetch();
  const after = job.payload?.after ?? null;
  const todo = [...guild.members.cache.values()]
    .filter((m) => after === null || cmpId(m.id, after) > 0)
    .sort((a, b) => cmpId(a.id, b.id));
  const batch = todo.slice(0, GRANT_BATCH);
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
  // A member we could not grant (and who has not left) must not be skipped: retry the batch.
  if (failure) throw failure;
  if (todo.length > GRANT_BATCH) {
    await schedule(ctx, guild.id, GRANT_JOB, { after: batch[batch.length - 1].id });
    return;
  }
  await setFeature(ctx.db, guild.id, FEATURE, { config: { grantDone: true } });
  await schedule(ctx, guild.id, GATE_JOB, {});
}

// Categories first, then everything else; snowflake order inside each group.
const rank = (c) => (c.type === CATEGORY ? 0 : 1);
const order = (a, b) => rank(a) - rank(b) || cmpId(a.id, b.id);

export async function gateBatch(ctx, job, deps = { logVerification, gateChannel }) {
  const log = deps.logVerification ?? logVerification;
  const gate = deps.gateChannel ?? gateChannel;
  const cur = await load(ctx, job);
  if (!cur) return;
  const { guild, cfg, raw } = cur;
  if (raw.grantDone !== true) return; // the grant job schedules the gate when it is done
  const p = job.payload ?? {};
  const cursor = p.after ? { id: p.after, type: p.afterCat ? CATEGORY : 0 } : null;
  let failed = Number(p.failed) || 0;

  const fetched = await guild.channels.fetch();
  const all = [...fetched.values()].filter((c) => c && !c.isThread?.()).sort(order);
  const todo = cursor ? all.filter((c) => order(cursor, c) < 0) : all;
  const batch = todo.slice(0, GATE_BATCH);
  for (const channel of batch) {
    if ((await gate(ctx, guild, channel, cfg)) === 'failed') failed += 1;
  }
  if (todo.length > GATE_BATCH) {
    const last = batch[batch.length - 1];
    await schedule(ctx, guild.id, GATE_JOB, { after: last.id, afterCat: last.type === CATEGORY, failed });
    return;
  }
  if (!(await conclude(ctx, guild.id, failed > 0 ? 'failed' : 'active', { failedChannels: failed }))) return;
  const lang = await getLang(ctx.db, guild.id);
  await log(ctx, guild.id, lang, {
    kind: failed > 0 ? 'rollout_failed' : 'rollout',
    actorId: raw.rolloutBy ?? undefined,
    detail: failed > 0 ? `${failed} channel(s) could not be gated` : undefined,
  });
}

export const jobs = { [GRANT_JOB]: grantBatch, [GATE_JOB]: gateBatch };
