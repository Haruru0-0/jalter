import { sendLog } from '../logging/send-log.js';
import { t } from '../../i18n/index.js';

export async function logVerification(ctx, guildId, lang, { kind, userId, actorId, detail }, deps = { sendLog }) {
  try {
    const fields = [];
    if (userId) fields.push({ name: t(lang, 'verification.log.member'), value: `<@${userId}>`, inline: true });
    if (actorId) fields.push({ name: t(lang, 'verification.log.actor'), value: `<@${actorId}>`, inline: true });
    if (detail) fields.push({ name: t(lang, 'verification.log.detail'), value: String(detail).slice(0, 1000) });
    await deps.sendLog(ctx, guildId, 'modAction', { title: t(lang, `verification.log.${kind}`), fields });
  } catch (err) {
    console.warn('verification log failed:', err?.message ?? err);
  }
}
