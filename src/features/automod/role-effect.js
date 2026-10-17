// Timed role effect: a rule can give the offender a role (e.g. "Muted") that is taken back later.
import { getLang, t } from '../../i18n/index.js';
import { scheduleJob, cancelJobs } from '../../core/scheduler.js';

export const REMOVE_ROLE_JOB = 'automod.removeRole';
const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;
const AUDIT_REASON_MAX = 512;

const isPermanent = (err) => err?.status >= 400 && err?.status < 500 && err.status !== 429;
const auditReason = (text) => text.slice(0, AUDIT_REASON_MAX);
const jobKey = (userId, roleId) => `${userId}:${roleId}`;

// A punishment role must never carry staff power: someone able to set it could trip the rule from an alt.
const DANGEROUS_PERMISSIONS = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'BanMembers', 'KickMembers', 'ModerateMembers',
  'ManageChannels', 'ManageMessages', 'ManageWebhooks', 'MentionEveryone',
];

/** True when the role's own permissions include any staff power. */
export function isDangerousRole(role) {
  try {
    const perms = role?.permissions;
    // A raw API role carries a string here, which has no usable has(): not judged dangerous.
    if (typeof perms?.has !== 'function') return false;
    return DANGEROUS_PERMISSIONS.some((p) => perms.has(p) === true);
  } catch {
    return false;
  }
}

/** True when the member may hand out the role: the server owner, or their top role is strictly above it. */
export function callerCanGive(guild, member, role) {
  if (member?.id && member.id === guild?.ownerId) return true;
  const top = member?.roles?.highest?.position;
  return top !== undefined && role.position < top;
}

/** True when the bot can hand out this role: not @everyone, not managed, strictly below its top role. */
export function botCanGive(guild, role) {
  if (!role || role.id === guild.id || role.managed) return false;
  const botTop = guild.members.me?.roles.highest.position;
  return botTop !== undefined && role.position < botTop;
}

async function hasPendingRemoval(db, guildId, userId, roleId) {
  const res = await db.query(
    'SELECT 1 FROM scheduled_jobs WHERE guild_id = $1 AND type = $2 AND key = $3',
    [guildId, REMOVE_ROLE_JOB, jobKey(userId, roleId)],
  );
  return res.rowCount > 0;
}

/**
 * Gives the member the rule's role and schedules its removal. Returns true when the role is (now)
 * on a timer. Holding the role already means skip, unless our own removal is pending: then the
 * re-trigger just moves the removal time. A throw means the role could not be added; the caller logs it.
 */
export async function grantTimedRole(ctx, member, ruleCfg, now) {
  const { roleId, seconds } = ruleCfg?.giveRole ?? {};
  if (!roleId || !member) return false;
  const guild = member.guild;
  const role = guild.roles.cache.get(roleId);
  if (!botCanGive(guild, role)) return false;
  // Checked again here: the role may have gained permissions since setup.
  if (isDangerousRole(role)) {
    console.warn(`Auto-mod timed role ${roleId} in ${guild.id} has staff permissions; not given.`);
    return false;
  }
  const userId = member.id;
  const dueAt = now + seconds * 1000;
  const job = { guildId: guild.id, type: REMOVE_ROLE_JOB, key: jobKey(userId, roleId), payload: { userId, roleId }, dueAt };
  if (member.roles.cache.has(roleId)) {
    // Someone else's role must not be taken away later, but our own timer can be pushed back.
    if (!(await hasPendingRemoval(ctx.db, guild.id, userId, roleId))) return false;
    await scheduleJob(ctx.db, job);
    return true;
  }
  // Schedule first: if the add succeeded but the schedule failed, the role would never come off.
  await scheduleJob(ctx.db, job);
  try {
    const lang = await getLang(ctx.db, guild.id);
    await member.roles.add(roleId, auditReason(t(lang, 'automod.role.granted')));
  } catch (err) {
    await cancelJobs(ctx.db, { guildId: guild.id, type: REMOVE_ROLE_JOB, key: job.key });
    throw err;
  }
  return true;
}

/**
 * Scheduler handler: take the role back. Quiet when there is nothing left to do (guild, member or
 * role gone, role already off) or the error is permanent; transient errors throw so the scheduler retries.
 */
export async function removeTimedRole(ctx, job) {
  const guild = ctx.client.guilds.cache.get(job.guildId);
  if (!guild) return;
  const { userId, roleId } = job.payload;
  if (!guild.roles.cache.get(roleId)) return;
  const lang = await getLang(ctx.db, guild.id);
  try {
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(roleId)) return;
    await member.roles.remove(roleId, auditReason(t(lang, 'automod.role.expired')));
  } catch (err) {
    if (err?.code === UNKNOWN_MEMBER || err?.code === UNKNOWN_ROLE) return;
    if (isPermanent(err)) {
      console.warn(`Auto-mod role removal failed in ${guild.id}: ${err.message}`);
      return;
    }
    throw err;
  }
}

export const jobs = { [REMOVE_ROLE_JOB]: removeTimedRole };
