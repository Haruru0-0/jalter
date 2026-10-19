// Unverified-member policy: the warn and kick scheduler jobs.
//
// Fire-time checks: both jobs re-read everything when they run (feature on, state running, the
// saved policy not `none`, member still here, not a bot, without the Verified role, not spared).
// They act on the policy the job was QUEUED with (payload.policy), never on the saved one.
//
// Warn is at-most-once: after the checks (which may throw and retry) the job claims itself by
// deleting its own row; zero rows deleted means an earlier run (or a rejoin) owns it, so nothing
// happens. Only then is runAction called, and anything it throws counts as a failed warn. Either
// way the member's kick job is rescheduled at the same kickAt with `warned: 'ok' | 'failed'`.
//
// Under warn_kick the kick job kicks only when `warned === 'ok'`. A refused kick logs one line and
// is not retried; a thrown error is rethrown so the scheduler retries (a kick is idempotent: a
// retry finds the member gone).
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { scheduleJob, cancelJobs, MAX_ATTEMPTS } from '../../core/scheduler.js';
import { canManage } from '../../core/permissions.js';
import { formatDuration } from '../../core/duration.js';
import { runAction } from '../moderation/actions.js';
import { readConfig as readModConfig } from '../moderation/config.js';
import { readConfig, RUNNING } from './config.js';
import { logVerification } from './log.js';
import { WARN_JOB, KICK_JOB } from './unverified.js';

const UNKNOWN_MEMBER = 10007;
const QUEUED_POLICIES = new Set(['kick', 'warn_kick']);

const using = (deps) => ({
  run: deps.runAction ?? runAction,
  log: deps.logVerification ?? logVerification,
  now: deps.now ?? Date.now,
});

async function fetchMember(guild, userId) {
  try {
    return (await guild.members.fetch(userId)) ?? null;
  } catch (err) {
    if (err?.code === UNKNOWN_MEMBER) return null;
    throw err;
  }
}

// Bots, the owner, members at or above the bot's highest role, and managers are left alone.
async function isSpared(ctx, guild, member) {
  if (member.user?.bot) return true;
  if (member.id === guild.ownerId) return true;
  const botTop = guild.members.me?.roles?.highest?.position;
  const top = member.roles?.highest?.position ?? 0;
  if (typeof botTop !== 'number' || top >= botTop) return true;
  return canManage(ctx.db, member);
}

// The fire-time checks. null: do nothing. Throws only on transient errors (retry).
async function load(ctx, job) {
  const guild = ctx.client?.guilds?.cache?.get(job.guildId);
  if (!guild) return null;
  const { enabled, config } = await getFeature(ctx.db, job.guildId, 'verification');
  const cfg = readConfig(config);
  if (!enabled || !RUNNING.has(cfg.state) || cfg.unverifiedPolicy === 'none') return null;
  const member = await fetchMember(guild, job.key);
  if (!member) return null;
  if (member.user?.bot) return null;
  if (cfg.roleId && member.roles?.cache?.has(cfg.roleId)) return null;
  if (await isSpared(ctx, guild, member)) return null;
  return { guild, cfg, member };
}

const errorDetail = (err) => `error: ${err?.message ?? err}`;

async function rescheduleKick(ctx, guildId, userId, p, warned) {
  await scheduleJob(ctx.db, {
    guildId, type: KICK_JOB, key: userId,
    payload: { policy: p.policy, kickAt: p.kickAt, kickAfter: p.kickAfter, warned },
    dueAt: p.kickAt,
  });
}

/** Scheduler handler for WARN_JOB (queued policy warn_kick only). */
export async function warnJob(ctx, job, deps = {}) {
  const { run, log, now } = using(deps);
  const p = job.payload ?? {};
  if (p.policy !== 'warn_kick' || !Number.isFinite(p.kickAt)) return;
  let claimed = false;
  try {
    const cur = await load(ctx, job);
    if (!cur) return;
    const { guild, cfg, member } = cur;
    const lang = await getLang(ctx.db, guild.id);
    const modConfig = readModConfig((await getFeature(ctx.db, guild.id, 'moderation')).config);

    // The claim. Matching kickAt keeps a rejoin's newer row out of reach.
    const removed = await cancelJobs(ctx.db, {
      guildId: guild.id, type: WARN_JOB, key: member.id, payload: { kickAt: p.kickAt },
    });
    if (removed === 0) return;
    claimed = true;

    const left = Math.max(0, Math.ceil((p.kickAt - now()) / 1000));
    const reason = t(lang, 'verification.unverified.warn_reason', {
      channel: `<#${cfg.channelId}>`, time: formatDuration(left),
    });
    let result;
    try {
      result = await run(ctx, {
        guild, actor: guild.members.me, type: 'warn', targetId: member.id, target: member,
        reason, config: modConfig, lang,
      });
    } catch (err) {
      result = { ok: false, reason: errorDetail(err) };
    }
    const warned = result?.ok === true ? 'ok' : 'failed';
    await rescheduleKick(ctx, guild.id, member.id, p, warned);
    if (warned === 'failed') {
      await log(ctx, guild.id, lang, {
        kind: 'unverified_failed', userId: member.id, detail: `warn: ${result?.reason ?? 'unknown'}`,
      });
    }
  } catch (err) {
    // The scheduler drops the job after this attempt: the warn will never happen, so mark it
    // failed (the kick is skipped) and say so once. Not after the claim: the warn ran by then.
    if (!claimed && job.attempts >= MAX_ATTEMPTS) {
      try {
        await rescheduleKick(ctx, job.guildId, job.key, p, 'failed');
        const lang = await getLang(ctx.db, job.guildId);
        await log(ctx, job.guildId, lang, {
          kind: 'unverified_failed', userId: job.key, detail: `warn: ${errorDetail(err)}`,
        });
      } catch (inner) {
        console.warn(`Could not mark the unverified warn failed in ${job.guildId}: ${inner?.message ?? inner}`);
      }
    }
    throw err;
  }
}

// True when this claimed row was rescheduled since it was claimed (scheduleJob resets attempts to
// 0): the newer row runs on its own, this stale copy must not act.
async function isSuperseded(db, job) {
  if (job.id == null) return false;
  const { rows } = await db.query('SELECT attempts FROM scheduled_jobs WHERE id = $1', [job.id]);
  return rows.length > 0 && rows[0].attempts !== job.attempts;
}

async function warnPending(db, guildId, userId) {
  const { rows } = await db.query(
    'SELECT 1 FROM scheduled_jobs WHERE guild_id = $1 AND type = $2 AND key = $3 LIMIT 1',
    [guildId, WARN_JOB, userId],
  );
  return rows.length > 0;
}

/** Scheduler handler for KICK_JOB. */
export async function kickJob(ctx, job, deps = {}) {
  const { run, log } = using(deps);
  const p = job.payload ?? {};
  if (!QUEUED_POLICIES.has(p.policy)) return;
  try {
    const cur = await load(ctx, job);
    if (!cur) return;
    if (await isSuperseded(ctx.db, job)) return;
    const { guild, cfg, member } = cur;
    const lang = await getLang(ctx.db, guild.id);

    if (p.policy === 'warn_kick' && p.warned !== 'ok') {
      // `failed` was logged by the warn job. Undefined: the warn has not run. While its row is
      // still queued (due later or retrying) it will reschedule this kick itself, so stay quiet.
      if (p.warned === undefined && !(await warnPending(ctx.db, guild.id, member.id))) {
        await log(ctx, guild.id, lang, {
          kind: 'unverified_failed', userId: member.id, detail: 'kick skipped: the warning never ran',
        });
      }
      return;
    }

    const modConfig = readModConfig((await getFeature(ctx.db, guild.id, 'moderation')).config);
    const kickAfter = Number.isFinite(p.kickAfter) && p.kickAfter > 0 ? p.kickAfter : cfg.kickAfterSeconds;
    const reason = t(lang, 'verification.unverified.kick_reason', { time: formatDuration(kickAfter) });
    const result = await run(ctx, {
      guild, actor: guild.members.me, type: 'kick', targetId: member.id, target: member,
      reason, config: modConfig, lang,
    });
    if (result?.ok === true || result?.reason === 'not_in_server') return;
    await log(ctx, guild.id, lang, {
      kind: 'unverified_failed', userId: member.id, detail: `kick: ${result?.reason ?? 'unknown'}`,
    });
  } catch (err) {
    // Last attempt: the scheduler drops the job, so the kick failure must reach the mod log.
    if (job.attempts >= MAX_ATTEMPTS) {
      try {
        const lang = await getLang(ctx.db, job.guildId);
        await log(ctx, job.guildId, lang, {
          kind: 'unverified_failed', userId: job.key, detail: `kick: ${errorDetail(err)}`,
        });
      } catch (inner) {
        console.warn(`Could not log the unverified kick failure in ${job.guildId}: ${inner?.message ?? inner}`);
      }
    }
    throw err;
  }
}

export const jobs = { [WARN_JOB]: warnJob, [KICK_JOB]: kickJob };
