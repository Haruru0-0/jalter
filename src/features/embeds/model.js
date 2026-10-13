import { renderPlaceholders } from '../../core/placeholders.js';

export function imageSource(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (value.type === 'url') return value.url;
  if (value.type === 'stored') return value.name;
  return undefined;
}

export function validateEmbed(spec, { allowEmpty = false } = {}) {
  const errors = [];
  const fields = spec.fields ?? [];
  const len = (s) => (s ? s.length : 0);
  const authorText = spec.author?.text;

  if (
    !allowEmpty &&
    !spec.title && !spec.description && !spec.image && !spec.thumbnail &&
    !authorText && !spec.footer && fields.length === 0
  ) {
    errors.push('embeds.err.empty');
  }
  if (len(spec.title) > 256) errors.push('embeds.err.titleTooLong');
  if (len(spec.description) > 4096) errors.push('embeds.err.descriptionTooLong');
  if (len(spec.footer) > 2048) errors.push('embeds.err.footerTooLong');
  if (len(authorText) > 256) errors.push('embeds.err.authorTooLong');
  if (spec.author?.icon && !authorText) errors.push('embeds.err.authorNeedsText');
  if (fields.length > 25) errors.push('embeds.err.tooManyFields');
  if (fields.some((f) => len(f.name) > 256 || len(f.value) > 1024)) {
    errors.push('embeds.err.fieldTooLong');
  }
  const total =
    len(spec.title) + len(spec.description) + len(spec.footer) + len(authorText) +
    fields.reduce((sum, f) => sum + len(f.name) + len(f.value), 0);
  if (total > 6000) errors.push('embeds.err.tooLarge');
  if (spec.color && !/^#[0-9a-fA-F]{6}$/.test(spec.color)) errors.push('embeds.err.badColor');

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function toDiscordEmbed(spec, images = {}, { now } = {}) {
  const embed = {};
  if (spec.title) embed.title = spec.title;
  if (spec.description) embed.description = spec.description;
  if (spec.color) embed.color = parseInt(spec.color.slice(1), 16);
  if (spec.author?.text) {
    embed.author = { name: spec.author.text };
    if (images.authorIcon) embed.author.icon_url = images.authorIcon;
  }
  if (spec.footer) embed.footer = { text: spec.footer };
  if (images.image) embed.image = { url: images.image };
  if (images.thumbnail) embed.thumbnail = { url: images.thumbnail };
  if (spec.timestamp) embed.timestamp = new Date(now ?? Date.now()).toISOString();
  if (spec.fields?.length) {
    embed.fields = spec.fields.map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }));
  }
  return embed;
}

export function renderEmbedSpec(spec, vars) {
  const out = { ...spec };
  const render = (text) => renderPlaceholders(text, vars);
  for (const key of ['title', 'description', 'footer']) {
    if (out[key]) out[key] = render(out[key]);
  }
  for (const key of ['image', 'thumbnail']) {
    if (spec[key] === undefined) continue;
    const rendered = render(imageSource(spec[key]));
    if (rendered) out[key] = rendered;
    else delete out[key];
  }
  if (spec.author) {
    const author = { ...spec.author };
    if (author.text) author.text = render(author.text);
    if (author.icon !== undefined) {
      const icon = render(imageSource(author.icon));
      if (icon) author.icon = icon;
      else delete author.icon;
    }
    out.author = author;
  }
  if (spec.fields) {
    out.fields = spec.fields.map((f) => ({ ...f, name: render(f.name), value: render(f.value) }));
  }
  return out;
}
