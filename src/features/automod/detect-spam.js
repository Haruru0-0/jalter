// Spam checks. The tracker keeps a short per-user event history; all time comes from `now`.
import { normalizeText } from './normalize.js';

const CHECKS = ['burst', 'identical', 'caps', 'emoji', 'mentions', 'attachments', 'linkRate'];
const MAX_EVENTS = 500;

const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const PICTO = String.raw`\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier})?[\u{E0020}-\u{E007F}]*`;
const UNICODE_EMOJI = new RegExp(
  String.raw`\p{Regional_Indicator}{2}|[0-9#*]️?⃣|${PICTO}(?:‍${PICTO})*`,
  'gu',
);

/** Counts unicode emoji (a ZWJ sequence, skin tone or flag is one) plus custom `<a?:name:id>` emoji. */
export function countEmoji(text) {
  if (typeof text !== 'string' || !text) return 0;
  const custom = text.match(CUSTOM_EMOJI)?.length ?? 0;
  const rest = text.replace(CUSTOM_EMOJI, ' ');
  return custom + (rest.match(UNICODE_EMOJI)?.length ?? 0);
}

function capsRatio(content) {
  let letters = 0;
  let upper = 0;
  for (const ch of content) {
    if (!/\p{L}/u.test(ch)) continue;
    letters++;
    if (/\p{Lu}/u.test(ch)) upper++;
  }
  return letters ? (upper / letters) * 100 : 0;
}

const on = (c) => c && c.enabled === true;

export function createSpamTracker() {
  /** key `guild:user` -> { events: [{ t, norm, att, links }], keep: ms } */
  const state = new Map();

  function check(msg, cfg, now) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    const norm = normalizeText(content);
    const key = `${msg.guildId}:${msg.userId}`;
    const win = (c) => (Number.isFinite(c?.seconds) ? c.seconds * 1000 : 0);
    const keep = Math.max(win(cfg?.burst), win(cfg?.identical), win(cfg?.attachments), win(cfg?.linkRate));

    let entry = state.get(key);
    if (!entry) {
      entry = { events: [], keep };
      state.set(key, entry);
    }
    entry.keep = Math.max(entry.keep, keep);
    entry.events.push({
      t: now,
      norm,
      att: Number(msg.attachmentCount) || 0,
      links: Number(msg.linkCount) || 0,
    });
    entry.events = entry.events.filter((e) => e.t > now - entry.keep).slice(-MAX_EVENTS);
    const events = entry.events;
    const within = (ms) => events.filter((e) => e.t > now - ms);

    const tripped = [];
    for (const name of CHECKS) {
      const c = cfg?.[name];
      if (!on(c)) continue;
      let hit = false;
      if (name === 'burst') hit = within(win(c)).length > c.messages;
      else if (name === 'identical') {
        if (norm) {
          let run = 0;
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].t <= now - win(c) || events[i].norm !== norm) break;
            run++;
          }
          hit = run >= c.count;
        }
      } else if (name === 'caps') hit = content.length >= c.minLength && capsRatio(content) >= c.percent;
      else if (name === 'emoji') hit = countEmoji(content) > c.max;
      else if (name === 'mentions') hit = (Number(msg.mentionCount) || 0) > c.max;
      else if (name === 'attachments') hit = (Number(msg.attachmentCount) || 0) > 0 && within(win(c)).reduce((n, e) => n + e.att, 0) >= c.count;
      else if (name === 'linkRate') hit = (Number(msg.linkCount) || 0) > 0 && within(win(c)).reduce((n, e) => n + e.links, 0) >= c.count;
      if (hit) tripped.push(name);
    }
    return tripped;
  }

  function prune(now) {
    for (const [key, entry] of state) {
      entry.events = entry.events.filter((e) => e.t > now - entry.keep);
      if (!entry.events.length) state.delete(key);
    }
  }

  return { check, prune, size: () => state.size };
}
