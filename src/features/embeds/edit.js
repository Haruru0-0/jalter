import { validateEmbed } from './model.js';
import { appendField } from './spec.js';

const STRING_PARTS = new Set(['title', 'description', 'footer', 'color', 'thumbnail', 'image']);

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

function withPart(spec, key, value) {
  const next = { ...spec };
  if (value === undefined || value === false || value === '') delete next[key];
  else next[key] = value;
  return next;
}

/**
 * Applies one edit to an embed spec without changing the original.
 * Returns { ok: true, spec } or { ok: false, errors }.
 */
export function applyEdit(spec, part, value) {
  let next;
  if (STRING_PARTS.has(part)) {
    next = withPart(spec, part, clean(value));
  } else if (part === 'timestamp') {
    next = withPart(spec, 'timestamp', value === true ? true : undefined);
  } else if (part === 'author') {
    const text = clean(value?.text);
    const icon = clean(value?.icon);
    if (!text && icon) return { ok: false, errors: ['embeds.err.authorNeedsText'] };
    next = withPart(spec, 'author', text ? { text, ...(icon ? { icon } : {}) } : undefined);
  } else if (part === 'field') {
    return appendField(spec, value ?? {});
  } else if (part === 'clear-fields') {
    next = withPart(spec, 'fields', undefined);
  } else {
    throw new Error(`unknown embed part: ${part}`);
  }
  const check = validateEmbed(next, { allowEmpty: true });
  return check.ok ? { ok: true, spec: next } : { ok: false, errors: check.errors };
}

// Applies [part, value] pairs in order and stops at the first error.
export function applyEdits(spec, edits) {
  let current = spec;
  for (const [part, value] of edits) {
    const result = applyEdit(current, part, value);
    if (!result.ok) return result;
    current = result.spec;
  }
  return { ok: true, spec: current };
}
