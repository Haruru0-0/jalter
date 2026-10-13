export function validateEmbed(spec) {
  const errors = [];
  const fields = spec.fields ?? [];
  const len = (s) => (s ? s.length : 0);

  if (!spec.title && !spec.description && !spec.image && fields.length === 0) {
    errors.push('embeds.err.empty');
  }
  if (len(spec.title) > 256) errors.push('embeds.err.titleTooLong');
  if (len(spec.description) > 4096) errors.push('embeds.err.descriptionTooLong');
  if (len(spec.footer) > 2048) errors.push('embeds.err.footerTooLong');
  if (fields.length > 25) errors.push('embeds.err.tooManyFields');
  if (fields.some((f) => len(f.name) > 256 || len(f.value) > 1024)) {
    errors.push('embeds.err.fieldTooLong');
  }
  const total =
    len(spec.title) + len(spec.description) + len(spec.footer) +
    fields.reduce((sum, f) => sum + len(f.name) + len(f.value), 0);
  if (total > 6000) errors.push('embeds.err.tooLarge');
  if (spec.color && !/^#[0-9a-fA-F]{6}$/.test(spec.color)) errors.push('embeds.err.badColor');

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function toDiscordEmbed(spec, images = {}) {
  const embed = {};
  if (spec.title) embed.title = spec.title;
  if (spec.description) embed.description = spec.description;
  if (spec.color) embed.color = parseInt(spec.color.slice(1), 16);
  if (spec.footer) embed.footer = { text: spec.footer };
  if (images.image) embed.image = { url: images.image };
  if (images.thumbnail) embed.thumbnail = { url: images.thumbnail };
  if (spec.fields?.length) {
    embed.fields = spec.fields.map((f) => ({ name: f.name, value: f.value, inline: Boolean(f.inline) }));
  }
  return embed;
}
