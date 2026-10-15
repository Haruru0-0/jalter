import { Events } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { fetchSendable, trySend } from '../../core/send.js';
import { ensureChannel, singleFlight, withBackoff } from '../../core/auto-channel.js';
import { safeMentions } from '../../core/mentions.js';
import { buildVars, renderPlaceholders } from '../../core/placeholders.js';
import { getEmbed, normalizeEmbedName } from '../embeds/store.js';
import { buildEmbedPayload } from '../embeds/render.js';
import { parseImageInput, resolveImage } from '../media/images.js';
import { getLang } from '../../i18n/index.js';
import { renderCard } from './card.js';
import { DEFAULT_MESSAGE, DM_KINDS } from './kinds.js';
import { AUTO_CHANNEL_NAME } from './config.js';
import { buildContent, ensureNotEmpty } from './message.js';

// Text plus the optional embed and card. Throws when an image or the card cannot be built;
// a missing embed only warns, so the text still goes out.
async function fullPayload(ctx, member, config, vars, content, embedNames) {
  const payload = content ? { content } : {};
  if (embedNames.length) {
    const name = normalizeEmbedName(embedNames[0]);
    const spec = name ? await getEmbed(ctx.db, member.guild.id, name) : null;
    if (spec) {
      Object.assign(payload, await buildEmbedPayload(ctx, member.guild.id, spec, vars));
    } else {
      console.warn(`Embed "${embedNames[0]}" not found for message in guild ${member.guild.id}`);
    }
  }
  if (config.card) {
    const background = config.background
      ? await resolveImage(ctx.db, ctx.client, member.guild.id, parseImageInput(config.background))
      : undefined;
    const attachment = await renderCard({
      username: vars.user_name,
      avatarUrl: vars.user_avatar || undefined,
      serverName: vars.server_name,
      background,
    });
    payload.files = [{ attachment, name: 'card.png' }];
  }
  return payload;
}

async function sendDm(member, payload) {
  try {
    await member.send({ ...payload, allowedMentions: { parse: [] } });
  } catch (err) {
    // The card file may be the problem: retry once without it.
    if (payload.files) {
      try {
        const { files: _files, ...withoutFiles } = payload;
        await member.send({ ...ensureNotEmpty(withoutFiles, payload.content ?? ''), allowedMentions: { parse: [] } });
        return;
      } catch { /* fall through to the warning */ }
    }
    console.warn(`Greet DM failed for ${member.id}:`, err.message);
  }
}

/**
 * Posts the greet, leave or boost message and the optional DM.
 * Returns 'sent' | 'off' | 'no-channel' | 'send-failed'. Never throws.
 */
export async function handleMember(ctx, member, kind) {
  try {
    const { enabled, config } = await getFeature(ctx.db, member.guild.id, kind);
    if (!enabled) return 'off';
    let channelId = config.channelId;
    if (!channelId) {
      // Enabled but no channel chosen: make one (one run at a time per guild and kind) and remember it.
      const key = `${member.guild.id}:${kind}`;
      channelId = await singleFlight(key, () => withBackoff(key, async () => {
        const fresh = await getFeature(ctx.db, member.guild.id, kind);
        if (fresh.config.channelId) return fresh.config.channelId;
        const created = await ensureChannel(member.guild, { name: AUTO_CHANNEL_NAME[kind] });
        if (!created) return null;
        await setFeature(ctx.db, member.guild.id, kind, { config: { channelId: created.id } });
        return created.id;
      }));
      if (!channelId) return 'no-channel';
    }
    // A partial member (left while uncached) normally still carries its user.
    if (!member.user) {
      console.warn(`Greet ${kind} skipped in ${member.guild.id}: member has no user data`);
      return 'send-failed';
    }
    const channel = await fetchSendable(ctx.client, channelId);
    if (!channel) {
      console.warn(`Channel for ${kind} missing in guild ${member.guild.id}`);
      return 'no-channel';
    }

    const lang = await getLang(ctx.db, member.guild.id);
    const vars = buildVars({ user: member.user, member, guild: member.guild, lang });
    const { content, embedNames } = buildContent(config.message ?? DEFAULT_MESSAGE[kind], vars);
    let payload;
    try {
      payload = await fullPayload(ctx, member, config, vars, content, embedNames);
    } catch (err) {
      console.warn(`Greet ${kind} extras failed in ${member.guild.id}, sending text only: ${err.message}`);
      payload = content ? { content } : {};
    }
    payload = ensureNotEmpty(payload, renderPlaceholders(DEFAULT_MESSAGE[kind], vars));

    const allowedMentions = kind === 'leave' ? safeMentions() : { parse: [], users: [member.id] };
    let sent = await trySend(channel, { ...payload, allowedMentions });
    if (!sent && (payload.embeds || payload.files)) {
      // Discord may refuse the embed or file (bad image URL, empty field): retry as text only.
      console.warn(`Greet ${kind} send refused in ${member.guild.id}, retrying as text only`);
      const textOnly = ensureNotEmpty(content ? { content } : {}, renderPlaceholders(DEFAULT_MESSAGE[kind], vars));
      sent = await trySend(channel, { ...textOnly, allowedMentions });
    }
    if (DM_KINDS.includes(kind) && config.dm) await sendDm(member, payload);
    return sent ? 'sent' : 'send-failed';
  } catch (err) {
    console.warn(`Greet ${kind} failed:`, err.message);
    return 'send-failed';
  }
}

export const events = [
  { name: Events.GuildMemberAdd, execute: (ctx, member) => handleMember(ctx, member, 'greet') },
  { name: Events.GuildMemberRemove, execute: (ctx, member) => handleMember(ctx, member, 'leave') },
  {
    name: Events.GuildMemberUpdate,
    execute: (ctx, oldMember, newMember) => {
      if (oldMember.partial) return;
      if (!oldMember.premiumSince && newMember.premiumSince) return handleMember(ctx, newMember, 'boost');
    },
  },
];
