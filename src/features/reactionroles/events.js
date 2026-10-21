import { Events } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { safe } from '../logging/send-log.js';
import { emojiKey } from './config.js';
import {
  getMessage, deleteMessage, deleteEntriesForRole, deleteMessagesInChannel, clearMemberBindings,
} from './store.js';
import { applyPick } from './apply.js';
import { syncMessage } from './render.js';

async function isOn(ctx, guildId) {
  return (await getFeature(ctx.db, guildId, 'reactionroles')).enabled;
}

// Partial reactions, messages and users must be fetched before use; false means "ignore this event".
async function hydrate(reaction, user) {
  try {
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.partial) await reaction.message.fetch();
    if (user.partial) await user.fetch();
    return true;
  } catch {
    return false;
  }
}

/** Builds the event list; tests pass fakes for `applyPick`. */
export function createEvents(deps = {}) {
  const apply = deps.applyPick ?? applyPick;

  const onReaction = (action) => async (ctx, reaction, user) => {
    if (user.bot || user.id === ctx.client.user?.id) return;
    if (!(await hydrate(reaction, user))) return;
    const guild = reaction.message.guild;
    if (!guild) return;
    const message = await getMessage(ctx.db, reaction.message.id);
    if (!message || message.style !== 'reactions' || !(await isOn(ctx, guild.id))) return;
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
    // applyPick sets clearReaction on every refusal of an add, so this also covers refused picks.
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
    const affected = await deleteEntriesForRole(ctx.db, role.guild.id, role.id);
    for (const messageId of affected) {
      const message = await getMessage(ctx.db, messageId);
      const channel = message && (await role.guild.channels.fetch(message.channelId).catch(() => null));
      const discordMessage = channel && (await channel.messages.fetch(messageId).catch(() => null));
      if (discordMessage) await syncMessage(ctx, message, discordMessage);
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
