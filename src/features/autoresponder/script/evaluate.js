// Autoresponder script evaluator: pure function from Compiled + context to a Plan (no Discord, no DB).
import { parseWords, renderArg } from './args.js';
import { renderRand } from './random.js';

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
// Argument tokens the member typed never ping, except words the script checked as a `user` (argResults[n].id).
function allowedUsers(template, { member, vars }, compiled, argResults) {
  const ids = new Set();
  for (const part of template) {
    if (part.t === 'text') {
      for (const m of part.v.matchAll(USER_MENTION)) ids.add(m[1]);
    } else if (part.t === 'arg') {
      for (const c of compiled.argChecks ?? []) {
        const id = argResults?.[c.n]?.id;
        const covered = c.n >= part.from && (part.to === 'end' || c.n <= part.to);
        if (c.type === 'user' && covered && id && argResults[c.n].ok) ids.add(id);
      }
    } else if (part.name === 'user' && member?.id) {
      ids.add(member.id);
    } else if (part.name === 'server_owner') {
      const m = /^<@!?(\d+)>$/.exec(String(vars?.server_owner ?? ''));
      if (m) ids.add(m[1]);
    }
  }
  return [...ids];
}

const renderPart = (part, { vars, words, draws }) => {
  if (part.t === 'text') return part.v;
  if (part.t === 'arg') return renderArg(part, words);
  if (part.t === 'rand') return renderRand(part, draws);
  return String(vars?.[part.name] ?? '');
};

/**
 * ctx = { member, channelId, vars, words?, draws?, argResults? } (the last three come from prepareRun and are
 * absent for a version 1 rule). Returns a skip Plan or a run Plan (allowedUsers: ids the reply may ping).
 * Gate order: the script's gates in order, first failure wins; the `requirearg` checks come after all of them.
 */
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
  const words = ctx.words ?? parseWords('');
  const draws = ctx.draws ?? null;
  const argResults = ctx.argResults ?? {};
  for (const { n, type } of compiled.argChecks ?? []) {
    const present = words.list[n - 1] !== undefined;
    const ok = present && (type == null || argResults[n]?.ok === true);
    if (!ok) return { status: 'skip', gate: 'arg', notice: !compiled.flags.silent, arg: { n, type: type ?? null } };
  }
  const text = compiled.template.map((part) => renderPart(part, { vars: ctx.vars, words, draws })).join('').trim();
  const actions = compiled.actions.map((a) => (a.target != null ? { ...a, targetId: argResults[a.target]?.id ?? null } : a));
  return {
    status: 'run', cooldown, text, flags: compiled.flags, actions,
    allowedUsers: allowedUsers(compiled.template, ctx, compiled, argResults),
    ...(compiled.version >= 2 ? { v2: true, words, draws } : {}),
  };
}
