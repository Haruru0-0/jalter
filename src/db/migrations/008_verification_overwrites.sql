CREATE TABLE verification_overwrites (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  everyone JSONB,
  verified JSONB,
  bot JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, channel_id)
);
