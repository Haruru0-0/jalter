export const MIN_DELAY = 60;
export const MAX_DELAY = 2592000;

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };
const PART = /(\d+)\s*([a-z])/gy;

/** `30m`, `1d12h`, `1h 30m` to seconds; null when it does not match completely or is zero. */
export function parseDuration(input) {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return null;
  PART.lastIndex = 0;
  let total = 0;
  let end = 0;
  let match;
  while (end < text.length && (match = PART.exec(text))) {
    const factor = UNITS[match[2]];
    if (!factor) return null;
    total += Number(match[1]) * factor;
    end = PART.lastIndex;
    while (text[end] === ' ') end = PART.lastIndex = end + 1;
  }
  return end === text.length && total > 0 ? total : null;
}

/** 90 gives `1m30s`; zero units are skipped. */
export function formatDuration(seconds) {
  let rest = Math.max(0, Math.floor(seconds));
  let out = '';
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]]) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count) out += `${count}${unit}`;
  }
  return out || '0s';
}
