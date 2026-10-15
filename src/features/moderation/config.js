export const DEFAULTS = {
  reasonRequired: true,
  dm: true,
  timeoutDefaultSeconds: 600,
  banDeleteDays: 0,
  muteRoleId: null,
  permittedRoles: [],
};
export const MAX_PERMITTED = 10;

const TIMEOUT_MIN = 60;
const TIMEOUT_MAX = 2_419_200;

const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const intIn = (v, min, max, d) => (Number.isInteger(v) && v >= min && v <= max ? v : d);

/** Normalises the raw stored config: defaults for anything missing or invalid. */
export function readConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const roles = Array.isArray(c.permittedRoles)
    ? [...new Set(c.permittedRoles.filter((id) => typeof id === 'string' && id !== ''))].slice(0, MAX_PERMITTED)
    : [];
  return {
    reasonRequired: bool(c.reasonRequired, DEFAULTS.reasonRequired),
    dm: bool(c.dm, DEFAULTS.dm),
    timeoutDefaultSeconds: intIn(c.timeoutDefaultSeconds, TIMEOUT_MIN, TIMEOUT_MAX, DEFAULTS.timeoutDefaultSeconds),
    banDeleteDays: intIn(c.banDeleteDays, 0, 7, DEFAULTS.banDeleteDays),
    muteRoleId: typeof c.muteRoleId === 'string' && c.muteRoleId !== '' ? c.muteRoleId : null,
    permittedRoles: roles,
  };
}

const ok = (config) => ({ ok: true, config });
const fail = (reason) => ({ ok: false, reason });

export function addPermittedRole(config, roleId) {
  const current = readConfig(config);
  if (current.permittedRoles.includes(roleId)) return fail('exists');
  if (current.permittedRoles.length >= MAX_PERMITTED) return fail('full');
  return ok({ ...current, permittedRoles: [...current.permittedRoles, roleId] });
}

export function removePermittedRole(config, roleId) {
  const current = readConfig(config);
  if (!current.permittedRoles.includes(roleId)) return fail('missing');
  return ok({ ...current, permittedRoles: current.permittedRoles.filter((id) => id !== roleId) });
}
