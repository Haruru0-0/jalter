import { scheduleJob, cancelJobs } from '../../core/scheduler.js';

export const GRANT_JOB = 'autorole.grant';

export async function queueRole(db, guildId, userId, roleId, dueAtMs) {
  await scheduleJob(db, {
    guildId, type: GRANT_JOB, key: `${userId}:${roleId}`, payload: { userId, roleId }, dueAt: dueAtMs,
  });
}

export function cancelRole(db, guildId, roleId) {
  return cancelJobs(db, { guildId, type: GRANT_JOB, payload: { roleId } });
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

export async function forgetRoles(db, guildId, userId) {
  await db.query('DELETE FROM remembered_roles WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
}

export async function purgeOld(db, nowMs, maxAgeMs) {
  const { rowCount } = await db.query(
    'DELETE FROM remembered_roles WHERE left_at < $1', [new Date(nowMs - maxAgeMs)]);
  return rowCount;
}
