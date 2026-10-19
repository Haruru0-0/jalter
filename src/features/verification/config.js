export const MODES = ['button', 'captcha'];
export const STATES = ['none', 'rolling_out', 'active', 'failed'];
// States in which verification is running. `failed` keeps running too: the gate stays on the
// channels it reached (same ruling as the verify button and the captcha).
export const RUNNING = new Set(['rolling_out', 'active', 'failed']);
export const MAX_CHANNELS = 200;
export const UNVERIFIED_POLICIES = ['none', 'kick', 'warn_kick'];
// The policies that queue warn/kick jobs.
export const QUEUED_POLICIES = UNVERIFIED_POLICIES.filter((p) => p !== 'none');
export const DEFAULT_KICK = 86400;

const seconds = (v) => (Number.isFinite(v) && v > 0 ? v : null);
const id = (v) => (typeof v === 'string' && v !== '' ? v : null);
const list = (v) => {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x) => typeof x === 'string' && x !== ''))].slice(0, MAX_CHANNELS);
};

/** Turns the stored JSON into a complete config; bad values fall back to defaults. */
export function readConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    mode: MODES.includes(r.mode) ? r.mode : 'button',
    roleId: id(r.roleId),
    channelId: id(r.channelId),
    messageId: id(r.messageId),
    state: STATES.includes(r.state) ? r.state : 'none',
    publicChannels: list(r.publicChannels),
    skippedChannels: list(r.skippedChannels),
    cutoff: Number.isFinite(r.cutoff) && r.cutoff >= 0 ? r.cutoff : null,
    unverifiedPolicy: UNVERIFIED_POLICIES.includes(r.unverifiedPolicy) ? r.unverifiedPolicy : 'none',
    kickAfterSeconds: seconds(r.kickAfterSeconds) ?? DEFAULT_KICK,
    warnAfterSeconds: seconds(r.warnAfterSeconds),
  };
}

/** What the gate does with a channel: verify, public, skip or gated (in that precedence). */
export function classify(channelId, cfg) {
  if (cfg.channelId === channelId) return 'verify';
  if (cfg.publicChannels.includes(channelId)) return 'public';
  if (cfg.skippedChannels.includes(channelId)) return 'skip';
  return 'gated';
}
