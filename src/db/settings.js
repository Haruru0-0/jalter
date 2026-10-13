export async function getFeature(db, guildId, key) {
  const { rows } = await db.query(
    'SELECT enabled, config FROM guild_settings WHERE guild_id = $1 AND feature = $2',
    [guildId, key],
  );
  return rows[0]
    ? { enabled: rows[0].enabled, config: rows[0].config }
    : { enabled: false, config: {} };
}

export async function setFeature(db, guildId, key, patch) {
  await db.query(
    `INSERT INTO guild_settings (guild_id, feature, enabled, config)
     VALUES ($1, $2, COALESCE($3::boolean, false), $4::jsonb)
     ON CONFLICT (guild_id, feature) DO UPDATE SET
       enabled = COALESCE($3::boolean, guild_settings.enabled),
       config  = guild_settings.config || $4::jsonb`,
    [guildId, key, patch.enabled ?? null, JSON.stringify(patch.config ?? {})],
  );
}

export async function listFeatures(db, guildId) {
  const { rows } = await db.query(
    'SELECT feature, enabled, config FROM guild_settings WHERE guild_id = $1',
    [guildId],
  );
  return new Map(rows.map((r) => [r.feature, { enabled: r.enabled, config: r.config }]));
}
