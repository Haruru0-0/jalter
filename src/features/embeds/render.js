import { MessageFlags } from 'discord.js';
import { ephemeral } from '../../core/replies.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { safeMentions } from '../../core/mentions.js';
import { memberCanPost } from '../../core/permissions.js';
import { buildVars } from '../../core/placeholders.js';
import { t } from '../../i18n/index.js';
import { imageSource, renderEmbedSpec, toDiscordEmbed, validateEmbed } from './model.js';
import { parseImageInput, resolveImage } from '../media/images.js';
import { errorText } from './spec.js';

async function resolve(ctx, guildId, value) {
  return value ? resolveImage(ctx.db, ctx.client, guildId, parseImageInput(value)) : undefined;
}

/**
 * Renders placeholders, validates the rendered spec, resolves its images and builds the payload.
 * Throws `embed-invalid` (with `.errors`) or `image-not-found`.
 */
export async function buildEmbedPayload(ctx, guildId, spec, vars, { now } = {}) {
  const rendered = renderEmbedSpec(spec, vars);
  const check = validateEmbed(rendered);
  if (!check.ok) throw Object.assign(new Error('embed-invalid'), { errors: check.errors });
  const images = {
    image: await resolve(ctx, guildId, imageSource(rendered.image)),
    thumbnail: await resolve(ctx, guildId, imageSource(rendered.thumbnail)),
    authorIcon: await resolve(ctx, guildId, imageSource(rendered.author?.icon)),
    footerIcon: await resolve(ctx, guildId, imageSource(rendered.footerIcon)),
  };
  return { embeds: [toDiscordEmbed(rendered, images, { now })] };
}

// A text channel in the same guild the bot can see, or null.
export async function fetchGuildSendable(client, guildId, channelId) {
  const channel = await fetchSendable(client, channelId);
  return channel && channel.guildId === guildId ? channel : null;
}

/**
 * Validates, renders, resolves and posts an embed spec to a channel, answering the interaction.
 * Nothing is sent when an image is missing. Returns the sent message or null.
 * Never leaves the interaction unanswered.
 */
export async function sendEmbedSpec(interaction, ctx, lang, spec, channelId) {
  const check = validateEmbed(spec);
  if (!check.ok) {
    await interaction.reply(ephemeral(errorText(lang, check.errors)));
    return null;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const vars = buildVars({ user: interaction.user, member: interaction.member, guild: interaction.guild, lang });
    let payload;
    try {
      payload = await buildEmbedPayload(ctx, interaction.guildId, spec, vars);
    } catch (err) {
      if (err.message === 'image-not-found') {
        await interaction.editReply(t(lang, 'embeds.imageMissing'));
        return null;
      }
      if (err.message === 'embed-invalid') {
        await interaction.editReply(errorText(lang, err.errors));
        return null;
      }
      throw err;
    }
    const channel = await fetchGuildSendable(ctx.client, interaction.guildId, channelId);
    if (channel && !memberCanPost(channel, interaction.member)) {
      await interaction.editReply(t(lang, 'common.cannotPostThere'));
      return null;
    }
    const sent = channel ? await trySend(channel, { ...payload, allowedMentions: safeMentions() }) : null;
    await interaction.editReply(t(lang, sent ? 'embeds.sent' : 'embeds.cannotSend'));
    return sent;
  } catch (err) {
    console.error('Embed send failed:', err);
    await interaction.editReply(t(lang, 'embeds.cannotSend')).catch(() => {});
    return null;
  }
}
