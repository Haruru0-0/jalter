import { Events } from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { sendLog, safe } from './send-log.js';
import { formatRename, truncate } from './format.js';

const onChannelCreate = safe('channelCreate', async (ctx, channel) => {
  if (!channel.guildId) return;
  const lang = await getLang(ctx.db, channel.guildId);
  await sendLog(ctx, channel.guildId, 'channelCreate', {
    title: t(lang, 'logging.channelCreated'),
    description: `<#${channel.id}> (${channel.name})`,
  }, { sourceChannelId: channel.id });
});

const onChannelDelete = safe('channelDelete', async (ctx, channel) => {
  if (!channel.guildId) return;
  const lang = await getLang(ctx.db, channel.guildId);
  await sendLog(ctx, channel.guildId, 'channelDelete', {
    title: t(lang, 'logging.channelDeleted'),
    description: truncate(channel.name),
  }, { sourceChannelId: channel.id });
});

const onChannelUpdate = safe('channelUpdate', async (ctx, oldC, newC) => {
  if (!newC.guildId || oldC.name === newC.name) return;
  const lang = await getLang(ctx.db, newC.guildId);
  await sendLog(ctx, newC.guildId, 'channelUpdate',
    formatRename(t(lang, 'logging.channelRenamed'), oldC.name, newC.name, lang), { sourceChannelId: newC.id });
});

const onRoleCreate = safe('roleCreate', async (ctx, role) => {
  const lang = await getLang(ctx.db, role.guild.id);
  await sendLog(ctx, role.guild.id, 'roleCreate', {
    title: t(lang, 'logging.roleCreated'),
    description: `<@&${role.id}> (${role.name})`,
  });
});

const onRoleDelete = safe('roleDelete', async (ctx, role) => {
  const lang = await getLang(ctx.db, role.guild.id);
  await sendLog(ctx, role.guild.id, 'roleDelete', {
    title: t(lang, 'logging.roleDeleted'),
    description: truncate(role.name),
  });
});

const onRoleUpdate = safe('roleUpdate', async (ctx, oldR, newR) => {
  const renamed = oldR.name !== newR.name;
  const permsChanged = oldR.permissions.bitfield !== newR.permissions.bitfield;
  if (!renamed && !permsChanged) return;
  const lang = await getLang(ctx.db, newR.guild.id);
  const fields = [];
  if (renamed) fields.push({ name: t(lang, 'logging.name'), value: `${truncate(oldR.name)} → ${truncate(newR.name)}` });
  if (permsChanged) fields.push({ name: t(lang, 'logging.permissions'), value: t(lang, 'logging.permissionsChanged') });
  await sendLog(ctx, newR.guild.id, 'roleUpdate', {
    title: t(lang, 'logging.roleUpdated'),
    description: `<@&${newR.id}>`,
    fields,
  });
});

const onEmojiCreate = safe('emojiCreate', async (ctx, emoji) => {
  const lang = await getLang(ctx.db, emoji.guild.id);
  await sendLog(ctx, emoji.guild.id, 'emoji', {
    title: t(lang, 'logging.emojiCreated'),
    description: `${emoji.toString()} (${emoji.name})`,
  });
});

const onEmojiDelete = safe('emojiDelete', async (ctx, emoji) => {
  const lang = await getLang(ctx.db, emoji.guild.id);
  await sendLog(ctx, emoji.guild.id, 'emoji', {
    title: t(lang, 'logging.emojiDeleted'),
    description: truncate(emoji.name),
  });
});

const onEmojiUpdate = safe('emojiUpdate', async (ctx, oldE, newE) => {
  if (oldE.name === newE.name) return;
  const lang = await getLang(ctx.db, newE.guild.id);
  await sendLog(ctx, newE.guild.id, 'emoji',
    formatRename(t(lang, 'logging.emojiRenamed'), oldE.name, newE.name, lang));
});

export const events = [
  { name: Events.ChannelCreate, execute: onChannelCreate },
  { name: Events.ChannelDelete, execute: onChannelDelete },
  { name: Events.ChannelUpdate, execute: onChannelUpdate },
  { name: Events.GuildRoleCreate, execute: onRoleCreate },
  { name: Events.GuildRoleDelete, execute: onRoleDelete },
  { name: Events.GuildRoleUpdate, execute: onRoleUpdate },
  { name: Events.GuildEmojiCreate, execute: onEmojiCreate },
  { name: Events.GuildEmojiDelete, execute: onEmojiDelete },
  { name: Events.GuildEmojiUpdate, execute: onEmojiUpdate },
];
