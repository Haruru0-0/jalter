// Pure link and invite detection. Runs on RAW message text (hosts are lowercased here).
// No network calls: invite targets are resolved through an injected async function.

export const MAX_LINKS = 20;
const MAX_CODE = 32;

// URL: scheme then non-space, non-bracket run. Bare domain: labels, TLD, optional path.
// Bounded quantifiers and single-class runs keep matching linear-ish on hostile input.
const LINK_RE =
  /https?:\/\/[^\s<>()[\]]{1,2048}|(?<![\w@./-])(?:[a-z0-9-]{1,63}\.){1,10}[a-z]{2,24}(?![\w@-])(?:\/[^\s<>()[\]]{0,2048})?/gi;

const INVITE_RE =
  /(?<![\w.@-])(?:https?:\/\/)?(?:(?:www|ptb|canary)\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-z0-9-]{2,32})(?![\w-])/gi;

const TRAILING = /[.,!?;:'"*_~`|]+$/;

const INVITE_WEB_HOST = /^(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com$/;

const isInviteHost = (host, pathname) =>
  host === 'discord.gg' ||
  host === 'www.discord.gg' ||
  (INVITE_WEB_HOST.test(host) && /^\/invite(\/|$)/i.test(pathname));

function hostOf(candidate) {
  let s = candidate.replace(TRAILING, '');
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/\.+$/, '');
    if (!host || !host.includes('.')) return null;
    return { host, pathname: u.pathname };
  } catch {
    return null;
  }
}

/** Lowercase hostnames of http(s) URLs and bare domains, invite links excluded. Deduped, capped at 20. */
export function extractLinks(text) {
  if (typeof text !== 'string' || text === '') return [];
  const hosts = new Set();
  for (const m of text.matchAll(LINK_RE)) {
    const parsed = hostOf(m[0]);
    if (!parsed || isInviteHost(parsed.host, parsed.pathname)) continue;
    hosts.add(parsed.host);
    if (hosts.size >= MAX_LINKS) break;
  }
  return [...hosts];
}

/** Invite codes from discord.gg/x, discord.com/invite/x, discordapp.com/invite/x. Deduped, capped at 20. */
export function extractInviteCodes(text) {
  if (typeof text !== 'string' || text === '') return [];
  const codes = new Set();
  for (const m of text.matchAll(INVITE_RE)) {
    if (m[1].length > MAX_CODE) continue;
    codes.add(m[1]);
    if (codes.size >= MAX_LINKS) break;
  }
  return [...codes];
}

/** True when host equals a listed domain or is a subdomain of one. */
export function domainMatches(host, list) {
  if (typeof host !== 'string' || !Array.isArray(list)) return false;
  const h = host.toLowerCase();
  return list.some((entry) => {
    if (typeof entry !== 'string') return false;
    const e = entry.trim().toLowerCase();
    return e !== '' && (h === e || h.endsWith(`.${e}`));
  });
}

/** cfg is config.rules.links. */
export function evaluateLinks(text, cfg) {
  const matches = [];
  for (const host of extractLinks(text)) {
    if (domainMatches(host, cfg.allow)) continue;
    if (domainMatches(host, cfg.block) || cfg.blockAllExceptAllowed) matches.push(host);
  }
  return { violated: matches.length > 0, matches };
}

/** cfg is config.rules.invites. allow/block hold guild ids (or invite codes).
 *  resolve(code) -> guild id string | null (known foreign/unknown invite) | undefined (lookup failed: skip the code).
 *  A throwing resolve counts as undefined. Distinct codes resolve concurrently. */
export async function evaluateInvites(text, cfg, { ownGuildId, resolve }) {
  const codes = extractInviteCodes(text);
  const resolved = await Promise.all(
    codes.map(async (code) => {
      try {
        return await resolve(code);
      } catch {
        return undefined;
      }
    }),
  );
  const matches = [];
  codes.forEach((code, i) => {
    const gid = resolved[i];
    if (gid === undefined) return;
    if (gid !== null && gid === ownGuildId) return;
    const ids = gid === null ? [code] : [gid, code];
    if (ids.some((id) => cfg.allow.includes(id))) return;
    if (ids.some((id) => cfg.block.includes(id)) || cfg.blockAllExceptAllowed) matches.push(code);
  });
  return { violated: matches.length > 0, matches };
}
