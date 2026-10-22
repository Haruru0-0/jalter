import { Events } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { safe } from '../logging/send-log.js';
import { emojiKey } from './config.js';
import {
  getMessage, deleteMessage, deleteEntriesForRole, deleteMessagesInChannel, clearMemberBindings, removeRoleFromLists,
} from './store.js';
import { applyPick } from './apply.js';
import { syncMessage } from './render.js';

async function isOn(ctx, guildId) {
  return (await getFeature(ctx.db, guildId, 'reactionroles')).enabled;
}

// Partial reactions and messages must be fetched before use, and a user only when its bot flag is unknown;
// false means "ignore this event". Called only for a stored message of a guild with the feature on.
async function hydrate(reaction, user) {
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (user.bot == null && user.partial) await user.fetch();
    return !user.bot;
  } catch {
    return false;
  }
}

/** Builds the event list; tests pass fakes for `applyPick`. */
export function createEvents(deps = {}) {
  const apply = deps.applyPick ?? applyPick;

  const onReaction = (action) => async (ctx, reaction, user) => {
    if (user.bot || user.id === ctx.client.user?.id) return;
    // The ids are there even on partials: check that the message is ours and the feature is on before any REST call.
    const guildId = reaction.message.guildId;
    if (!guildId) return;
    const message = await getMessage(ctx.db, reaction.message.id);
    if (!message || message.guildId !== guildId || message.style !== 'reactions' || !(await isOn(ctx, guildId))) return;
    if (!(await hydrate(reaction, user))) return;
    const guild = reaction.message.guild;
    if (!guild) return;
    const key = reaction.emoji.id ?? reaction.emoji.name;
    const entry = message.entries.find((e) => e.emoji && emojiKey(e.emoji) === key);
    if (!entry) {
      // Not one of ours: a stray reaction on a role message is cleaned up.
      if (action === 'add') await reaction.users.remove(user.id).catch(() => {});
      return;
    }
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;
    const result = await apply(ctx, member, message, { kind: 'entry', entry, action });
    // Every refusal of an add clears the reaction except a `nothing` on normal, unique or reversed (the reaction
    // matches the member's state there) and an unexpected failure on reversed (clearing it would grant the role).
    if (result.clearReaction) await reaction.users.remove(user.id).catch(() => {});
    // A unique pick drops the member's other reactions on this message.
    for (const roleId of result.removed ?? []) {
      const old = message.entries.find((e) => e.roleId === roleId && e.emoji);
      const oldReaction = old && reaction.message.reactions.cache.get(emojiKey(old.emoji));
      if (oldReaction && old !== entry) await oldReaction.users.remove(user.id).catch(() => {});
    }
  };

  const onMessageDelete = async (ctx, message) => {
    await deleteMessage(ctx.db, message.id);
  };

  const onBulkDelete = async (ctx, messages) => {
    for (const id of messages.keys()) await deleteMessage(ctx.db, id);
  };

  const onRoleDelete = async (ctx, role) => {
    const guildId = role.guild.id;
    await removeRoleFromLists(ctx.db, guildId, role.id);
    const affected = await deleteEntriesForRole(ctx.db, guildId, role.id);
    for (const messageId of affected) {
      // One message that fails to sync must not stop the others.
      try {
        const message = await getMessage(ctx.db, messageId);
        const channel = message && (await role.guild.channels.fetch(message.channelId).catch(() => null));
        const discordMessage = channel && (await channel.messages.fetch(messageId).catch(() => null));
        if (discordMessage) await syncMessage(ctx, message, discordMessage);
      } catch (err) {
        console.warn(`Reaction role sync after role delete failed for ${messageId}: ${err?.message ?? err}`);
      }
    }
  };

  const onChannelDelete = async (ctx, channel) => {
    if (channel.guild) await deleteMessagesInChannel(ctx.db, channel.guild.id, channel.id);
  };

  const onMemberRemove = async (ctx, member) => {
    if (member.guild) await clearMemberBindings(ctx.db, member.guild.id, member.id);
  };

  return [
    { name: Events.MessageReactionAdd, execute: safe('rrReactionAdd', onReaction('add')) },
    { name: Events.MessageReactionRemove, execute: safe('rrReactionRemove', onReaction('remove')) },
    { name: Events.MessageDelete, execute: safe('rrMessageDelete', onMessageDelete) },
    { name: Events.MessageBulkDelete, execute: safe('rrBulkDelete', onBulkDelete) },
    { name: Events.GuildRoleDelete, execute: safe('rrRoleDelete', onRoleDelete) },
    { name: Events.ChannelDelete, execute: safe('rrChannelDelete', onChannelDelete) },
    { name: Events.GuildMemberRemove, execute: safe('rrMemberRemove', onMemberRemove) },
  ];
}

export const events = createEvents();
