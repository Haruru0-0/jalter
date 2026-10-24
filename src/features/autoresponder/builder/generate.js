// Draft -> script text. Reply text first, then one function per line, so the evaluator's trim drops the line breaks.

const escapeArg = (s) => String(s).replace(/[\\|]/g, (c) => `\\${c}`);

const wrap = (prefix) => (id) => `${prefix}${id}>`;
const role = wrap('<@&');
const channel = wrap('<#');
const user = wrap('<@');

const GATE_ARGS = {
  cooldown: (g) => [String(g.seconds)],
  requirerole: (g) => g.ids.map(role),
  denyrole: (g) => g.ids.map(role),
  requireperm: (g) => g.perms,
  denyperm: (g) => g.perms,
  requirechannel: (g) => g.ids.map(channel),
  denychannel: (g) => g.ids.map(channel),
  requireuser: (g) => g.ids.map(user),
};

// A role action aimed at a typed word: {addrole:<@&id>|[$N]}.
const roleTarget = (a) => (a.target ? `${role(a.id)}|[$${a.target}]` : role(a.id));

// Weights are numbers (percent) or the typed text, so a bad one still reaches the compiler's WEIGHT_INVALID.
const weight = (w) => (typeof w === 'number' ? `${w}%` : escapeArg(w));

const ACTION_ARG = {
  addrole: roleTarget,
  removerole: roleTarget,
  setnick: (a) => escapeArg(a.text),
  react: (a) => escapeArg(a.emoji),
  reactreply: (a) => escapeArg(a.emoji),
};

export function generateScript(d) {
  if (d.mode === 'script') return d.scriptText;
  const calls = [];
  for (const g of d.gates) calls.push(`{${g.fn}:${GATE_ARGS[g.fn](g).join('|')}}`);
  for (const a of d.actions) calls.push(`{${a.fn}:${ACTION_ARG[a.fn](a)}}`);
  if (d.embed) {
    if (d.embed.kind === 'named') calls.push(`{embed:${escapeArg(d.embed.name)}}`);
    else calls.push(d.embed.color ? `{embed:${d.embed.color}}` : '{embed}');
  }
  if (d.dest === 'dm') calls.push('{dm}');
  else if (d.dest === 'channel' && d.channelId) calls.push(`{sendto:${channel(d.channelId)}}`);
  if (d.deleteTrigger) calls.push('{delete}');
  if (d.deleteReplyAfter) calls.push(`{delete_reply:${d.deleteReplyAfter}}`);
  if (d.silent) calls.push('{silent}');
  for (const r of d.random.ranges) calls.push(`{range:${r.min}-${r.max}}`);
  for (const c of d.random.choosers) {
    if (c.kind === 'weighted') calls.push(`{weightedchoose:${c.weights.map(weight).join('|')}}`);
    else calls.push(`{choose:${c.options.map(escapeArg).join('|')}}`);
  }
  for (const values of d.random.locked) calls.push(`{lockedchoose:${values.map(escapeArg).join('|')}}`);
  for (const c of d.argChecks) calls.push(c.type ? `{requirearg:${c.n}|${c.type}}` : `{requirearg:${c.n}}`);
  return [d.text, ...calls].join('\n');
}
