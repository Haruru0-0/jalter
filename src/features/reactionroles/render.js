import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { getEmbed } from '../embeds/store.js';
import { buildEmbedPayload } from '../embeds/render.js';
import { buildVars } from '../../core/placeholders.js';
import { safeMentions } from '../../core/mentions.js';
import { trySend } from '../../core/send.js';
import { componentEmoji, emojiKey } from './config.js';

export const PREFIX = 'reactionroles';

const roleName = (guild, roleId) => guild?.roles?.cache?.get(roleId)?.name ?? roleId;

function button(message, entry) {
  const b = new ButtonBuilder()
    .setCustomId(`${PREFIX}:btn:${message.messageId}:${entry.id}`)
    .setStyle(ButtonStyle.Secondary);
  if (entry.label) b.setLabel(entry.label.slice(0, 80));
  if (entry.emoji) b.setEmoji(componentEmoji(entry.emoji));
  return b;
}

/** The action rows for a message: up to 5 buttons per row, or one dropdown; none for reactions. */
export function buildComponents(message, guild) {
  const { entries, style } = message;
  if (!entries.length || style === 'reactions') return [];
  if (style === 'buttons') {
    const rows = [];
    for (let i = 0; i < entries.length; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(entries.slice(i, i + 5).map((e) => button(message, e))));
    }
    return rows;
  }
  const single = message.type === 'unique' || message.type === 'binding';
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`${PREFIX}:menu:${message.messageId}`)
    .setMinValues(0)
    .setMaxValues(single ? 1 : entries.length)
    .addOptions(entries.map((e) => {
      const option = { label: (e.label || roleName(guild, e.roleId)).slice(0, 100), value: e.roleId };
      if (e.emoji) option.emoji = componentEmoji(e.emoji);
      return option;
    }));
  return [new ActionRowBuilder().addComponents(menu)];
}

const botReactionKeys = (discordMessage) =>
  new Set([...discordMessage.reactions.cache.values()].filter((r) => r.me).map((r) => r.emoji.id ?? r.emoji.name));

/** Emoji of entries that the bot has not reacted with yet. */
export function missingReactions(message, discordMessage) {
  const have = botReactionKeys(discordMessage);
  return message.entries.filter((e) => e.emoji && !have.has(emojiKey(e.emoji))).map((e) => e.emoji);
}

/** Brings the Discord message in line with the stored entries. */
export async function syncMessage(ctx, message, discordMessage) {
  try {
    if (message.style !== 'reactions') {
      await discordMessage.edit({ components: buildComponents(message, discordMessage.guild) });
      return { ok: true };
    }
  } catch {
    return { ok: false, reason: 'cannot_edit' };
  }
  try {
    const wanted = new Set(message.entries.filter((e) => e.emoji).map((e) => emojiKey(e.emoji)));
    for (const reaction of discordMessage.reactions.cache.values()) {
      if (reaction.me && !wanted.has(reaction.emoji.id ?? reaction.emoji.name)) await reaction.users.remove(ctx.client.user.id);
    }
    for (const emoji of missingReactions(message, discordMessage)) await discordMessage.react(emoji);
    return { ok: true };
  } catch {
    return { ok: false, reason: 'cannot_react' };
  }
}

async function embedPayload(ctx, guild, user, member, lang, embedName) {
  const spec = await getEmbed(ctx.db, guild.id, embedName);
  if (!spec) return { error: 'missing' };
  try {
    return { payload: await buildEmbedPayload(ctx, guild.id, spec, buildVars({ user, member, guild, lang })) };
  } catch (err) {
    return { error: err.message === 'image-not-found' ? 'image' : 'invalid' };
  }
}

/** Posts the named embed to `channel`. Returns `{ message }` or `{ error: 'missing' | 'image' | 'invalid' | 'cannot_send' }`. */
export async function postRoleMessage(ctx, interaction, lang, channel, embedName) {
  const built = await embedPayload(ctx, interaction.guild, interaction.user, interaction.member, lang, embedName);
  if (built.error) return built;
  const sent = await trySend(channel, { ...built.payload, allowedMentions: safeMentions() });
  return sent ? { message: sent } : { error: 'cannot_send' };
}

/** Re-renders the named embed onto the posted message, keeping its components. */
export async function refreshEmbed(ctx, interaction, lang, message, discordMessage) {
  const built = await embedPayload(ctx, interaction.guild, interaction.user, interaction.member, lang, message.embedName);
  if (built.error) return built;
  await discordMessage.edit({ ...built.payload, allowedMentions: safeMentions() });
  return { ok: true };
}
