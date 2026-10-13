export function ordinal(n, lang = 'en') {
  if (lang === 'fr') return n === 1 ? '1er' : `${n}e`;
  if (lang === 'ar') return String(n);
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'}`;
}

export function renderPlaceholders(text, vars) {
  if (!text) return text;
  return text.replace(/\{([a-z_]+)\}/g, (match, key) =>
    Object.hasOwn(vars, key) && vars[key] !== undefined ? String(vars[key]) : match);
}

const unix = (ms) => Math.floor(ms / 1000);

export function buildVars({ user, member = null, guild, lang = 'en', now = Date.now() }) {
  const memberCount = guild.memberCount;
  const boosts = guild.premiumSubscriptionCount ?? 0;
  return {
    user: `<@${user.id}>`,
    user_name: member?.displayName ?? user.globalName ?? user.username,
    user_tag: user.tag ?? user.username,
    user_avatar: user.displayAvatarURL({ extension: 'png', size: 256 }) ?? '',
    server_name: guild.name,
    server_icon: guild.iconURL({ extension: 'png', size: 256 }) ?? '',
    server_owner: `<@${guild.ownerId}>`,
    server_createdate: `<t:${unix(guild.createdTimestamp)}:D>`,
    server_membercount: memberCount,
    server_membercount_ordinal: ordinal(memberCount, lang),
    server_boostcount: boosts,
    date: `<t:${unix(now)}:D>`,
    newline: '\n',
    // old names from Phase 1
    username: user.username,
    server: guild.name,
    count: memberCount,
    boosts,
  };
}

export function extractEmbedRefs(text) {
  if (!text) return { text: text ?? '', names: [] };
  const names = [];
  const stripped = text.replace(/\{embed:([A-Za-z0-9_-]{1,16})\}/g, (_match, name) => {
    names.push(name.toLowerCase());
    return '';
  });
  return { text: stripped.trim(), names };
}
