import { SlashCommandBuilder } from 'discord.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';

export function createVerificationCommand() {
  const data = toggleSubcommands(
    new SlashCommandBuilder().setName('verification').setDescription('Verification settings'),
  );

  async function execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'verification');
  }

  return { data, execute };
}
