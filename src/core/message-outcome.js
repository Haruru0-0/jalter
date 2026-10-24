// Lets a later message listener wait for auto-mod's verdict on the same message.
// Auto-mod calls beginOutcome first, markActed when it enforces, finishOutcome when done.

const MAX_ENTRIES = 2000;
const KEEP_MS = 30_000;

const pending = new Map();

function drop(id) {
  const entry = pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(id);
}

export function beginOutcome(messageId) {
  if (messageId === undefined || messageId === null) return;
  drop(messageId);
  const entry = { acted: false, done: false };
  entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
  entry.timer = setTimeout(() => {
    entry.resolve('clean');
    pending.delete(messageId);
  }, KEEP_MS);
  entry.timer.unref?.();
  pending.set(messageId, entry);
  while (pending.size > MAX_ENTRIES) {
    const oldest = pending.keys().next().value;
    pending.get(oldest).resolve('clean');
    drop(oldest);
  }
}

export function markActed(messageId) {
  const entry = pending.get(messageId);
  if (entry) entry.acted = true;
}

export function finishOutcome(messageId) {
  const entry = pending.get(messageId);
  if (!entry || entry.done) return;
  entry.done = true;
  entry.resolve(entry.acted ? 'acted' : 'clean');
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
