import { SlashCommandBuilder, Events } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';

export async function assignAutoRole(ctx, member) {
  try {
    const { enabled, config } = await getFeature(ctx.db, member.guild.id, 'autorole');
    if (!enabled) return;
    const roleId = member.user.bot ? config.botRoleId : config.humanRoleId;
    if (!roleId) return;
    await member.roles.add(roleId);
  } catch (err) {
    console.warn(`Auto role failed in ${member.guild.id}: ${err.message}`);
  }
}

const data = new SlashCommandBuilder()
  .setName('autorole')
  .setDescription('Give new members a role automatically')
  .addSubcommand((s) =>
    s.setName('setup').setDescription('Choose the roles')
      .addRoleOption((o) => o.setName('human-role').setDescription('Role for new members'))
      .addRoleOption((o) => o.setName('bot-role').setDescription('Role for new bots')))
  .addSubcommand((s) => s.setName('disable').setDescription('Turn auto role off'));

async function execute(interaction, ctx) {
  if (interaction.options.getSubcommand() === 'disable') return handleToggle(interaction, ctx, 'autorole');
  const lang = await guard(interaction, ctx, 'autorole', { requireEnabled: false });
  if (!lang) return;
  const human = interaction.options.getRole('human-role');
  const bot = interaction.options.getRole('bot-role');
  const botTop = interaction.guild.members.me?.roles.highest.position;
  const tooHigh = botTop === undefined
    ? []
    : [human, bot].filter(Boolean).filter((r) => r.position >= botTop);
  await setFeature(ctx.db, interaction.guildId, 'autorole', {
    enabled: true,
    config: { humanRoleId: human?.id ?? null, botRoleId: bot?.id ?? null },
  });
  const warn = tooHigh.length ? `\n${t(lang, 'autorole.tooHigh')}` : '';
  await interaction.reply(ephemeral(t(lang, 'autorole.setupDone') + warn));
}

export const commands = [{ data, execute }];
export const events = [
  { name: Events.GuildMemberAdd, execute: assignAutoRole },
];
