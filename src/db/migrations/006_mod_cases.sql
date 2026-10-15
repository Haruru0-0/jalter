CREATE TABLE mod_counters (
  guild_id TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL
);

CREATE TABLE mod_cases (
  guild_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  moderator_id TEXT NOT NULL,
  reason TEXT,
  duration_ms BIGINT,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active BOOLEAN NOT NULL DEFAULT true,
  log_channel_id TEXT,
  log_message_id TEXT,
  PRIMARY KEY (guild_id, number)
);

CREATE INDEX mod_cases_target_idx ON mod_cases (guild_id, target_id);
