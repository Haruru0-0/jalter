// Pure bad-word matching. Words and text share the same normaliser.
import { normalizeText, tokens } from './normalize.js';
import { BUILTIN_WORDS } from './words-default.js';

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

/** Returns the first listed word found in text, or null. Single words match whole tokens;
 *  phrases and Arabic words match as substrings of the normalised text. */
export function findBadWord(text, words) {
  if (!Array.isArray(words) || words.length === 0) return null;
  const norm = normalizeText(text);
  if (!norm) return null;
  const toks = new Set(tokens(text));
  const subs = [];
  for (const raw of words) {
    const w = normalizeText(raw);
    if (!w) continue;
    if (w.includes(' ') || ARABIC.test(w)) subs.push([w, raw]);
    else if (toks.has(w)) return raw;
  }
  for (const [w, raw] of subs) if (norm.includes(w)) return raw;
  return null;
}
