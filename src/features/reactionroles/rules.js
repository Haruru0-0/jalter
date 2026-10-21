// Pure pick decisions: no Discord, no database. `message` is an RRMessage from store.js.
const entryRoles = (message) => message.entries.map((e) => e.roleId);

// Lock, blacklist, whitelist: the checks that apply to every type, in that order.
function gate(message, memberRoleIds) {
  if (message.type === 'lock') return 'locked';
  if (message.blacklist.some((r) => memberRoleIds.has(r))) return 'blacklisted';
  if (message.whitelist.length && !message.whitelist.some((r) => memberRoleIds.has(r))) return 'not_whitelisted';
  return null;
}

/**
 * One reaction or button pick. `action`: 'add' (reaction added), 'remove' (reaction removed),
 * 'toggle' (button). `clearReaction` tells the caller to remove the member's reaction.
 */
export function decidePick({ message, entry, action, memberRoleIds, binding = null }) {
  const { type } = message;
  // Lock / verify / binding: the staff-owned messages always clear the member's reaction
  // (even on a refusal or a `remove` action), so the toggle can be re-attempted fresh.
  const alwaysClear = type === 'lock' || type === 'verify' || type === 'binding';
  // A reversed message is opt-out: the bot removing the reaction would fire a remove event, which grants the role.
  const keepReaction = type === 'reversed';
  const stop = (reason) => ({ ok: false, reason, clearReaction: alwaysClear || (action === 'add' && !(keepReaction && reason === 'nothing')) });

  const blocked = gate(message, memberRoleIds);
  if (blocked) return stop(blocked);

  const held = memberRoleIds.has(entry.roleId);
  let want;
  if (type === 'verify' || type === 'binding') want = action === 'remove' ? null : 'add';
  else if (type === 'drop') want = action === 'remove' ? null : 'remove';
  else if (action === 'toggle') want = held ? 'remove' : 'add';
  else if (type === 'reversed') want = action === 'add' ? 'remove' : 'add';
  else want = action;

  if (want === 'remove') {
    if (!held) return stop('nothing');
    return { ok: true, add: [], remove: [entry.roleId], clearReaction: alwaysClear || type === 'drop' };
  }
  if (want === 'add') {
    if (held) return stop('nothing');
    if (type === 'binding' && binding) return stop('bound');
    const others = entryRoles(message).filter((r) => r !== entry.roleId && memberRoleIds.has(r));
    const single = type === 'unique' || type === 'binding';
    if (!single && message.limit != null && others.length >= message.limit) return stop('limit');
    return {
      ok: true,
      add: [entry.roleId],
      remove: type === 'unique' ? others : [],
      clearReaction: alwaysClear,
    };
  }
  return stop('nothing');
}

/** A dropdown submission: `selectedRoleIds` is the whole selection. Refused whole or applied whole. */
export function decideMenu({ message, selectedRoleIds, memberRoleIds, binding = null }) {
  const stop = (reason) => ({ ok: false, reason, clearReaction: false });
  const blocked = gate(message, memberRoleIds);
  if (blocked) return stop(blocked);

  const { type } = message;
  const roles = entryRoles(message);
  const selected = new Set(selectedRoleIds.filter((r) => roles.includes(r)));
  const held = roles.filter((r) => memberRoleIds.has(r));
  const single = type === 'unique' || type === 'binding';
  if (single && selected.size > 1) return stop('limit');

  let add = [];
  let remove = [];
  if (type === 'drop') {
    remove = held.filter((r) => selected.has(r));
  } else {
    add = [...selected].filter((r) => !memberRoleIds.has(r));
    if (type === 'normal' || type === 'unique') remove = held.filter((r) => !selected.has(r));
  }
  if (type === 'binding' && binding && add.length) return stop('bound');
  if (!add.length && !remove.length) return stop('nothing');
  if (type !== 'unique' && type !== 'binding' && message.limit != null) {
    if (held.length - remove.length + add.length > message.limit) return stop('limit');
  }
  return { ok: true, add, remove, clearReaction: false };
}
