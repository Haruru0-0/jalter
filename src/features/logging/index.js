import { SlashCommandBuilder, ChannelType, Events } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { getLang, t } from '../../i18n/index.js';
import {
  formatMessageEdit, formatMessageDelete, diffRoles, formatRoleChange, formatRename, truncate,
} from './format.js';

const CATEGORIES = ['messages', 'members', 'server', 'mod'];
const categoryChoices = CATEGORIES.map((c) => ({ name: c, value: c }));

export async function sendLog(ctx, guildId, category, embed, sourceChannelId) {
  try {
    const { enabled, config } = await getFeature(ctx.db, guildId, 'logging');
    if (!enabled) return;
    const channels = config.channels ?? {};
    const channelId = channels[category];
    if (!channelId) return;
    if (sourceChannelId && Object.values(channels).includes(sourceChannelId)) return;
    const channel = await fetchSendable(ctx.client, channelId);
    if (!channel) {
      console.warn(`Log channel for ${category} missing in guild ${guildId}`);
      return;
    }
    await trySend(channel, { embeds: [{ ...embed, timestamp: new Date().toISOString() }], allowedMentions: { parse: [] } });
  } catch (err) {
    console.warn(`Could not write log in ${guildId}: ${err.message}`);
  }
}

// Wraps an event handler so it can never throw into the event loop.
function safe(name, handler) {
  return async (ctx, ...args) => {
    try {
      await handler(ctx, ...args);
    } catch (err) {
      console.warn(`Logging handler ${name} failed: ${err.message}`);
    }
  };
}

const userLine = (user) => `<@${user.id}> (${user.username ?? '?'})`;

const onMessageUpdate = safe('messageUpdate', async (ctx, oldM, newM) => {
  if (!newM.guildId || newM.author?.bot) return;
  const known = oldM.content !== null && oldM.content !== undefined
    && newM.content !== null && newM.content !== undefined;
  if (known && oldM.content === newM.content) return;
  const lang = await getLang(ctx.db, newM.guildId);
  await sendLog(ctx, newM.guildId, 'messages', formatMessageEdit(oldM, newM, lang), newM.channelId);
});

const onMessageDelete = safe('messageDelete', async (ctx, message) => {
  if (!message.guildId || message.author?.bot) return;
  const lang = await getLang(ctx.db, message.guildId);
  await sendLog(ctx, message.guildId, 'messages', formatMessageDelete(message, lang), message.channelId);
});

const onMemberAdd = safe('memberAdd', async (ctx, member) => {
  const lang = await getLang(ctx.db, member.guild.id);
  await sendLog(ctx, member.guild.id, 'members', {
    title: t(lang, 'logging.memberJoined'),
    description: userLine(member.user),
  });
});

const onMemberRemove = safe('memberRemove', async (ctx, member) => {
  const lang = await getLang(ctx.db, member.guild.id);
  await sendLog(ctx, member.guild.id, 'members', {
    title: t(lang, 'logging.memberLeft'),
    description: userLine(member.user),
  });
});

const onMemberUpdate = safe('memberUpdate', async (ctx, oldM, newM) => {
  if (oldM.partial) return;
  const lang = await getLang(ctx.db, newM.guild.id);
  if (oldM.nickname !== newM.nickname) {
    await sendLog(ctx, newM.guild.id, 'members', {
      title: t(lang, 'logging.nicknameChanged'),
      description: userLine(newM.user),
      fields: [
        { name: t(lang, 'logging.before'), value: truncate(oldM.nickname) },
        { name: t(lang, 'logging.after'), value: truncate(newM.nickname) },
      ],
    });
  }
  const diff = diffRoles([...oldM.roles.cache.keys()], [...newM.roles.cache.keys()]);
  if (diff.added.length || diff.removed.length) {
    await sendLog(ctx, newM.guild.id, 'members', formatRoleChange(newM.user.id, diff, lang));
  }
});

const onChannelCreate = safe('channelCreate', async (ctx, channel) => {
  if (!channel.guildId) return;
  const lang = await getLang(ctx.db, channel.guildId);
  await sendLog(ctx, channel.guildId, 'server', {
    title: t(lang, 'logging.channelCreated'),
    description: `<#${channel.id}> (${channel.name})`,
  }, channel.id);
});

const onChannelDelete = safe('channelDelete', async (ctx, channel) => {
  if (!channel.guildId) return;
  const lang = await getLang(ctx.db, channel.guildId);
  await sendLog(ctx, channel.guildId, 'server', {
    title: t(lang, 'logging.channelDeleted'),
    description: truncate(channel.name),
  }, channel.id);
});

const onChannelUpdate = safe('channelUpdate', async (ctx, oldC, newC) => {
  if (!newC.guildId || oldC.name === newC.name) return;
  const lang = await getLang(ctx.db, newC.guildId);
  await sendLog(ctx, newC.guildId, 'server',
    formatRename(t(lang, 'logging.channelRenamed'), oldC.name, newC.name, lang), newC.id);
});

const onRoleCreate = safe('roleCreate', async (ctx, role) => {
  const lang = await getLang(ctx.db, role.guild.id);
  await sendLog(ctx, role.guild.id, 'server', {
    title: t(lang, 'logging.roleCreated'),
    description: `<@&${role.id}> (${role.name})`,
  });
});

const onRoleDelete = safe('roleDelete', async (ctx, role) => {
  const lang = await getLang(ctx.db, role.guild.id);
  await sendLog(ctx, role.guild.id, 'server', {
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
  await sendLog(ctx, newR.guild.id, 'server', {
    title: t(lang, 'logging.roleUpdated'),
    description: `<@&${newR.id}>`,
    fields,
  });
});

const onEmojiCreate = safe('emojiCreate', async (ctx, emoji) => {
  const lang = await getLang(ctx.db, emoji.guild.id);
  await sendLog(ctx, emoji.guild.id, 'server', {
    title: t(lang, 'logging.emojiCreated'),
    description: `${emoji.toString()} (${emoji.name})`,
  });
});

const onEmojiDelete = safe('emojiDelete', async (ctx, emoji) => {
  const lang = await getLang(ctx.db, emoji.guild.id);
  await sendLog(ctx, emoji.guild.id, 'server', {
    title: t(lang, 'logging.emojiDeleted'),
    description: truncate(emoji.name),
  });
});

const onEmojiUpdate = safe('emojiUpdate', async (ctx, oldE, newE) => {
  if (oldE.name === newE.name) return;
  const lang = await getLang(ctx.db, newE.guild.id);
  await sendLog(ctx, newE.guild.id, 'server',
    formatRename(t(lang, 'logging.emojiRenamed'), oldE.name, newE.name, lang));
});

const data = toggleSubcommands(
  new SlashCommandBuilder()
    .setName('logging')
    .setDescription('Log server activity to channels'),
)
  .addSubcommand((s) =>
    s.setName('set').setDescription('Choose the channel for a log category')
      .addStringOption((o) =>
        o.setName('category').setDescription('Which kind of log').setRequired(true)
          .addChoices(...categoryChoices))
      .addChannelOption((o) =>
        o.setName('channel').setDescription('Where the logs go').setRequired(true)
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand((s) =>
    s.setName('clear').setDescription('Stop logging a category')
      .addStringOption((o) =>
        o.setName('category').setDescription('Which kind of log').setRequired(true)
          .addChoices(...categoryChoices)));

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'logging');
  const lang = await guard(interaction, ctx, 'logging', { requireEnabled: false });
  if (!lang) return;
  const category = interaction.options.getString('category', true);
  const { config } = await getFeature(ctx.db, interaction.guildId, 'logging');
  const channels = { ...(config.channels ?? {}) };
  if (sub === 'set') {
    const channel = interaction.options.getChannel('channel', true);
    channels[category] = channel.id;
    await setFeature(ctx.db, interaction.guildId, 'logging', { enabled: true, config: { channels } });
    await interaction.reply(ephemeral(t(lang, 'logging.set', { category, channel: `<#${channel.id}>` })));
    return;
  }
  delete channels[category];
  await setFeature(ctx.db, interaction.guildId, 'logging', { config: { channels } });
  await interaction.reply(ephemeral(t(lang, 'logging.cleared', { category })));
}

export const commands = [{ data, execute }];
export const events = [
  { name: Events.MessageUpdate, execute: onMessageUpdate },
  { name: Events.MessageDelete, execute: onMessageDelete },
  { name: Events.GuildMemberAdd, execute: onMemberAdd },
  { name: Events.GuildMemberRemove, execute: onMemberRemove },
  { name: Events.GuildMemberUpdate, execute: onMemberUpdate },
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
