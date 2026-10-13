import { t } from '../../i18n/index.js';
import { parseImageInput } from '../media/images.js';

export const errorText = (lang, errors) => errors.map((e) => `• ${t(lang, e)}`).join('\n');

// Builds an embed spec from text values; `get(id)` returns the raw value for a field.
export function specFromFields(get) {
  const value = (id) => (get(id) ?? '').trim();
  const spec = {};
  for (const key of ['title', 'description', 'color', 'footer']) {
    if (value(key)) spec[key] = value(key);
  }
  if (value('image')) spec.image = parseImageInput(value('image'));
  return spec;
}

// Builds an embed spec from /embed quick options ({ title, description, color, image }).
export function quickSpec(options) {
  return specFromFields((id) => options[id]);
}
