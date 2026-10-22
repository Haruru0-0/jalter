// A guild member whose role calls behave like discord.js 14 (GuildMemberRoleManager):
// - the ARRAY forms of roles.add / roles.remove compute the full role list from `roles.cache` and send one
//   PATCH that REPLACES the member's whole role set on Discord;
// - the SINGLE-id forms send an atomic PUT / DELETE for that one role and never read the cache;
// - none of them updates `roles.cache`: only the gateway (GUILD_MEMBER_UPDATE) does, later. Here that is
//   `member.gateway()`, which tests call when they want the cache to catch up;
// - `guild.members.fetch({ user, force: true })` returns the member as Discord holds it now.
// `member.server` is that true role set; `member.calls` records every REST call as [verb, roleId | roleIds].

const tick = () => new Promise((r) => setImmediate(r));

export function fakeDiscordMember(guild, { id = 'u1', held = [] } = {}) {
  const server = new Set(held);
  const calls = [];
  const failOn = new Set();

  function view(cacheIds) {
    const cache = new Map(cacheIds.map((r) => [r, {}]));
    const rest = async (verb, arg, next) => {
      await tick();
      calls.push([verb, arg]);
      if (failOn.has(verb) || failOn.has(`${verb}:${Array.isArray(arg) ? arg.join(',') : arg}`)) {
        throw new Error('Missing Permissions');
      }
      next();
    };
    const replaceWith = (ids) => { server.clear(); for (const r of ids) server.add(r); };
    return {
      cache,
      async add(roles) {
        if (Array.isArray(roles)) {
          const next = [...new Set([...roles, ...cache.keys()])];
          return rest('patch', next, () => replaceWith(next));
        }
        return rest('put', roles, () => server.add(roles));
      },
      async remove(roles) {
        if (Array.isArray(roles)) {
          const next = [...cache.keys()].filter((r) => !roles.includes(r));
          return rest('patch', next, () => replaceWith(next));
        }
        return rest('delete', roles, () => server.delete(roles));
      },
    };
  }

  const member = {
    id,
    guild,
    calls,
    server,
    failOn,
    roles: view([...held]),
    /** The gateway event lands: the cached view catches up with Discord. */
    gateway() { member.roles = view([...server]); },
    /** What a forced fetch returns: a fresh member object with the current roles. */
    snapshot() { return { ...member, roles: view([...server]) }; },
  };
  const fetches = [];
  guild.members = guild.members ?? {};
  guild.members.fetches = fetches;
  guild.members.fetch = async (arg) => {
    fetches.push(arg);
    const uid = typeof arg === 'string' ? arg : arg?.user;
    if (uid !== id) throw new Error('Unknown Member');
    if (guild.members.failFetch) throw new Error('fetch failed');
    return typeof arg === 'object' && arg.force ? member.snapshot() : member;
  };
  return member;
}

/** The role ids the member holds on Discord, sorted. */
export const heldRoles = (member) => [...member.server].sort();
