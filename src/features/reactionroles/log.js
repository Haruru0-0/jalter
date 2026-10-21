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
