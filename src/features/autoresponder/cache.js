import { getFeature } from '../../db/settings.js';
import { ruleOf } from './store.js';

const FEATURE = 'autoresponder';

// guildId -> enabled rules ([] while the feature is off, so an off guild costs no read per message).
// Hot path only: list/show commands must read the store, never this cache.
const cache = new Map();

export async function getRules(db, guildId) {
  const hit = cache.get(guildId);
  if (hit) return hit;
  const { enabled } = await getFeature(db, guildId, FEATURE);
  let rules = [];
  if (enabled) {
    const { rows } = await db.query(
      'SELECT * FROM autoresponder_rules WHERE guild_id = $1 AND enabled ORDER BY id', [guildId]);
    rules = rows.map(ruleOf);
  }
  cache.set(guildId, rules);
  return rules;
}

/** Call on every rule change and on enable/disable. */
export function invalidate(guildId) {
  cache.delete(guildId);
}

export function clearCache() {
  cache.clear();
}
