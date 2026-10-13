const NAME_RE = /^[a-z0-9_-]{1,16}$/;

export function normalizeEmbedName(input) {
  if (typeof input !== 'string') return null;
  const name = input.trim().toLowerCase();
  return NAME_RE.test(name) ? name : null;
}

export async function createEmbed(db, guildId, name) {
  const { rowCount } = await db.query(
    `INSERT INTO embeds (guild_id, name, json) VALUES ($1, $2, '{}'::jsonb)
     ON CONFLICT (guild_id, name) DO NOTHING`,
    [guildId, name],
  );
  return rowCount > 0;
}

export async function getEmbed(db, guildId, name) {
  const { rows } = await db.query(
    'SELECT json FROM embeds WHERE guild_id = $1 AND name = $2', [guildId, name]);
  return rows[0]?.json ?? null;
}

export async function saveEmbed(db, guildId, name, spec) {
  const { rowCount } = await db.query(
    'UPDATE embeds SET json = $3::jsonb WHERE guild_id = $1 AND name = $2',
    [guildId, name, JSON.stringify(spec)],
  );
  return rowCount > 0;
}

export async function listEmbeds(db, guildId) {
  const { rows } = await db.query(
    'SELECT name FROM embeds WHERE guild_id = $1 ORDER BY name', [guildId]);
  return rows.map((r) => r.name);
}

export async function deleteEmbed(db, guildId, name) {
  const { rowCount } = await db.query(
    'DELETE FROM embeds WHERE guild_id = $1 AND name = $2', [guildId, name]);
  return rowCount > 0;
}
