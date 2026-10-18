// Undo records: the original permission overwrites of a channel before the gate
// touched it. Each of everyone/verified/bot is { existed, allow, deny } or null
// (not touched). The first record per channel wins.

const toJson = (v) => (v == null ? null : JSON.stringify(v));

const fromRow = (r) => ({
  guildId: r.guild_id,
  channelId: r.channel_id,
  everyone: r.everyone,
  verified: r.verified,
  bot: r.bot,
  createdAt: r.created_at,
});

export async function recordOriginal(db, guildId, channelId, { everyone, verified, bot }) {
  const { rowCount } = await db.query(
    `INSERT INTO verification_overwrites (guild_id, channel_id, everyone, verified, bot)
     VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)
     ON CONFLICT (guild_id, channel_id) DO NOTHING`,
    [guildId, channelId, toJson(everyone), toJson(verified), toJson(bot)],
  );
  return rowCount === 1;
}

export async function getRecord(db, guildId, channelId) {
  const { rows } = await db.query(
    'SELECT * FROM verification_overwrites WHERE guild_id = $1 AND channel_id = $2',
    [guildId, channelId],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listRecords(db, guildId) {
  const { rows } = await db.query(
    'SELECT * FROM verification_overwrites WHERE guild_id = $1 ORDER BY created_at, channel_id',
    [guildId],
  );
  return rows.map(fromRow);
}

export async function deleteRecord(db, guildId, channelId) {
  await db.query(
    'DELETE FROM verification_overwrites WHERE guild_id = $1 AND channel_id = $2',
    [guildId, channelId],
  );
}

export async function countRecords(db, guildId) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM verification_overwrites WHERE guild_id = $1',
    [guildId],
  );
  return rows[0].n;
}
