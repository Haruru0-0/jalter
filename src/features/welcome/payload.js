import { renderTemplate } from '../../core/templates.js';
import { t } from '../../i18n/index.js';
import { toDiscordEmbed } from '../embeds/model.js';

export const DEFAULT_TEXT = {
  join: 'Welcome {user} to {server}! You are member #{count}.',
  leave: '{username} left {server}.',
  boost: 'Thank you {user} for boosting {server}!',
};

function renderEmbedText(spec, vars) {
  const r = (s) => (s ? renderTemplate(s, vars) : s);
  return {
    ...spec,
    title: r(spec.title),
    description: r(spec.description),
    footer: r(spec.footer),
    fields: spec.fields?.map((f) => ({ ...f, name: r(f.name), value: r(f.value) })),
  };
}

/**
 * Builds the message for a welcome event. In embed style the description is the
 * event's editable text and the title is cfg.embed.title when set, otherwise a
 * localized per-event default.
 */
export function buildWelcomePayload(cfg, vars, { images = {}, card = null, event = 'join', lang = 'en' } = {}) {
  const text = cfg.text ?? DEFAULT_TEXT[event] ?? '';
  if (cfg.style === 'embed') {
    const spec = {
      ...(cfg.embed ?? {}),
      title: cfg.embed?.title || t(lang, `welcome.title.${event}`),
      description: text || undefined,
    };
    return { embeds: [toDiscordEmbed(renderEmbedText(spec, vars), images)] };
  }
  if (cfg.style === 'card' && card) {
    const payload = { files: [{ attachment: card, name: 'welcome.png' }] };
    if (text) payload.content = renderTemplate(text, vars);
    return payload;
  }
  return { content: renderTemplate(text, vars) };
}

// The config patch that sets (ref) or clears (null) the image for one welcome event:
// the card background in card style, otherwise the embed image.
export function imagePatch(current, ref) {
  if (current.style === 'card') return { background: ref };
  const embed = { ...(current.embed ?? {}) };
  if (ref) embed.image = ref;
  else delete embed.image;
  return { embed };
}
