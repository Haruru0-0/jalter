export async function saveTemplate(db, guildId, name, spec) {
  await db.query(
    `INSERT INTO embed_templates (guild_id, name, json) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (guild_id, name) DO UPDATE SET json = $3::jsonb`,
    [guildId, name, JSON.stringify(spec)],
  );
}

export async function getTemplate(db, guildId, name) {
  const { rows } = await db.query(
    'SELECT json FROM embed_templates WHERE guild_id = $1 AND name = $2', [guildId, name]);
  return rows[0]?.json ?? null;
}

export async function listTemplates(db, guildId) {
  const { rows } = await db.query(
    'SELECT name FROM embed_templates WHERE guild_id = $1 ORDER BY name', [guildId]);
  return rows.map((r) => r.name);
}

export async function deleteTemplate(db, guildId, name) {
  const { rowCount } = await db.query(
    'DELETE FROM embed_templates WHERE guild_id = $1 AND name = $2', [guildId, name]);
  return rowCount > 0;
}
