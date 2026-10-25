// The member's words after the trigger, and argument type checks. Pure except checkArgType (guild reads).
import { ESCAPED_BRACKET } from './parse.js';

export const MAX_ARG_INDEX = 20;

/** Split the remainder into words, keeping the original text so `rest(n)` preserves spacing. */
export function parseWords(remainder) {
  const text = typeof remainder === 'string' ? remainder : '';
  const list = [];
  const starts = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    list.push(m[0]);
    starts.push(m.index);
  }
  return {
    list,
    text,
    starts,
    rest(n) {
      const i = Math.floor(Number(n)) - 1;
      if (!(i >= 0) || i >= list.length) return '';
      return text.slice(starts[i]).trimEnd();
    },
  };
}

/**
 * Words with every word that passed a `user` check written as `<@id>` (a bare id or `<@!id>` becomes a
 * mention). Only the display changes: pings still come from evaluate's allowedUsers alone, and a word that was
 * not checked as a user stays exactly as typed. Spacing between words is kept.
 */
export function mentionCheckedUsers(words, argChecks, argResults) {
  const swaps = new Map();
  for (const { n, type } of argChecks ?? []) {
    const r = argResults?.[n];
    if (type === 'user' && r?.ok === true && r.id && words.list[n - 1] !== undefined) swaps.set(n - 1, `<@${r.id}>`);
  }
  if (!swaps.size) return words;
  let out = '';
  let pos = 0;
  words.list.forEach((w, i) => {
    out += words.text.slice(pos, words.starts[i]) + (swaps.get(i) ?? w);
    pos = words.starts[i] + w.length;
  });
  return parseWords(out + words.text.slice(pos));
}

/**
 * Words for a nickname: every word checked as a `user` is replaced by that member's display name (the typed word
 * when there is none), because Discord does not resolve mentions in a nickname. The name is member-controlled, so
 * the escape sentinel is dropped from it; renderArgsInText inserts it in one pass and never rescans it.
 */
export function nicknameWords(words, argChecks, argResults) {
  const swaps = new Map();
  for (const { n, type } of argChecks ?? []) {
    const r = argResults?.[n];
    if (type !== 'user' || r?.ok !== true || words.list[n - 1] === undefined) continue;
    const name = String(r.name ?? '').replaceAll(ESCAPED_BRACKET, '');
    swaps.set(n - 1, name || words.list[n - 1]);
  }
  if (!swaps.size) return words;
  // Built directly, not re-split: a display name may hold spaces and must stay one word.
  const list = [];
  const starts = [];
  let text = '';
  let pos = 0;
  words.list.forEach((w, i) => {
    text += words.text.slice(pos, words.starts[i]);
    const word = swaps.get(i) ?? w;
    list.push(word);
    starts.push(text.length);
    text += word;
    pos = words.starts[i] + w.length;
  });
  text += words.text.slice(pos);
  return {
    list,
    text,
    starts,
    rest(n) {
      const i = Math.floor(Number(n)) - 1;
      if (!(i >= 0) || i >= list.length) return '';
      return text.slice(starts[i]).trimEnd();
    },
  };
}

/** Text for an `arg` token. */
export function renderArg(token, words) {
  if (token.to === 'end') return words.rest(token.from);
  if (token.to === token.from) return words.list[token.from - 1] ?? '';
  return words.list.slice(token.from - 1, token.to).join(' ');
}

const ARG_IN_TEXT = /\[\$([1-9]|1\d|20)(?:(\+)|-([1-9]|1\d|20))?\]/g;

/** Render `[$...]` tokens inside an argument string; the escaped-bracket sentinel becomes `[`. */
export function renderArgsInText(text, words) {
  return String(text ?? '')
    .replace(ARG_IN_TEXT, (raw, a, plus, b) => {
      const from = Number(a);
      if (plus) return renderArg({ from, to: 'end' }, words);
      if (b) {
        const to = Number(b);
        if (to < from) return raw;
        return renderArg({ from, to }, words);
      }
      return renderArg({ from, to: from }, words);
    })
    .replaceAll(ESCAPED_BRACKET, '[');
}

const ID = '(\\d{17,20})';
const USER_RE = new RegExp(`^(?:<@!?${ID}>|${ID})$`);
const CHANNEL_RE = new RegExp(`^(?:<#${ID}>|${ID})$`);
const ROLE_RE = new RegExp(`^(?:<@&${ID}>|${ID})$`);
const idOf = (re, word) => {
  const m = re.exec(word);
  return m ? (m[1] ?? m[2]) : null;
};

/** Does `word` satisfy `type`? `null` type: the word merely exists. */
export async function checkArgType(type, word, guild) {
  if (typeof word !== 'string' || word === '') return { ok: false };
  switch (type) {
    case null:
    case undefined:
      return { ok: true };
    case 'number':
      return { ok: /^-?\d+(\.\d+)?$/.test(word) };
    case 'color':
      return { ok: /^#[0-9a-fA-F]{6}$/.test(word) };
    case 'user': {
      const id = idOf(USER_RE, word);
      if (!id) return { ok: false };
      try {
        const member = await guild?.members?.fetch(id);
        return member ? { ok: true, id, name: typeof member.displayName === 'string' ? member.displayName : '' } : { ok: false };
      } catch {
        return { ok: false };
      }
    }
    case 'channel': {
      const id = idOf(CHANNEL_RE, word);
      return id && guild?.channels?.cache?.get(id) ? { ok: true, id } : { ok: false };
    }
    case 'role': {
      const id = idOf(ROLE_RE, word);
      return id && guild?.roles?.cache?.get(id) ? { ok: true, id } : { ok: false };
    }
    default:
      return { ok: false };
  }
}
