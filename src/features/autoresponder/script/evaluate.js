// Autoresponder script evaluator: pure function from Compiled + context to a Plan (no Discord, no DB).

const GATE_KIND = {
  requirerole: 'role', denyrole: 'role',
  requireperm: 'perm', denyperm: 'perm',
  requirechannel: 'channel', denychannel: 'channel',
  requireuser: 'user',
};

function matchesAny(gate, { member, channelId }) {
  switch (gate.fn) {
    case 'requirerole':
    case 'denyrole':
      return gate.roleIds.some((id) => member.roles.cache.has(id));
    case 'requireperm':
    case 'denyperm':
      return gate.perms.some((p) => member.permissions.has(p));
    case 'requirechannel':
    case 'denychannel':
      return gate.channelIds.includes(channelId);
    case 'requireuser':
      return gate.userIds.includes(member.id);
    default:
      return true;
  }
}

const USER_MENTION = /<@!?(\d+)>/g;

// Who the reply may ping: only users the script writer chose. That is the user mentions typed in
// the script's own text, the triggering member through {user}, and the owner through {server_owner}.
// A mention inside a member-controlled value ({message_content}, a name...) never pings.
function allowedUsers(template, { member, vars }) {
  const ids = new Set();
  for (const part of template) {
    if (part.t === 'text') {
      for (const m of part.v.matchAll(USER_MENTION)) ids.add(m[1]);
    } else if (part.name === 'user' && member?.id) {
      ids.add(member.id);
    } else if (part.name === 'server_owner') {
      const m = /^<@!?(\d+)>$/.exec(String(vars?.server_owner ?? ''));
      if (m) ids.add(m[1]);
    }
  }
  return [...ids];
}

/** ctx = { member, channelId, vars }. Returns a skip Plan or a run Plan (allowedUsers: ids the reply may ping). */
export function evaluate(compiled, ctx) {
  let cooldown = null;
  for (const gate of compiled.gates) {
    if (gate.fn === 'cooldown') {
      cooldown = gate.seconds;
      continue;
    }
    const kind = GATE_KIND[gate.fn];
    if (!kind) continue;
    const matched = matchesAny(gate, ctx);
    const passed = gate.fn.startsWith('require') ? matched : !matched;
    if (!passed) {
      return { status: 'skip', gate: kind, notice: gate.fn === 'requirerole' && !compiled.flags.silent };
    }
  }
  const text = compiled.template
    .map((part) => (part.t === 'text' ? part.v : String(ctx.vars?.[part.name] ?? '')))
    .join('')
    .trim();
  return {
    status: 'run', cooldown, text, flags: compiled.flags, actions: compiled.actions,
    allowedUsers: allowedUsers(compiled.template, ctx),
  };
}
