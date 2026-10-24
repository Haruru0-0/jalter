// Pure rule matching for the autoresponder: no Discord, no DB.
import {
  compilePatterns,
  validatePattern,
  matchPatterns,
  MAX_TEST_LENGTH,
} from '../automod/regex-safe.js';

export const MATCH_MODES = ['exact', 'startswith', 'endswith', 'includes', 'regex'];
export const MAX_TRIGGER_LENGTH = 100;

const norm = (s) => String(s).trim().toLowerCase();

/** { ok: true } or { ok: false, code } for a trigger the admin typed. */
export function checkTrigger(trigger, matchMode) {
  if (!MATCH_MODES.includes(matchMode)) return { ok: false, code: 'BAD_MODE' };
  if (typeof trigger !== 'string' || trigger.trim() === '') return { ok: false, code: 'EMPTY_TRIGGER' };
  if (matchMode === 'regex') {
    return validatePattern(trigger).ok ? { ok: true } : { ok: false, code: 'BAD_REGEX' };
  }
  if (trigger.length > MAX_TRIGGER_LENGTH) return { ok: false, code: 'TRIGGER_TOO_LONG' };
  return { ok: true };
}

const regexCache = new Map(); // rule id -> { pattern, regexes }
const MAX_CACHED_RULES = 2000;

function compiledFor(rule) {
  const hit = regexCache.get(rule.id);
  if (hit?.pattern === rule.trigger) return hit.regexes;
  const regexes = compilePatterns([rule.trigger]);
  regexCache.delete(rule.id);
  regexCache.set(rule.id, { pattern: rule.trigger, regexes });
  if (regexCache.size > MAX_CACHED_RULES) regexCache.delete(regexCache.keys().next().value);
  return regexes;
}

export function matchRule(rule, text) {
  if (typeof text !== 'string' || !rule || typeof rule.trigger !== 'string') return false;
  if (rule.matchMode === 'regex') {
    if (text.length > MAX_TEST_LENGTH) return false;
    return matchPatterns(text, compiledFor(rule)) !== null;
  }
  const t = norm(text);
  const trig = norm(rule.trigger);
  if (!trig) return false;
  switch (rule.matchMode) {
    case 'exact': return t === trig;
    case 'startswith': return t.startsWith(trig);
    case 'endswith': return t.endsWith(trig);
    case 'includes': return t.includes(trig);
    default: return false;
  }
}

/**
 * The original text after the trigger for startswith/includes rules, else null.
 * Case-insensitive search (first occurrence for includes); message trimmed at the start.
 */
export function triggerRemainder(rule, text) {
  if (typeof text !== 'string' || !rule || typeof rule.trigger !== 'string') return null;
  if (rule.matchMode !== 'startswith' && rule.matchMode !== 'includes') return null;
  const trig = norm(rule.trigger);
  if (!trig) return null;
  const body = text.trimStart();
  // Search the same whole-string fold the match uses (context-sensitive cases such as the
  // Greek final sigma included), then map the folded index back to an original offset.
  const folded = body.toLowerCase();
  const at = rule.matchMode === 'startswith'
    ? (folded.startsWith(trig) ? 0 : -1)
    : folded.indexOf(trig);
  if (at < 0) return null;
  const end = at + trig.length;
  if (folded.length === body.length) return body.slice(end); // no length drift
  // Some characters (e.g. U+0130) lowercase to a different length: map per code point.
  const offsets = [];
  let pos = 0;
  for (const ch of body) {
    const n = ch.toLowerCase().length;
    for (let k = 0; k < n; k++) offsets.push(pos);
    pos += ch.length;
  }
  offsets.push(body.length);
  if (offsets.length - 1 !== folded.length) return body.slice(Math.min(end, body.length));
  return body.slice(offsets[end]);
}

/** Best matching enabled rule: non-regex first, then longest trigger, then lowest id. */
export function chooseRule(rules, text) {
  let best = null;
  for (const rule of rules ?? []) {
    if (!rule.enabled || !matchRule(rule, text)) continue;
    if (!best || compare(rule, best) < 0) best = rule;
  }
  return best;
}

function compare(a, b) {
  const ar = a.matchMode === 'regex' ? 1 : 0;
  const br = b.matchMode === 'regex' ? 1 : 0;
  if (ar !== br) return ar - br;
  const al = norm(a.trigger).length;
  const bl = norm(b.trigger).length;
  if (al !== bl) return bl - al;
  return a.id - b.id;
}
