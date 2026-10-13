import { getFeature } from '../db/settings.js';

export async function canManage(db, member) {
  if (member.permissions.has('ManageGuild')) return true;
  const { config } = await getFeature(db, member.guild.id, 'panel');
  return Boolean(config.managerRoleId) && member.roles.cache.has(config.managerRoleId);
}
