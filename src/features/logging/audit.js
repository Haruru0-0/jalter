// Audit-log lookup for moderator attribution. Never throws: a missing
// View Audit Log permission or API error just means no attribution.
const MAX_AGE_MS = 10_000;

export async function findExecutor(guild, auditType, targetId, now = Date.now()) {
  try {
    const logs = await guild.fetchAuditLogs({ type: auditType, limit: 5 });
    let best = null;
    for (const entry of logs.entries.values()) {
      if (entry.target?.id !== targetId) continue;
      if (now - entry.createdTimestamp >= MAX_AGE_MS) continue;
      if (!entry.executor?.id) continue;
      if (!best || entry.createdTimestamp > best.createdTimestamp) best = entry;
    }
    return best ? best.executor.id : null;
  } catch {
    return null;
  }
}
