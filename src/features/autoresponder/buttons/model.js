import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export const STYLES = {
  blue: ButtonStyle.Primary,
  green: ButtonStyle.Success,
  grey: ButtonStyle.Secondary,
  red: ButtonStyle.Danger,
};
export const LIMITATIONS = ['none', 'limited', 'strict'];

const PREFIX = 'autoresponder:p';
const NAME = /^[a-z0-9_-]{1,16}$/;
const MAX_LABEL = 80;
const MAX_ROWS = 5;
const PER_ROW = 5;

export function checkButtonInput({ name, label, style, limitations }) {
  if (typeof name !== 'string' || !NAME.test(name)) return { ok: false, code: 'BUTTON_NAME_INVALID' };
  if (typeof label !== 'string' || !label.trim() || label.length > MAX_LABEL) return { ok: false, code: 'BUTTON_LABEL_INVALID' };
  if (!Object.hasOwn(STYLES, style)) return { ok: false, code: 'BUTTON_STYLE_INVALID' };
  if (!LIMITATIONS.includes(limitations)) return { ok: false, code: 'BUTTON_LIMITATION_INVALID' };
  return { ok: true };
}

export const buttonId = (messageId, index) => `${PREFIX}:${messageId}:${index}`;

export function parseButtonId(customId) {
  if (typeof customId !== 'string') return null;
  const m = /^autoresponder:p:(\d+):(\d+)$/.exec(customId);
  return m ? { messageId: m[1], index: Number(m[2]) } : null;
}

/**
 * Action rows for a posted message (5 per row, 25 buttons at most).
 * entries: [{ kind: 'stored', name, label, emoji, style } | { kind: 'link', label, url, emoji }].
 * `parseEmoji` turns a stored emoji into what ButtonBuilder#setEmoji accepts.
 */
export function buildRows(messageId, entries, state, parseEmoji) {
  const pressed = new Set(state?.pressed ?? []);
  const rows = [];
  const capped = entries.slice(0, MAX_ROWS * PER_ROW);
  for (let i = 0; i < capped.length; i += PER_ROW) {
    const row = new ActionRowBuilder();
    row.addComponents(capped.slice(i, i + PER_ROW).map((e, j) => {
      const b = new ButtonBuilder().setLabel(String(e.label ?? '').slice(0, MAX_LABEL) || '-');
      if (e.kind === 'link') b.setStyle(ButtonStyle.Link).setURL(e.url);
      else {
        b.setStyle(STYLES[e.style] ?? ButtonStyle.Secondary)
          .setCustomId(buttonId(messageId, i + j))
          .setDisabled(Boolean(state?.locked) || pressed.has(i + j));
      }
      if (e.emoji) b.setEmoji(parseEmoji(e.emoji));
      return b;
    }));
    rows.push(row);
  }
  return rows;
}

const THROTTLE_MAX = 10_000;

/** In-memory floor: one press per presser per message every `everyMs`. Bounded. */
export function createPressThrottle(everyMs = 3000) {
  const last = new Map();
  return {
    /** true when the press may go ahead (and records it), false when it came too soon. */
    check(messageId, presserId, now = Date.now()) {
      const key = `${messageId}:${presserId}`;
      const prev = last.get(key);
      if (prev !== undefined && now - prev < everyMs) return false;
      if (last.size >= THROTTLE_MAX) {
        for (const [k, t] of last) if (now - t >= everyMs) last.delete(k);
        while (last.size >= THROTTLE_MAX) last.delete(last.keys().next().value);
      }
      last.delete(key);
      last.set(key, now);
      return true;
    },
    size: () => last.size,
  };
}

/** Pure: may this presser go ahead? The record and button are already loaded. */
export function pressDecision({ record, button, presserId, now, throttle }) {
  if (record.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (button?.invokerOnly && presserId !== record.invokerId) return { ok: false, reason: 'invoker' };
  if (throttle && !throttle.check(record.messageId, presserId, now)) return { ok: false, reason: 'slow' };
  return { ok: true };
}
