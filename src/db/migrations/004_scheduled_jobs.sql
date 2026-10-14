CREATE TABLE scheduled_jobs (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  type TEXT NOT NULL,
  key TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  due_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_until TIMESTAMPTZ
);

CREATE UNIQUE INDEX scheduled_jobs_key_idx ON scheduled_jobs (guild_id, type, key);
CREATE INDEX scheduled_jobs_due_at_idx ON scheduled_jobs (due_at);
