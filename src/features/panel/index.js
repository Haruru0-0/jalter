import { SlashCommandBuilder } from 'discord.js';
import { FEATURES } from '../../core/registry.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { listFeatures, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';

export function buildPanelEmbed(features, lang) {
  const lines = FEATURES.map((f) => {
    let status;
    if (f.alwaysOn) status = t(lang, 'panel.core');
    else if (f.command === null) status = t(lang, 'panel.comingSoon');
    else status = features.get(f.key)?.enabled ? t(lang, 'common.on') : t(lang, 'common.off');
    return `**${t(lang, f.nameKey)}**: ${status}`;
  });
  return { title: t(lang, 'panel.title'), description: lines.join('\n') };
}

const data = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('See which bot features are on')
  .addSubcommand((s) => s.setName('overview').setDescription('Show which features are on and off'))
  .addSubcommand((s) =>
    s.setName('manager-role').setDescription('Let a role manage the bot')
      .addRoleOption((o) => o.setName('role').setDescription('The manager role').setRequired(true)))
  .addSubcommand((s) => s.setName('manager-role-clear').setDescription('Remove the bot manager role'));

async function execute(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'panel', { requireEnabled: false });
  if (!lang) return;
  const sub = interaction.options.getSubcommand();
  if (sub === 'overview') {
    const features = await listFeatures(ctx.db, interaction.guildId);
    await interaction.reply(ephemeral({ embeds: [buildPanelEmbed(features, lang)] }));
  } else if (sub === 'manager-role') {
    const role = interaction.options.getRole('role', true);
    await setFeature(ctx.db, interaction.guildId, 'panel', { config: { managerRoleId: role.id } });
    await interaction.reply(ephemeral(t(lang, 'panel.managerSet', { role: role.name })));
  } else {
    await setFeature(ctx.db, interaction.guildId, 'panel', { config: { managerRoleId: null } });
    await interaction.reply(ephemeral(t(lang, 'panel.managerCleared')));
  }
}

export const commands = [{ data, execute }];
export const events = [];
