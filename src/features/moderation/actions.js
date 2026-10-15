import { Events } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { scheduleJob, cancelJobs } from '../../core/scheduler.js';
import { sendLog, safe } from '../logging/send-log.js';
import { readConfig } from './config.js';
import { checkTarget, checkDuration } from './rules.js';
import { createCase, setCaseLog, isCurrentlyMuted } from './store.js';
import { formatCase, dmText } from './format.js';

const PUNISHMENTS = new Set(['warn', 'timeout', 'mute', 'kick', 'ban']);
const NEEDS_MEMBER = new Set(['timeout', 'untimeout', 'mute', 'unmute', 'kick']);
const TIMED = new Set(['timeout', 'mute', 'ban']);
const UNKNOWN_BAN = 10026;
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;
const AUDIT_REASON_MAX = 512;
const EXPIRY_GRACE_MS = 1000;

const UNBAN_JOB = 'mod.unban';
const UNMUTE_JOB = 'mod.unmute';

const fail = (reason) => ({ ok: false, reason });

// A permanent Discord error will not get better by retrying: finish the job. 429 and 5xx are transient.
const isPermanent = (err) => err?.status >= 400 && err?.status < 500 && err.status !== 429;

const auditReason = (reason) => (reason ? reason.slice(0, AUDIT_REASON_MAX) : undefined);

async function isBanned(guild, userId) {
  try {
    await guild.bans.fetch(userId);
    return true;
  } catch (err) {
    if (err?.code === UNKNOWN_BAN) return false;
    throw err;
  }
}

function muteRoleOf(guild, config) {
  return config.muteRoleId && guild.roles.cache.has(config.muteRoleId) ? config.muteRoleId : null;
}

function discordAction(guild, { type, target, targetId, reason, seconds, deleteDays, config, muteRoleId }) {
  const why = auditReason(reason);
  switch (type) {
    case 'timeout': return target.timeout(seconds * 1000, why);
    case 'untimeout': return target.timeout(null, why);
    case 'mute': return target.roles.add(muteRoleId, why);
    case 'unmute': return target.roles.remove(muteRoleId, why);
    case 'kick': return target.kick(why);
    case 'ban':
      return guild.members.ban(targetId, {
        deleteMessageSeconds: (deleteDays ?? config.banDeleteDays) * 86400,
        reason: why,
      });
    case 'unban': return guild.members.unban(targetId, why);
    default: return undefined; // warn has no Discord action
  }
}

async function postLog(ctx, guildId, modCase, lang, warnings) {
  try {
    const where = await sendLog(ctx, guildId, 'modAction', formatCase(modCase, lang));
    if (where) await setCaseLog(ctx.db, guildId, modCase.number, where);
  } catch (err) {
    console.warn(`Could not log case ${modCase.number} in ${guildId}: ${err.message}`);
    warnings?.push('log_failed');
  }
}

async function schedule(ctx, guildId, { type, targetId, seconds, now }, warnings) {
  const jobType = { ban: UNBAN_JOB, mute: UNMUTE_JOB, unban: UNBAN_JOB, unmute: UNMUTE_JOB }[type];
  if (!jobType) return;
  try {
    if ((type === 'ban' || type === 'mute') && seconds) {
      await scheduleJob(ctx.db, {
        guildId, type: jobType, key: targetId, payload: { userId: targetId }, dueAt: now + seconds * 1000,
      });
    } else {
      // A manual undo, or a new permanent ban or mute, must not leave an older expiry behind.
      await cancelJobs(ctx.db, { guildId, type: jobType, key: targetId });
    }
  } catch (err) {
    console.warn(`Could not schedule ${type} for ${targetId} in ${guildId}: ${err.message}`);
    warnings.push('schedule_failed');
  }
}

/** Runs one moderation action. Refusals and Discord failures create no case and use no number. */
export async function runAction(ctx, params) {
  const { guild, actor, type, targetId, target, deleteDays = null, config, lang } = params;
  const reason = params.reason?.trim() || null;
  const botMember = guild.members.me;
  const seconds = type === 'timeout'
    ? (params.durationSeconds ?? config.timeoutDefaultSeconds)
    : (TIMED.has(type) ? (params.durationSeconds ?? null) : null);

  if (PUNISHMENTS.has(type) && config.reasonRequired && !reason) return fail('reason_required');
  const allowed = checkTarget({ guild, actor, target, targetId, botMember });
  if (!allowed.ok) return fail(allowed.reason);
  const duration = checkDuration(type, seconds);
  if (!duration.ok) return fail(duration.reason);

  if (NEEDS_MEMBER.has(type) && !target) return fail('not_in_server');
  let muteRoleId = null;
  if (type === 'mute' || type === 'unmute') {
    muteRoleId = muteRoleOf(guild, config);
    if (!muteRoleId) return fail('no_mute_role');
  }
  try {
    if (type === 'ban' && await isBanned(guild, targetId)) return fail('already_banned');
    if (type === 'unban' && !(await isBanned(guild, targetId))) return fail('not_banned');
    if (type === 'mute' && await isCurrentlyMuted(ctx.db, guild.id, targetId, Date.now())) {
      return fail('already_muted');
    }
  } catch (err) {
    console.warn(`Could not check state for ${type} in ${guild.id}: ${err.message}`);
    return fail('discord_refused');
  }

  const warnings = [];
  if (config.dm && target && PUNISHMENTS.has(type)) {
    try {
      await target.send(dmText(lang, type, {
        guildName: guild.name, reason, durationSeconds: seconds, caseNumber: null,
      }));
    } catch {
      warnings.push('dm_failed');
    }
  }

  try {
    await discordAction(guild, { type, target, targetId, reason, seconds, deleteDays, config, muteRoleId });
  } catch (err) {
    console.warn(`Moderation ${type} failed in ${guild.id}: ${err.message}`);
    return fail('discord_refused');
  }

  const now = Date.now();
  let modCase = null;
  try {
    modCase = await createCase(ctx.db, {
      guildId: guild.id, type, targetId, moderatorId: actor.id, reason,
      durationMs: seconds ? seconds * 1000 : null,
      endsAt: seconds ? now + seconds * 1000 : null,
    });
  } catch (err) {
    console.warn(`Could not save ${type} case in ${guild.id}: ${err.message}`);
    warnings.push('case_not_saved');
  }

  await schedule(ctx, guild.id, { type, targetId, seconds, now }, warnings);
  if (modCase) await postLog(ctx, guild.id, modCase, lang, warnings);
  return { ok: true, modCase, warnings };
}

async function expiryCase(ctx, guild, type, userId, lang) {
  try {
    const modCase = await createCase(ctx.db, {
      guildId: guild.id, type, targetId: userId, moderatorId: ctx.client.user.id,
      reason: t(lang, 'moderation.expired'),
    });
    await postLog(ctx, guild.id, modCase, lang);
  } catch (err) {
    // The Discord side is done; retrying would find nothing to do, so just report.
    console.warn(`Could not record expired ${type} in ${guild.id}: ${err.message}`);
  }
}

/** Scheduler handler: unban when a timed ban ends. Runs whether or not the feature is on. */
export async function expireBan(ctx, job) {
  const guild = ctx.client.guilds.cache.get(job.guildId);
  if (!guild) return;
  const { userId } = job.payload;
  const lang = await getLang(ctx.db, guild.id);
  try {
    if (!(await isBanned(guild, userId))) return;
    await guild.members.unban(userId, auditReason(t(lang, 'moderation.expired')));
  } catch (err) {
    if (err?.code === UNKNOWN_BAN) return;
    if (isPermanent(err)) {
      console.warn(`Timed unban failed in ${guild.id}: ${err.message}`);
      return;
    }
    throw err;
  }
  await expiryCase(ctx, guild, 'unban', userId, lang);
}

/** Scheduler handler: remove the mute role when a timed mute ends. Runs whether or not the feature is on. */
export async function expireMute(ctx, job) {
  const guild = ctx.client.guilds.cache.get(job.guildId);
  if (!guild) return;
  const { userId } = job.payload;
  // A newer mute that is still running (permanent, or ending later) owns the role now.
  // The grace covers rounding between the job's due time and the case's end time.
  if (await isCurrentlyMuted(ctx.db, guild.id, userId, Date.now() + EXPIRY_GRACE_MS)) return;
  const { config } = await getFeature(ctx.db, guild.id, 'moderation');
  const roleId = muteRoleOf(guild, readConfig(config));
  if (!roleId) return;
  const lang = await getLang(ctx.db, guild.id);
  try {
    const member = await guild.members.fetch(userId);
    // Idempotent on the role itself, so a lost mute case still expires and a done one is not logged twice.
    if (!member.roles.cache.has(roleId)) return;
    await member.roles.remove(roleId, auditReason(t(lang, 'moderation.expired')));
  } catch (err) {
    if (err?.code === UNKNOWN_MEMBER || err?.code === UNKNOWN_ROLE) return;
    if (isPermanent(err)) {
      console.warn(`Timed unmute failed in ${guild.id}: ${err.message}`);
      return;
    }
    throw err;
  }
  await expiryCase(ctx, guild, 'unmute', userId, lang);
}

export const jobs = { [UNBAN_JOB]: expireBan, [UNMUTE_JOB]: expireMute };

/** GuildMemberAdd: a member who is still muted gets the mute role back. Never throws. */
export async function reapplyMute(ctx, member) {
  try {
    const guild = member.guild;
    const { enabled, config } = await getFeature(ctx.db, guild.id, 'moderation');
    if (!enabled) return;
    const roleId = muteRoleOf(guild, readConfig(config));
    if (!roleId) return;
    if (!(await isCurrentlyMuted(ctx.db, guild.id, member.id, Date.now()))) return;
    await member.roles.add(roleId, auditReason(t(await getLang(ctx.db, guild.id), 'moderation.rejoinMute')));
  } catch (err) {
    console.warn(`Could not re-apply mute in ${member?.guild?.id}: ${err.message}`);
  }
}

export const events = [{ name: Events.GuildMemberAdd, execute: safe('reapplyMute', reapplyMute) }];
