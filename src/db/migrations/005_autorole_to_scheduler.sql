INSERT INTO scheduled_jobs (guild_id, type, key, payload, due_at)
SELECT guild_id, 'autorole.grant', user_id || ':' || role_id,
       jsonb_build_object('userId', user_id, 'roleId', role_id), due_at
FROM pending_roles
ON CONFLICT DO NOTHING;

DROP TABLE pending_roles;
