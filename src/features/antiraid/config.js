// Anti-raid settings and the state of a running lockdown.
//
// Both live in the same jsonb (the feature config of `antiraid`), because setFeature
// merge-writes: a settings write never replaces the lockdown state, and a state write never
// replaces the settings. There is no table of our own and no migration.
//
// The ranges are the admin limits. A value outside them is refused at save time (checkConfig)
// and read back as the default (readConfig), so a hand-edited config cannot break the detector.
export const DEFAULTS = {
  joins: 10,
  windowSeconds: 60,
  accountAgeSeconds: 604800,
  durationSeconds: 1800,
  pingRoleId: null,
};

export const RANGES = {
  joins: [3, 100],
  windowSeconds: [10, 600],
  accountAgeSeconds: [3600, 7776000],
  durationSeconds: [300, 86400],
};

// The keys of a running lockdown. They are reset by every start and every end.
export const STATE_KEYS = [
  'state', 'lockedAt', 'lockedUntil', 'startedBy', 'kicked',
  'invitesPausedByUs', 'inviteResult', 'alertResult',
];

const STATES = new Set(['idle', 'locked']);
const INVITE_RESULTS = new Set(['none', 'paused', 'already', 'failed']);
const ALERT_RESULTS = new Set(['none', 'sent', 'no_channel', 'failed']);

const REASON = {
  joins: 'joins_range',
  windowSeconds: 'window_range',
  accountAgeSeconds: 'age_range',
  durationSeconds: 'duration_range',
};

const intIn = (v, min, max, d) => (Number.isInteger(v) && v >= min && v <= max ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const id = (v) => (typeof v === 'string' && v !== '' ? v : null);
const stamp = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalises the raw stored config: the defaults for anything missing, invalid or out of range. */
export function readConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    joins: intIn(c.joins, RANGES.joins[0], RANGES.joins[1], DEFAULTS.joins),
    windowSeconds: intIn(c.windowSeconds, RANGES.windowSeconds[0], RANGES.windowSeconds[1], DEFAULTS.windowSeconds),
    accountAgeSeconds: intIn(
      c.accountAgeSeconds, RANGES.accountAgeSeconds[0], RANGES.accountAgeSeconds[1], DEFAULTS.accountAgeSeconds,
    ),
    durationSeconds: intIn(
      c.durationSeconds, RANGES.durationSeconds[0], RANGES.durationSeconds[1], DEFAULTS.durationSeconds,
    ),
    pingRoleId: id(c.pingRoleId),
    state: STATES.has(c.state) ? c.state : 'idle',
    lockedAt: stamp(c.lockedAt),
    lockedUntil: stamp(c.lockedUntil),
    startedBy: id(c.startedBy),
    kicked: Number.isInteger(c.kicked) && c.kicked >= 0 ? c.kicked : 0,
    invitesPausedByUs: bool(c.invitesPausedByUs, false),
    inviteResult: INVITE_RESULTS.has(c.inviteResult) ? c.inviteResult : 'none',
    alertResult: ALERT_RESULTS.has(c.alertResult) ? c.alertResult : 'none',
  };
}

/**
 * Checks the settings a caller wants to save. Only the keys that are present are checked:
 * `{ joins: 20 }` says nothing about the window.
 */
export function checkConfig(patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (p[key] === undefined || p[key] === null) continue;
    const v = p[key];
    if (!Number.isInteger(v) || v < min || v > max) return { ok: false, reason: REASON[key] };
  }
  return { ok: true };
}
