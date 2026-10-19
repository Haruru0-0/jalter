// Unverified-member policy: constants, pure helpers and the job queue/cancel helpers.
import { UNVERIFIED_POLICIES, DEFAULT_KICK } from './config.js';
import { scheduleJob, cancelJobs } from '../../core/scheduler.js';

export const POLICIES = UNVERIFIED_POLICIES;
export const DEFAULT_KICK_SECONDS = DEFAULT_KICK;
export const KICK_MIN_SECONDS = 600;
export const KICK_MAX_SECONDS = 2592000;
export const MIN_GAP_SECONDS = 600;
export const WARN_JOB = 'verification.warn';
export const KICK_JOB = 'verification.kick';

/** The warn time in effect: the saved one, or half the kick time (floored). */
export function effectiveWarnSeconds({ kickAfterSeconds, warnAfterSeconds }) {
  return warnAfterSeconds ?? Math.floor(kickAfterSeconds / 2);
}

/** Validates the times for a policy: { ok: true } or { ok: false, reason: 'kick_range' | 'warn_gap' }. */
export function checkTimes({ policy, kickAfterSeconds, warnAfterSeconds }) {
  if (kickAfterSeconds < KICK_MIN_SECONDS || kickAfterSeconds > KICK_MAX_SECONDS) {
    return { ok: false, reason: 'kick_range' };
  }
  if (policy === 'warn_kick') {
    const warn = effectiveWarnSeconds({ kickAfterSeconds, warnAfterSeconds });
    if (warn > kickAfterSeconds - MIN_GAP_SECONDS) return { ok: false, reason: 'warn_gap' };
  }
  return { ok: true };
}

/**
 * Queues the warn/kick jobs for a joining human. One job per (guild, type, member), so a rejoin
 * replaces them. Due times count from the join, never earlier than now.
 */
export async function queueUnverifiedJobs(ctx, member, cfg, now = Date.now()) {
  if (cfg.unverifiedPolicy === 'none') return;
  const guildId = member.guild.id;
  const joined = member.joinedTimestamp ?? now;
  const at = (seconds) => Math.max(now, joined + seconds * 1000);
  const kickAt = at(cfg.kickAfterSeconds);
  const base = { policy: cfg.unverifiedPolicy, kickAt, kickAfter: cfg.kickAfterSeconds };
  if (cfg.unverifiedPolicy === 'warn_kick') {
    await scheduleJob(ctx.db, {
      guildId, type: WARN_JOB, key: member.id, payload: base, dueAt: at(effectiveWarnSeconds(cfg)),
    });
  }
  await scheduleJob(ctx.db, { guildId, type: KICK_JOB, key: member.id, payload: base, dueAt: kickAt });
}

/** Drops a member's queued warn and kick jobs. */
export async function cancelMemberJobs(db, guildId, userId) {
  await cancelJobs(db, { guildId, type: WARN_JOB, key: userId });
  await cancelJobs(db, { guildId, type: KICK_JOB, key: userId });
}

/** Drops every queued warn and kick job of a guild. */
export async function cancelAllUnverifiedJobs(db, guildId) {
  await cancelJobs(db, { guildId, type: WARN_JOB });
  await cancelJobs(db, { guildId, type: KICK_JOB });
}
