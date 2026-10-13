import { getFeature } from '../db/settings.js';

export async function canManage(db, member) {
  if (member.permissions.has('ManageGuild')) return true;
  const { config } = await getFeature(db, member.guild.id, 'panel');
  const roleId = config.managerRoleId;
  // The @everyone role shares the guild id and every member has it: never treat it as a manager role.
  if (!roleId || roleId === member.guild.id) return false;
  return member.roles.cache.has(roleId);
}

// True when the member may see and post in the channel. Never throws.
export function memberCanPost(channel, member) {
  try {
    const perms = channel.permissionsFor?.(member);
    return Boolean(perms?.has(['ViewChannel', 'SendMessages']));
  } catch {
    return false;
  }
}
