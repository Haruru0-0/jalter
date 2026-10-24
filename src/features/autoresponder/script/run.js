// Per-message preparation shared by the live listener, `/autoresponder test` and the builder's Try it, so all
// three behave identically: the member's words, the one random drawing and the argument type checks.
import { ESCAPED_BRACKET } from './parse.js';
import { parseWords, renderArgsInText, checkArgType } from './args.js';
import { drawRandom, renderRand } from './random.js';
import { triggerRemainder } from '../match.js';

const unescape = (v) => (typeof v === 'string' ? v.replaceAll(ESCAPED_BRACKET, '[') : v);

/**
 * Words after the trigger, the random draws (once per message) and every `requirearg` check result.
 * Resolves to { words, draws, argResults } with argResults a map N -> checkArgType result.
 * A version 1 compiled object (no `random`, no `argChecks`) gets empty words and draws.
 * Chooser options and locked values hold the escaped-bracket sentinel; it is mapped back to `[` here, so a
 * drawn value reads the same wherever it is rendered.
 */
export async function prepareRun({ compiled, rule, text, guild, rng = Math.random }) {
  const argResults = {};
  if (!compiled || (!compiled.random && !compiled.argChecks)) {
    return { words: parseWords(''), draws: drawRandom(null, rng), argResults };
  }
  const words = parseWords(triggerRemainder(rule, text) ?? '');
  const draws = drawRandom(compiled.random, rng);
  draws.choice = draws.choice.map(unescape);
  draws.lockedchoice = draws.lockedchoice.map(unescape);
  for (const { n, type } of compiled.argChecks ?? []) {
    argResults[n] = await checkArgType(type ?? null, words.list[n - 1], guild);
  }
  return { words, draws, argResults };
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
