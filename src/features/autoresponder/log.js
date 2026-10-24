import { sendLog } from '../logging/send-log.js';
import { t } from '../../i18n/index.js';
import { createThrottle } from './throttle.js';

const runErrorThrottle = createThrottle(60 * 60 * 1000);

/** One `modAction` log line for a staff action on an autoresponder rule. Never throws. */
export async function logAutoresponder(ctx, guild, lang, { action, actorId, ruleId, detail }, deps = {}) {
  try {
    const send = deps.sendLog ?? sendLog;
    const fields = [
      { name: t(lang, 'autoresponder.log.moderator'), value: `<@${actorId}>`, inline: true },
      { name: t(lang, 'autoresponder.log.rule'), value: String(ruleId), inline: true },
    ];
    if (detail) fields.push({ name: '​', value: String(detail) });
    await send(ctx, guild.id, 'modAction', { title: t(lang, 'autoresponder.log.title', { action }), fields });
  } catch (err) {
    console.warn(`Could not write autoresponder log: ${err?.message ?? err}`);
  }
}

/** Tells staff a rule failed at run time: at most one line per rule per hour. Never throws. */
export async function logRunError(ctx, guild, lang, { ruleId, errors }, deps = {}) {
  try {
    if (!errors?.length) return;
    const throttle = deps.throttle ?? runErrorThrottle;
    if (!throttle.allow(`${guild.id}:${ruleId}`)) return;
    const send = deps.sendLog ?? sendLog;
    const lines = errors.map((e) => `${t(lang, `autoresponder.run.${e.code}`)} (${e.action}${e.detail ? `: ${e.detail}` : ''})`);
    await send(ctx, guild.id, 'modAction', {
      title: t(lang, 'autoresponder.log.error'),
      fields: [
        { name: t(lang, 'autoresponder.log.rule'), value: String(ruleId), inline: true },
        { name: '​', value: lines.join('\n').slice(0, 1024) },
      ],
    });
  } catch (err) {
    console.warn(`Could not write autoresponder error log: ${err?.message ?? err}`);
  }
}
