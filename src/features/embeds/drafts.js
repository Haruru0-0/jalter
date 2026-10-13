const TTL_MS = 15 * 60 * 1000;
const drafts = new Map();

export function putDraft(userId, spec, now = Date.now()) {
  drafts.set(userId, { spec, expires: now + TTL_MS });
}

export function getDraft(userId, now = Date.now()) {
  const draft = drafts.get(userId);
  if (!draft) return null;
  if (draft.expires < now) {
    drafts.delete(userId);
    return null;
  }
  return draft.spec;
}

export function clearDraft(userId) {
  drafts.delete(userId);
}
