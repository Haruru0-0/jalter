// Shared by the slash commands and the builder panel, so both apply the same rules.
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { isDangerousRole, botCanGive, callerCanGive } from '../../core/role-safety.js';
import { parseEmoji, checkEntryInput } from './config.js';
import { addEntry, getMessage } from './store.js';
import { syncMessage } from './render.js';

/** Why a role may not be offered, or 'ok'. */
export function checkRoleForSetup(guild, caller, role) {
  if (isDangerousRole(role)) return 'dangerous';
  if (!botCanGive(guild, role)) return 'bot_cannot';
  if (!callerCanGive(guild, caller, role)) return 'caller_cannot';
  return 'ok';
}

// Types that clear the member's reaction after a pick, which needs Manage Messages.
const CLEARS_REACTION = ['drop', 'verify', 'lock'];

/**
 * The first permission the bot lacks to run a role message of this style and type, as the name shown
 * in Discord, or null. `channel` is the message's channel; without it the guild-wide permissions are used.
 */
export function missingBotPermission(guild, channel, { style, type = 'normal' }) {
  const me = guild.members.me;
  const perms = channel?.permissionsFor?.(me) ?? me?.permissions;
  const needed = [['ManageRoles', 'Manage Roles']];
  if (style === 'reactions') {
    needed.push(['AddReactions', 'Add Reactions'], ['ReadMessageHistory', 'Read Message History']);
    if (CLEARS_REACTION.includes(type)) needed.push(['ManageMessages', 'Manage Messages']);
  }
  return needed.find(([flag]) => !perms?.has(flag))?.[1] ?? null;
}

/** Replies with the localized refusal for a missing bot permission; returns true when one was missing. */
export async function refuseMissingPermission(interaction, lang, channel, message) {
  const permission = missingBotPermission(interaction.guild, channel, message);
  if (!permission) return false;
  await interaction.reply(ephemeral(t(lang, 'reactionroles.needPermission', { permission })));
  return true;
}

// Replies "gone" and returns null when the id is unknown or belongs to another guild; else the stored message.
export async function loadMessage(interaction, ctx, lang) {
  const message = await getMessage(ctx.db, interaction.options.getString('message_id'));
  if (!message || message.guildId !== interaction.guildId) {
    await interaction.reply(ephemeral(t(lang, 'reactionroles.gone')));
    return null;
  }
  return message;
}

export async function fetchDiscordMessage(guild, message) {
  const channel = await guild.channels.fetch(message.channelId).catch(() => null);
  return channel ? channel.messages.fetch(message.messageId).catch(() => null) : null;
}

/**
 * Validates and stores one entry, then syncs the Discord message.
 * Returns 'ok' or a reason: role.<verdict>, emoji.<error>, emoji_required, label_required, full, duplicate, missing, sync.<reason>.
 */
export async function addOne(ctx, { guild, caller }, message, { role, emojiText, label }) {
  const verdict = checkRoleForSetup(guild, caller, role);
  if (verdict !== 'ok') return `role.${verdict}`;
  let emoji = null;
  if (emojiText) {
    const parsed = parseEmoji(emojiText, guild);
    if (parsed.error) return `emoji.${parsed.error}`;
    emoji = parsed.emoji;
  }
  const input = checkEntryInput(message.style, { emoji, label });
  if (input !== 'ok') return input;
  const result = await addEntry(ctx.db, message.messageId, { roleId: role.id, emoji, label: label ?? null });
  if (typeof result === 'string') return result;
  const fresh = await getMessage(ctx.db, message.messageId);
  const discordMessage = await fetchDiscordMessage(guild, fresh);
  if (discordMessage) {
    const synced = await syncMessage(ctx, fresh, discordMessage);
    if (!synced.ok) return `sync.${synced.reason}`;
  }
  return 'ok';
}
