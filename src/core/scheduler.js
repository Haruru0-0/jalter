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

// Both match on the claimed attempts too: a reschedule of the same key resets attempts to 0 while
// a claimed job always has at least 1, so a stale finish leaves the rescheduled row alone.
export async function completeJob(db, job) {
  await db.query('DELETE FROM scheduled_jobs WHERE id = $1 AND attempts = $2', [job.id, job.attempts]);
}

export async function failJob(db, job, nowMs) {
  if (job.attempts >= MAX_ATTEMPTS) {
    await completeJob(db, job);
    return 'dropped';
  }
  const delay = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)];
  await db.query(
    `UPDATE scheduled_jobs
     SET due_at = to_timestamp(($2::float8 + $3::float8) / 1000.0), claimed_until = NULL
     WHERE id = $1 AND attempts = $4`,
    [job.id, nowMs, delay, job.attempts],
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

const warnedTypes = new Set();

async function runHousekeeping(ctx, housekeeping, now) {
  for (const fn of housekeeping ?? []) {
    try {
      await fn(ctx, { now });
    } catch (err) {
      console.warn(`Housekeeping failed: ${err.message}`);
    }
  }
}

async function runJob(ctx, handler, job, now) {
  try {
    await handler(ctx, job);
  } catch (err) {
    const info = `type ${job.type}, guild ${job.guildId}, attempt ${job.attempts}`;
    const result = await failJob(ctx.db, job, now);
    if (result === 'dropped') {
      console.warn(`Scheduled job dropped after ${job.attempts} attempts (${info}): ${err.message}`);
    } else {
      console.warn(`Scheduled job failed, will retry (${info}): ${err.message}`);
    }
    return;
  }
  await completeJob(ctx.db, job);
}

export async function runDueJobs(ctx, { jobs, housekeeping }, { now = Date.now() } = {}) {
  try {
    if (ctx.client?.isReady?.() === false) return;
    await runHousekeeping(ctx, housekeeping, now);
    const types = [...jobs.keys()];
    for (const type of await countDueOtherTypes(ctx.db, now, types)) {
      if (warnedTypes.has(type)) continue;
      warnedTypes.add(type);
      console.warn(`Scheduled jobs of type "${type}" are due but no handler is registered`);
    }
    const due = await claimDue(ctx.db, now, { types });
    for (const job of due) {
      try {
        await runJob(ctx, jobs.get(job.type), job, now);
      } catch (err) {
        console.warn(`Scheduled job bookkeeping failed (type ${job.type}, id ${job.id}): ${err.message}`);
      }
    }
  } catch (err) {
    console.warn(`Scheduler run failed: ${err.message}`);
  }
}

export function startScheduler(ctx, registry, { intervalMs = 30000 } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDueJobs(ctx, registry);
    } catch (err) {
      console.warn(`Scheduler tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
