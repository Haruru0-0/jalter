export const STYLES = ['reactions', 'buttons', 'menu'];
export const TYPES = ['normal', 'unique', 'verify', 'drop', 'reversed', 'binding', 'lock'];
export const MAX_ENTRIES = 20;
export const SELFDESTRUCT_JOB = 'reactionroles.destruct';

const CUSTOM = /^<(a?):(\w{2,32}):(\d{17,20})>$/;
const UNICODE = /^(?:\p{Extended_Pictographic}[️‍\p{Extended_Pictographic}\p{Emoji_Modifier}]*|\p{Regional_Indicator}{2}|[0-9#*]️?⃣)$/u;

/** Parses what staff typed into an emoji: `{ emoji, key }` or `{ error: 'invalid' | 'foreign' }`. */
export function parseEmoji(input, guild) {
  const text = String(input ?? '').trim();
  const custom = CUSTOM.exec(text);
  if (custom) {
    const found = guild?.emojis?.cache?.get(custom[3]);
    if (!found || found.available === false) return { error: 'foreign' };
    return { emoji: text, key: custom[3] };
  }
  if (UNICODE.test(text)) return { emoji: text, key: text };
  return { error: 'invalid' };
}

/** The id of a stored custom emoji, or the Unicode character itself. Matches `reaction.emoji.id ?? reaction.emoji.name`. */
export function emojiKey(stored) {
  const custom = CUSTOM.exec(stored ?? '');
  return custom ? custom[3] : stored;
}

/** A stored emoji in the shape a button or menu option accepts. */
export function componentEmoji(stored) {
  const custom = CUSTOM.exec(stored ?? '');
  return custom ? { id: custom[3], name: custom[2], animated: custom[1] === 'a' } : stored;
}

export function checkEntryInput(style, { emoji, label }) {
  if (style === 'reactions') return emoji ? 'ok' : 'emoji_required';
  return label || emoji ? 'ok' : 'label_required';
}

/** `reversed` needs a "reaction removed" action, which buttons and menus do not have. */
export function typeAllowedForStyle(type, style) {
  return !(type === 'reversed' && style !== 'reactions');
}
