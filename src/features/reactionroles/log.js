import { sendLog } from '../logging/send-log.js';
import { t } from '../../i18n/index.js';

// Mirrors the verification logging helper. Sends one mod-log embed to staff when we refuse a grant
// because the bot can no longer hand out the role (role hierarchy changed, role deleted, etc.).
export async function logRoleDanger(ctx, guildId, lang, { messageId, roleId }, deps = { sendLog }) {
  try {
    await deps.sendLog(ctx, guildId, 'modAction', { description: t(lang, 'reactionroles.log.danger', { message: String(messageId), role: `<@&${roleId}>` }) });
  } catch (err) {
    console.warn('reactionroles log failed:', err?.message ?? err);
  }
}

/** One `mod` log line for a staff action on a role message. Never throws. */
export async function logReactionRoles(ctx, guild, lang, { action, actorId, messageId, detail }, deps = {}) {
  try {
    const send = deps.sendLog ?? sendLog;
    const fields = [
      { name: t(lang, 'reactionroles.log.moderator'), value: `<@${actorId}>`, inline: true },
      { name: t(lang, 'reactionroles.log.message'), value: String(messageId), inline: true },
    ];
    if (detail) fields.push({ name: '​', value: String(detail) });
    await send(ctx, guild.id, 'modAction', { title: t(lang, 'reactionroles.log.title', { action }), fields });
  } catch (err) {
    console.warn(`Could not write reaction roles log: ${err.message}`);
  }
}
