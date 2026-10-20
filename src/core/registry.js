import { getFeature } from '../db/settings.js';

const f = (key, phase, command, extra = {}) => ({
  key, nameKey: `feature.${key}`, phase, command, ...extra,
});

export const FEATURES = [
  f('panel', 1, 'panel', { alwaysOn: true }),
  f('help', 1, 'help', { alwaysOn: true }),
  f('language', 1, 'language', { alwaysOn: true }),
  f('media', 1, 'media', { enableCommand: 'media setup' }),
  f('embeds', 1, 'embed', { alwaysOn: true }),
  f('post', 1, 'post', { alwaysOn: true }),
  f('greet', 1, 'set', { enableCommand: 'set greet channel', commands: ['set', 'test'], byKey: true }),
  f('leave', 1, 'set', { enableCommand: 'set leave channel', commands: ['set', 'test'], byKey: true }),
  f('boost', 1, 'set', { enableCommand: 'set boost channel', commands: ['set', 'test'], byKey: true }),
  f('autorole', 1, 'autorole', { enableCommand: 'autorole add' }),
  f('logging', 1, 'logging', { enableCommand: 'logging set' }),
  f('info', 1, 'info', { commands: ['info', 'userinfo', 'avatar', 'banner', 'serverinfo'] }),
  f('moderation', 2, 'moderation', {
    commands: ['moderation', 'warn', 'warnings', 'timeout', 'untimeout', 'mute', 'unmute', 'kick', 'ban', 'unban', 'reason',
      'purge', 'slowmode', 'lock', 'unlock'],
    enableCommand: 'moderation enable',
  }),
  f('automod', 2, 'automod', { enableCommand: 'automod enable' }),
  f('antiraid', 2, 'antiraid', { enableCommand: 'antiraid enable' }),
  f('verification', 2, 'verification', { enableCommand: 'verification enable' }),
  f('stickyroles', 2, null),
  f('autoresponder', 3, null), f('reactionroles', 3, null), f('quote', 3, null),
  f('leveling', 4, null), f('tickets', 4, null), f('reminders', 4, null),
  f('birthdays', 4, null), f('confessions', 4, null), f('starboard', 4, null),
  f('afk', 4, null), f('statschannels', 4, null),
  f('backup', 5, null), f('translate', 5, null),
];

// The command (without the slash) that turns a feature on and sets it up.
export function setupCommand(feature) {
  return feature.enableCommand ?? `${feature.command ?? feature.key} enable`;
}

export async function isEnabled(db, guildId, key) {
  return (await getFeature(db, guildId, key)).enabled;
}
