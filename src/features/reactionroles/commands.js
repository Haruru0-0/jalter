import { SlashCommandBuilder, ChannelType, MessageFlags } from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { canManage } from '../../core/permissions.js';
import { botCanGive } from '../../core/role-safety.js';
import { listEmbeds } from '../embeds/store.js';
import { STYLES, TYPES, typeAllowedForStyle } from './config.js';
import { createMessage, getMessage, listMessages, removeEntry } from './store.js';
import { postRoleMessage, syncMessage } from './render.js';
import { logReactionRoles } from './log.js';
import { addOne, fetchDiscordMessage, loadMessage, refuseMissingPermission } from './setup.js';

export { checkRoleForSetup } from './setup.js';

const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const choices = (list) => list.map((v) => ({ name: v, value: v }));
const messageIdOption = (o) => o.setName('message_id').setDescription('Id of the role message').setRequired(true);

export function buildData() {
  return new SlashCommandBuilder()
    .setName('reactionroles')
    .setDescription('Let members pick roles from an embed message')
    .addSubcommand((s) => s.setName('enable').setDescription('Turn reaction roles on'))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn reaction roles off'))
    .addSubcommand((s) => s.setName('status').setDescription('Show the role messages and any problems'))
    .addSubcommand((s) =>
      s.setName('create').setDescription('Post a named embed as a role message')
        .addStringOption((o) => o.setName('embed').setDescription('Name of the embed').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('style').setDescription('How members pick').addChoices(...choices(STYLES)).setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post (default: here)').addChannelTypes(...CHANNEL_TYPES))
        .addStringOption((o) => o.setName('type').setDescription('Behavior (default: normal)').addChoices(...choices(TYPES))))
    .addSubcommand((s) =>
      s.setName('adopt').setDescription('Use an embed message the bot already posted')
        .addStringOption(messageIdOption)
        .addStringOption((o) => o.setName('style').setDescription('How members pick').addChoices(...choices(STYLES)).setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Channel of the message (default: here)').addChannelTypes(...CHANNEL_TYPES)))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Add a role to a role message')
        .addStringOption(messageIdOption)
        .addRoleOption((o) => o.setName('role').setDescription('Role to offer').setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji (required for reactions)'))
        .addStringOption((o) => o.setName('label').setDescription('Label for buttons and the dropdown').setMaxLength(80)))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Remove a role from a role message')
        .addStringOption(messageIdOption)
        .addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true)))
    .addSubcommand((s) =>
      s.setName('show').setDescription('List the role messages, or one message in detail')
        .addStringOption((o) => o.setName('message_id').setDescription('Id of the role message')));
}

async function create(interaction, ctx, lang) {
  const style = interaction.options.getString('style');
  const type = interaction.options.getString('type') ?? 'normal';
  if (!typeAllowedForStyle(type, style)) return interaction.reply(ephemeral(t(lang, 'reactionroles.reversedNeedsReactions')));
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  if (await refuseMissingPermission(interaction, lang, channel, { style, type })) return;
  const name = interaction.options.getString('embed');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const posted = await postRoleMessage(ctx, interaction, lang, channel, name);
  if (posted.error) return interaction.editReply(t(lang, `reactionroles.embed.${posted.error}`));
  await createMessage(ctx.db, {
    guildId: interaction.guildId, messageId: posted.message.id, channelId: channel.id,
    embedName: name, style, type, createdBy: interaction.user.id,
  });
  await logReactionRoles(ctx, interaction.guild, lang, { action: 'create', actorId: interaction.user.id, messageId: posted.message.id });
  return interaction.editReply(t(lang, 'reactionroles.created', { id: posted.message.id }));
}

async function adopt(interaction, ctx, lang) {
  const style = interaction.options.getString('style');
  const channel = interaction.options.getChannel('channel') ?? interaction.channel;
  const id = interaction.options.getString('message_id');
  if (await refuseMissingPermission(interaction, lang, channel, { style })) return;
  const found = await channel.messages.fetch(id).catch(() => null);
  if (!found) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  if (found.author.id !== ctx.client.user.id) return interaction.reply(ephemeral(t(lang, 'reactionroles.adopt.notOurs')));
  if (!found.embeds.length) return interaction.reply(ephemeral(t(lang, 'reactionroles.adopt.noEmbed')));
  if (found.components.length) return interaction.reply(ephemeral(t(lang, 'reactionroles.adopt.hasComponents')));
  if (await getMessage(ctx.db, id)) return interaction.reply(ephemeral(t(lang, 'reactionroles.adopt.already')));
  await createMessage(ctx.db, {
    guildId: interaction.guildId, messageId: id, channelId: channel.id, embedName: null, style, createdBy: interaction.user.id,
  });
  await syncMessage(ctx, await getMessage(ctx.db, id), found);
  await logReactionRoles(ctx, interaction.guild, lang, { action: 'adopt', actorId: interaction.user.id, messageId: id });
  return interaction.reply(ephemeral(t(lang, 'reactionroles.adopted', { id })));
}

async function add(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const channel = await interaction.guild.channels.fetch(message.channelId).catch(() => null);
  if (await refuseMissingPermission(interaction, lang, channel, message)) return;
  const role = interaction.options.getRole('role');
  const outcome = await addOne(ctx, { guild: interaction.guild, caller: interaction.member }, message, {
    role,
    emojiText: interaction.options.getString('emoji'),
    label: interaction.options.getString('label'),
  });
  if (outcome === 'ok') {
    await logReactionRoles(ctx, interaction.guild, lang, {
      action: 'add', actorId: interaction.user.id, messageId: message.messageId, detail: `<@&${role.id}>`,
    });
  }
  return interaction.reply(ephemeral(t(lang, outcome === 'ok' ? 'reactionroles.added' : `reactionroles.add.${outcome}`)));
}

async function remove(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const role = interaction.options.getRole('role');
  if (!(await removeEntry(ctx.db, message.messageId, role.id))) {
    return interaction.reply(ephemeral(t(lang, 'reactionroles.noSuchEntry')));
  }
  const fresh = await getMessage(ctx.db, message.messageId);
  const discordMessage = await fetchDiscordMessage(interaction.guild, fresh);
  if (discordMessage) await syncMessage(ctx, fresh, discordMessage);
  await logReactionRoles(ctx, interaction.guild, lang, {
    action: 'remove', actorId: interaction.user.id, messageId: message.messageId, detail: `<@&${role.id}>`,
  });
  return interaction.reply(ephemeral(t(lang, 'reactionroles.removed')));
}

const describe = (lang, m) =>
  t(lang, 'reactionroles.show.line', { id: m.messageId, channel: `<#${m.channelId}>`, style: m.style, type: m.type, count: m.entries.length });

async function show(interaction, ctx, lang) {
  const id = interaction.options.getString('message_id');
  if (!id) {
    const all = await listMessages(ctx.db, interaction.guildId);
    return interaction.reply(ephemeral(all.length ? all.map((m) => describe(lang, m)).join('\n') : t(lang, 'reactionroles.show.none')));
  }
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const entries = message.entries.map((e) => `${e.emoji ?? ''} ${e.label ?? ''} <@&${e.roleId}>`.trim());
  const lines = [describe(lang, message), ...entries];
  if (message.limit != null) lines.push(t(lang, 'reactionroles.show.limit', { limit: message.limit }));
  if (message.whitelist.length) lines.push(t(lang, 'reactionroles.show.whitelist', { roles: message.whitelist.map((r) => `<@&${r}>`).join(' ') }));
  if (message.blacklist.length) lines.push(t(lang, 'reactionroles.show.blacklist', { roles: message.blacklist.map((r) => `<@&${r}>`).join(' ') }));
  return interaction.reply(ephemeral(lines.join('\n')));
}

async function status(interaction, ctx, lang) {
  const all = await listMessages(ctx.db, interaction.guildId);
  const problems = [];
  for (const m of all) {
    const discordMessage = await fetchDiscordMessage(interaction.guild, m);
    if (!discordMessage) {
      problems.push(t(lang, 'reactionroles.status.deleted', { id: m.messageId }));
      continue;
    }
    if (!m.entries.length) problems.push(t(lang, 'reactionroles.status.empty', { id: m.messageId }));
    for (const e of m.entries) {
      const role = interaction.guild.roles.cache.get(e.roleId);
      if (!role || !botCanGive(interaction.guild, role)) problems.push(t(lang, 'reactionroles.status.role', { id: m.messageId, role: `<@&${e.roleId}>` }));
    }
    if (m.style === 'reactions' && m.entries.some((e) => e.emoji) && discordMessage.reactions.cache.size === 0) {
      problems.push(t(lang, 'reactionroles.status.reactions', { id: m.messageId }));
    }
  }
  const head = t(lang, 'reactionroles.status.head', { count: all.length });
  return interaction.reply(ephemeral([head, ...problems].join('\n')));
}

const HANDLERS = { create, adopt, add, remove, show, status };

export function createReactionRolesCommand() {
  return {
    data: buildData(),
    async execute(interaction, ctx) {
      const sub = interaction.options.getSubcommand();
      if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'reactionroles');
      const lang = await guard(interaction, ctx, 'reactionroles');
      if (!lang) return;
      return HANDLERS[sub]?.(interaction, ctx, lang);
    },
    async autocomplete(interaction, ctx) {
      if (!interaction.guildId || !(await canManage(ctx.db, interaction.member))) return interaction.respond([]);
      const typed = interaction.options.getFocused().toLowerCase();
      const names = (await listEmbeds(ctx.db, interaction.guildId)).filter((n) => n.includes(typed)).slice(0, 25);
      return interaction.respond(names.map((n) => ({ name: n, value: n })));
    },
  };
}
