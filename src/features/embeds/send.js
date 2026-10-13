import { MessageFlags } from 'discord.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { safeMentions } from '../../core/mentions.js';
import { t } from '../../i18n/index.js';
import { toDiscordEmbed, validateEmbed } from './model.js';
import { resolveImage } from '../media/images.js';
import { errorText } from './spec.js';

export async function buildEmbedPayload(ctx, guildId, spec) {
  const images = {};
  if (spec.image) images.image = await resolveImage(ctx.db, ctx.client, guildId, spec.image);
  if (spec.thumbnail) images.thumbnail = await resolveImage(ctx.db, ctx.client, guildId, spec.thumbnail);
  return { embeds: [toDiscordEmbed(spec, images)] };
}

// A text channel in the same guild the bot can see, or null.
export async function fetchGuildSendable(client, guildId, channelId) {
  const channel = await fetchSendable(client, channelId);
  return channel && channel.guildId === guildId ? channel : null;
}

/**
 * Validates, resolves and posts an embed spec to a channel, answering the interaction.
 * `ns` picks the reply keys (`embeds` or `post`). Nothing is sent when an image is missing.
 * Returns the sent message or null. Never leaves the interaction unanswered.
 */
export async function sendEmbedSpec(interaction, ctx, lang, spec, channelId, ns = 'embeds') {
  const check = validateEmbed(spec);
  if (!check.ok) {
    await interaction.reply(ephemeral(errorText(lang, check.errors)));
    return null;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    let payload;
    try {
      payload = await buildEmbedPayload(ctx, interaction.guildId, spec);
    } catch (err) {
      if (err.message !== 'image-not-found') throw err;
      await interaction.editReply(t(lang, 'embeds.imageMissing'));
      return null;
    }
    const channel = await fetchGuildSendable(ctx.client, interaction.guildId, channelId);
    const sent = channel ? await trySend(channel, { ...payload, allowedMentions: safeMentions() }) : null;
    await interaction.editReply(t(lang, sent ? `${ns}.sent` : `${ns}.cannotSend`));
    return sent;
  } catch (err) {
    console.error('Embed send failed:', err);
    await interaction.editReply(t(lang, `${ns}.cannotSend`)).catch(() => {});
    return null;
  }
}
