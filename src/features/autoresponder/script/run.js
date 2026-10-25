// Per-message preparation shared by the live listener, `/autoresponder test` and the builder's Try it, so all
// three behave identically: the member's words, the one random drawing and the argument type checks.
import { ESCAPED_BRACKET } from './parse.js';
import { parseWords, renderArgsInText, checkArgType, mentionCheckedUsers, nicknameWords } from './args.js';
import { drawRandom, renderRand } from './random.js';
import { triggerRemainder } from '../match.js';

const unescape = (v) => (typeof v === 'string' ? v.replaceAll(ESCAPED_BRACKET, '[') : v);
const ARG_TOKEN = /\[\$(?:[1-9]|1\d|20)(?:\+|-(?:[1-9]|1\d|20))?\]/;

const hasRandom = (r) => Boolean(r && (r.ranges?.length || r.choosers?.length || r.locked?.length));
// Does anything in the rule read the member's words? (A role target always comes with a `requirearg`.)
const needsWords = (c) => Boolean(c.argChecks?.length)
  || c.template.some((p) => p.t === 'arg')
  || c.actions.some((a) => a.target != null || (a.fn === 'setnick' && ARG_TOKEN.test(a.text ?? '')));

/**
 * Words after the trigger, the random draws (once per message) and every `requirearg` check result.
 * Resolves to { words, nickWords, draws, nickDraws, argResults } (nickWords: a checked user word as the member's display name, for {setnick}) with argResults a map N -> checkArgType result.
 * A version 1 compiled object, or a version 2 one that uses no random value and no word, takes the fast path:
 * empty words and draws, no remainder search, no rng call and no guild read.
 * Words checked as a `user` are written as `<@id>` (mentionCheckedUsers). Chooser options and locked values
 * then get their `[$N]` tokens rendered with those words; they hold the escaped-bracket sentinel, which
 * renderArgsInText maps back to `[` after the tokens, so `\[$1]` stays literal and a value reads the same
 * wherever it is rendered. The rendered member words are never scanned again.
 */
export async function prepareRun({ compiled, rule, text, guild, rng = Math.random }) {
  const argResults = {};
  if (!compiled?.template || !compiled.actions || (!hasRandom(compiled.random) && !needsWords(compiled))) {
    const empty = parseWords('');
    const draws = drawRandom(null, rng);
    return { words: empty, nickWords: empty, draws, nickDraws: draws, argResults };
  }
  const typed = parseWords(triggerRemainder(rule, text) ?? '');
  const draws = drawRandom(compiled.random, rng);
  for (const { n, type } of compiled.argChecks ?? []) {
    argResults[n] = await checkArgType(type ?? null, typed.list[n - 1], guild);
  }
  const words = mentionCheckedUsers(typed, compiled.argChecks, argResults);
  const nickWords = nicknameWords(typed, compiled.argChecks, argResults);
  const renderWith = (w) => (v) => (typeof v === 'string' ? renderArgsInText(v, w) : v);
  const raw = { choice: draws.choice, lockedchoice: draws.lockedchoice };
  // The same picks, rendered for a nickname: a checked user word inside an option is the display name there.
  const nickDraws = { ...draws, choice: raw.choice.map(renderWith(nickWords)), lockedchoice: raw.lockedchoice.map(renderWith(nickWords)) };
  draws.choice = raw.choice.map(renderWith(words));
  draws.lockedchoice = raw.lockedchoice.map(renderWith(words));
  return { words, nickWords, draws, nickDraws, argResults };
}

// Argument tokens, random tokens and {placeholders} in one pass, so a value that was substituted is never scanned again.
const TOKENS = /(\[\$(?:[1-9]|1\d|20)(?:\+|-(?:[1-9]|1\d|20))?\]|\[(?:range|choice|lockedchoice)[2-4]?\]|\{[a-z_]+\})/;
const RAND = /^\[(range|choice|lockedchoice)([2-4])?\]$/;

/**
 * Renders a setnick text: argument tokens, random tokens (same `draws` as the reply text) and placeholders.
 * A random token with no matching draw stays as typed.
 */
export function renderScriptText(text, { words, draws, vars = {} }) {
  const w = words ?? parseWords('');
  return String(text ?? '')
    .split(TOKENS)
    .map((piece, i) => {
      if (i % 2 === 0) return unescape(piece);
      if (piece.startsWith('[$')) return renderArgsInText(piece, w);
      if (piece.startsWith('{')) {
        const key = piece.slice(1, -1);
        return Object.hasOwn(vars, key) && vars[key] !== undefined ? String(vars[key]) : piece;
      }
      const m = RAND.exec(piece);
      const token = { kind: m[1], n: m[2] ? Number(m[2]) : 1 };
      return (draws?.[token.kind]?.length ?? 0) >= token.n ? renderRand(token, draws) : piece;
    })
    .join('');
}
