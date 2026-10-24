// Placeholders available inside autoresponder scripts: the shared ones plus message-specific extras.
import { buildVars } from '../../../core/placeholders.js';

const EXTRA_NAMES = [
  'user_id', 'user_nick', 'user_joindate', 'user_createdate', 'user_displaycolor', 'user_boostsince',
  'server_id', 'server_boostlevel', 'channel', 'channel_name', 'message_id', 'message_content', 'message_link',
];

const unix = (ms) => Math.floor(ms / 1000);
const dateTag = (ms) => `<t:${unix(ms)}:D>`;

export function buildScriptVars({ message, member = null, guild, lang = 'en', now = Date.now() }) {
  const user = message.author;
  const base = buildVars({ user, member, guild, lang, now });
  const joined = member?.joinedTimestamp;
  const boostSince = member?.premiumSinceTimestamp;
  return {
    ...base,
    user_id: user.id,
    user_nick: member?.nickname ?? member?.displayName ?? user.globalName ?? user.username,
    user_joindate: joined ? dateTag(joined) : '',
    user_createdate: dateTag(user.createdTimestamp ?? now),
    user_displaycolor: member?.displayHexColor ?? '#000000',
    user_boostsince: boostSince ? dateTag(boostSince) : '',
    server_id: guild.id,
    server_boostlevel: guild.premiumTier ?? 0,
    channel: `<#${message.channel?.id ?? message.channelId}>`,
    channel_name: message.channel?.name ?? '',
    message_id: message.id,
    message_content: message.content ?? '',
    message_link: message.url ?? '',
  };
}

// The names buildVars returns, taken from a probe so the two lists cannot drift apart.
const probeUser = { id: '0', username: '', displayAvatarURL: () => '' };
const probeGuild = { name: '', iconURL: () => '', ownerId: '0', createdTimestamp: 0, memberCount: 0 };
export const PLACEHOLDER_NAMES = new Set([
  ...Object.keys(buildVars({ user: probeUser, guild: probeGuild })),
  ...EXTRA_NAMES,
]);
