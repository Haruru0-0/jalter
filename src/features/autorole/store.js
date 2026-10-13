export async function queueRole(db, guildId, userId, roleId, dueAtMs) {
  await db.query(
    `INSERT INTO pending_roles (guild_id, user_id, role_id, due_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (guild_id, user_id, role_id) DO UPDATE SET due_at = EXCLUDED.due_at`,
    [guildId, userId, roleId, new Date(dueAtMs)],
  );
}

export async function takeDue(db, nowMs, limit = 100) {
  const { rows } = await db.query(
    `DELETE FROM pending_roles WHERE ctid IN (
       SELECT ctid FROM pending_roles WHERE due_at <= $1
       ORDER BY due_at LIMIT $2 FOR UPDATE SKIP LOCKED)
     RETURNING guild_id, user_id, role_id, due_at`,
    [new Date(nowMs), limit],
  );
  return rows
    .sort((a, b) => a.due_at - b.due_at)
    .map((r) => ({ guildId: r.guild_id, userId: r.user_id, roleId: r.role_id }));
}

export async function cancelRole(db, guildId, roleId) {
  const { rowCount } = await db.query(
    'DELETE FROM pending_roles WHERE guild_id = $1 AND role_id = $2', [guildId, roleId]);
  return rowCount;
}

export async function rememberRoles(db, guildId, userId, roleIds, nowMs) {
  await db.query(
    `INSERT INTO remembered_roles (guild_id, user_id, role_ids, left_at) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (guild_id, user_id) DO UPDATE SET role_ids = EXCLUDED.role_ids, left_at = EXCLUDED.left_at`,
    [guildId, userId, JSON.stringify(roleIds), new Date(nowMs)],
  );
}

export async function takeRemembered(db, guildId, userId, nowMs, maxAgeMs) {
  const { rows } = await db.query(
    `DELETE FROM remembered_roles WHERE guild_id = $1 AND user_id = $2
     RETURNING role_ids, left_at`,
    [guildId, userId],
  );
  if (!rows[0]) return [];
  if (nowMs - rows[0].left_at.getTime() > maxAgeMs) return [];
  return rows[0].role_ids;
}

export async function purgeOld(db, nowMs, maxAgeMs) {
  const { rowCount } = await db.query(
    'DELETE FROM remembered_roles WHERE left_at < $1', [new Date(nowMs - maxAgeMs)]);
  return rowCount;
}
