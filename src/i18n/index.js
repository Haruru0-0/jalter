import { readFileSync } from 'node:fs';
import { getFeature } from '../db/settings.js';

const load = (lang) =>
  JSON.parse(readFileSync(new URL(`./${lang}.json`, import.meta.url), 'utf8'));

export const LANGS = ['en', 'ar', 'fr'];
const STRINGS = Object.fromEntries(LANGS.map((l) => [l, load(l)]));

export function createT(strings) {
  return (lang, key, vars = {}) => {
    const text = strings[lang]?.[key] ?? strings.en?.[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
      name in vars ? String(vars[name]) : match,
    );
  };
}

export const t = createT(STRINGS);

export async function getLang(db, guildId) {
  const { config } = await getFeature(db, guildId, 'language');
  return LANGS.includes(config.lang) ? config.lang : 'en';
}

export const isRtl = (lang) => lang === 'ar';
