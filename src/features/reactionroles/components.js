import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { ephemeral } from '../../core/replies.js';
import { getMessage } from './store.js';
import { applyPick } from './apply.js';
import { PREFIX } from './render.js';
import { handleBuilder } from './builder.js';
import { handlePurge } from './commands-settings.js';

const roleName = (guild, id) => guild.roles.cache.get(id)?.name ?? id;

// What a member is told after a button or dropdown pick.
function summary(lang, guild, result) {
  if (!result.ok) return t(lang, `reactionroles.refused.${result.reason}`);
  const names = (ids) => ids.map((id) => roleName(guild, id)).join(', ');
  const lines = [];
  if (result.added.length) lines.push(t(lang, 'reactionroles.picked.added', { roles: names(result.added) }));
  if (result.removed.length) lines.push(t(lang, 'reactionroles.picked.removed', { roles: names(result.removed) }));
  return lines.join('\n');
}

async function pick(interaction, ctx, lang, messageId, build) {
  const message = await getMessage(ctx.db, messageId);
  if (!message) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  const feature = await getFeature(ctx.db, interaction.guildId, 'reactionroles');
  if (!feature.enabled) return interaction.reply(ephemeral(t(lang, 'reactionroles.off')));
  const member = interaction.member?.roles?.cache ? interaction.member : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return interaction.reply(ephemeral(t(lang, 'common.error')));
  const picked = build(message);
  if (!picked) return interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
  const result = await applyPick(ctx, member, message, picked);
  return interaction.reply(ephemeral(summary(lang, interaction.guild, result)));
}

/** Routes every `reactionroles:*` component: picks and the purge confirm. */
export async function handle(interaction, ctx) {
  if (!interaction.guildId) return;
  const [prefix, kind, ...rest] = interaction.customId.split(':');
  if (prefix !== PREFIX) return;
  const lang = await getLang(ctx.db, interaction.guildId);
  if (kind === 'btn') {
    const [messageId, entryId] = rest;
    return pick(interaction, ctx, lang, messageId, (message) => {
      const entry = message.entries.find((e) => String(e.id) === entryId);
      return entry ? { kind: 'entry', entry, action: 'toggle' } : null;
    });
  }
  if (kind === 'menu') {
    return pick(interaction, ctx, lang, rest[0], () => ({ kind: 'menu', roleIds: interaction.values }));
  }
  if (kind === 'b') return handleBuilder(interaction, ctx);
  if (kind === 'purge') return handlePurge(interaction, ctx);
}
