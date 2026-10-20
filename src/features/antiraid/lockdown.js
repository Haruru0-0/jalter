// The anti-raid lockdown: what happens when a burst of joins is detected.
//
// A start flips the state with ONE conditional update (state not already locked, feature on),
// so two starts can never both win. Everything after that is best effort: a refused invite
// pause, a missing mod-log channel or a kick Discord refuses is recorded and the lockdown
// still runs.
//
// The state lives in the feature config (merge-written) and the end timer in the shared
// scheduler, so there is no table of our own and no migration.
import { getFeature, setFeature } from '../../db/settings.js';
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
});

const errorText = (err) => err?.message ?? String(err);

// ---- the two conditional state flips ------------------------------------------------------

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

/** Flips the state back to idle in one statement. Zero rows means there was no lockdown. */
async function flipToIdle(ctx, guildId, patch) {
  const res = await ctx.db.query(
    `UPDATE guild_settings
        SET config = config || $2::jsonb
      WHERE guild_id = $1 AND feature = 'antiraid'
        AND config->>'state' = 'locked'`,
    [guildId, JSON.stringify(patch)],
  );
  return res.rowCount;
}

/** The end timer of a lockdown that could not be ended the normal way. */
async function forceIdle(ctx, guildId) {
  await ctx.db.query(
    `UPDATE guild_settings
        SET config = config || $2::jsonb
      WHERE guild_id = $1 AND feature = 'antiraid'`,
    [guildId, JSON.stringify({
      state: 'idle', lockedAt: null, lockedUntil: null, startedBy: null,
      invitesPausedByUs: false, inviteResult: 'none', alertResult: 'none',
    })],
  );
}

/** Adds one to the count of removed accounts, without reading it first. */
async function bumpKicked(ctx, guildId) {
  await ctx.db.query(
    `UPDATE guild_settings
        SET config = jsonb_set(config, '{kicked}', to_jsonb(
          (CASE WHEN (config->>'kicked') ~ '^[0-9]+$' THEN (config->>'kicked')::int ELSE 0 END) + 1))
      WHERE guild_id = $1 AND feature = 'antiraid'`,
    [guildId],
  );
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
 * Starts a lockdown: state, end timer, alert, invite pause and the kicks of the young accounts.
 * Every step after the state flip is best effort, so a refusal or a thrown Discord error is
 * recorded and the next step still runs.
 */
export async function startLockdown(ctx, guild, {
  trigger = 'auto', startedBy = null, joinedCount = 0, candidates = [],
} = {}, deps = {}) {
  const { run, log, send, fetch, now } = using(deps);
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
    await scheduleJob(ctx.db, {
      guildId, type: END_JOB, key: END_KEY, payload: { lockedUntil }, dueAt: lockedUntil,
    });
  } catch (err) {
    console.warn(`Could not queue the anti-raid end in ${guildId}: ${errorText(err)}`);
  }

  const lang = await getLang(ctx.db, guildId);

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

  // The invite pause. A pause that is already there is somebody else's: leave it alone.
  let inviteResult = 'none';
  let invitesPausedByUs = false;
  const already = guild.incidentsData?.invitesDisabledUntil;
  const alreadyMs = already ? new Date(already).getTime() : NaN;
  if (Number.isFinite(alreadyMs) && alreadyMs > at) {
    inviteResult = 'already';
  } else {
    try {
      await guild.setIncidentActions({ invitesDisabledUntil: new Date(lockedUntil) });
      inviteResult = 'paused';
      invitesPausedByUs = true;
    } catch (err) {
      console.warn(`Could not pause the invites in ${guildId}: ${errorText(err)}`);
      inviteResult = 'failed';
    }
  }
  // Written right away: the end must know whether the pause is ours to lift.
  try {
    await setFeature(ctx.db, guildId, FEATURE, { config: { inviteResult, invitesPausedByUs } });
  } catch (err) {
    console.warn(`Could not save the anti-raid invite result in ${guildId}: ${errorText(err)}`);
  }

  // The kicks of the young accounts of the burst.
  const modConfig = readModConfig((await getFeature(ctx.db, guildId, 'moderation')).config);
  const reason = t(lang, 'antiraid.kick_reason');
  let kicked = 0;
  for (const candidate of candidates.slice(0, MAX_KICKS)) {
    const result = await kickCandidate(ctx, guild, candidate, { run, modConfig, lang, reason, cfg, at });
    if (result === 'kicked') kicked += 1;
  }

  try {
    await setFeature(ctx.db, guildId, FEATURE, { config: { kicked, inviteResult, alertResult } });
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
      config: modConfig,
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
 */
export async function endLockdown(ctx, guild, { by = 'timer', actorId = null } = {}, deps = {}) {
  const { log, joins } = using(deps);
  const guildId = guild.id;

  const { config } = await getFeature(ctx.db, guildId, FEATURE);
  const cfg = readConfig(config);

  const ended = await flipToIdle(ctx, guildId, {
    state: 'idle',
    lockedAt: null,
    lockedUntil: null,
    startedBy: null,
    invitesPausedByUs: false,
    inviteResult: 'none',
    alertResult: 'none',
  });
  if (ended === 0) return { ok: false, reason: 'not_locked' };

  try {
    await cancelJobs(ctx.db, { guildId, type: END_JOB, key: END_KEY });
  } catch (err) {
    console.warn(`Could not cancel the anti-raid end in ${guildId}: ${errorText(err)}`);
  }

  // Only the pause this lockdown made is lifted: an admin's own pause stays.
  let lifted = false;
  if (cfg.invitesPausedByUs) {
    try {
      await guild.setIncidentActions({ invitesDisabledUntil: null });
      lifted = true;
    } catch (err) {
      console.warn(`Could not lift the invite pause in ${guildId}: ${errorText(err)}`);
    }
  }

  joins.clear(guildId);

  try {
    const lang = await getLang(ctx.db, guildId);
    await log(ctx, guildId, 'modAction', endEmbed(lang, { by, actorId, kicked: cfg.kicked, lifted }));
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
      config: modConfig,
      lang,
    });
    if (result?.ok !== true) return 'failed';
  } catch (err) {
    console.warn(`Could not kick ${member?.id} in ${guildId}: ${errorText(err)}`);
    return 'failed';
  }
  await bumpKicked(ctx, guildId);
  return 'kicked';
}

// ---- the end job ---------------------------------------------------------------------------

/**
 * Scheduler handler for the end of a lockdown. A job for a lockdown that already ended does
 * nothing. A failure is rethrown so the scheduler retries, but on the last attempt the
 * lockdown is concluded anyway: it can never stay stuck.
 */
export async function endJob(ctx, job, deps = {}) {
  const guild = ctx.client?.guilds?.cache?.get(job.guildId);
  if (!guild) return;
  try {
    await endLockdown(ctx, guild, { by: 'timer' }, deps);
  } catch (err) {
    if (job.attempts >= MAX_ATTEMPTS) {
      try {
        const { config } = await getFeature(ctx.db, job.guildId, FEATURE);
        if (readConfig(config).invitesPausedByUs) {
          await guild.setIncidentActions({ invitesDisabledUntil: null });
        }
        await forceIdle(ctx, job.guildId);
      } catch (inner) {
        console.warn(`Could not conclude the anti-raid lockdown in ${job.guildId}: ${errorText(inner)}`);
      }
    }
    throw err;
  }
}

export const jobs = { [END_JOB]: endJob };
