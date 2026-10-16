/** In-memory sliding-window strike counter and step selection. Pure: no DB, no Discord. */

const keyOf = (guildId, userId, rule) => `${guildId}:${userId}:${rule}`;

export function createStrikeStore() {
  const map = new Map();

  /** A strike made at time t is inside the window while now - t < windowMs. */
  const live = (list, now, windowMs) => list.filter((t) => now - t < windowMs);

  return {
    /** previous = strikes in the window before this one; count = including it. */
    add(guildId, userId, rule, now, windowMs) {
      const key = keyOf(guildId, userId, rule);
      const list = live(map.get(key) ?? [], now, windowMs);
      const previous = list.length;
      list.push(now);
      map.set(key, list);
      return { previous, count: previous + 1 };
    },
    reset(guildId, userId, rule) {
      map.delete(keyOf(guildId, userId, rule));
    },
    /** Drops expired timestamps and empty keys so memory stays bounded. */
    prune(now, maxWindowMs) {
      for (const [key, list] of map) {
        const kept = live(list, now, maxWindowMs);
        if (kept.length === 0) map.delete(key);
        else if (kept.length !== list.length) map.set(key, kept);
      }
    },
    size() {
      return map.size;
    },
  };
}

/** Highest step with previous < step.strikes <= count, or null. */
export function stepReached(steps, previous, count) {
  let hit = null;
  for (const step of steps ?? []) {
    if (previous < step.strikes && step.strikes <= count && (!hit || step.strikes > hit.strikes)) hit = step;
  }
  return hit;
}

export function isTopStep(steps, step) {
  if (!step || !steps?.length) return false;
  return steps.every((s) => s.strikes <= step.strikes);
}
