export const CLAIM_MS = 5 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_MS = [60000, 300000, 900000, 3600000];

const JOB_COLUMNS = `id, guild_id, type, key, payload, attempts,
  (EXTRACT(EPOCH FROM due_at) * 1000)::float8 AS due_ms`;

function toJob(row) {
  return {
    id: row.id,
    guildId: row.guild_id,
    type: row.type,
    key: row.key,
    payload: row.payload,
    attempts: row.attempts,
    dueAt: Math.round(row.due_ms),
  };
}

export async function scheduleJob(db, { guildId, type, key = null, payload = {}, dueAt }) {
  await db.query(
    `INSERT INTO scheduled_jobs (guild_id, type, key, payload, due_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5::float8 / 1000.0))
     ON CONFLICT (guild_id, type, key) DO UPDATE
       SET payload = EXCLUDED.payload, due_at = EXCLUDED.due_at,
           attempts = 0, claimed_until = NULL`,
    [guildId, type, key, JSON.stringify(payload), dueAt],
  );
}

export async function cancelJobs(db, { guildId, type, key = null, payload = null }) {
  const res = await db.query(
    `DELETE FROM scheduled_jobs
     WHERE guild_id = $1 AND type = $2
       AND ($3::text IS NULL OR key = $3)
       AND ($4::jsonb IS NULL OR payload @> $4::jsonb)`,
    [guildId, type, key, payload === null ? null : JSON.stringify(payload)],
  );
  return res.rowCount;
}

export async function claimDue(db, nowMs, { types, limit = 100 }) {
  if (!types || types.length === 0) return [];
  const res = await db.query(
    `UPDATE scheduled_jobs
     SET claimed_until = to_timestamp(($1::float8 + $4::float8) / 1000.0), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM scheduled_jobs
       WHERE type = ANY($2::text[])
         AND due_at <= to_timestamp($1::float8 / 1000.0)
         AND (claimed_until IS NULL OR claimed_until <= to_timestamp($1::float8 / 1000.0))
       ORDER BY due_at, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING ${JOB_COLUMNS}`,
    [nowMs, types, limit, CLAIM_MS],
  );
  return res.rows.map(toJob).sort((a, b) => a.dueAt - b.dueAt || Number(a.id) - Number(b.id));
}

export async function completeJob(db, id) {
  await db.query('DELETE FROM scheduled_jobs WHERE id = $1', [id]);
}

export async function failJob(db, job, nowMs) {
  if (job.attempts >= MAX_ATTEMPTS) {
    await completeJob(db, job.id);
    return 'dropped';
  }
  const delay = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
  await db.query(
    `UPDATE scheduled_jobs
     SET due_at = to_timestamp(($2::float8 + $3::float8) / 1000.0), claimed_until = NULL
     WHERE id = $1`,
    [job.id, nowMs, delay],
  );
  return 'retry';
}

export async function countDueOtherTypes(db, nowMs, types) {
  const res = await db.query(
    `SELECT DISTINCT type FROM scheduled_jobs
     WHERE NOT (type = ANY($2::text[]))
       AND due_at <= to_timestamp($1::float8 / 1000.0)
       AND (claimed_until IS NULL OR claimed_until <= to_timestamp($1::float8 / 1000.0))
     ORDER BY type`,
    [nowMs, types],
  );
  return res.rows.map((r) => r.type);
}
