// The recent joins of every server, in memory only.
//
// The counter is not persisted: a restart empties it. That is deliberate (a raid does not last a
// restart) and it is why a manual start right after a restart may kick nobody.
//
// The store keeps the entries for a while after they fell out of the detection window, so the
// window can grow without losing the joins it now covers. The sweep drops whatever is older
// than the longest window the admin can configure, so the memory stays bounded.
const SWEEP_MS = 60_000;
export const MAX_WINDOW_MS = 600_000;

/** A join is live while `now - joinedAt < windowMs`: one that is exactly windowMs old is out. */
const isLive = (entry, now, windowMs) => now - entry.joinedAt < windowMs;

export function createJoinStore() {
  const byGuild = new Map();

  /** Adds a join and returns how many joins of this server are inside the window. */
  function record(guildId, { userId, createdAt }, now, windowMs) {
    const list = byGuild.get(guildId) ?? [];
    list.push({ userId, createdAt, joinedAt: now });
    byGuild.set(guildId, list);
    return list.filter((entry) => isLive(entry, now, windowMs)).length;
  }

  /** The joins of this server that are inside the window, oldest first. */
  function recent(guildId, now, windowMs) {
    const list = byGuild.get(guildId) ?? [];
    return list.filter((entry) => isLive(entry, now, windowMs)).map((entry) => ({ ...entry }));
  }

  /** Forgets every join of this server (used when a lockdown ends). */
  function clear(guildId) {
    byGuild.delete(guildId);
  }

  /** Drops the entries that fell out of the longest possible window, and the empty servers. */
  function prune(now, maxWindowMs = MAX_WINDOW_MS) {
    for (const [guildId, list] of byGuild) {
      const kept = list.filter((entry) => isLive(entry, now, maxWindowMs));
      if (kept.length) byGuild.set(guildId, kept);
      else byGuild.delete(guildId);
    }
  }

  /** How many joins are stored, for every server together. */
  function size() {
    let total = 0;
    for (const list of byGuild.values()) total += list.length;
    return total;
  }

  return { record, recent, clear, prune, size };
}

/** The store of this process. */
export const joins = createJoinStore();

let sweep = null;

/** Starts the prune timer once (unref'd, so it never keeps the process alive). Returns the handle. */
export function startAntiraidSweep(store = joins) {
  if (!sweep) {
    sweep = setInterval(() => {
      try {
        store.prune(Date.now(), MAX_WINDOW_MS);
      } catch (err) {
        console.warn(`Anti-raid join sweep failed: ${err?.message ?? err}`);
      }
    }, SWEEP_MS);
    sweep.unref?.();
  }
  return sweep;
}

export function stopAntiraidSweep() {
  if (sweep) clearInterval(sweep);
  sweep = null;
}
