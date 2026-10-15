import { t } from '../../i18n/index.js';
import { formatDuration } from '../../core/duration.js';

const FIELD_MAX = 1024;

const clip = (text) => (text.length > FIELD_MAX ? text.slice(0, FIELD_MAX) : text);

/** The mod log embed for one case. */
export function formatCase(modCase, lang) {
  const fields = [
    { name: t(lang, 'moderation.case.target'), value: `<@${modCase.targetId}>`, inline: true },
    { name: t(lang, 'moderation.case.moderator'), value: `<@${modCase.moderatorId}>`, inline: true },
  ];
  if (modCase.durationMs) {
    fields.push({
      name: t(lang, 'moderation.case.duration'),
      value: formatDuration(modCase.durationMs / 1000),
      inline: true,
    });
  }
  fields.push({
    name: t(lang, 'moderation.case.reason'),
    value: modCase.reason ? clip(modCase.reason) : t(lang, 'moderation.case.noReason'),
  });
  return {
    title: t(lang, 'moderation.case.title', {
      number: modCase.number,
      type: t(lang, `moderation.type.${modCase.type}`),
    }),
    fields,
  };
}

/** The DM sent to the offender. `caseNumber` is null when it is not known yet. */
export function dmText(lang, type, { guildName, reason, durationSeconds, caseNumber } = {}) {
  const lines = [t(lang, `moderation.dm.${type}`, { server: guildName ?? '' })];
  if (durationSeconds) {
    lines.push(t(lang, 'moderation.dm.duration', { duration: formatDuration(durationSeconds) }));
  }
  if (reason) lines.push(t(lang, 'moderation.dm.reason', { reason }));
  if (caseNumber) lines.push(t(lang, 'moderation.dm.case', { number: caseNumber }));
  return lines.join('\n');
}
