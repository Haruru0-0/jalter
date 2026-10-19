// Unverified-member policy: constants and pure helpers (no I/O).
import { UNVERIFIED_POLICIES, DEFAULT_KICK } from './config.js';

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
