import { randomInt } from 'node:crypto';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
export const CODE_TTL_MS = 300_000;
export const MAX_WRONG = 3;
export const COOLDOWN_MS = 30_000;

// A character index: crypto.randomInt by default (codes must not be guessable); tests inject
// a `random` returning [0, 1) to get fixed codes.
const pick = (random) => (random
  ? Math.min(CODE_ALPHABET.length - 1, Math.floor(random() * CODE_ALPHABET.length))
  : randomInt(CODE_ALPHABET.length));

export function makeCode(random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[pick(random)];
  return out;
}

// In-memory, per guild+user. Entry: { code, expiresAt, wrong, cooldownUntil }.
// code is null while cooling down. check() returns 'cooldown' for the wrong entry
// that starts the cooldown (triesLeft is then 0), 'wrong' otherwise.
export function createChallengeStore({ now = Date.now, random } = {}) {
  const entries = new Map();
  const key = (g, u) => `${g}:${u}`;

  function prune() {
    const t = now();
    for (const [k, e] of entries) {
      if (e.cooldownUntil) {
        if (t >= e.cooldownUntil) entries.delete(k);
      } else if (t >= e.expiresAt + CODE_TTL_MS) {
        entries.delete(k); // kept one extra TTL so check() can say 'expired'
      }
    }
  }

  function cooldownLeft(guildId, userId) {
    prune();
    const e = entries.get(key(guildId, userId));
    return e?.cooldownUntil ? Math.max(0, e.cooldownUntil - now()) : 0;
  }

  function triesLeft(guildId, userId) {
    prune();
    const e = entries.get(key(guildId, userId));
    if (!e) return MAX_WRONG;
    if (e.cooldownUntil) return 0;
    return Math.max(0, MAX_WRONG - e.wrong);
  }

  function issue(guildId, userId) {
    prune();
    const k = key(guildId, userId);
    const prev = entries.get(k);
    if (prev?.cooldownUntil) {
      return { code: null, cooldownLeft: Math.max(0, prev.cooldownUntil - now()) };
    }
    const code = makeCode(random);
    // Wrong entries carry over a re-issue so refreshing cannot be used to dodge the limit.
    entries.set(k, { code, expiresAt: now() + CODE_TTL_MS, wrong: prev?.wrong ?? 0, cooldownUntil: 0 });
    return { code };
  }

  function check(guildId, userId, input) {
    prune();
    const k = key(guildId, userId);
    const e = entries.get(k);
    if (!e) return 'none';
    if (e.cooldownUntil) return 'cooldown';
    if (now() >= e.expiresAt) {
      entries.delete(k);
      return 'expired';
    }
    if (String(input ?? '').trim().toUpperCase() === e.code) {
      entries.delete(k);
      return 'ok';
    }
    e.wrong += 1;
    if (e.wrong >= MAX_WRONG) {
      e.code = null;
      e.cooldownUntil = now() + COOLDOWN_MS;
      return 'cooldown';
    }
    return 'wrong';
  }

  function clear(guildId, userId) {
    entries.delete(key(guildId, userId));
  }

  return { issue, check, cooldownLeft, triesLeft, clear, size: () => (prune(), entries.size) };
}
