// Shared text normaliser for auto-mod checks. Pure, never throws.
const SWAPS = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };

export function normalizeText(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .normalize('NFKD')
    .replace(/[\p{Cf}\u0640]/gu, '') // zero-width, soft hyphen, bidi marks, Arabic tatweel
    .replace(/\p{M}/gu, '') // accents and Arabic diacritics
    .toLowerCase()
    .replace(/[013457@$]/g, (c) => SWAPS[c] ?? c)
    .replace(/(.)\1{2,}/gsu, '$1$1') // 3+ repeats -> 2
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalised text split on whitespace and punctuation.
export function tokens(text) {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
