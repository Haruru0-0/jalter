import { canUseAction } from '../moderation/rules.js';

/** True when automod must leave this member / channel alone. Never throws. */
export function isExempt(member, channel, autoConfig, modConfig, managerRoleId) {
  try {
    if (!member) return true;
    if (member.user?.bot) return true;
    if (member.permissions?.has('ManageGuild')) return true;
    const roles = member.roles?.cache;
    const hasRole = (id) => Boolean(id) && Boolean(roles?.has(id));
    // The @everyone role shares the guild id and every member has it: never a manager role.
    if (managerRoleId && managerRoleId !== member.guild?.id && hasRole(managerRoleId)) return true;
    // Moderate Members holders and moderation permittedRoles.
    if (canUseAction(member, 'warn', modConfig)) return true;
    if ((autoConfig?.exemptRoles ?? []).some(hasRole)) return true;
    const channels = autoConfig?.exemptChannels ?? [];
    if (channel && (channels.includes(channel.id) || (channel.parentId && channels.includes(channel.parentId)))) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}
