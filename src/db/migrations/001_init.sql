CREATE TABLE guild_settings (
  guild_id TEXT NOT NULL,
  feature  TEXT NOT NULL,
  enabled  BOOLEAN NOT NULL DEFAULT false,
  config   JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (guild_id, feature)
);

CREATE TABLE embed_templates (
  id       SERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  name     TEXT NOT NULL,
  json     JSONB NOT NULL,
  UNIQUE (guild_id, name)
);

CREATE TABLE media_items (
  id               SERIAL PRIMARY KEY,
  guild_id         TEXT NOT NULL,
  name             TEXT NOT NULL,
  channel_id       TEXT NOT NULL,
  message_id       TEXT NOT NULL,
  attachment_index INTEGER NOT NULL DEFAULT 0,
  UNIQUE (guild_id, name)
);
