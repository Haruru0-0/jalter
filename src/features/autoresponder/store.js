export const MAX_RULES = 100;

export const ruleOf = (r) => ({
  id: r.id,
  guildId: r.guild_id,
  trigger: r.trigger,
  matchMode: r.match_mode,
  script: r.script,
  compiled: r.compiled,
  enabled: r.enabled,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

/** Returns the new rule, or 'full' when the guild already has MAX_RULES rules. */
export async function createRule(db, { guildId, trigger, matchMode, script, compiled, createdBy }) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Serialises creates per guild so two concurrent calls cannot both pass the cap.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`autoresponder:${guildId}`]);
    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS n FROM autoresponder_rules WHERE guild_id = $1', [guildId]);
    if (counted[0].n >= MAX_RULES) {
      await client.query('ROLLBACK');
      return 'full';
    }
    const { rows } = await client.query(
      `INSERT INTO autoresponder_rules (guild_id, trigger, match_mode, script, compiled, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING *`,
      [guildId, trigger, matchMode, script, JSON.stringify(compiled), createdBy]);
    await client.query('COMMIT');
    return ruleOf(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getRule(db, guildId, id) {
  const { rows } = await db.query('SELECT * FROM autoresponder_rules WHERE guild_id = $1 AND id = $2', [guildId, id]);
  return rows[0] ? ruleOf(rows[0]) : null;
}

export async function listRules(db, guildId) {
  const { rows } = await db.query('SELECT * FROM autoresponder_rules WHERE guild_id = $1 ORDER BY id', [guildId]);
  return rows.map(ruleOf);
}

const COLUMNS = { trigger: 'trigger', matchMode: 'match_mode', script: 'script', compiled: 'compiled', enabled: 'enabled' };

export async function updateRule(db, guildId, id, patch) {
  const keys = Object.keys(patch).filter((k) => k in COLUMNS);
  if (!keys.length) return false;
  const sets = keys.map((k, i) => `${COLUMNS[k]} = $${i + 3}${k === 'compiled' ? '::jsonb' : ''}`);
  const values = keys.map((k) => (k === 'compiled' ? JSON.stringify(patch[k]) : patch[k]));
  const { rowCount } = await db.query(
    `UPDATE autoresponder_rules SET ${sets.join(', ')} WHERE guild_id = $1 AND id = $2`, [guildId, id, ...values]);
  return rowCount > 0;
}

export async function deleteRule(db, guildId, id) {
  const { rowCount } = await db.query('DELETE FROM autoresponder_rules WHERE guild_id = $1 AND id = $2', [guildId, id]);
  return rowCount > 0;
}
