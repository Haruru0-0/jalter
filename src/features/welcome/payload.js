import { renderTemplate } from '../../core/templates.js';
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

export function buildWelcomePayload(cfg, vars, { images = {}, card = null }) {
  if (cfg.style === 'embed' && cfg.embed) {
    return { embeds: [toDiscordEmbed(renderEmbedText(cfg.embed, vars), images)] };
  }
  if (cfg.style === 'card' && card) {
    const payload = { files: [{ attachment: card, name: 'welcome.png' }] };
    if (cfg.text) payload.content = renderTemplate(cfg.text, vars);
    return payload;
  }
  return { content: renderTemplate(cfg.text, vars) };
}
