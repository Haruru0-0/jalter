import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable } from '../../core/send.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';

const data = toggleSubcommands(
  new SlashCommandBuilder()
    .setName('media')
    .setDescription('Images stored for use in embeds and welcome cards')
    .addSubcommand((s) =>
      s.setName('setup').setDescription('Choose the storage channel')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Where images are kept')
            .addChannelTypes(ChannelType.GuildText).setRequired(true)))
    .addSubcommand((s) =>
      s.setName('add').setDescription('Store an image under a name')
        .addStringOption((o) => o.setName('name').setDescription('Name to use later').setRequired(true))
        .addAttachmentOption((o) => o.setName('image').setDescription('The image').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List stored images'))
    .addSubcommand((s) =>
      s.setName('remove').setDescription('Forget a stored image')
        .addStringOption((o) => o.setName('name').setDescription('Image name').setRequired(true))),
);

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'media');

  if (sub === 'setup') {
    const lang = await guard(interaction, ctx, 'media', { requireEnabled: false });
    if (!lang) return;
    const channel = interaction.options.getChannel('channel', true);
    await setFeature(ctx.db, interaction.guildId, 'media', { enabled: true, config: { channelId: channel.id } });
    return interaction.reply(ephemeral(t(lang, 'media.setupDone', { channel: `<#${channel.id}>` })));
  }

  const lang = await guard(interaction, ctx, 'media');
  if (!lang) return;
  const guildId = interaction.guildId;

  if (sub === 'add') {
    const name = interaction.options.getString('name', true).trim();
    const attachment = interaction.options.getAttachment('image', true);
    if (!attachment.contentType?.startsWith('image/')) {
      return interaction.reply(ephemeral(t(lang, 'media.notImage')));
    }
    const { config } = await getFeature(ctx.db, guildId, 'media');
    const channel = await fetchSendable(ctx.client, config.channelId);
    if (!channel) return interaction.reply(ephemeral(t(lang, 'media.noChannel')));
    await interaction.deferReply({ flags: ephemeral('').flags });
    const sent = await channel.send({ files: [{ attachment: attachment.url, name: attachment.name }] });
    await ctx.db.query(
      `INSERT INTO media_items (guild_id, name, channel_id, message_id, attachment_index)
       VALUES ($1, $2, $3, $4, 0)
       ON CONFLICT (guild_id, name) DO UPDATE SET channel_id = $3, message_id = $4, attachment_index = 0`,
      [guildId, name, channel.id, sent.id],
    );
    return interaction.editReply(t(lang, 'media.added', { name }));
  }

  if (sub === 'list') {
    const { rows } = await ctx.db.query('SELECT name FROM media_items WHERE guild_id = $1 ORDER BY name', [guildId]);
    const text = rows.length ? rows.map((r) => `\`${r.name}\``).join(', ') : t(lang, 'media.empty');
    return interaction.reply(ephemeral(text));
  }

  if (sub === 'remove') {
    const name = interaction.options.getString('name', true).trim();
    const { rowCount } = await ctx.db.query('DELETE FROM media_items WHERE guild_id = $1 AND name = $2', [guildId, name]);
    return interaction.reply(ephemeral(t(lang, rowCount ? 'media.removed' : 'media.unknown', { name })));
  }
}

export const commands = [{ data, execute }];
export const events = [];
