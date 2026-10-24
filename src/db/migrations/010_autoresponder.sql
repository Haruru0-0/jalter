CREATE TABLE autoresponder_rules (
  id SERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  match_mode TEXT NOT NULL,
  script TEXT NOT NULL,
  compiled JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX autoresponder_rules_guild ON autoresponder_rules (guild_id);

CREATE TABLE autoresponder_cooldowns (
  rule_id INTEGER NOT NULL REFERENCES autoresponder_rules (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (rule_id, user_id)
);
