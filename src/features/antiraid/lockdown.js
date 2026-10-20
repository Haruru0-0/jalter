// The anti-raid lockdown: what happens when a burst of joins is detected.
//
// A start flips the state with ONE conditional update (state not already locked, feature on),
// so two starts can never both win. Everything after that is best effort: a refused invite
// pause, a missing mod-log channel or a kick Discord refuses is recorded and the lockdown
// still runs.
//
// The state lives in the feature config (merge-written) and the end timer in the shared
// scheduler, so there is no table of our own and no migration.
//
// A running start must never overwrite or outlive an end: every write it makes after the flip
// is conditional on the lockdown still being the one it started (config.lockedAt), and the kick
// loop stops as soon as it is not.
import { PermissionFlagsBits } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { formatDuration } from '../../core/duration.js';
import { scheduleJob, cancelJobs, MAX_ATTEMPTS } from '../../core/scheduler.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { safeMentions } from '../../core/mentions.js';
import { sendLog } from '../logging/send-log.js';
import { runAction } from '../moderation/actions.js';
import { readConfig as readModConfig } from '../moderation/config.js';
import { fetchMember, isSpared } from '../verification/unverified-jobs.js';
import { readConfig, resolvePingRole } from './config.js';
import { joins as defaultJoins } from './joins.js';

const FEATURE = 'antiraid';

export const END_JOB = 'antiraid.end';
export const END_KEY = 'lockdown';
/** At most this many accounts are removed by one lockdown. */
export const MAX_KICKS = 100;

const using = (deps) => ({
  run: deps.runAction ?? runAction,
  log: deps.sendLog ?? sendLog,
  send: deps.trySend ?? trySend,
  fetch: deps.fetchSendable ?? fetchSendable,
  now: deps.now ?? Date.now,
  joins: deps.joins ?? defaultJoins,
  schedule: deps.scheduleJob ?? scheduleJob,
});

const IDLE = {
  state: 'idle',
  lockedAt: null,
  lockedUntil: null,
  startedBy: null,
  invitesPausedByUs: false,
  inviteResult: 'none',
  alertResult: 'none',
};

const errorText = (err) => err?.message ?? String(err);

// ---- the conditional state writes ----------------------------------------------------------

/**
 * Flips the state to locked in one statement. It only writes when the feature is on and the
 * state is not locked yet, so two starts can never both win: the loser sees zero rows.
 */
async function flipToLocked(ctx, guildId, patch) {
  const res = await ctx.db.query(
    `UPDATE guild_settings
        SET config = config || $2::jsonb
      WHERE guild_id = $1 AND feature = 'antiraid' AND enabled
        AND COALESCE(config->>'state', 'idle') <> 'locked'`,
    [guildId, JSON.stringify(patch)],
  );
  return res.rowCount;
}

/**
 * Flips the state back to idle in one statement and returns the config as it was just before
 * the flip (the pause, end time and kick count of the lockdown that ended), or null when there
 * was no lockdown. The locked row is taken FOR UPDATE, so two ends cannot both get it.
 */
async function flipToIdle(ctx, guildId, patch) {
  const res = await ctx.db.query(
    `WITH old AS (
       SELECT config FROM guild_settings
        WHERE guild_id = $1 AND feature = 'antiraid' AND config->>'state' = 'locked'
          FOR UPDATE
     )
     UPDATE guild_settings g
        SET config = g.config || $2::jsonb
       FROM old
      WHERE g.guild_id = $1 AND g.feature = 'antiraid' AND g.config->>'state' = 'locked'
  RETURNING old.config AS old_config`,
    [guildId, JSON.stringify(patch)],
  );
  return res.rows[0]?.old_config ?? null;
}

/** Merges a patch only while the lockdown that started at lockedAt is still the current one. */
async function patchIfCurrent(ctx, guildId, lockedAt, patch) {
  const res = await ctx.db.query(
    `UPDATE guild_settings
        SET config = config || $3::jsonb
      WHERE guild_id = $1 AND feature = 'antiraid'
        AND config->>'state' = 'locked' AND config->>'lockedAt' = $2`,
    [guildId, String(lockedAt), JSON.stringify(patch)],
  );
  return res.rowCount > 0;
}

/** True while the lockdown that started at lockedAt is still the current one. */
async function isCurrent(ctx, guildId, lockedAt) {
  const res = await ctx.db.query(
    `SELECT 1 FROM guild_settings
      WHERE guild_id = $1 AND feature = 'antiraid'
        AND config->>'state' = 'locked' AND config->>'lockedAt' = $2`,
    [guildId, String(lockedAt)],
  );
  return res.rowCount > 0;
}

/** The end timer of a lockdown that could not be ended the normal way. */
async function forceIdle(ctx, guildId) {
  await ctx.db.query(
    `UPDATE guild_settings
        SET config = config || $2::jsonb
      WHERE guild_id = $1 AND feature = 'antiraid'`,
    [guildId, JSON.stringify(IDLE)],
  );
}

/** Adds one to the count of removed accounts, while that lockdown is still the current one. */
async function bumpKicked(ctx, guildId, lockedAt) {
  await ctx.db.query(
    `UPDATE guild_settings
        SET config = jsonb_set(config, '{kicked}', to_jsonb(
          (CASE WHEN (config->>'kicked') ~ '^[0-9]+$' THEN (config->>'kicked')::int ELSE 0 END) + 1))
      WHERE guild_id = $1 AND feature = 'antiraid'
        AND config->>'state' = 'locked' AND config->>'lockedAt' = $2`,
    [guildId, String(lockedAt)],
  );
}

// ---- discord helpers -----------------------------------------------------------------------

/** The admin's own DM pause, passed back unchanged: setIncidentActions replaces both fields. */
const keepDms = (guild, at) => {
  const raw = guild.incidentsData?.dmsDisabledUntil;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) && ms > at ? raw : null;
};

const canKick = (guild) => guild.members?.me?.permissions?.has(PermissionFlagsBits.KickMembers) === true;

/** True when the guild's invite pause is the one this lockdown made (same end, to the second). */
function pauseIsOurs(guild, lockedUntil) {
  const raw = guild.incidentsData?.invitesDisabledUntil;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) && Number.isFinite(lockedUntil) && Math.abs(ms - lockedUntil) <= 1000;
}

// ---- the alert and the log line ------------------------------------------------------------

const timestamp = (ms) => `<t:${Math.floor(ms / 1000)}:F>`;

function alertEmbed(lang, { cfg, joinedCount, candidates, lockedUntil, trigger, startedBy }) {
  const who = startedBy && startedBy !== 'auto' ? `<@${startedBy}>` : null;
  return {
    title: t(lang, 'antiraid.alert.title'),
    fields: [
      {
        name: t(lang, 'antiraid.alert.joins'),
        value: t(lang, 'antiraid.alert.joins_value', {
          joins: joinedCount, window: formatDuration(cfg.windowSeconds),
        }),
        inline: true,
      },
      {
        name: t(lang, 'antiraid.alert.candidates'),
        value: t(lang, 'antiraid.alert.candidates_value', {
          count: candidates.length, age: formatDuration(cfg.accountAgeSeconds),
        }),
        inline: true,
      },
      {
        name: t(lang, 'antiraid.alert.ends'),
        value: t(lang, 'antiraid.alert.ends_value', { until: timestamp(lockedUntil) }),
        inline: true,
      },
      {
        name: t(lang, 'antiraid.alert.trigger'),
        value: who ? t(lang, 'antiraid.alert.trigger_manual', { who }) : t(lang, 'antiraid.alert.trigger_auto'),
      },
    ],
  };
}

function endEmbed(lang, { by, actorId, kicked, lifted }) {
  const who = actorId ? `<@${actorId}>` : null;
  const byText = by === 'manual' && who
    ? t(lang, 'antiraid.log.by_manual', { who })
    : t(lang, by === 'disable' ? 'antiraid.log.by_disable' : 'antiraid.log.by_timer');
  return {
    title: t(lang, 'antiraid.log.title'),
    fields: [
      { name: t(lang, 'antiraid.log.by'), value: byText, inline: true },
      { name: t(lang, 'antiraid.log.kicked'), value: String(kicked), inline: true },
      {
        name: t(lang, 'antiraid.log.pause'),
        value: lifted ? t(lang, 'antiraid.log.pause_lifted') : t(lang, 'antiraid.log.pause_kept'),
      },
    ],
  };
}

// ---- the start -----------------------------------------------------------------------------

/**
 * Starts a lockdown: state, end timer, invite pause, alert and the kicks of the young accounts.
 * Every step after the state flip is best effort, so a refusal or a thrown Discord error is
 * recorded and the next step still runs. The one exception is the end timer: without it the
 * lockdown could never end, so a failure there undoes the lock (reason 'schedule_failed').
 */
export async function startLockdown(ctx, guild, {
  trigger = 'auto', startedBy = null, joinedCount = 0, candidates = [],
} = {}, deps = {}) {
  const { run, log, send, fetch, now, schedule } = using(deps);
  const guildId = guild.id;
  const at = now();

  const { enabled, config } = await getFeature(ctx.db, guildId, FEATURE);
  if (!enabled) return { ok: false, reason: 'disabled' };
  const cfg = readConfig(config);
  const lockedUntil = at + cfg.durationSeconds * 1000;

  const won = await flipToLocked(ctx, guildId, {
    state: 'locked',
    lockedAt: at,
    lockedUntil,
    startedBy: startedBy ?? null,
    kicked: 0,
    invitesPausedByUs: false,
    inviteResult: 'none',
    alertResult: 'none',
  });
  if (won === 0) {
    // The feature was turned off between the read and the flip: that is not a lockdown.
    const cur = await getFeature(ctx.db, guildId, FEATURE);
    return { ok: false, reason: cur.enabled ? 'already_locked' : 'disabled' };
  }

  // The end timer. It survives a restart, because the state and the job are both in the database.
  try {
    await schedule(ctx.db, {
      guildId, type: END_JOB, key: END_KEY, payload: { lockedUntil }, dueAt: lockedUntil,
    });
  } catch (err) {
    console.warn(`Could not queue the anti-raid end in ${guildId}: ${errorText(err)}`);
    try {
      await flipToIdle(ctx, guildId, IDLE);
    } catch (inner) {
      console.warn(`Could not undo the anti-raid lock in ${guildId}: ${errorText(inner)}`);
      try {
        await forceIdle(ctx, guildId);
      } catch (last) {
        console.warn(`Could not force the anti-raid lock off in ${guildId}: ${errorText(last)}`);
      }
    }
    return { ok: false, reason: 'schedule_failed' };
  }

  const lang = await getLang(ctx.db, guildId);

  // The invite pause comes first: it is what stops the raid. A pause that is already there is
  // somebody else's: leave it alone.
  let inviteResult = 'none';
  let invitesPausedByUs = false;
  const already = guild.incidentsData?.invitesDisabledUntil;
  const alreadyMs = already ? new Date(already).getTime() : NaN;
  if (Number.isFinite(alreadyMs) && alreadyMs > at) {
    inviteResult = 'already';
  } else {
    try {
      await guild.setIncidentActions({
        invitesDisabledUntil: new Date(lockedUntil),
        dmsDisabledUntil: keepDms(guild, at),
      });
      inviteResult = 'paused';
      invitesPausedByUs = true;
    } catch (err) {
      console.warn(`Could not pause the invites in ${guildId}: ${errorText(err)}`);
      inviteResult = 'failed';
    }
  }
  // Written right away: the end must know whether the pause is ours to lift.
  let stillOurs;
  try {
    stillOurs = await patchIfCurrent(ctx, guildId, at, { inviteResult, invitesPausedByUs });
  } catch (err) {
    console.warn(`Could not save the anti-raid invite result in ${guildId}: ${errorText(err)}`);
    stillOurs = true;
  }
  if (!stillOurs) {
    // The lockdown ended while we were starting, so the end could not know about our pause.
    if (invitesPausedByUs) {
      try {
        await guild.setIncidentActions({ invitesDisabledUntil: null, dmsDisabledUntil: keepDms(guild, at) });
      } catch (err) {
        console.warn(`Could not lift the invite pause in ${guildId}: ${errorText(err)}`);
      }
    }
    return { ok: false, reason: 'ended' };
  }

  // The alert: a mod-log message, and a ping in the same channel.
  let alertResult = 'none';
  try {
    const where = await log(ctx, guildId, 'modAction', alertEmbed(lang, {
      cfg, joinedCount, candidates, lockedUntil, trigger, startedBy,
    }));
    if (!where) {
      alertResult = 'no_channel';
    } else {
      alertResult = 'sent';
      const ping = await resolvePingRole(ctx, guildId, cfg);
      if (ping.roleId) {
        const channel = await fetch(ctx.client, where.channelId);
        const sent = channel
          ? await send(channel, {
            content: t(lang, 'antiraid.alert.ping', { role: `<@&${ping.roleId}>` }),
            allowedMentions: safeMentions([ping.roleId]),
          })
          : null;
        if (!sent) alertResult = 'failed';
      }
    }
  } catch (err) {
    console.warn(`Could not send the anti-raid alert in ${guildId}: ${errorText(err)}`);
    alertResult = 'failed';
  }

  // The kicks of the young accounts of the burst. Each one is counted as it happens, and the
  // loop stops the moment this lockdown is no longer the current one.
  let kicked = 0;
  if (!canKick(guild)) {
    if (candidates.length > 0) console.warn(`The bot cannot kick in ${guildId}: Kick Members is missing`);
  } else {
    const modConfig = readModConfig((await getFeature(ctx.db, guildId, 'moderation')).config);
    const reason = t(lang, 'antiraid.kick_reason');
    for (const candidate of candidates.slice(0, MAX_KICKS)) {
      if (!(await isCurrent(ctx, guildId, at))) break;
      const result = await kickCandidate(ctx, guild, candidate, { run, modConfig, lang, reason, cfg, at });
      if (result === 'kicked') {
        kicked += 1;
        try {
          await bumpKicked(ctx, guildId, at);
        } catch (err) {
          console.warn(`Could not count a kick in ${guildId}: ${errorText(err)}`);
        }
      }
    }
  }

  try {
    await patchIfCurrent(ctx, guildId, at, { alertResult });
  } catch (err) {
    console.warn(`Could not save the anti-raid result in ${guildId}: ${errorText(err)}`);
  }

  return { ok: true, kicked };
}

/** Kicks one candidate of the burst. 'old' when the account is not young enough. */
async function kickCandidate(ctx, guild, candidate, { run, modConfig, lang, reason, cfg, at }) {
  if (!candidate || typeof candidate.userId !== 'string') return 'failed';
  const createdAt = Number(candidate.createdAt);
  if (!Number.isFinite(createdAt) || at - createdAt >= cfg.accountAgeSeconds * 1000) return 'old';
  let member;
  try {
    member = await fetchMember(guild, candidate.userId);
  } catch (err) {
    console.warn(`Could not fetch ${candidate.userId} in ${guild.id}: ${errorText(err)}`);
    return 'failed';
  }
  if (!member) return 'failed';
  if (await isSpared(ctx, guild, member)) return 'spared';
  try {
    const result = await run(ctx, {
      guild,
      actor: guild.members.me,
      type: 'kick',
      targetId: member.id,
      target: member,
      reason,
      // No DM: a raid account is not owed an explanation, and a DM per kick is spam.
      config: { ...modConfig, dm: false },
      lang,
    });
    return result?.ok === true ? 'kicked' : 'failed';
  } catch (err) {
    console.warn(`Could not kick ${member.id} in ${guild.id}: ${errorText(err)}`);
    return 'failed';
  }
}

// ---- the end -------------------------------------------------------------------------------

/**
 * Ends the lockdown: idle again, the end timer cancelled, our invite pause lifted, the join
 * list cleared and one line in the mod log. Ending twice does nothing the second time.
 * It does not need the feature to be on: /antiraid disable ends the lockdown after turning it off.
 */
export async function endLockdown(ctx, guild, { by = 'timer', actorId = null } = {}, deps = {}) {
  const { log, joins, now } = using(deps);
  const guildId = guild.id;

  const old = await flipToIdle(ctx, guildId, IDLE);
  if (!old) return { ok: false, reason: 'not_locked' };
  const was = readConfig(old);
  // Right away, before any other I/O: a lockdown that starts next must keep its own joins.
  joins.clear(guildId);

  try {
    // Only this lockdown's timer: a newer lockdown may already have queued its own.
    await cancelJobs(ctx.db, {
      guildId, type: END_JOB, key: END_KEY, payload: { lockedUntil: was.lockedUntil },
    });
  } catch (err) {
    console.warn(`Could not cancel the anti-raid end in ${guildId}: ${errorText(err)}`);
  }

  // Only the pause this lockdown made is lifted: an admin's own pause stays, even one that
  // replaced ours since.
  let lifted = false;
  if (was.invitesPausedByUs && pauseIsOurs(guild, was.lockedUntil)) {
    try {
      await guild.setIncidentActions({ invitesDisabledUntil: null, dmsDisabledUntil: keepDms(guild, now()) });
      lifted = true;
    } catch (err) {
      console.warn(`Could not lift the invite pause in ${guildId}: ${errorText(err)}`);
    }
  }

  try {
    const lang = await getLang(ctx.db, guildId);
    await log(ctx, guildId, 'modAction', endEmbed(lang, { by, actorId, kicked: was.kicked, lifted }));
  } catch (err) {
    console.warn(`Could not log the anti-raid end in ${guildId}: ${errorText(err)}`);
  }

  return { ok: true };
}

// ---- a young join while the lockdown is on --------------------------------------------------

/**
 * Kicks a young account that joins while the lockdown is on, and counts it.
 * 'old' when the account is not young enough, 'spared' when the member is never kicked,
 * 'failed' when the kick did not happen.
 */
export async function kickYoungJoin(ctx, guild, member, deps = {}) {
  const { run, now } = using(deps);
  const guildId = guild.id;
  const { config } = await getFeature(ctx.db, guildId, FEATURE);
  const cfg = readConfig(config);
  const at = now();

  if (!canKick(guild)) return 'failed';
  const createdAt = Number(member?.user?.createdTimestamp);
  if (!Number.isFinite(createdAt)) return 'failed';
  if (at - createdAt >= cfg.accountAgeSeconds * 1000) return 'old';
  if (await isSpared(ctx, guild, member)) return 'spared';

  const lang = await getLang(ctx.db, guildId);
  const modConfig = readModConfig((await getFeature(ctx.db, guildId, 'moderation')).config);
  const reason = t(lang, 'antiraid.kick_reason');
  try {
    const result = await run(ctx, {
      guild,
      actor: guild.members.me,
      type: 'kick',
      targetId: member.id,
      target: member,
      reason,
      config: { ...modConfig, dm: false },
      lang,
    });
    if (result?.ok !== true) return 'failed';
  } catch (err) {
    console.warn(`Could not kick ${member?.id} in ${guildId}: ${errorText(err)}`);
    return 'failed';
  }
  try {
    await bumpKicked(ctx, guildId, cfg.lockedAt);
  } catch (err) {
    console.warn(`Could not count a kick in ${guildId}: ${errorText(err)}`);
  }
  return 'kicked';
}

// ---- the end job ---------------------------------------------------------------------------

/**
 * Scheduler handler for the end of a lockdown. A job for a lockdown that already ended, or for
 * an older one, does nothing. A failure (including a guild that is not cached) is rethrown so
 * the scheduler retries, but on the last attempt the lockdown is concluded anyway: it can
 * never stay stuck.
 */
export async function endJob(ctx, job, deps = {}) {
  const guildId = job.guildId;
  try {
    const { config } = await getFeature(ctx.db, guildId, FEATURE);
    if (job.payload?.lockedUntil !== readConfig(config).lockedUntil) return;
    const guild = ctx.client?.guilds?.cache?.get(guildId);
    if (!guild) throw new Error(`guild ${guildId} is not in the cache`);
    await endLockdown(ctx, guild, { by: 'timer' }, deps);
  } catch (err) {
    if (job.attempts >= MAX_ATTEMPTS) {
      try {
        const { config } = await getFeature(ctx.db, guildId, FEATURE);
        const cfg = readConfig(config);
        if (job.payload?.lockedUntil === cfg.lockedUntil) {
          const guild = ctx.client?.guilds?.cache?.get(guildId);
          if (guild && cfg.invitesPausedByUs && pauseIsOurs(guild, cfg.lockedUntil)) {
            await guild.setIncidentActions({ invitesDisabledUntil: null, dmsDisabledUntil: keepDms(guild, (deps.now ?? Date.now)()) });
          }
          await forceIdle(ctx, guildId);
        }
      } catch (inner) {
        console.warn(`Could not conclude the anti-raid lockdown in ${guildId}: ${errorText(inner)}`);
      }
    }
    throw err;
  }
}

export const jobs = { [END_JOB]: endJob };
