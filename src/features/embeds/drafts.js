const TTL_MS = 15 * 60 * 1000;
const drafts = new Map();

// Drafts belong to one user in one guild, so a draft cannot be sent from another server.
export const draftKey = (guildId, userId) => `${guildId}:${userId}`;

export function putDraft(key, spec, now = Date.now()) {
  for (const [k, draft] of drafts) {
    if (draft.expires < now) drafts.delete(k);
  }
  drafts.set(key, { spec, expires: now + TTL_MS });
}

export function getDraft(key, now = Date.now()) {
  const draft = drafts.get(key);
  if (!draft) return null;
  if (draft.expires < now) {
    drafts.delete(key);
    return null;
  }
  return draft.spec;
}

export function clearDraft(key) {
  drafts.delete(key);
}

export const draftCount = () => drafts.size;
