import { setFeature } from '../db/settings.js';
import { t } from '../i18n/index.js';
import { guard } from './guard.js';
import { ephemeral } from './replies.js';

export function toggleSubcommands(builder) {
  return builder
    .addSubcommand((s) => s.setName('enable').setDescription('Turn this feature on'))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn this feature off'));
}

export async function handleToggle(interaction, ctx, key) {
  const lang = await guard(interaction, ctx, key, { requireEnabled: false });
  if (!lang) return;
  const on = interaction.options.getSubcommand() === 'enable';
  await setFeature(ctx.db, interaction.guildId, key, { enabled: on });
  const msgKey = on ? 'common.enabledMsg' : 'common.disabledMsg';
  await interaction.reply(ephemeral(t(lang, msgKey, { feature: t(lang, `feature.${key}`) })));
}
