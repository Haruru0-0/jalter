const CHANNEL_ID_FEATURES = ['greet', 'leave', 'boost', 'media'];

export async function mediaHoldsChannel(db, guildId, channelId) {
  const { rows } = await db.query(
    'SELECT 1 FROM media_items WHERE guild_id = $1 AND channel_id = $2 LIMIT 1',
    [guildId, channelId],
  );
  return rows.length > 0;
}

// Returns a new config with oldId replaced by newId, or null when nothing matched.
function repoint(feature, config, oldId, newId) {
  if (!config || typeof config !== 'object') return null;
  let changed = false;
  const next = { ...config };
  if (feature === 'logging') {
    if (config.channels && typeof config.channels === 'object') {
      const channels = {};
      for (const [k, v] of Object.entries(config.channels)) {
        if (v === oldId) { channels[k] = newId; changed = true; } else channels[k] = v;
      }
      next.channels = channels;
    }
    if (Array.isArray(config.ignore?.channels)) {
      const list = config.ignore.channels.map((id) => (id === oldId ? newId : id));
      if (list.some((id, i) => id !== config.ignore.channels[i])) {
        next.ignore = { ...config.ignore, channels: list };
        changed = true;
      }
    }
  } else if (CHANNEL_ID_FEATURES.includes(feature) && config.channelId === oldId) {
    next.channelId = newId;
    changed = true;
  }
  return changed ? next : null;
}

export async function moveChannelId(db, guildId, oldId, newId) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT feature, config FROM guild_settings
       WHERE guild_id = $1 AND feature = ANY($2::text[]) FOR UPDATE`,
      [guildId, ['logging', ...CHANNEL_ID_FEATURES]],
    );
    let moved = 0;
    for (const row of rows) {
      const next = repoint(row.feature, row.config, oldId, newId);
      if (!next) continue;
      await client.query(
        'UPDATE guild_settings SET config = $1::jsonb WHERE guild_id = $2 AND feature = $3',
        [JSON.stringify(next), guildId, row.feature],
      );
      moved += 1;
    }
    await client.query('COMMIT');
    return { moved };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
