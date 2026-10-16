CREATE TABLE automod_history (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rules TEXT[] NOT NULL,
  message_id TEXT,
  actions TEXT[] NOT NULL,
  case_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX automod_history_guild_idx ON automod_history (guild_id, created_at DESC);
