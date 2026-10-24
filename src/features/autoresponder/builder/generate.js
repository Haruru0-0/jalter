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

const ACTION_ARG = {
  addrole: (a) => role(a.id),
  removerole: (a) => role(a.id),
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
  return [d.text, ...calls].join('\n');
}
