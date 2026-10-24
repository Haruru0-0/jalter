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

/** ctx = { member, channelId, vars }. Returns a skip Plan or a run Plan. */
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
  return { status: 'run', cooldown, text, flags: compiled.flags, actions: compiled.actions };
}
