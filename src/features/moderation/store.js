const COLUMNS = `guild_id, number, type, target_id, moderator_id, reason, duration_ms,
  active, log_channel_id, log_message_id,
  (EXTRACT(EPOCH FROM ends_at) * 1000)::float8 AS ends_ms,
  (EXTRACT(EPOCH FROM created_at) * 1000)::float8 AS created_ms`;

function toCase(row) {
  return {
    guildId: row.guild_id,
    number: row.number,
    type: row.type,
    targetId: row.target_id,
    moderatorId: row.moderator_id,
    reason: row.reason,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    endsAt: row.ends_ms === null ? null : Math.round(row.ends_ms),
    createdAt: Math.round(row.created_ms),
    active: row.active,
    logChannelId: row.log_channel_id,
    logMessageId: row.log_message_id,
  };
}

// One statement, so the counter bump and the insert commit together and the
// counter row lock serialises concurrent callers.
export async function createCase(db, {
  guildId, type, targetId, moderatorId, reason, durationMs = null, endsAt = null,
}) {
  const { rows } = await db.query(
    `WITH n AS (
       INSERT INTO mod_counters (guild_id, last_number) VALUES ($1, 1)
       ON CONFLICT (guild_id) DO UPDATE SET last_number = mod_counters.last_number + 1
       RETURNING last_number
     )
     INSERT INTO mod_cases (guild_id, number, type, target_id, moderator_id, reason, duration_ms, ends_at)
     SELECT $1, n.last_number, $2, $3, $4, $5, $6,
            CASE WHEN $7::float8 IS NULL THEN NULL ELSE to_timestamp($7::float8 / 1000.0) END
     FROM n
     RETURNING ${COLUMNS}`,
    [guildId, type, targetId, moderatorId, reason, durationMs, endsAt],
  );
  return toCase(rows[0]);
}

export async function getCase(db, guildId, number) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM mod_cases WHERE guild_id = $1 AND number = $2`, [guildId, number]);
  return rows[0] ? toCase(rows[0]) : null;
}

export async function setCaseLog(db, guildId, number, { channelId, messageId }) {
  await db.query(
    'UPDATE mod_cases SET log_channel_id = $3, log_message_id = $4 WHERE guild_id = $1 AND number = $2',
    [guildId, number, channelId, messageId],
  );
}

export async function setCaseReason(db, guildId, number, reason) {
  const res = await db.query(
    'UPDATE mod_cases SET reason = $3 WHERE guild_id = $1 AND number = $2', [guildId, number, reason]);
  return res.rowCount > 0;
}

export async function listWarnings(db, guildId, userId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM mod_cases
     WHERE guild_id = $1 AND target_id = $2 AND type = 'warn' AND active
     ORDER BY number`,
    [guildId, userId],
  );
  return rows.map(toCase);
}

export async function editWarning(db, guildId, number, reason) {
  const res = await db.query(
    `UPDATE mod_cases SET reason = $3
     WHERE guild_id = $1 AND number = $2 AND type = 'warn' AND active`,
    [guildId, number, reason],
  );
  return res.rowCount > 0;
}

export async function deactivateWarning(db, guildId, number) {
  const res = await db.query(
    `UPDATE mod_cases SET active = false
     WHERE guild_id = $1 AND number = $2 AND type = 'warn' AND active`,
    [guildId, number],
  );
  return res.rowCount > 0;
}

export async function clearWarnings(db, guildId, userId) {
  const res = await db.query(
    `UPDATE mod_cases SET active = false
     WHERE guild_id = $1 AND target_id = $2 AND type = 'warn' AND active`,
    [guildId, userId],
  );
  return res.rowCount;
}

export async function topWarnings(db, guildId, limit = 10) {
  const { rows } = await db.query(
    `SELECT target_id, count(*)::int AS count FROM mod_cases
     WHERE guild_id = $1 AND type = 'warn' AND active
     GROUP BY target_id
     ORDER BY count DESC, target_id
     LIMIT $2`,
    [guildId, limit],
  );
  return rows.map((r) => ({ userId: r.target_id, count: r.count }));
}

export async function isCurrentlyMuted(db, guildId, userId, nowMs) {
  const { rows } = await db.query(
    `SELECT type, (EXTRACT(EPOCH FROM ends_at) * 1000)::float8 AS ends_ms FROM mod_cases
     WHERE guild_id = $1 AND target_id = $2 AND type IN ('mute', 'unmute')
     ORDER BY number DESC LIMIT 1`,
    [guildId, userId],
  );
  const last = rows[0];
  if (!last || last.type !== 'mute') return false;
  return last.ends_ms === null || last.ends_ms > nowMs;
}
