export const MODES = ['button', 'captcha'];
export const STATES = ['none', 'rolling_out', 'active', 'failed'];
export const MAX_CHANNELS = 200;

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
  };
}

/** What the gate does with a channel: verify, public, skip or gated (in that precedence). */
export function classify(channelId, cfg) {
  if (cfg.channelId === channelId) return 'verify';
  if (cfg.publicChannels.includes(channelId)) return 'public';
  if (cfg.skippedChannels.includes(channelId)) return 'skip';
  return 'gated';
}
