CREATE TABLE pending_roles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (guild_id, user_id, role_id)
);

CREATE INDEX pending_roles_due_at_idx ON pending_roles (due_at);

CREATE TABLE remembered_roles (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_ids JSONB NOT NULL,
  left_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
