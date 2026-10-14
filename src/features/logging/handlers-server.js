import { Events, AuditLogEvent } from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { sendLog, safe } from './send-log.js';
import { formatRename, truncate, withExecutor } from './format.js';
import { findExecutor } from './audit.js';

const onChannelCreate = safe('channelCreate', async (ctx, channel) => {
  if (!channel.guildId) return;
  const lang = await getLang(ctx.db, channel.guildId);
  const executor = await findExecutor(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
  await sendLog(ctx, channel.guildId, 'channelCreate', withExecutor({
    title: t(lang, 'logging.channelCreated'),
    description: `<#${channel.id}> (${channel.name})`,
  }, executor, lang), { sourceChannelId: channel.id });
});

const onChannelDelete = safe('channelDelete', async (ctx, channel) => {
  if (!channel.guildId) return;
  const lang = await getLang(ctx.db, channel.guildId);
  const executor = await findExecutor(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
  await sendLog(ctx, channel.guildId, 'channelDelete', withExecutor({
    title: t(lang, 'logging.channelDeleted'),
    description: truncate(channel.name),
  }, executor, lang), { sourceChannelId: channel.id });
});

const onChannelUpdate = safe('channelUpdate', async (ctx, oldC, newC) => {
  if (!newC.guildId || oldC.name === newC.name) return;
  const lang = await getLang(ctx.db, newC.guildId);
  await sendLog(ctx, newC.guildId, 'channelUpdate',
    formatRename(t(lang, 'logging.channelRenamed'), oldC.name, newC.name, lang), { sourceChannelId: newC.id });
});

const onRoleCreate = safe('roleCreate', async (ctx, role) => {
  const lang = await getLang(ctx.db, role.guild.id);
  const executor = await findExecutor(role.guild, AuditLogEvent.RoleCreate, role.id);
  await sendLog(ctx, role.guild.id, 'roleCreate', withExecutor({
    title: t(lang, 'logging.roleCreated'),
    description: `<@&${role.id}> (${role.name})`,
  }, executor, lang));
});

const onRoleDelete = safe('roleDelete', async (ctx, role) => {
  const lang = await getLang(ctx.db, role.guild.id);
  const executor = await findExecutor(role.guild, AuditLogEvent.RoleDelete, role.id);
  await sendLog(ctx, role.guild.id, 'roleDelete', withExecutor({
    title: t(lang, 'logging.roleDeleted'),
    description: truncate(role.name),
  }, executor, lang));
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

const onGuildUpdate = safe('guildUpdate', async (ctx, oldG, newG) => {
  const renamed = oldG.name !== newG.name;
  const iconChanged = oldG.icon !== newG.icon;
  if (!renamed && !iconChanged) return;
  const lang = await getLang(ctx.db, newG.id);
  const fields = [];
  if (renamed) fields.push({ name: t(lang, 'logging.name'), value: `${truncate(oldG.name)} → ${truncate(newG.name)}` });
  if (iconChanged) fields.push({ name: t(lang, 'logging.icon'), value: t(lang, 'logging.iconChanged') });
  await sendLog(ctx, newG.id, 'guildUpdate', { title: t(lang, 'logging.guildUpdated'), fields });
});

export const events = [
  { name: Events.GuildUpdate, execute: onGuildUpdate },
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
