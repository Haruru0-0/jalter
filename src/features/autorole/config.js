export const LIMITS = { roles: 10, blacklist: 25 };
export const MAX_TIMED = 10;

/** Normalises the raw stored config, folding the legacy single-role keys in. */
export function readConfig(config = {}) {
  return {
    roles: config.roles ?? (config.humanRoleId ? [config.humanRoleId] : []),
    botRoles: config.botRoles ?? (config.botRoleId ? [config.botRoleId] : []),
    timed: config.timed ?? [],
    reassign: Boolean(config.reassign),
    blacklist: config.blacklist ?? [],
  };
}

const ok = (config) => ({ ok: true, config });
const fail = (reason) => ({ ok: false, reason });

export function addRole(config, target, roleId) {
  const current = readConfig(config);
  const key = target === 'bots' ? 'botRoles' : 'roles';
  if (current[key].includes(roleId)) return fail('exists');
  if (current[key].length >= LIMITS.roles) return fail('full');
  return ok({ ...current, [key]: [...current[key], roleId] });
}

export function removeRole(config, target, roleId) {
  const current = readConfig(config);
  const keys = target === 'both' ? ['roles', 'botRoles'] : [target === 'bots' ? 'botRoles' : 'roles'];
  if (!keys.some((key) => current[key].includes(roleId))) return fail('missing');
  const next = { ...current };
  for (const key of keys) next[key] = current[key].filter((id) => id !== roleId);
  return ok(next);
}

/** The same role again replaces its delay. */
export function addTimed(config, roleId, seconds) {
  const current = readConfig(config);
  if (current.timed.some((t) => t.roleId === roleId)) {
    return ok({ ...current, timed: current.timed.map((t) => (t.roleId === roleId ? { roleId, seconds } : t)) });
  }
  if (current.timed.length >= MAX_TIMED) return fail('full');
  return ok({ ...current, timed: [...current.timed, { roleId, seconds }] });
}

export function removeTimed(config, roleId) {
  const current = readConfig(config);
  if (!current.timed.some((t) => t.roleId === roleId)) return fail('missing');
  return ok({ ...current, timed: current.timed.filter((t) => t.roleId !== roleId) });
}

export function addBlacklist(config, roleId) {
  const current = readConfig(config);
  if (current.blacklist.includes(roleId)) return fail('exists');
  if (current.blacklist.length >= LIMITS.blacklist) return fail('full');
  return ok({ ...current, blacklist: [...current.blacklist, roleId] });
}

export function removeBlacklist(config, roleId) {
  const current = readConfig(config);
  if (!current.blacklist.includes(roleId)) return fail('missing');
  return ok({ ...current, blacklist: current.blacklist.filter((id) => id !== roleId) });
}

export const setReassign = (config, on) => ({ ...readConfig(config), reassign: Boolean(on) });

/** `@everyone` (role id equals guild id) and managed roles cannot be handed out. */
export const isValidRoleId = (role, guildId) => role.id !== guildId && !role.managed;
