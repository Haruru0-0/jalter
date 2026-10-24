// Lets a later message listener wait for auto-mod's verdict on the same message.
// Auto-mod calls beginOutcome first, markActed when it enforces, finishOutcome when done.
// markActed answers waiters at once ('acted' is final); finishOutcome answers 'clean' otherwise.

const DEFAULTS = {
  maxEntries: 2000,
  keepMs: 30_000, // an entry auto-mod never finished
  finishedKeepMs: 5_000, // the autoresponder reads a finished entry within milliseconds
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

let cfg = { ...DEFAULTS };

const pending = new Map();
const finished = new Set(); // finished ids, oldest first

function drop(id) {
  const entry = pending.get(id);
  if (!entry) return;
  cfg.clearTimeout(entry.timer);
  pending.delete(id);
  finished.delete(id);
}

function arm(id, entry, ms) {
  cfg.clearTimeout(entry.timer);
  entry.timer = cfg.setTimeout(() => {
    entry.resolve('clean');
    if (pending.get(id) === entry) drop(id);
  }, ms);
  entry.timer?.unref?.();
}

/** Test helper: overrides limits and timers ({ maxEntries, keepMs, finishedKeepMs, setTimeout, clearTimeout })
 *  and forgets every entry. Call with no argument to restore the defaults. */
export function configureOutcome(over = {}) {
  for (const id of [...pending.keys()]) drop(id);
  cfg = { ...DEFAULTS, ...over };
}

export function beginOutcome(messageId) {
  if (messageId === undefined || messageId === null) return;
  drop(messageId);
  const entry = { acted: false, done: false, timer: null };
  entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
  arm(messageId, entry, cfg.keepMs);
  pending.set(messageId, entry);
  while (pending.size > cfg.maxEntries) {
    // Finished entries go first; an entry auto-mod is still checking is evicted only as a last resort.
    const victim = finished.size ? finished.values().next().value : pending.keys().next().value;
    pending.get(victim).resolve('clean');
    drop(victim);
  }
}

export function markActed(messageId) {
  const entry = pending.get(messageId);
  if (!entry) return;
  entry.acted = true;
  // Acted is final: answer waiters now, not after the delete, action, log and history finish.
  entry.resolve('acted');
}

export function finishOutcome(messageId) {
  const entry = pending.get(messageId);
  if (!entry || entry.done) return;
  entry.done = true;
  entry.resolve(entry.acted ? 'acted' : 'clean');
  finished.add(messageId);
  arm(messageId, entry, cfg.finishedKeepMs);
}

export function awaitOutcome(messageId, timeoutMs = 3000) {
  const entry = pending.get(messageId);
  if (!entry) return Promise.resolve('clean');
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('clean'), timeoutMs);
    timer.unref?.();
    entry.promise.then((v) => { clearTimeout(timer); resolve(v); });
  });
}

/** Test helper: number of tracked entries. */
export function outcomeSize() {
  return pending.size;
}
