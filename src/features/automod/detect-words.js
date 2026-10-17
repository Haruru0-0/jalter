// Pure bad-word matching. Words and text share the same normaliser.
import { normalizeText, tokens } from './normalize.js';
import { BUILTIN_WORDS } from './words-default.js';
import { getCompiled, matchPatterns } from './regex-safe.js';

const ARABIC = /\p{Script=Arabic}/u;

/** cfg is config.rules.words. Normalised, deduped, builtin (all languages) minus removed plus custom. */
export function effectiveWords(cfg) {
  const c = cfg ?? {};
  const removed = new Set((Array.isArray(c.removedBuiltin) ? c.removedBuiltin : []).map(normalizeText));
  const all = [];
  if (c.useBuiltin !== false) {
    for (const list of Object.values(BUILTIN_WORDS)) all.push(...list.map(normalizeText).filter((w) => !removed.has(w)));
  }
  if (Array.isArray(c.custom)) all.push(...c.custom.map(normalizeText));
  return [...new Set(all.filter(Boolean))];
}

const squeeze = (s) => s.replace(/(.)\1+/gsu, '$1');
const hasRun = (s) => /(.)\1/su.test(s);

/** Returns the first listed word found in text, or null. Single words match whole tokens;
 *  phrases and Arabic words match as substrings of the normalised text. Exact comparison
 *  first, then a squeezed comparison (runs collapsed to 1) only where the text has a run,
 *  so stretched spellings ('fuuuuck') match without 'as' matching 'ass'. */
export function findBadWord(text, words) {
  if (!Array.isArray(words) || words.length === 0) return null;
  const norm = normalizeText(text);
  if (!norm) return null;
  const toks = new Set(tokens(text));
  const subs = [];
  const singles = [];
  for (const raw of words) {
    const w = normalizeText(raw);
    if (!w) continue;
    if (w.includes(' ') || ARABIC.test(w)) subs.push([w, raw]);
    else {
      singles.push([w, raw]);
      if (toks.has(w)) return raw;
    }
  }
  for (const [w, raw] of subs) if (norm.includes(w)) return raw;

  const stretched = new Set();
  for (const t of toks) if (hasRun(t)) stretched.add(squeeze(t));
  if (stretched.size) {
    for (const [w, raw] of singles) if (stretched.has(squeeze(w))) return raw;
  }
  if (hasRun(norm)) {
    const sq = squeeze(norm);
    for (const [w, raw] of subs) if (sq.includes(squeeze(w))) return raw;
  }
  return null;
}

/** cfg is config.rules.words. Returns the source of the first admin regex matching text, or null. */
export function findPattern(text, cfg, guildId) {
  const patterns = cfg?.patterns;
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  return matchPatterns(text, getCompiled(guildId, patterns));
}
