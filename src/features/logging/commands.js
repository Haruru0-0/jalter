import { SlashCommandBuilder, ChannelType } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { CATEGORIES } from './events.js';

const categoryChoices = CATEGORIES.map((c) => ({ name: c, value: c }));

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
