import { EVENTS } from './events.js';

export function isEventEnabled(config, event) {
  return !(config.disabledEvents ?? []).includes(event);
}

export function resolveChannelId(config, event) {
  const channels = config.channels ?? {};
  const category = EVENTS[event];
  if (channels[category]) return channels[category];
  if (category === 'join' && channels.members) return channels.members;
  return channels.default ?? null;
}

export function isIgnored(config, { channelId, userId, content } = {}) {
  const ignore = config.ignore ?? {};
  if (channelId && (ignore.channels ?? []).includes(channelId)) return true;
  if (userId && (ignore.members ?? []).includes(userId)) return true;
  if (typeof content === 'string' && content) {
    return (ignore.prefixes ?? []).some((prefix) => content.startsWith(prefix));
  }
  return false;
}

export function encodeSettings(config) {
  const payload = {
    v: 1,
    disabledEvents: config.disabledEvents ?? [],
    prefixes: config.ignore?.prefixes ?? [],
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeSettings(code) {
  if (typeof code !== 'string' || code.length > 2000) return null;
  try {
    const p = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'));
    if (p?.v !== 1 || !Array.isArray(p.disabledEvents) || !Array.isArray(p.prefixes)) return null;
    if (!p.disabledEvents.every((e) => Object.hasOwn(EVENTS, e))) return null;
    if (!p.prefixes.every((x) => typeof x === 'string' && x.length <= 10)) return null;
    return { disabledEvents: p.disabledEvents, prefixes: p.prefixes };
  } catch {
    return null;
  }
}
