import { t } from '../../i18n/index.js';

export function truncate(text, max = 1024) {
  if (text === null || text === undefined || text === '') return '—';
  return text.length > max ? text.slice(0, max) : text;
}

function contentOrUnavailable(lang, content) {
  return content === null || content === undefined
    ? t(lang, 'logging.contentUnavailable')
    : truncate(content);
}

export function formatMessageEdit(before, after, lang) {
  return {
    title: t(lang, 'logging.messageEdited'),
    description: `${after.author?.username ?? '?'} in <#${after.channelId}> [${t(lang, 'logging.jump')}](${after.url ?? ''})`,
    fields: [
      { name: t(lang, 'logging.before'), value: contentOrUnavailable(lang, before.content) },
      { name: t(lang, 'logging.after'), value: truncate(after.content) },
    ],
  };
}

export function formatMessageDelete(message, lang) {
  return {
    title: t(lang, 'logging.messageDeleted'),
    description: `${message.author?.username ?? '?'} in <#${message.channelId}>`,
    fields: [{ name: t(lang, 'logging.content'), value: contentOrUnavailable(lang, message.content) }],
  };
}

export function diffRoles(oldIds, newIds) {
  const before = new Set(oldIds);
  const after = new Set(newIds);
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id)),
  };
}

const mentions = (ids) => truncate(ids.map((id) => `<@&${id}>`).join(' '));

export function formatRoleChange(userId, { added, removed }, lang) {
  const fields = [];
  if (added.length) fields.push({ name: t(lang, 'logging.rolesAdded'), value: mentions(added) });
  if (removed.length) fields.push({ name: t(lang, 'logging.rolesRemoved'), value: mentions(removed) });
  return { title: t(lang, 'logging.rolesChanged'), description: `<@${userId}>`, fields };
}

export function formatRename(title, oldName, newName, lang) {
  return {
    title,
    fields: [
      { name: t(lang, 'logging.before'), value: truncate(oldName) },
      { name: t(lang, 'logging.after'), value: truncate(newName) },
    ],
  };
}

export function withExecutor(embed, executorId, lang) {
  if (!executorId) return embed;
  return { ...embed, fields: [...(embed.fields ?? []), { name: t(lang, 'logging.by'), value: `<@${executorId}>` }] };
}
