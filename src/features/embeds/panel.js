import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';

// Stub until the button panel exists (Task 6).
export async function showPanel(interaction, ctx, lang) {
  return interaction.reply(ephemeral(t(lang, 'embeds.panelSoon')));
}
