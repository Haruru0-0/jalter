export const RULES = ['spam', 'invites', 'links', 'words'];

export const MAX_EXEMPT_ROLES = 10;
export const MAX_EXEMPT_CHANNELS = 20;
export const MAX_LIST = 100;
export const MAX_STEPS = 8;

export const STRIKES_MIN = 1;
export const STRIKES_MAX = 50;
export const WINDOW_MIN = 10;
export const WINDOW_MAX = 86_400;
export const TIMEOUT_MIN = 60;
export const TIMEOUT_MAX = 2_419_200;
const TIMEOUT_DEFAULT = 600;

const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const intIn = (v, min, max, d) => (Number.isInteger(v) && v >= min && v <= max ? v : d);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

const DEFAULT_STEPS = [{ strikes: 3, action: 'warn', timeoutSeconds: null }];

/** Spam sub-checks: [key, [[field, min, max, default], ...]]. Each also has `enabled` (default true). */
export const SPAM_CHECKS = {
  burst: { messages: [2, 50, 5], seconds: [1, 3600, 5] },
  identical: { count: [2, 50, 4], seconds: [1, 3600, 60] },
  caps: { minLength: [1, 2000, 10], percent: [10, 100, 70] },
  emoji: { max: [1, 100, 10] },
  mentions: { max: [1, 100, 5] },
  attachments: { count: [2, 50, 5], seconds: [1, 3600, 30] },
  linkRate: { count: [2, 50, 5], seconds: [1, 3600, 30] },
};

const cleanList = (v, max) =>
  Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x !== ''))].slice(0, max) : [];

/** Returns a normalised step, or null when invalid. */
function cleanStep(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  if (!Number.isInteger(s.strikes) || s.strikes < STRIKES_MIN || s.strikes > STRIKES_MAX) return null;
  if (s.action === 'warn') return { strikes: s.strikes, action: 'warn', timeoutSeconds: null };
  if (s.action === 'timeout') {
    const secs = s.timeoutSeconds == null ? TIMEOUT_DEFAULT : s.timeoutSeconds;
    if (!Number.isInteger(secs) || secs < TIMEOUT_MIN || secs > TIMEOUT_MAX) return null;
    return { strikes: s.strikes, action: 'timeout', timeoutSeconds: secs };
  }
  return null;
}

/** Lenient: drops invalid and duplicate steps, sorts ascending, falls back to the default. */
function readSteps(v) {
  if (!Array.isArray(v)) return DEFAULT_STEPS.map((s) => ({ ...s }));
  const seen = new Set();
  const steps = [];
  for (const raw of v) {
    const s = cleanStep(raw);
    if (!s || seen.has(s.strikes)) continue;
    seen.add(s.strikes);
    steps.push(s);
  }
  steps.sort((a, b) => a.strikes - b.strikes);
  const capped = steps.slice(0, MAX_STEPS);
  return capped.length ? capped : DEFAULT_STEPS.map((s) => ({ ...s }));
}

function readRule(raw, rule) {
  const r = obj(raw);
  const out = {
    enabled: bool(r.enabled, false),
    delete: bool(r.delete, true),
    windowSeconds: intIn(r.windowSeconds, WINDOW_MIN, WINDOW_MAX, 600),
    steps: readSteps(r.steps),
  };
  if (rule === 'spam') {
    for (const [name, fields] of Object.entries(SPAM_CHECKS)) {
      const c = obj(r[name]);
      const check = { enabled: bool(c.enabled, true) };
      for (const [f, [min, max, d]] of Object.entries(fields)) check[f] = intIn(c[f], min, max, d);
      out[name] = check;
    }
  }
  if (rule === 'invites' || rule === 'links') {
    out.allow = cleanList(r.allow, MAX_LIST);
    out.block = cleanList(r.block, MAX_LIST);
    out.blockAllExceptAllowed = bool(r.blockAllExceptAllowed, rule === 'invites');
  }
  if (rule === 'words') {
    out.custom = cleanList(r.custom, MAX_LIST);
    out.removedBuiltin = cleanList(r.removedBuiltin, MAX_LIST);
    out.useBuiltin = bool(r.useBuiltin, true);
  }
  return out;
}

/** Normalises the raw stored config: defaults for anything missing or invalid. Never throws. */
export function readConfig(raw) {
  const c = obj(raw);
  const rules = obj(c.rules);
  return {
    exemptRoles: cleanList(c.exemptRoles, MAX_EXEMPT_ROLES),
    exemptChannels: cleanList(c.exemptChannels, MAX_EXEMPT_CHANNELS),
    nickname: { enabled: bool(obj(c.nickname).enabled, false) },
    rules: Object.fromEntries(RULES.map((rule) => [rule, readRule(rules[rule], rule)])),
  };
}

const ok = (config) => ({ ok: true, config });
const fail = (reason) => ({ ok: false, reason });

/** Describes where each list lives so mutators can read and write it. */
const LISTS = {
  exemptRoles: { max: MAX_EXEMPT_ROLES },
  exemptChannels: { max: MAX_EXEMPT_CHANNELS },
  'invites.allow': { rule: 'invites', key: 'allow', max: MAX_LIST },
  'invites.block': { rule: 'invites', key: 'block', max: MAX_LIST },
  'links.allow': { rule: 'links', key: 'allow', max: MAX_LIST },
  'links.block': { rule: 'links', key: 'block', max: MAX_LIST },
  'words.custom': { rule: 'words', key: 'custom', max: MAX_LIST },
  'words.removedBuiltin': { rule: 'words', key: 'removedBuiltin', max: MAX_LIST },
};

const getList = (config, path) => {
  const spec = LISTS[path];
  return spec.rule ? config.rules[spec.rule][spec.key] : config[path];
};

function withList(config, path, list) {
  const spec = LISTS[path];
  if (!spec.rule) return { ...config, [path]: list };
  return {
    ...config,
    rules: { ...config.rules, [spec.rule]: { ...config.rules[spec.rule], [spec.key]: list } },
  };
}

const isPath = (path) => typeof path === 'string' && Object.hasOwn(LISTS, path);

export function addToList(config, path, value) {
  if (!isPath(path) || typeof value !== 'string' || value === '') return fail('invalid');
  const current = readConfig(config);
  const list = getList(current, path);
  if (list.includes(value)) return fail('exists');
  if (list.length >= LISTS[path].max) return fail('full');
  return ok(withList(current, path, [...list, value]));
}

export function removeFromList(config, path, value) {
  if (!isPath(path)) return fail('invalid');
  const current = readConfig(config);
  const list = getList(current, path);
  if (!list.includes(value)) return fail('missing');
  return ok(withList(current, path, list.filter((x) => x !== value)));
}

/** Strict: any invalid or duplicate step rejects the whole set. Sorted ascending by strikes. */
export function setSteps(config, rule, steps) {
  if (!RULES.includes(rule)) return fail('invalid');
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) return fail('invalid');
  const cleaned = steps.map(cleanStep);
  if (cleaned.some((s) => s === null)) return fail('invalid');
  if (new Set(cleaned.map((s) => s.strikes)).size !== cleaned.length) return fail('invalid');
  cleaned.sort((a, b) => a.strikes - b.strikes);
  const current = readConfig(config);
  return ok({ ...current, rules: { ...current.rules, [rule]: { ...current.rules[rule], steps: cleaned } } });
}
