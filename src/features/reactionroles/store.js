import { MAX_ENTRIES } from './config.js';

const entryOf = (r) => ({ id: r.id, roleId: r.role_id, emoji: r.emoji, label: r.label, position: r.position });
const messageOf = (r, entries) => ({
  guildId: r.guild_id,
  messageId: r.message_id,
  channelId: r.channel_id,
  embedName: r.embed_name,
  style: r.style,
  type: r.type,
  limit: r.limit,
  whitelist: r.whitelist,
  blacklist: r.blacklist,
  selfdestructAt: r.selfdestruct_at,
  entries,
});

async function withEntries(db, rows) {
  if (!rows.length) return [];
  const { rows: entryRows } = await db.query(
    'SELECT * FROM reaction_role_entries WHERE message_id = ANY($1) ORDER BY position', [rows.map((r) => r.message_id)]);
  return rows.map((r) => messageOf(r, entryRows.filter((e) => e.message_id === r.message_id).map(entryOf)));
}

export async function createMessage(db, { guildId, messageId, channelId, embedName = null, style, type = 'normal', createdBy }) {
  await db.query(
    `INSERT INTO reaction_role_messages (message_id, guild_id, channel_id, embed_name, style, type, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [messageId, guildId, channelId, embedName, style, type, createdBy],
  );
}

export async function getMessage(db, messageId) {
  const { rows } = await db.query('SELECT * FROM reaction_role_messages WHERE message_id = $1', [messageId]);
  return (await withEntries(db, rows))[0] ?? null;
}

export async function listMessages(db, guildId) {
  const { rows } = await db.query(
    'SELECT * FROM reaction_role_messages WHERE guild_id = $1 ORDER BY created_at DESC', [guildId]);
  return withEntries(db, rows);
}

const COLUMNS = { type: 'type', limit: '"limit"', whitelist: 'whitelist', blacklist: 'blacklist', selfdestructAt: 'selfdestruct_at' };

export async function updateMessage(db, messageId, patch) {
  const keys = Object.keys(patch).filter((k) => k in COLUMNS);
  if (!keys.length) return false;
  const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 2}`);
  const values = keys.map((k) => (Array.isArray(patch[k]) ? JSON.stringify(patch[k]) : patch[k]));
  const { rowCount } = await db.query(
    `UPDATE reaction_role_messages SET ${sets.join(', ')} WHERE message_id = $1`, [messageId, ...values]);
  return rowCount > 0;
}

export async function addEntry(db, messageId, { roleId, emoji = null, label = null }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT 1 FROM reaction_role_messages WHERE message_id = $1 FOR UPDATE', [messageId]);
    if (!locked.rowCount) {
      await client.query('ROLLBACK');
      return 'missing';
    }
    const { rows } = await client.query(
      'SELECT role_id, emoji, position FROM reaction_role_entries WHERE message_id = $1', [messageId]);
    if (rows.length >= MAX_ENTRIES) {
      await client.query('ROLLBACK');
      return 'full';
    }
    if (rows.some((r) => r.role_id === roleId || (emoji && r.emoji === emoji))) {
      await client.query('ROLLBACK');
      return 'duplicate';
    }
    const position = rows.reduce((max, r) => Math.max(max, r.position + 1), 0);
    const inserted = await client.query(
      `INSERT INTO reaction_role_entries (message_id, role_id, emoji, label, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [messageId, roleId, emoji, label, position]);
    await client.query('COMMIT');
    return entryOf(inserted.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function removeEntry(db, messageId, roleId) {
  const { rowCount } = await db.query(
    'DELETE FROM reaction_role_entries WHERE message_id = $1 AND role_id = $2', [messageId, roleId]);
  return rowCount > 0;
}

/** Removes every role of a message and keeps the message itself. Returns how many were removed. */
export async function clearEntries(db, messageId) {
  const { rowCount } = await db.query('DELETE FROM reaction_role_entries WHERE message_id = $1', [messageId]);
  return rowCount;
}

export async function deleteMessage(db, messageId) {
  const { rowCount } = await db.query('DELETE FROM reaction_role_messages WHERE message_id = $1', [messageId]);
  return rowCount > 0;
}

async function deleteReturning(db, sql, params) {
  const { rows } = await db.query(sql, params);
  return [...new Set(rows.map((r) => r.message_id))];
}

export const deleteMessagesInChannel = (db, guildId, channelId) => deleteReturning(db,
  'DELETE FROM reaction_role_messages WHERE guild_id = $1 AND channel_id = $2 RETURNING message_id', [guildId, channelId]);

export const deleteGuildMessages = (db, guildId) => deleteReturning(db,
  'DELETE FROM reaction_role_messages WHERE guild_id = $1 RETURNING message_id', [guildId]);

export const deleteEntriesForRole = (db, guildId, roleId) => deleteReturning(db,
  `DELETE FROM reaction_role_entries e USING reaction_role_messages m
   WHERE e.message_id = m.message_id AND m.guild_id = $1 AND e.role_id = $2
   RETURNING e.message_id`, [guildId, roleId]);

/** Strips a role from the whitelist and blacklist of every message of the guild (the role was deleted). */
export async function removeRoleFromLists(db, guildId, roleId) {
  await db.query(
    `UPDATE reaction_role_messages SET whitelist = whitelist - $2::text, blacklist = blacklist - $2::text
     WHERE guild_id = $1 AND (whitelist ? $2::text OR blacklist ? $2::text)`, [guildId, roleId]);
}

export async function getBinding(db, messageId, userId) {
  const { rows } = await db.query(
    'SELECT role_id FROM reaction_role_bindings WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
  return rows[0]?.role_id ?? null;
}

export async function setBinding(db, { guildId, messageId, userId, roleId }) {
  await db.query(
    `INSERT INTO reaction_role_bindings (guild_id, message_id, user_id, role_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id, user_id) DO NOTHING`, [guildId, messageId, userId, roleId]);
}

export async function clearMemberBindings(db, guildId, userId) {
  await db.query('DELETE FROM reaction_role_bindings WHERE guild_id = $1 AND user_id = $2', [guildId, userId]);
}
