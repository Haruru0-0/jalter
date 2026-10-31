// Autoresponder script compiler: source text -> JSON-safe Compiled, or every error found.
// Two passes: the first collects every function into the accumulator, the second resolves the template's
// `rand`/`arg` tokens and role targets against the whole script, so the order of functions never matters.
import { parseScript, PARSE_ERROR_CODES, ESCAPED_BRACKET } from './parse.js';
import { PLACEHOLDER_NAMES } from './placeholders.js';
import { FUNCTIONS, WORD_MODES } from './functions.js';

export const MAX_SCRIPT = 4000;

export const COMPILE_ERROR_CODES = [
  ...PARSE_ERROR_CODES,
  'UNKNOWN_FUNCTION', 'MISSING_ARGUMENT', 'BAD_ARGUMENT', 'TOO_MANY_ARGUMENTS', 'DUPLICATE_FUNCTION',
  'COOLDOWN_RANGE', 'DELETE_REPLY_RANGE', 'TOO_MANY_EMBEDS', 'TOO_MANY_REACTIONS', 'TOO_MANY_ROLE_ACTIONS',
  'ROLE_NOT_FOUND', 'ROLE_AMBIGUOUS', 'ROLE_DANGEROUS', 'ROLE_ABOVE_BOT', 'ROLE_ABOVE_YOU',
  'CHANNEL_NOT_FOUND', 'EMBED_NOT_FOUND', 'INVALID_PERMISSION', 'INVALID_USER', 'INVALID_EMOJI',
  'NICK_TOO_LONG', 'TARGET_NOT_ALLOWED_YET', 'SCRIPT_TOO_LONG',
  'RANGE_INVALID', 'WEIGHT_INVALID', 'TOO_MANY_RANDOM', 'CHOICE_COUNT_MISMATCH', 'CHOICE_NOT_CHOSEN_YET',
  'ARG_INDEX_INVALID', 'ARG_TYPE_INVALID', 'NO_ARGUMENTS_IN_MODE', 'TARGET_NOT_CHECKED_USER', 'TARGET_NEEDS_GATE',
  'BUTTON_NOT_FOUND', 'LINK_URL_INVALID', 'TOO_MANY_BUTTONS', 'BUTTONS_NEED_CHANNEL', 'BUTTONS_NEED_TEXT', 'BUTTON_NAME_INVALID',
];

const err = (code, pos, detail) => (detail === undefined ? { code, pos } : { code, pos, detail });
const ARG_TOKEN_IN_TEXT = /\[\$(?:[1-9]|1\d|20)(?:\+|-(?:[1-9]|1\d|20))?\]/;
const plain = (s) => s.replaceAll(ESCAPED_BRACKET, '[');

// A `rand` token is live only when the script defines the function that produces it.
function randIsLive(token, random, buttonScript) {
  // A button's own script draws at press time, so its tokens are always live.
  if (buttonScript) return true;
  const defined = { range: random.ranges, choice: random.choosers, lockedchoice: random.locked }[token.kind];
  return token.n <= defined.length;
}

/**
 * env = { db, guild, writer, matchMode?, buttonScript? } (no matchMode: unknown, no mode errors;
 * buttonScript: a stored button's own script, its words come from the original message so matchMode is ignored).
 * Resolves to { ok: true, compiled, warnings } or { ok: false, errors }.
 */
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
    random: { ranges: [], choosers: [], locked: [] },
    argChecks: [],
    targets: [],
    lockedPos: [],
    buttons: [],
    buttonPos: null,
    pos: 0,
  };
  const errors = [];
  const warnings = [];
  const noWords = Boolean(env.matchMode) && !env.buttonScript && !WORD_MODES.has(env.matchMode);
  const warnArgs = (pos) => {
    if (noWords && warnings.length === 0) warnings.push({ code: 'ARGS_EMPTY_IN_MODE', pos });
  };

  // Pass 1: functions.
  for (const node of parsed.nodes) {
    if (node.t === 'arg') warnArgs(node.pos);
    if (node.t !== 'call') continue;
    if (node.args.length === 0 && PLACEHOLDER_NAMES.has(node.name)) continue;
    const fn = Object.hasOwn(FUNCTIONS, node.name) ? FUNCTIONS[node.name] : null;
    if (!fn) {
      errors.push(err('UNKNOWN_FUNCTION', node.pos, node.name));
      continue;
    }
    // `{name:}` carries one empty argument: it counts as no argument.
    const raw = node.args.length === 1 && node.args[0] === '' ? [] : node.args;
    if (raw.length < fn.min) {
      errors.push(err('MISSING_ARGUMENT', node.pos, node.name));
      continue;
    }
    if (raw.length > fn.max) {
      errors.push(err('TOO_MANY_ARGUMENTS', node.pos, node.name));
      continue;
    }
    if (raw.some((a) => ARG_TOKEN_IN_TEXT.test(a))) warnArgs(node.pos);
    // Functions that keep the escaped-bracket sentinel render it themselves; the rest resolve a plain `[`.
    const args = fn.keepEscapes ? raw : raw.map(plain);
    acc.pos = node.pos;
    for (const e of await fn.check(args, env, acc)) errors.push(err(e.code, node.pos, e.detail));
  }

  // Pass 2: pairing and whole-script checks.
  acc.random.locked.forEach((values, k) => {
    const partner = acc.random.choosers[k];
    if (!partner) {
      errors.push(err('CHOICE_NOT_CHOSEN_YET', acc.lockedPos[k]));
      return;
    }
    const count = partner.kind === 'weighted' ? partner.weights.length : partner.options.length;
    if (count !== values.length) errors.push(err('CHOICE_COUNT_MISMATCH', acc.lockedPos[k], `${values.length}/${count}`));
  });
  for (const target of acc.targets) {
    const checked = acc.argChecks.some((c) => c.n === target.n && c.type === 'user');
    if (!checked) {
      errors.push(err('TARGET_NOT_CHECKED_USER', target.pos, `[$${target.n}]`));
      continue;
    }
    if (!acc.gates.some((g) => g.fn === 'requirerole' || g.fn === 'requireperm')) {
      errors.push(err('TARGET_NEEDS_GATE', target.pos));
    }
  }

  const template = [];
  const pushText = (v) => {
    const last = template[template.length - 1];
    if (last?.t === 'text') last.v += v;
    else template.push({ t: 'text', v });
  };
  for (const node of parsed.nodes) {
    if (node.t === 'text') pushText(node.v);
    else if (node.t === 'arg') template.push({ t: 'arg', from: node.from, to: node.to });
    else if (node.t === 'rand') {
      if (randIsLive(node, acc.random, env.buttonScript)) template.push({ t: 'rand', kind: node.kind, n: node.n });
      else pushText(node.raw);
    } else if (node.args.length === 0 && PLACEHOLDER_NAMES.has(node.name)) template.push({ t: 'ph', name: node.name });
  }

  if (acc.buttons.length) {
    if (acc.flags.dm) errors.push(err('BUTTONS_NEED_CHANNEL', acc.buttonPos));
    const hasText = template.some((p) => p.t !== 'text' || p.v.trim() !== '') || acc.flags.embed !== null;
    if (!hasText) errors.push(err('BUTTONS_NEED_TEXT', acc.buttonPos));
  }

  if (errors.length) return { ok: false, errors: errors.sort((a, b) => a.pos - b.pos) };
  return {
    ok: true,
    warnings,
    compiled: {
      version: 2,
      template,
      gates: acc.gates,
      actions: acc.actions,
      flags: acc.flags,
      random: acc.random,
      argChecks: acc.argChecks,
      ...(acc.buttons.length ? { buttons: acc.buttons } : {}),
    },
  };
}
