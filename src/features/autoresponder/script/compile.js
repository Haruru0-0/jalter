// Autoresponder script compiler: source text -> JSON-safe Compiled, or every error found.
import { parseScript, PARSE_ERROR_CODES } from './parse.js';
import { PLACEHOLDER_NAMES } from './placeholders.js';
import { FUNCTIONS } from './functions.js';

export const MAX_SCRIPT = 4000;

export const COMPILE_ERROR_CODES = [
  ...PARSE_ERROR_CODES,
  'UNKNOWN_FUNCTION', 'MISSING_ARGUMENT', 'BAD_ARGUMENT', 'TOO_MANY_ARGUMENTS', 'DUPLICATE_FUNCTION',
  'COOLDOWN_RANGE', 'DELETE_REPLY_RANGE', 'TOO_MANY_EMBEDS', 'TOO_MANY_REACTIONS', 'TOO_MANY_ROLE_ACTIONS',
  'ROLE_NOT_FOUND', 'ROLE_AMBIGUOUS', 'ROLE_DANGEROUS', 'ROLE_ABOVE_BOT', 'ROLE_ABOVE_YOU',
  'CHANNEL_NOT_FOUND', 'EMBED_NOT_FOUND', 'INVALID_PERMISSION', 'INVALID_USER', 'INVALID_EMOJI',
  'NICK_TOO_LONG', 'TARGET_NOT_ALLOWED_YET', 'SCRIPT_TOO_LONG',
];

const err = (code, pos, detail) => (detail === undefined ? { code, pos } : { code, pos, detail });

/** env = { db, guild, writer }. Resolves to { ok: true, compiled } or { ok: false, errors }. */
export async function compileScript(source, env) {
  const src = typeof source === 'string' ? source : '';
  if (src.length > MAX_SCRIPT) return { ok: false, errors: [err('SCRIPT_TOO_LONG', 0, String(MAX_SCRIPT))] };
  const parsed = parseScript(src);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const acc = {
    gates: [],
    actions: [],
    seen: new Set(),
    roleActions: 0,
    reactions: 0,
    flags: { silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null },
  };
  const template = [];
  const errors = [];

  for (const node of parsed.nodes) {
    if (node.t === 'text') {
      const last = template[template.length - 1];
      if (last?.t === 'text') last.v += node.v;
      else template.push({ t: 'text', v: node.v });
      continue;
    }
    if (node.args.length === 0 && PLACEHOLDER_NAMES.has(node.name)) {
      template.push({ t: 'ph', name: node.name });
      continue;
    }
    const fn = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : null;
    if (!fn) {
      errors.push(err('UNKNOWN_FUNCTION', node.pos, node.name));
      continue;
    }
    // `{name:}` carries one empty argument: it counts as no argument.
    const args = node.args.length === 1 && node.args[0] === '' ? [] : node.args;
    if (args.length < fn.min) {
      errors.push(err('MISSING_ARGUMENT', node.pos, node.name));
      continue;
    }
    if (args.length > fn.max) {
      errors.push(err('TOO_MANY_ARGUMENTS', node.pos, node.name));
      continue;
    }
    for (const e of await fn.check(args, env, acc)) errors.push(err(e.code, node.pos, e.detail));
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    compiled: { version: 1, template, gates: acc.gates, actions: acc.actions, flags: acc.flags },
  };
}
