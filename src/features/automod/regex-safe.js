// Admin-supplied regex patterns. RE2 runs in linear time, so a hostile pattern cannot hang the bot,
// and it rejects backreferences and lookarounds by throwing, which we report as invalid.
import RE2 from 're2';

export const MAX_PATTERN_LENGTH = 250;
export const MAX_TEST_LENGTH = 1000;
const MAX_CACHED_GUILDS = 500;

const originals = new WeakMap(); // compiled regex -> the source the admin wrote (RE2 may normalise .source)

function compile(source) {
  const re = new RE2(source, 'iu');
  originals.set(re, source);
  return re;
}

/** { ok: true } or { ok: false, reason: 'too_long' | 'invalid' }. */
export function validatePattern(source) {
  if (typeof source !== 'string' || source === '') return { ok: false, reason: 'invalid' };
  if (source.length > MAX_PATTERN_LENGTH) return { ok: false, reason: 'too_long' };
  try {
    compile(source);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/** Compiles the valid sources, skipping (and warning about) stored ones that no longer compile. */
export function compilePatterns(sources) {
  const out = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (typeof source !== 'string' || source.length > MAX_PATTERN_LENGTH) {
      console.warn('[automod] skipping invalid regex pattern');
      continue;
    }
    try {
      out.push(compile(source));
    } catch (err) {
      console.warn(`[automod] skipping invalid regex pattern ${JSON.stringify(source)}: ${err.message}`);
    }
  }
  return out;
}

/** Source of the first pattern matching the first 1000 characters of text, or null. */
export function matchPatterns(text, regexes) {
  if (typeof text !== 'string' || !regexes?.length) return null;
  const head = text.slice(0, MAX_TEST_LENGTH);
  for (const re of regexes) if (re.test(head)) return originals.get(re) ?? re.source;
  return null;
}

const cache = new Map(); // guildId -> { key, regexes }

/** Compiled patterns for a guild, reused until its sources change. Oldest guild is dropped past 500. */
export function getCompiled(guildId, patterns) {
  const key = JSON.stringify(patterns);
  const hit = cache.get(guildId);
  if (hit?.key === key) return hit.regexes;
  const regexes = compilePatterns(patterns);
  cache.delete(guildId);
  cache.set(guildId, { key, regexes });
  if (cache.size > MAX_CACHED_GUILDS) cache.delete(cache.keys().next().value);
  return regexes;
}
