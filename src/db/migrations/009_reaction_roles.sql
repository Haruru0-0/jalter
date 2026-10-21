CREATE TABLE reaction_role_messages (
  message_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  embed_name TEXT,
  style TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal',
  "limit" INTEGER,
  whitelist JSONB NOT NULL DEFAULT '[]',
  blacklist JSONB NOT NULL DEFAULT '[]',
  selfdestruct_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reaction_role_messages_guild ON reaction_role_messages (guild_id);

CREATE TABLE reaction_role_entries (
  id SERIAL PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES reaction_role_messages (message_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  emoji TEXT,
  label TEXT,
  position INTEGER NOT NULL,
  UNIQUE (message_id, role_id)
);
CREATE UNIQUE INDEX reaction_role_entries_emoji ON reaction_role_entries (message_id, emoji) WHERE emoji IS NOT NULL;

CREATE TABLE reaction_role_bindings (
  guild_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES reaction_role_messages (message_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
