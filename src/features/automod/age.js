// Account-age conditions: a rule can be limited to new accounts and/or recent joiners.

/**
 * True when the member satisfies every age limit set on the rule (none set means true).
 * A missing timestamp (partial member) fails a set limit, so the rule is skipped rather than guessed at.
 */
export function passesAge(member, ruleCfg, now) {
  const { accountYoungerThanSeconds: account, joinedWithinSeconds: joined } = ruleCfg?.age ?? {};
  if (account != null) {
    const created = member?.user?.createdTimestamp;
    if (!Number.isFinite(created) || now - created >= account * 1000) return false;
  }
  if (joined != null) {
    const at = member?.joinedTimestamp;
    if (!Number.isFinite(at) || now - at >= joined * 1000) return false;
  }
  return true;
}
