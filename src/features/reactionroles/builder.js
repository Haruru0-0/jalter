import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, RoleSelectMenuBuilder, StringSelectMenuBuilder,
  TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { ephemeral } from '../../core/replies.js';
import { getMessage, removeEntry } from './store.js';
import { syncMessage } from './render.js';
import { addOne, fetchDiscordMessage, fitLines, loadMessage } from './setup.js';
import { logReactionRoles } from './log.js';

const TTL_MS = 10 * 60 * 1000;
const CONTENT_LIMIT = 2000;
// customId: reactionroles:b:<action>:<userId>:<messageId>:<startedAt>[:<roleId>]; startedAt is base-36 seconds so the id stays under Discord's 100 characters
const id = (action, userId, messageId, startedAt, extra) =>
  ['reactionroles', 'b', action, userId, messageId, startedAt, extra].filter((p) => p !== undefined).join(':');

/** The panel: current entries, a role picker, Add, Remove and Done. Rebuilt from the database each time. */
export function builderPayload(lang, message, guild, { userId, startedAt, roleId = null }) {
  const head = t(lang, 'reactionroles.builder.head', { id: message.messageId });
  const lines = message.entries.map((e) => `${e.emoji ?? ''} ${e.label ?? ''} <@&${e.roleId}>`.trim());
  const list = lines.length ? fitLines(lang, lines, CONTENT_LIMIT - head.length - 1) : t(lang, 'reactionroles.builder.empty');
  const picker = new RoleSelectMenuBuilder().setCustomId(id('role', userId, message.messageId, startedAt))
    .setPlaceholder(t(lang, 'reactionroles.builder.pickRole')).setMinValues(1).setMaxValues(1);
  const add = new ButtonBuilder().setCustomId(id('add', userId, message.messageId, startedAt, roleId ?? undefined))
    .setLabel(t(lang, 'reactionroles.builder.add')).setStyle(ButtonStyle.Primary).setDisabled(!roleId);
  const done = new ButtonBuilder().setCustomId(id('done', userId, message.messageId, startedAt))
    .setLabel(t(lang, 'reactionroles.builder.done')).setStyle(ButtonStyle.Secondary);
  const rows = [new ActionRowBuilder().addComponents(picker), new ActionRowBuilder().addComponents(add, done)];
  if (message.entries.length) {
    const remove = new StringSelectMenuBuilder().setCustomId(id('rm', userId, message.messageId, startedAt))
      .setPlaceholder(t(lang, 'reactionroles.builder.remove'))
      .addOptions(message.entries.map((e) => ({
        label: (e.label || guild.roles.cache.get(e.roleId)?.name || e.roleId).slice(0, 100), value: e.roleId,
      })));
    rows.splice(1, 0, new ActionRowBuilder().addComponents(remove));
  }
  return { content: `${head}\n${list}`, components: rows };
}

/** `/reactionroles builder`: opens the panel for the caller. */
export async function builderHandler(interaction, ctx, lang) {
  const message = await loadMessage(interaction, ctx, lang);
  if (!message) return;
  const startedAt = Math.floor(Date.now() / 1000).toString(36);
  return interaction.reply(ephemeral(builderPayload(lang, message, interaction.guild, { userId: interaction.user.id, startedAt })));
}

function modal(lang, customId) {
  return new ModalBuilder().setCustomId(customId).setTitle(t(lang, 'reactionroles.builder.modalTitle'))
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('emoji').setLabel(t(lang, 'reactionroles.builder.emoji'))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(64)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('label').setLabel(t(lang, 'reactionroles.builder.label'))
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80)),
    );
}

/** Every component and modal of the panel (`reactionroles:b:*`). Only the opener may use it, for ten minutes. */
export async function handleBuilder(interaction, ctx) {
  const [, , action, userId, messageId, startedAt, roleId] = interaction.customId.split(':');
  const lang = await getLang(ctx.db, interaction.guildId);
  const refuse = (key) => interaction.reply(ephemeral(t(lang, key)));
  if (interaction.user.id !== userId) return refuse('reactionroles.notYours');
  const age = Date.now() - parseInt(startedAt, 36) * 1000;
  if (!(age <= TTL_MS)) return refuse('reactionroles.expired');
  const message = await getMessage(ctx.db, messageId);
  if (!message || message.guildId !== interaction.guildId) return refuse('reactionroles.gone');
  const state = { userId, startedAt };
  const guild = interaction.guild;

  if (action === 'role') {
    return interaction.update(builderPayload(lang, message, guild, { ...state, roleId: interaction.values[0] }));
  }
  if (action === 'add') return interaction.showModal(modal(lang, id('modal', userId, messageId, startedAt, roleId)));
  if (action === 'done') return interaction.update({ content: t(lang, 'reactionroles.builder.finished'), components: [] });
  if (action === 'rm') {
    const removedId = interaction.values[0];
    const removed = await removeEntry(ctx.db, messageId, removedId);
    const fresh = await getMessage(ctx.db, messageId);
    if (removed) {
      const discordMessage = await fetchDiscordMessage(guild, fresh);
      if (discordMessage) await syncMessage(ctx, fresh, discordMessage);
      await logReactionRoles(ctx, guild, lang, { action: 'remove', actorId: userId, messageId, detail: `<@&${removedId}>` });
    }
    return interaction.update(builderPayload(lang, fresh, guild, state));
  }
  if (action === 'modal') {
    const role = guild.roles.cache.get(roleId);
    if (!role) return refuse('reactionroles.refused.role_missing');
    const outcome = await addOne(ctx, { guild, caller: interaction.member }, message, {
      role,
      emojiText: interaction.fields.getTextInputValue('emoji').trim() || null,
      label: interaction.fields.getTextInputValue('label').trim() || null,
    });
    if (outcome !== 'ok') return refuse(`reactionroles.add.${outcome}`);
    await logReactionRoles(ctx, guild, lang, { action: 'add', actorId: userId, messageId, detail: `<@&${role.id}>` });
    return interaction.update(builderPayload(lang, await getMessage(ctx.db, messageId), guild, state));
  }
}
