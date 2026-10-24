// Function table: name -> { min, max, check(args, env, acc) }. A check writes into the accumulator
// (gates, actions, flags) and returns errors as `{ code, detail? }` objects; async checks are awaited.
// Stage 2 functions are added as new rows.
import { PermissionsBitField } from 'discord.js';
import { parseEmoji } from '../../reactionroles/config.js';
import { isDangerousRole, botCanGive, callerCanGive } from '../../../core/role-safety.js';
import { getEmbed, normalizeEmbedName } from '../../embeds/store.js';
import { ESCAPED_BRACKET } from './parse.js';
import { MAX_ARG_INDEX } from './args.js';

export const MAX_COOLDOWN = 604800;
export const MAX_DELETE_REPLY = 300;
export const MAX_REACTIONS = 5;
export const MAX_ROLE_ACTIONS = 3;
export const MAX_NICK = 32;
export const MAX_LIST = 10;
export const MAX_RANDOM = 4;
export const MAX_CHOICES = 25;
export const MAX_RANGE_VALUE = 1_000_000_000;
export const ARG_TYPES = ['user', 'channel', 'color', 'role', 'number'];
// Modes whose rules have no words after the trigger.
export const WORD_MODES = new Set(['startswith', 'includes']);

// The sentinel marks an escaped `\[`; arguments that are resolved at save time see a plain `[`.
const unescape = (s) => s.replaceAll(ESCAPED_BRACKET, '[');
const TARGET_RE = /^\[\$([1-9]|1\d|20)\]$/;

const SNOWFLAKE = /^\d{17,20}$/;
const HEX = /^#([0-9a-f]{6})$/i;
const PERM_BY_LOWER = new Map(Object.keys(PermissionsBitField.Flags).map((k) => [k.toLowerCase(), k]));

const cacheValues = (cache) => [...(cache?.values?.() ?? [])];

function resolveRole(guild, arg) {
  const m = /^<@&(\d{17,20})>$/.exec(arg) ?? (SNOWFLAKE.test(arg) ? [null, arg] : null);
  if (m) {
    const role = guild.roles.cache.get(m[1]);
    return role ? { role } : { error: { code: 'ROLE_NOT_FOUND', detail: arg } };
  }
  const lower = arg.toLowerCase();
  const found = cacheValues(guild.roles.cache).filter((r) => r.name?.toLowerCase() === lower);
  if (found.length === 0) return { error: { code: 'ROLE_NOT_FOUND', detail: arg } };
  if (found.length > 1) return { error: { code: 'ROLE_AMBIGUOUS', detail: arg } };
  return { role: found[0] };
}

function resolveChannel(guild, arg) {
  const m = /^<#(\d{17,20})>$/.exec(arg) ?? (SNOWFLAKE.test(arg) ? [null, arg] : null);
  if (m) {
    const channel = guild.channels.cache.get(m[1]);
    return channel ? { channel } : { error: { code: 'CHANNEL_NOT_FOUND', detail: arg } };
  }
  const lower = arg.replace(/^#/, '').toLowerCase();
  const channel = cacheValues(guild.channels.cache).find((c) => c.name?.toLowerCase() === lower);
  return channel ? { channel } : { error: { code: 'CHANNEL_NOT_FOUND', detail: arg } };
}

/** Resolves every argument with `one`, pushing ids into `into`; returns the errors. */
function resolveList(args, one, key, into) {
  const errors = [];
  for (const arg of args) {
    const r = one(arg);
    if (r.error) errors.push(r.error);
    else into.push(r[key].id);
  }
  return errors;
}

const roleGate = (fn) => ({
  min: 1,
  max: MAX_LIST,
  check(args, { guild }, acc) {
    const roleIds = [];
    const errors = resolveList(args, (a) => resolveRole(guild, a), 'role', roleIds);
    if (!errors.length) acc.gates.push({ fn, roleIds });
    return errors;
  },
});

const permGate = (fn) => ({
  min: 1,
  max: MAX_LIST,
  check(args, _env, acc) {
    const perms = [];
    const errors = [];
    for (const arg of args) {
      const canonical = PERM_BY_LOWER.get(arg.toLowerCase());
      if (canonical) perms.push(canonical);
      else errors.push({ code: 'INVALID_PERMISSION', detail: arg });
    }
    if (!errors.length) acc.gates.push({ fn, perms });
    return errors;
  },
});

const channelGate = (fn) => ({
  min: 1,
  max: MAX_LIST,
  check(args, { guild }, acc) {
    const channelIds = [];
    const errors = resolveList(args, (a) => resolveChannel(guild, a), 'channel', channelIds);
    if (!errors.length) acc.gates.push({ fn, channelIds });
    return errors;
  },
});

/** Marks a singleton function as used; returns a DUPLICATE_FUNCTION error on a second use. */
function once(acc, name) {
  if (acc.seen.has(name)) return [{ code: 'DUPLICATE_FUNCTION', detail: name }];
  acc.seen.add(name);
  return [];
}

const boolFlag = (name) => ({
  min: 0,
  max: 0,
  check(_args, _env, acc) {
    const dup = once(acc, name);
    if (dup.length) return dup;
    acc.flags[name] = true;
    return [];
  },
});

const roleAction = (fn) => ({
  min: 1,
  max: 2,
  keepEscapes: true,
  check(args, { guild, writer }, acc) {
    if (acc.roleActions >= MAX_ROLE_ACTIONS) return [{ code: 'TOO_MANY_ROLE_ACTIONS' }];
    acc.roleActions++;
    const roleArg = unescape(args[0]);
    const r = resolveRole(guild, roleArg);
    if (r.error) return [r.error];
    const { role } = r;
    if (isDangerousRole(role)) return [{ code: 'ROLE_DANGEROUS', detail: role.name }];
    if (!botCanGive(guild, role)) return [{ code: 'ROLE_ABOVE_BOT', detail: role.name }];
    if (!callerCanGive(guild, writer, role)) return [{ code: 'ROLE_ABOVE_YOU', detail: role.name }];
    let target = null;
    if (args.length > 1) {
      const m = TARGET_RE.exec(args[1]);
      if (!m) return [{ code: 'TARGET_NOT_CHECKED_USER', detail: unescape(args[1]) }];
      target = Number(m[1]);
      acc.targets.push({ n: target, pos: acc.pos });
    }
    acc.actions.push({ fn, roleId: role.id, raw: roleArg, target });
    return [];
  },
});

const reactAction = (fn) => ({
  min: 1,
  max: 1,
  check(args, { guild }, acc) {
    if (acc.reactions >= MAX_REACTIONS) return [{ code: 'TOO_MANY_REACTIONS' }];
    acc.reactions++;
    const parsed = parseEmoji(args[0], guild);
    if (parsed.error) return [{ code: 'INVALID_EMOJI', detail: args[0] }];
    acc.actions.push({ fn, emoji: parsed.emoji });
    return [];
  },
});

const RANGE_RE = /^(-?\d+)-(-?\d+)$/;
const WEIGHT_RE = /^(\d+(?:\.\d+)?)%$/;
const ARG_N_RE = /^(?:[1-9]|1\d|20)$/;

const emptyOption = (args) => args.some((a) => a === '');

export const FUNCTIONS = {
  range: {
    min: 1,
    max: 1,
    check(args, _env, acc) {
      const m = RANGE_RE.exec(args[0]);
      const min = m ? Number(m[1]) : NaN;
      const max = m ? Number(m[2]) : NaN;
      if (!m || Math.abs(min) > MAX_RANGE_VALUE || Math.abs(max) > MAX_RANGE_VALUE || max < min) {
        return [{ code: 'RANGE_INVALID', detail: args[0] }];
      }
      if (acc.random.ranges.length >= MAX_RANDOM) return [{ code: 'TOO_MANY_RANDOM' }];
      acc.random.ranges.push({ min, max });
      return [];
    },
  },
  choose: {
    min: 1,
    max: MAX_CHOICES,
    keepEscapes: true,
    check(args, _env, acc) {
      if (emptyOption(args)) return [{ code: 'BAD_ARGUMENT', detail: '' }];
      if (acc.random.choosers.length >= MAX_RANDOM) return [{ code: 'TOO_MANY_RANDOM' }];
      acc.random.choosers.push({ kind: 'choose', options: [...args] });
      return [];
    },
  },
  weightedchoose: {
    min: 1,
    max: MAX_CHOICES,
    check(args, _env, acc) {
      const weights = [];
      const errors = [];
      for (const a of args) {
        const m = WEIGHT_RE.exec(a);
        const w = m ? Number(m[1]) : NaN;
        if (Number.isFinite(w)) weights.push(w);
        else errors.push({ code: 'WEIGHT_INVALID', detail: a });
      }
      if (errors.length) return errors;
      if (!(weights.reduce((x, y) => x + y, 0) > 0)) return [{ code: 'WEIGHT_INVALID', detail: args.join('|') }];
      if (acc.random.choosers.length >= MAX_RANDOM) return [{ code: 'TOO_MANY_RANDOM' }];
      acc.random.choosers.push({ kind: 'weighted', weights });
      return [];
    },
  },
  lockedchoose: {
    min: 1,
    max: MAX_CHOICES,
    keepEscapes: true,
    check(args, _env, acc) {
      if (emptyOption(args)) return [{ code: 'BAD_ARGUMENT', detail: '' }];
      if (acc.random.locked.length >= MAX_RANDOM) return [{ code: 'TOO_MANY_RANDOM' }];
      acc.random.locked.push([...args]);
      acc.lockedPos.push(acc.pos);
      return [];
    },
  },
  requirearg: {
    min: 1,
    max: 2,
    check(args, { matchMode }, acc) {
      if (!ARG_N_RE.test(args[0]) || Number(args[0]) > MAX_ARG_INDEX) return [{ code: 'ARG_INDEX_INVALID', detail: args[0] }];
      const n = Number(args[0]);
      const type = args.length > 1 ? args[1].toLowerCase() : null;
      if (type !== null && !ARG_TYPES.includes(type)) return [{ code: 'ARG_TYPE_INVALID', detail: args[1] }];
      if (matchMode && !WORD_MODES.has(matchMode)) return [{ code: 'NO_ARGUMENTS_IN_MODE', detail: matchMode }];
      if (acc.argChecks.some((c) => c.n === n)) return [{ code: 'DUPLICATE_FUNCTION', detail: `requirearg:${n}` }];
      acc.argChecks.push({ n, type });
      return [];
    },
  },
  cooldown: {
    min: 1,
    max: 1,
    check(args, _env, acc) {
      const dup = once(acc, 'cooldown');
      if (dup.length) return dup;
      if (!/^\d+$/.test(args[0])) return [{ code: 'BAD_ARGUMENT', detail: args[0] }];
      const seconds = Number(args[0]);
      if (seconds < 1 || seconds > MAX_COOLDOWN) return [{ code: 'COOLDOWN_RANGE', detail: args[0] }];
      acc.gates.push({ fn: 'cooldown', seconds });
      return [];
    },
  },
  requirerole: roleGate('requirerole'),
  denyrole: roleGate('denyrole'),
  requireperm: permGate('requireperm'),
  denyperm: permGate('denyperm'),
  requirechannel: channelGate('requirechannel'),
  denychannel: channelGate('denychannel'),
  requireuser: {
    min: 1,
    max: MAX_LIST,
    check(args, _env, acc) {
      const userIds = [];
      const errors = [];
      for (const arg of args) {
        const m = /^<@!?(\d{17,20})>$/.exec(arg) ?? (SNOWFLAKE.test(arg) ? [null, arg] : null);
        if (m) userIds.push(m[1]);
        else errors.push({ code: 'INVALID_USER', detail: arg });
      }
      if (!errors.length) acc.gates.push({ fn: 'requireuser', userIds });
      return errors;
    },
  },
  addrole: roleAction('addrole'),
  removerole: roleAction('removerole'),
  setnick: {
    min: 1,
    max: 1,
    keepEscapes: true,
    check(args, _env, acc) {
      if (acc.roleActions >= MAX_ROLE_ACTIONS) return [{ code: 'TOO_MANY_ROLE_ACTIONS' }];
      acc.roleActions++;
      if ([...args[0]].length > MAX_NICK) return [{ code: 'NICK_TOO_LONG', detail: String(MAX_NICK) }];
      acc.actions.push({ fn: 'setnick', text: args[0] });
      return [];
    },
  },
  react: reactAction('react'),
  reactreply: reactAction('reactreply'),
  embed: {
    min: 0,
    max: 1,
    async check(args, { db, guild }, acc) {
      const dup = once(acc, 'embed');
      if (dup.length) return dup;
      const arg = args[0] ?? '';
      if (arg === '') {
        acc.flags.embed = { kind: 'plain', color: null };
        return [];
      }
      if (arg.startsWith('#')) {
        const m = HEX.exec(arg);
        if (!m) return [{ code: 'BAD_ARGUMENT', detail: arg }];
        acc.flags.embed = { kind: 'plain', color: parseInt(m[1], 16) };
        return [];
      }
      const name = normalizeEmbedName(arg);
      if (!name || !(await getEmbed(db, guild.id, name))) return [{ code: 'EMBED_NOT_FOUND', detail: arg }];
      acc.flags.embed = { kind: 'named', name };
      return [];
    },
  },
  sendto: {
    min: 1,
    max: 1,
    check(args, { guild }, acc) {
      const dup = once(acc, 'sendto');
      if (dup.length) return dup;
      const r = resolveChannel(guild, args[0]);
      if (r.error) return [r.error];
      acc.flags.sendTo = r.channel.id;
      return [];
    },
  },
  dm: boolFlag('dm'),
  delete: boolFlag('delete'),
  silent: boolFlag('silent'),
  delete_reply: {
    min: 1,
    max: 1,
    check(args, _env, acc) {
      const dup = once(acc, 'delete_reply');
      if (dup.length) return dup;
      if (!/^\d+$/.test(args[0])) return [{ code: 'BAD_ARGUMENT', detail: args[0] }];
      const seconds = Number(args[0]);
      if (seconds < 1 || seconds > MAX_DELETE_REPLY) return [{ code: 'DELETE_REPLY_RANGE', detail: args[0] }];
      acc.flags.deleteReplyAfter = seconds;
      return [];
    },
  },
};
