// Unverified-member policy: the warn and kick scheduler jobs.
//
// Fire-time checks: both jobs re-read everything when they run (feature on, state running, the
// saved policy not `none`, member still here with the queued joinedAt, not a bot, without the Verified role, not spared).
// They act on the policy the job was QUEUED with (payload.policy), never on the saved one.
//
// Warn is at-most-once: after the checks (which may throw and retry) the job claims itself by
// deleting its own row; zero rows deleted means an earlier run (or a rejoin) owns it, so nothing
// happens. Only then is runAction called, and anything it throws counts as a failed warn. Either
// way the member's kick job of the same schedule gets `warned: 'ok' | 'failed'` and a due time at
// least MIN_GAP_SECONDS away (see rescheduleKick for when the write is skipped).
//
// Under warn_kick the kick job kicks only when `warned === 'ok'`. Without Kick Members it logs one
// line and never calls runAction (no false kick DM). A refused kick logs one line and
// is not retried; a thrown error is rethrown so the scheduler retries (a kick is idempotent: a
// retry finds the member gone).
import { PermissionFlagsBits } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { scheduleJob, cancelJobs, MAX_ATTEMPTS } from '../../core/scheduler.js';
import { canManage } from '../../core/permissions.js';
import { formatDuration } from '../../core/duration.js';
import { runAction } from '../moderation/actions.js';
import { readConfig as readModConfig } from '../moderation/config.js';
import { readConfig, RUNNING, QUEUED_POLICIES } from './config.js';
import { logVerification } from './log.js';
import { WARN_JOB, KICK_JOB, MIN_GAP_SECONDS } from './unverified.js';

const UNKNOWN_MEMBER = 10007;
const QUEUED = new Set(QUEUED_POLICIES);
const GRACE_MS = MIN_GAP_SECONDS * 1000;

const using = (deps) => ({
  run: deps.runAction ?? runAction,
  log: deps.logVerification ?? logVerification,
  now: deps.now ?? Date.now,
});

export async function fetchMember(guild, userId) {
  try {
    return (await guild.members.fetch(userId)) ?? null;
  } catch (err) {
    if (err?.code === UNKNOWN_MEMBER) return null;
    throw err;
  }
}

// Bots, the owner, members at or above the bot's highest role, and managers are left alone.
export async function isSpared(ctx, guild, member) {
  if (member.user?.bot) return true;
  if (member.id === guild.ownerId) return true;
  const botTop = guild.members.me?.roles?.highest?.position;
  const top = member.roles?.highest?.position ?? 0;
  if (typeof botTop !== 'number' || top >= botTop) return true;
  return canManage(ctx.db, member);
}

// The fire-time checks. null: do nothing. Throws only on transient errors (retry).
async function load(ctx, job) {
  const guild = ctx.client?.guilds?.cache?.get(job.guildId);
  if (!guild) return null;
  const { enabled, config } = await getFeature(ctx.db, job.guildId, 'verification');
  const cfg = readConfig(config);
  if (!enabled || !RUNNING.has(cfg.state) || cfg.unverifiedPolicy === 'none') return null;
  const member = await fetchMember(guild, job.key);
  if (!member) return null;
  // Queued for another membership: the member left and rejoined unseen (bot down, or while
  // verification was off), so this row's clock is not theirs. Old payloads have no joinedAt.
  const joinedAt = job.payload?.joinedAt;
  if (joinedAt != null && member.joinedTimestamp !== joinedAt) return null;
  if (member.user?.bot) return null;
  if (cfg.roleId && member.roles?.cache?.has(cfg.roleId)) return null;
  if (await isSpared(ctx, guild, member)) return null;
  return { guild, cfg, member };
}

const errorDetail = (err) => `error: ${err?.message ?? err}`;

// The kick after a warn, never sooner than GRACE_MS from now (a warn that fires late, after
// downtime, still leaves the member time to act).
const kickAfterWarn = (p, now) => Math.max(p.kickAt, now + GRACE_MS);

// Writes the warn result into the member's kick row of THIS schedule (matched by the warn's own
// kickAt), in one statement:
// - the kick row exists with that kickAt: its payload gets `warned` and the (maybe later) kickAt;
// - the kick row exists with another kickAt (a rejoin queued a newer schedule): left alone;
// - no kick row (consumed, or cancelled): inserted only if no newer warn row exists for the
//   member AND verification still runs with a policy (a remove or policy none cancelled it all).
async function rescheduleKick(db, guildId, userId, p, warned, dueAt) {
  await db.query(
    `INSERT INTO scheduled_jobs (guild_id, type, key, payload, due_at)
     SELECT $1, $2, $3, $4::jsonb, to_timestamp($5::float8 / 1000.0)
     WHERE NOT EXISTS (
         SELECT 1 FROM scheduled_jobs w
         WHERE w.guild_id = $1 AND w.type = $7 AND w.key = $3 AND NOT (w.payload @> $6::jsonb))
       AND EXISTS (
         SELECT 1 FROM guild_settings s
         WHERE s.guild_id = $1 AND s.feature = 'verification' AND s.enabled
           AND s.config->>'state' = ANY($8::text[])
           AND s.config->>'unverifiedPolicy' = ANY($9::text[]))
     ON CONFLICT (guild_id, type, key) DO UPDATE
       SET payload = EXCLUDED.payload, due_at = EXCLUDED.due_at, attempts = 0, claimed_until = NULL
       WHERE scheduled_jobs.payload @> $6::jsonb`,
    [
      guildId, KICK_JOB, userId,
      JSON.stringify({
        policy: p.policy, kickAt: dueAt, kickAfter: p.kickAfter,
        ...(p.joinedAt != null ? { joinedAt: p.joinedAt } : {}), warned,
      }),
      dueAt, JSON.stringify({ kickAt: p.kickAt }), WARN_JOB, [...RUNNING], QUEUED_POLICIES,
    ],
  );
}

/** Scheduler handler for WARN_JOB (queued policy warn_kick only). */
export async function warnJob(ctx, job, deps = {}) {
  const { run, log, now } = using(deps);
  const p = job.payload ?? {};
  if (p.policy !== 'warn_kick' || !Number.isFinite(p.kickAt)) return;
  let claimed = false;
  try {
    const cur = await load(ctx, job);
    if (!cur) return;
    const { guild, cfg, member } = cur;
    const lang = await getLang(ctx.db, guild.id);
    const modConfig = readModConfig((await getFeature(ctx.db, guild.id, 'moderation')).config);

    // The claim. Matching kickAt keeps a rejoin's newer row out of reach.
    const removed = await cancelJobs(ctx.db, {
      guildId: guild.id, type: WARN_JOB, key: member.id, payload: { kickAt: p.kickAt },
    });
    if (removed === 0) return;
    claimed = true;

    const at = now();
    const kickAt = kickAfterWarn(p, at);
    const time = formatDuration(Math.ceil((kickAt - at) / 1000));
    const reason = cfg.channelId
      ? t(lang, 'verification.unverified.warn_reason', { channel: `<#${cfg.channelId}>`, time })
      : t(lang, 'verification.unverified.warn_reason_no_channel', { time });
    let result;
    try {
      result = await run(ctx, {
        guild, actor: guild.members.me, type: 'warn', targetId: member.id, target: member,
        reason, config: modConfig, lang,
      });
    } catch (err) {
      result = { ok: false, reason: errorDetail(err) };
    }
    const warned = result?.ok === true ? 'ok' : 'failed';
    await rescheduleKick(ctx.db, guild.id, member.id, p, warned, kickAt);
    if (warned === 'failed') {
      await log(ctx, guild.id, lang, {
        kind: 'unverified_failed', userId: member.id, detail: `warn: ${result?.reason ?? 'unknown'}`,
      });
    }
  } catch (err) {
    // The scheduler drops the job after this attempt: the warn will never happen, so mark it
    // failed (the kick is skipped) and say so once. Not after the claim: the warn ran by then.
    if (!claimed && job.attempts >= MAX_ATTEMPTS) {
      try {
        await rescheduleKick(ctx.db, job.guildId, job.key, p, 'failed', kickAfterWarn(p, now()));
        const lang = await getLang(ctx.db, job.guildId);
        await log(ctx, job.guildId, lang, {
          kind: 'unverified_failed', userId: job.key, detail: `warn: ${errorDetail(err)}`,
        });
      } catch (inner) {
        console.warn(`Could not mark the unverified warn failed in ${job.guildId}: ${inner?.message ?? inner}`);
      }
    }
    throw err;
  }
}

// True when this claimed row was rescheduled since it was claimed (scheduleJob resets attempts to
// 0): the newer row runs on its own, this stale copy must not act.
async function isSuperseded(db, job) {
  if (job.id == null) return false;
  const { rows } = await db.query('SELECT attempts FROM scheduled_jobs WHERE id = $1', [job.id]);
  return rows.length > 0 && rows[0].attempts !== job.attempts;
}

async function warnPending(db, guildId, userId) {
  const { rows } = await db.query(
    'SELECT 1 FROM scheduled_jobs WHERE guild_id = $1 AND type = $2 AND key = $3 LIMIT 1',
    [guildId, WARN_JOB, userId],
  );
  return rows.length > 0;
}

/** Scheduler handler for KICK_JOB. */
export async function kickJob(ctx, job, deps = {}) {
  const { run, log } = using(deps);
  const p = job.payload ?? {};
  if (!QUEUED.has(p.policy)) return;
  try {
    const cur = await load(ctx, job);
    if (!cur) return;
    if (await isSuperseded(ctx.db, job)) return;
    const { guild, cfg, member } = cur;
    const lang = await getLang(ctx.db, guild.id);

    if (p.policy === 'warn_kick' && p.warned !== 'ok') {
      // `failed` was logged by the warn job. Undefined: the warn has not run. While its row is
      // still queued (due later or retrying) it will reschedule this kick itself, so stay quiet.
      if (p.warned === undefined && !(await warnPending(ctx.db, guild.id, member.id))) {
        await log(ctx, guild.id, lang, {
          kind: 'unverified_failed', userId: member.id, detail: 'kick skipped: the warning never ran',
        });
      }
      return;
    }

    // Without Kick Members runAction would DM "you were kicked" before the kick fails: check first.
    if (!guild.members.me?.permissions?.has(PermissionFlagsBits.KickMembers)) {
      await log(ctx, guild.id, lang, {
        kind: 'unverified_failed', userId: member.id, detail: 'kick: the bot lacks the Kick Members permission',
      });
      return;
    }

    const modConfig = readModConfig((await getFeature(ctx.db, guild.id, 'moderation')).config);
    const kickAfter = Number.isFinite(p.kickAfter) && p.kickAfter > 0 ? p.kickAfter : cfg.kickAfterSeconds;
    const reason = t(lang, 'verification.unverified.kick_reason', { time: formatDuration(kickAfter) });
    const result = await run(ctx, {
      guild, actor: guild.members.me, type: 'kick', targetId: member.id, target: member,
      reason, config: modConfig, lang,
    });
    if (result?.ok === true || result?.reason === 'not_in_server') return;
    await log(ctx, guild.id, lang, {
      kind: 'unverified_failed', userId: member.id, detail: `kick: ${result?.reason ?? 'unknown'}`,
    });
  } catch (err) {
    // Last attempt: the scheduler drops the job, so the kick failure must reach the mod log.
    if (job.attempts >= MAX_ATTEMPTS) {
      try {
        const lang = await getLang(ctx.db, job.guildId);
        await log(ctx, job.guildId, lang, {
          kind: 'unverified_failed', userId: job.key, detail: `kick: ${errorDetail(err)}`,
        });
      } catch (inner) {
        console.warn(`Could not log the unverified kick failure in ${job.guildId}: ${inner?.message ?? inner}`);
      }
    }
    throw err;
  }
}

export const jobs = { [WARN_JOB]: warnJob, [KICK_JOB]: kickJob };
