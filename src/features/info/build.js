import { t } from '../../i18n/index.js';

const stamp = (ms) => `<t:${Math.floor(ms / 1000)}:D> (<t:${Math.floor(ms / 1000)}:R>)`;

const FIELD_MAX = 1024;

function rolesField(member, lang) {
  const mentions = [...member.roles.cache.values()]
    .filter((r) => r.name !== '@everyone')
    .map((r) => `<@&${r.id}>`);
  if (!mentions.length) return '—';
  const whole = mentions.join(' ');
  if (whole.length <= FIELD_MAX) return whole;
  let kept = [];
  let len = 0;
  for (let i = 0; i < mentions.length; i++) {
    const suffix = ' ' + t(lang, 'info.rolesMore', { count: mentions.length - i });
    if (len + (kept.length ? 1 : 0) + mentions[i].length + suffix.length > FIELD_MAX) break;
    len += (kept.length ? 1 : 0) + mentions[i].length;
    kept.push(mentions[i]);
  }
  return `${kept.join(' ')} ${t(lang, 'info.rolesMore', { count: mentions.length - kept.length })}`;
}

export function buildServerInfo(guild, lang) {
  return {
    title: guild.name,
    fields: [
      { name: t(lang, 'info.members'), value: String(guild.memberCount) },
      { name: t(lang, 'info.boosts'), value: t(lang, 'info.boostValue', { count: guild.premiumSubscriptionCount ?? 0, tier: guild.premiumTier }) },
      { name: t(lang, 'info.channels'), value: String(guild.channels.cache.size) },
      { name: t(lang, 'info.roles'), value: String(guild.roles.cache.size) },
      { name: t(lang, 'info.created'), value: stamp(guild.createdTimestamp) },
    ],
  };
}

export function buildUserInfo(member, lang) {
  const roles = rolesField(member, lang);
  const later = t(lang, 'info.notAvailable');
  return {
    title: member.user.username,
    fields: [
      { name: t(lang, 'info.joined'), value: member.joinedTimestamp ? stamp(member.joinedTimestamp) : '—' },
      { name: t(lang, 'info.accountAge'), value: stamp(member.user.createdTimestamp) },
      { name: t(lang, 'info.roles'), value: roles },
      { name: t(lang, 'info.level'), value: later },
      { name: t(lang, 'info.warnings'), value: later },
      { name: t(lang, 'info.birthday'), value: later },
    ],
  };
}
