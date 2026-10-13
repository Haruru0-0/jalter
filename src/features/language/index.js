import { SlashCommandBuilder } from 'discord.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { setFeature } from '../../db/settings.js';
import { t, LANGS } from '../../i18n/index.js';

const data = new SlashCommandBuilder()
  .setName('language')
  .setDescription('Set the bot language for this server')
  .addSubcommand((s) =>
    s.setName('set').setDescription('Choose the language')
      .addStringOption((o) =>
        o.setName('language').setDescription('Language').setRequired(true)
          .addChoices(
            { name: 'English', value: 'en' },
            { name: 'العربية', value: 'ar' },
            { name: 'Français', value: 'fr' },
          )));

async function execute(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'language', { requireEnabled: false });
  if (!lang) return;
  const chosen = interaction.options.getString('language', true);
  if (!LANGS.includes(chosen)) return;
  await setFeature(ctx.db, interaction.guildId, 'language', { config: { lang: chosen } });
  await interaction.reply(ephemeral(t(chosen, 'language.set')));
}

export const commands = [{ data, execute }];
export const events = [];
