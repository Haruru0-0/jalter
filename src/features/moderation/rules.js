export const ACTION_PERMISSIONS = {
  warn: 'ModerateMembers',
  warnings: 'ModerateMembers',
  timeout: 'ModerateMembers',
  untimeout: 'ModerateMembers',
  mute: 'ModerateMembers',
  unmute: 'ModerateMembers',
  reason: 'ModerateMembers',
  kick: 'KickMembers',
  ban: 'BanMembers',
  unban: 'BanMembers',
};

const MIN_SECONDS = 60;
const TIMEOUT_MAX_SECONDS = 2_419_200;

/** True when the member holds the Discord permission for the action or a permitted role. */
export function canUseAction(member, action, config) {
  if (!Object.hasOwn(ACTION_PERMISSIONS, action)) return false;
  if (member.permissions.has(ACTION_PERMISSIONS[action])) return true;
  const roles = Array.isArray(config?.permittedRoles) ? config.permittedRoles : [];
  return roles.some((id) => member.roles.cache.has(id));
}

/** `target` is null when the user is not in the server; only identity checks apply then. */
export function checkTarget({ guild, actor, target, targetId, botMember }) {
  if (targetId === guild.ownerId) return { ok: false, reason: 'owner' };
  if (targetId === actor.id) return { ok: false, reason: 'self' };
  if (targetId === botMember.id) return { ok: false, reason: 'bot_self' };
  if (!target) return { ok: true };
  const position = target.roles.highest.position;
  if (actor.id !== guild.ownerId && position >= actor.roles.highest.position) {
    return { ok: false, reason: 'actor_hierarchy' };
  }
  if (position >= botMember.roles.highest.position) return { ok: false, reason: 'bot_hierarchy' };
  return { ok: true };
}

export function checkDuration(action, seconds) {
  if (seconds === null || seconds === undefined) return { ok: true };
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS) return { ok: false, reason: 'too_short' };
  if (action === 'timeout' && seconds > TIMEOUT_MAX_SECONDS) return { ok: false, reason: 'too_long' };
  return { ok: true };
}
