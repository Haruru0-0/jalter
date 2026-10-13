import { t } from '../../i18n/index.js';
import { validateEmbed } from './model.js';

export const errorText = (lang, errors) => errors.map((e) => `• ${t(lang, e)}`).join('\n');

const YES = new Set(['yes', 'y', 'true', '1', 'oui', 'o', 'نعم']);

// "Inline" answer from the add-field form: yes in English, French or Arabic means inline.
export function parseInline(value) {
  return YES.has((value ?? '').trim().toLowerCase());
}

// Returns { ok: true, spec } with the field appended (spec is not changed), or { ok: false, errors }.
export function appendField(spec, { name, value, inline }) {
  const field = { name: (name ?? '').trim(), value: (value ?? '').trim(), inline: Boolean(inline) };
  if (!field.name || !field.value) return { ok: false, errors: ['embeds.err.fieldEmpty'] };
  const next = { ...spec, fields: [...(spec.fields ?? []), field] };
  const check = validateEmbed(next);
  return check.ok ? { ok: true, spec: next } : { ok: false, errors: check.errors };
}
