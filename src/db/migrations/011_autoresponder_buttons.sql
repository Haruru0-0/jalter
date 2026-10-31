CREATE TABLE autoresponder_buttons (
  id SERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  emoji TEXT,
  style TEXT NOT NULL,
  script TEXT NOT NULL,
  compiled JSONB NOT NULL,
  invoker_only BOOLEAN NOT NULL DEFAULT false,
  limitations TEXT NOT NULL DEFAULT 'none',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (guild_id, name)
);

CREATE TABLE autoresponder_button_messages (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  rule_id INTEGER NOT NULL REFERENCES autoresponder_rules (id) ON DELETE CASCADE,
  invoker_id TEXT NOT NULL,
  buttons JSONB NOT NULL,
  words TEXT NOT NULL DEFAULT '',
  draws JSONB NOT NULL DEFAULT '{}',
  locked BOOLEAN NOT NULL DEFAULT false,
  pressed JSONB NOT NULL DEFAULT '[]',
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX autoresponder_button_messages_expires ON autoresponder_button_messages (expires_at);

CREATE TABLE autoresponder_button_cooldowns (
  message_id TEXT NOT NULL REFERENCES autoresponder_button_messages (message_id) ON DELETE CASCADE,
  button_index INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (message_id, button_index, user_id)
);
