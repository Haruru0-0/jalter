// In-memory store of open builder panels. One panel per member per server, sliding expiry,
// a size cap, and a save lock so a double click cannot save twice.
import { randomInt } from 'node:crypto';

const ID_LENGTH = 8;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function createDraftStore({ now = Date.now, ttlMs = 900000, max = 500 } = {}) {
  const entries = new Map(); // panelId -> Entry, in opening order

  const newId = () => {
    for (;;) {
      let id = '';
      for (let i = 0; i < ID_LENGTH; i++) id += ALPHABET[randomInt(ALPHABET.length)];
      if (!entries.has(id)) return id;
    }
  };

  // Returns the live entry (sliding its expiry when asked) or null after removing an expired one.
  function live(panelId, slide) {
    const e = entries.get(panelId);
    if (!e) return null;
    if (e.expiresAt <= now()) { entries.delete(panelId); return null; }
    if (slide) e.expiresAt = now() + ttlMs;
    return e;
  }

  return {
    open(guildId, userId, draft) {
      for (const [id, e] of entries) if (e.guildId === guildId && e.userId === userId) entries.delete(id);
      while (entries.size >= max) entries.delete(entries.keys().next().value);
      const panelId = newId();
      entries.set(panelId, {
        panelId, guildId, userId, draft, page: 'main', pending: null, saving: false, expiresAt: now() + ttlMs,
      });
      return panelId;
    },
    get: (panelId) => live(panelId, true),
    update(panelId, patch) {
      const e = live(panelId, true);
      return e ? Object.assign(e, patch) : null;
    },
    beginSave(panelId) {
      const e = live(panelId, false);
      if (!e || e.saving) return null;
      e.saving = true;
      return e;
    },
    endSave(panelId, done) {
      if (done) { entries.delete(panelId); return; }
      const e = entries.get(panelId);
      if (e) e.saving = false;
    },
    drop(panelId) { entries.delete(panelId); },
    size: () => entries.size,
  };
}

export const drafts = createDraftStore();
