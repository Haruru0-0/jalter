export function safeMentions(roleIds = []) {
  return roleIds.length ? { parse: [], roles: roleIds } : { parse: [] };
}

export function extractRoleIds(text) {
  return [...text.matchAll(/<@&(\d+)>/g)].map((m) => m[1]);
}
