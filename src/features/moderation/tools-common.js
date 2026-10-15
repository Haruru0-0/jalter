import { canUseAction, ACTION_PERMISSIONS } from './rules.js';
import { trySend } from '../../core/send.js';
import { sendLog as defaultSendLog } from '../logging/send-log.js';
import { t } from '../../i18n/index.js';

/**
 * Shared checks for the channel tools. `botPermissions` lists what the bot needs in `channel`
 * (always ViewChannel plus the action's own permission). Send Messages is never required: a locked
 * channel denies it to the bot as well, and public notices are best effort.
 */
export function checkToolAccess({ interaction, action, config, channel, botPermissions }) {
  if (!canUseAction(interaction.member, action, config)) return { ok: false, reason: 'not_allowed' };
  if (!channel) return { ok: false, reason: 'bad_channel' };
  if (!channel.permissionsFor(interaction.member)?.has('ViewChannel')) return { ok: false, reason: 'no_view' };
  const botPerms = channel.permissionsFor(interaction.guild.members.me);
  const needed = new Set(['ViewChannel', ACTION_PERMISSIONS[action], ...(botPermissions ?? [])]);
  for (const p of needed) {
    if (!botPerms?.has(p)) return { ok: false, reason: 'bot_missing' };
  }
  return { ok: true };
}

/** Best-effort send; true when a message was posted. */
export async function postNotice(channel, payload) {
  if (!channel) return false;
  return Boolean(await trySend(channel, payload));
}

/** Writes one `mod` log line for a channel tool. Never throws. */
export async function logTool(ctx, guild, lang, { tool, actorId, channelId, detail, reason }, deps = {}) {
  try {
    const send = deps.sendLog ?? defaultSendLog;
    const fields = [
      { name: t(lang, 'moderation.tools.log.moderator'), value: `<@${actorId}>`, inline: true },
      { name: t(lang, 'moderation.tools.log.channel'), value: `<#${channelId}>`, inline: true },
    ];
    if (detail) fields.push({ name: '​', value: String(detail) });
    if (reason) fields.push({ name: t(lang, 'moderation.tools.log.reason'), value: String(reason) });
    await send(ctx, guild.id, 'modAction', { title: t(lang, 'moderation.tools.log.title', { tool }), fields });
  } catch (err) {
    console.warn(`Could not write tool log: ${err.message}`);
  }
}
