const MAX_KEYS = 5000;

/** `allow(key)` is true at most once per key per window. Holds at most 5000 keys, oldest evicted first. */
export function createThrottle(everyMs, now = Date.now) {
  const last = new Map();
  return {
    allow(key) {
      const t = now();
      const prev = last.get(key);
      if (prev !== undefined && t - prev < everyMs) return false;
      last.delete(key); // re-insert so the Map order stays oldest first
      last.set(key, t);
      while (last.size > MAX_KEYS) last.delete(last.keys().next().value);
      return true;
    },
  };
}
