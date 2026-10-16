import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function openDb(databaseUrl) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // An idle client losing its connection (for example a Postgres restart) emits
  // 'error' on the pool; without a listener that would crash the process.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  await pool.query('CREATE TABLE IF NOT EXISTS schema_version (name TEXT PRIMARY KEY)');
  const done = new Set(
    (await pool.query('SELECT name FROM schema_version')).rows.map((r) => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_version (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return pool;
}

export async function resetDb(pool) {
  await pool.query(
    'TRUNCATE guild_settings, embeds, media_items, remembered_roles, scheduled_jobs, mod_cases, mod_counters, automod_history RESTART IDENTITY',
  );
}
