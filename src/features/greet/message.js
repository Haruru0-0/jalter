import { extractEmbedRefs, renderPlaceholders } from '../../core/placeholders.js';

/** Renders placeholders and pulls `{embed:name}` tags out. `content` is '' when only a tag was written. */
export function buildContent(rawMessage, vars) {
  const { text, names } = extractEmbedRefs(rawMessage);
  return { content: (renderPlaceholders(text, vars) ?? '').trim(), embedNames: names };
}

/** A message is never empty: when nothing would be sent, the fallback text becomes the content. */
export function ensureNotEmpty(payload, fallbackText) {
  if (payload.content || payload.embeds?.length || payload.files?.length) return payload;
  return { ...payload, content: fallbackText };
}
