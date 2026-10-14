// Audit-log lookup for moderator attribution. Never throws: a missing
// View Audit Log permission or API error just means no attribution.
// `filter(entry)` optionally narrows which entries count.
const MAX_AGE_MS = 10_000;

export async function findExecutor(guild, auditType, targetId, now = Date.now(), filter = null) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 });
    let best = null;
    for (const entry of logs.entries.values()) {
      if (entry.target?.id !== targetId) continue;
      if (now - entry.createdTimestamp >= MAX_AGE_MS) continue;
      if (!entry.executor?.id) continue;
      if (filter && !filter(entry)) continue;
      if (!best || entry.createdTimestamp > best.createdTimestamp) best = entry;
    }
    return best ? best.executor.id : null;
  } catch {
    return null;
  }
}
