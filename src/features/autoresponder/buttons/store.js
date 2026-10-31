export const MAX_BUTTONS = 50;

const ms = (col) => `(extract(epoch FROM ${col}) * 1000)::float8`;

export const buttonOf = (r) => ({
  id: r.id,
  guildId: r.guild_id,
  name: r.name,
  label: r.label,
  emoji: r.emoji,
  style: r.style,
  script: r.script,
  compiled: r.compiled,
  invokerOnly: r.invoker_only,
  limitations: r.limitations,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** Returns the new button, 'exists' for a duplicate name, or 'full' at MAX_BUTTONS per guild. */
export async function createButton(db, b) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialises creates per guild so two concurrent calls cannot both pass the cap.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`autoresponder-buttons:${b.guildId}`]);
    const { rows: dup } = await client.query(
      'SELECT 1 FROM autoresponder_buttons WHERE guild_id = $1 AND name = $2', [b.guildId, b.name]);
    if (dup.length) {
      await client.query('ROLLBACK');
      return 'exists';
    }
    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS n FROM autoresponder_buttons WHERE guild_id = $1', [b.guildId]);
    if (counted[0].n >= MAX_BUTTONS) {
      await client.query('ROLLBACK');
      return 'full';
    }
    const { rows } = await client.query(
      `INSERT INTO autoresponder_buttons
         (guild_id, name, label, emoji, style, script, compiled, invoker_only, limitations, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) RETURNING *`,
      [b.guildId, b.name, b.label, b.emoji ?? null, b.style, b.script, JSON.stringify(b.compiled),
        b.invokerOnly ?? false, b.limitations ?? 'none', b.createdBy]);
    await client.query('COMMIT');
    return buttonOf(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getButton(db, guildId, name) {
  const { rows } = await db.query('SELECT * FROM autoresponder_buttons WHERE guild_id = $1 AND name = $2', [guildId, name]);
  return rows[0] ? buttonOf(rows[0]) : null;
}

export async function listButtons(db, guildId) {
  const { rows } = await db.query('SELECT * FROM autoresponder_buttons WHERE guild_id = $1 ORDER BY name', [guildId]);
  return rows.map(buttonOf);
}

const COLUMNS = {
  label: 'label', emoji: 'emoji', style: 'style', script: 'script', compiled: 'compiled',
  invokerOnly: 'invoker_only', limitations: 'limitations',
};

export async function updateButton(db, guildId, name, patch) {
  const keys = Object.keys(patch).filter((k) => Object.hasOwn(COLUMNS, k) && patch[k] !== undefined);
  if (!keys.length) return false;
  const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 3}${k === 'compiled' ? '::jsonb' : ''}`);
  const values = keys.map((k) => (k === 'compiled' ? JSON.stringify(patch[k]) : patch[k]));
  const { rowCount } = await db.query(
    `UPDATE autoresponder_buttons SET ${sets.join(', ')} WHERE guild_id = $1 AND name = $2`, [guildId, name, ...values]);
  return rowCount > 0;
}

export async function deleteButton(db, guildId, name) {
  const { rowCount } = await db.query('DELETE FROM autoresponder_buttons WHERE guild_id = $1 AND name = $2', [guildId, name]);
  return rowCount > 0;
}

const recordOf = (r) => ({
  messageId: r.message_id,
  channelId: r.channel_id,
  guildId: r.guild_id,
  ruleId: r.rule_id,
  invokerId: r.invoker_id,
  buttons: r.buttons,
  words: r.words,
  draws: r.draws,
  locked: r.locked,
  pressed: r.pressed,
  expiresAt: Math.round(r.expires_ms),
});

export async function createMessageRecord(db, rec) {
  await db.query(
    `INSERT INTO autoresponder_button_messages
       (message_id, channel_id, guild_id, rule_id, invoker_id, buttons, words, draws, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, to_timestamp($9 / 1000.0))`,
    [rec.messageId, rec.channelId, rec.guildId, rec.ruleId, rec.invokerId, JSON.stringify(rec.buttons ?? []),
      rec.words ?? '', JSON.stringify(rec.draws ?? {}), rec.expiresAt]);
}

/** The stored record, or null when it does not exist or has expired. */
export async function getMessageRecord(db, messageId, now = Date.now()) {
  const { rows } = await db.query(
    `SELECT *, ${ms('expires_at')} AS expires_ms FROM autoresponder_button_messages
     WHERE message_id = $1 AND expires_at > to_timestamp($2 / 1000.0)`,
    [messageId, now]);
  return rows[0] ? recordOf(rows[0]) : null;
}

/**
 * Atomically decides a press. `none` presses write nothing (but still respect a lock);
 * `limited` and `strict` are one conditional UPDATE each, so two simultaneous presses
 * cannot both win. Returns { ok: true } or { ok: false, reason: 'locked' | 'pressed' | 'gone' }.
 */
export async function claimPress(db, messageId, index, limitation, now = Date.now()) {
  const alive = 'message_id = $1 AND expires_at > to_timestamp($2 / 1000.0)';
  if (limitation === 'limited') {
    const { rows } = await db.query(
      `UPDATE autoresponder_button_messages SET pressed = pressed || to_jsonb($3::int)
       WHERE ${alive} AND NOT locked AND NOT (pressed @> to_jsonb($3::int))
       RETURNING message_id`,
      [messageId, now, index]);
    if (rows.length) return { ok: true };
  } else if (limitation === 'strict') {
    const { rows } = await db.query(
      `UPDATE autoresponder_button_messages SET locked = true
       WHERE ${alive} AND NOT locked RETURNING message_id`,
      [messageId, now]);
    if (rows.length) return { ok: true };
  }
  const { rows: cur } = await db.query(
    `SELECT locked, pressed FROM autoresponder_button_messages WHERE ${alive}`, [messageId, now]);
  if (!cur.length) return { ok: false, reason: 'gone' };
  if (cur[0].locked) return { ok: false, reason: 'locked' };
  if (limitation === 'limited') return { ok: false, reason: 'pressed' };
  // A strict claim that wrote nothing must never be allowed.
  if (limitation === 'strict') return { ok: false, reason: 'locked' };
  return { ok: true };
}

/** Per member, per button of a posted message. Same single-statement upsert as claimCooldown. */
export async function claimButtonCooldown(db, messageId, index, userId, seconds, now = Date.now()) {
  const untilMs = now + seconds * 1000;
  const { rows } = await db.query(
    `INSERT INTO autoresponder_button_cooldowns (message_id, button_index, user_id, until)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))
     ON CONFLICT (message_id, button_index, user_id) DO UPDATE SET until = EXCLUDED.until
       WHERE autoresponder_button_cooldowns.until <= to_timestamp($5 / 1000.0)
     RETURNING message_id`,
    [messageId, index, userId, untilMs, now]);
  if (rows.length > 0) return { ok: true };
  const { rows: current } = await db.query(
    `SELECT ${ms('until')} AS until_ms FROM autoresponder_button_cooldowns
     WHERE message_id = $1 AND button_index = $2 AND user_id = $3`,
    [messageId, index, userId]);
  const retryAfterMs = current.length ? Math.max(1, Math.round(current[0].until_ms - now)) : 1;
  return { ok: false, retryAfterMs };
}

/** Housekeeping: deletes expired records (their cooldown rows cascade). */
export async function pruneButtonMessages(ctx, { now = Date.now() } = {}) {
  const res = await ctx.db.query(
    'DELETE FROM autoresponder_button_messages WHERE expires_at <= to_timestamp($1 / 1000.0)', [now]);
  return res.rowCount;
}
