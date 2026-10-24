import { getFeature } from '../../db/settings.js';
import { ruleOf } from './store.js';

const FEATURE = 'autoresponder';

// guildId -> enabled rules ([] while the feature is off, so an off guild costs no read per message).
// Hot path only: list/show commands must read the store, never this cache.
const cache = new Map();
// Bumped by invalidate; a load that started before a bump must not be cached.
const generations = new Map();
const generationOf = (guildId) => generations.get(guildId) ?? 0;

export async function getRules(db, guildId) {
  const hit = cache.get(guildId);
  if (hit) return hit;
  const generation = generationOf(guildId);
  const { enabled } = await getFeature(db, guildId, FEATURE);
  let rules = [];
  if (enabled) {
    const { rows } = await db.query(
      'SELECT * FROM autoresponder_rules WHERE guild_id = $1 AND enabled ORDER BY id', [guildId]);
    rules = rows.map(ruleOf);
  }
  if (generationOf(guildId) === generation) cache.set(guildId, rules);
  return rules;
}

/** Call on every rule change and on enable/disable. */
export function invalidate(guildId) {
  generations.set(guildId, generationOf(guildId) + 1);
  cache.delete(guildId);
}

export function clearCache() {
  cache.clear();
}
