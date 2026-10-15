import { EVENTS, categoryOf } from './events.js';

export function isEventEnabled(config, event) {
  return !(config.disabledEvents ?? []).includes(event);
}

export function resolveChannelId(config, event) {
  const channels = config.channels ?? {};
  const category = categoryOf(event);
  if (channels[category]) return channels[category];
  if (category === 'join' && channels.members) return channels.members;
  return channels.default ?? null;
}

export function isIgnored(config, { channelId, userId, content } = {}) {
  const ignore = config.ignore ?? {};
  if (channelId && (ignore.channels ?? []).includes(channelId)) return true;
  if (userId && (ignore.members ?? []).includes(userId)) return true;
  if (typeof content === 'string' && content) {
    return (ignore.prefixes ?? []).some((prefix) => prefix && content.startsWith(prefix));
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
    if (!p.prefixes.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 10)) return null;
    return { disabledEvents: p.disabledEvents, prefixes: p.prefixes };
  } catch {
    return null;
  }
}

export function toggleEvent(config, event, enabled) {
  const all = Object.keys(EVENTS);
  if (event === 'all') return enabled ? [] : all;
  const disabled = new Set(config.disabledEvents ?? []);
  if (enabled) disabled.delete(event);
  else disabled.add(event);
  return [...disabled];
}

function ignoreOf(config) {
  const i = config.ignore ?? {};
  return { channels: [...(i.channels ?? [])], members: [...(i.members ?? [])], prefixes: [...(i.prefixes ?? [])] };
}

export function addIgnore(config, kind, id) {
  const ignore = ignoreOf(config);
  if (!ignore[kind].includes(id)) ignore[kind].push(id);
  return ignore;
}

export function removeIgnore(config, kind, id) {
  const ignore = ignoreOf(config);
  ignore[kind] = ignore[kind].filter((x) => x !== id);
  return ignore;
}

export function setupPlan() {
  return [
    { name: 'log-messages', category: 'messages' },
    { name: 'log-members', category: 'members' },
    { name: 'log-joins', category: 'join' },
    { name: 'log-server', category: 'server' },
    { name: 'log-voice', category: 'voice' },
  ];
}
