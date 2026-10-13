import {
  SlashCommandBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { trySend } from '../../core/send.js';
import { safeMentions } from '../../core/mentions.js';
import { memberCanPost } from '../../core/permissions.js';
import { t } from '../../i18n/index.js';
import { getEmbed, normalizeEmbedName } from '../embeds/store.js';
import { fetchGuildSendable, sendEmbedSpec } from '../embeds/render.js';
import { rolesToPing, isHttpUrl } from './rules.js';

const CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const channelOption = (o) =>
  o.setName('channel').setDescription('Where to post').addChannelTypes(...CHANNEL_TYPES).setRequired(true);

const data = toggleSubcommands(
  new SlashCommandBuilder()
    .setName('post')
    .setDescription('Post a message as the bot')
    .addSubcommand((s) =>
      s.setName('text').setDescription('Post a plain text message')
        .addChannelOption(channelOption)
        .addStringOption((o) => o.setName('text').setDescription('Message text').setMaxLength(2000).setRequired(true))
        .addBooleanOption((o) => o.setName('allow-role-ping').setDescription('Let role mentions in the text ping')))
    .addSubcommand((s) =>
      s.setName('embed').setDescription('Post a saved embed template')
        .addChannelOption(channelOption)
        .addStringOption((o) => o.setName('template').setDescription('Template name').setMaxLength(100).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('buttons').setDescription('Post a message with a link button')
        .addChannelOption(channelOption)
        .addStringOption((o) => o.setName('text').setDescription('Message text').setMaxLength(2000).setRequired(true))
        .addStringOption((o) => o.setName('label').setDescription('Button label').setMaxLength(80).setRequired(true))
        .addStringOption((o) => o.setName('url').setDescription('Link starting with http:// or https://').setMaxLength(512).setRequired(true))),
);

// Defers, posts the payload and answers with post.sent or post.cannotSend.
async function postPayload(interaction, ctx, lang, channelId, payload) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const channel = await fetchGuildSendable(ctx.client, interaction.guildId, channelId);
    if (channel && !memberCanPost(channel, interaction.member)) {
      await interaction.editReply(t(lang, 'common.cannotPostThere'));
      return;
    }
    const sent = channel ? await trySend(channel, payload) : null;
    await interaction.editReply(t(lang, sent ? 'post.sent' : 'post.cannotSend'));
  } catch (err) {
    console.error('Post failed:', err);
    await interaction.editReply(t(lang, 'post.cannotSend')).catch(() => {});
  }
}

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'post');

  const lang = await guard(interaction, ctx, 'post');
  if (!lang) return;
  const channelId = interaction.options.getChannel('channel', true).id;

  if (sub === 'text') {
    const text = interaction.options.getString('text', true);
    const allow = interaction.options.getBoolean('allow-role-ping') ?? false;
    return postPayload(interaction, ctx, lang, channelId, {
      content: text,
      allowedMentions: safeMentions(rolesToPing(text, allow)),
    });
  }

  if (sub === 'embed') {
    const name = normalizeEmbedName(interaction.options.getString('template', true));
    if (!name) return interaction.reply(ephemeral(t(lang, 'embeds.badName')));
    const spec = await getEmbed(ctx.db, interaction.guildId, name);
    if (!spec) return interaction.reply(ephemeral(t(lang, 'embeds.notFound', { name })));
    return sendEmbedSpec(interaction, ctx, lang, spec, channelId);
  }

  if (sub === 'buttons') {
    const text = interaction.options.getString('text', true);
    const label = interaction.options.getString('label', true);
    const url = interaction.options.getString('url', true).trim();
    if (!isHttpUrl(url)) return interaction.reply(ephemeral(t(lang, 'post.badUrl')));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url),
    );
    return postPayload(interaction, ctx, lang, channelId, {
      content: text,
      components: [row],
      allowedMentions: safeMentions(),
    });
  }
}

export const commands = [{ data, execute }];
export const events = [];
