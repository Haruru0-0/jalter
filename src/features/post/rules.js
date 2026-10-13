import { extractRoleIds } from '../../core/mentions.js';

export function rolesToPing(text, allowRolePing) {
  if (!allowRolePing) return [];
  return [...new Set(extractRoleIds(text))].slice(0, 100);
}

export function isHttpUrl(value) {
  if (!/^https?:\/\/\S+$/i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}
