// Per-member cooldowns. The claim is one atomic upsert: it only succeeds when
// there is no row yet or the existing one has expired, so concurrent claims
// for the same rule and member cannot both win. Time comes from the caller.

export async function claimCooldown(db, ruleId, userId, seconds, now = Date.now()) {
  const untilMs = now + seconds * 1000;
  const { rows } = await db.query(
    `INSERT INTO autoresponder_cooldowns (rule_id, user_id, until)
     VALUES ($1, $2, to_timestamp($3 / 1000.0))
     ON CONFLICT (rule_id, user_id) DO UPDATE SET until = EXCLUDED.until
       WHERE autoresponder_cooldowns.until <= to_timestamp($4 / 1000.0)
     RETURNING rule_id`,
    [ruleId, userId, untilMs, now],
  );
  if (rows.length > 0) return { ok: true };
  const { rows: current } = await db.query(
    'SELECT (extract(epoch FROM until) * 1000)::float8 AS until_ms FROM autoresponder_cooldowns WHERE rule_id = $1 AND user_id = $2',
    [ruleId, userId],
  );
  const retryAfterMs = current.length ? Math.max(1, Math.round(current[0].until_ms - now)) : 1;
  return { ok: false, retryAfterMs };
}

export async function pruneCooldowns(ctx, { now = Date.now() } = {}) {
  const res = await ctx.db.query('DELETE FROM autoresponder_cooldowns WHERE until <= to_timestamp($1 / 1000.0)', [now]);
  return res.rowCount;
}

export async function clearRuleCooldowns(db, ruleId) {
  await db.query('DELETE FROM autoresponder_cooldowns WHERE rule_id = $1', [ruleId]);
}
