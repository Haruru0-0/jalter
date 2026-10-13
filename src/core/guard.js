import { getLang, t } from '../i18n/index.js';
import { canManage } from './permissions.js';
import { isEnabled, FEATURES, setupCommand } from './registry.js';
import { ephemeral } from './replies.js';

export async function guard(interaction, ctx, key, { requireManager = true, requireEnabled = true } = {}) {
  const lang = interaction.guildId ? await getLang(ctx.db, interaction.guildId) : 'en';
  if (!interaction.inGuild()) {
    await interaction.reply(ephemeral(t(lang, 'common.guildOnly')));
    return null;
  }
  if (requireManager && !(await canManage(ctx.db, interaction.member))) {
    await interaction.reply(ephemeral(t(lang, 'common.notAllowed')));
    return null;
  }
  if (requireEnabled && !(await isEnabled(ctx.db, interaction.guildId, key))) {
    const feature = FEATURES.find((f) => f.key === key) ?? { key };
    await interaction.reply(ephemeral(t(lang, 'common.featureOff', { command: `/${setupCommand(feature)}` })));
    return null;
  }
  return lang;
}
