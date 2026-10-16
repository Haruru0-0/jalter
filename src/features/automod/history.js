const KEEP = 200;

export async function addHistory(db, { guildId, userId, rules, messageId, actions, caseNumber }) {
  await db.query(
    `INSERT INTO automod_history (guild_id, user_id, rules, message_id, actions, case_number)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [guildId, userId, rules, messageId ?? null, actions, caseNumber ?? null],
  );
  await db.query(
    `DELETE FROM automod_history WHERE id IN (
       SELECT id FROM automod_history WHERE guild_id = $1 ORDER BY id DESC OFFSET $2
     )`,
    [guildId, KEEP],
  );
}

export async function listHistory(db, guildId, { userId = null, limit = 10 } = {}) {
  const { rows } = await db.query(
    `SELECT id, user_id, rules, message_id, actions, case_number, created_at
     FROM automod_history
     WHERE guild_id = $1 AND ($2::text IS NULL OR user_id = $2)
     ORDER BY id DESC
     LIMIT $3`,
    [guildId, userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    rules: r.rules,
    messageId: r.message_id,
    actions: r.actions,
    caseNumber: r.case_number,
    createdAt: r.created_at,
  }));
}
