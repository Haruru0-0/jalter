// Shared role-safety checks: used wherever a command chooses a role the bot will hand out later.
// A role the bot hands out must never carry staff power: whoever can pick it could escalate privileges.
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
