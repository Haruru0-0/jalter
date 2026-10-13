import { Events } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { readConfig } from './config.js';
import { queueRole, takeDue, rememberRoles, takeRemembered, forgetRoles, purgeOld } from './store.js';

export const MEMORY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

const UNKNOWN_MEMBER = 10007;
const UNKNOWN_ROLE = 10011;

/** Roles the bot may hand out: they exist, are not managed and sit below the bot's own role. */
function assignable(guild, roleId) {
  if (roleId === guild.id) return false;
  const role = guild.roles.cache.get(roleId);
  if (!role || role.managed) return false;
  const botPosition = guild.members.me?.roles.highest.position;
  return botPosition === undefined || role.position < botPosition;
}

export async function assignAutoRole(ctx, member, { now = Date.now() } = {}) {
  try {
    const guild = member.guild;
    const { enabled, config } = await getFeature(ctx.db, guild.id, 'autorole');
    if (!enabled) return;
    const cfg = readConfig(config);
    const isBot = Boolean(member.user?.bot);
    let ids = isBot ? [...cfg.botRoles] : [...cfg.roles];
    if (!isBot && cfg.reassign) {
      const remembered = await takeRemembered(ctx.db, guild.id, member.id, now, MEMORY_MAX_AGE_MS);
      ids.push(...remembered.filter((id) => !cfg.blacklist.includes(id) && assignable(guild, id)));
    } else if (!isBot) {
      // A memory written while sticky roles were on must not outlive a join with them off.
      await forgetRoles(ctx.db, guild.id, member.id);
    }
    ids = [...new Set(ids)];
    const timed = cfg.timed.filter((t) => !ids.includes(t.roleId));
    for (const id of ids) {
      try {
        await member.roles.add(id);
      } catch (err) {
        console.warn(`Auto role failed in ${guild.id}: ${err.message}`);
      }
    }
    if (!isBot) {
      for (const { roleId, seconds } of timed) {
        if (member.roles.cache?.has(roleId)) continue;
        await queueRole(ctx.db, guild.id, member.id, roleId, now + seconds * 1000);
      }
    }
  } catch (err) {
    console.warn(`Auto role failed in ${member.guild?.id}: ${err.message}`);
  }
}

export async function rememberMemberRoles(ctx, member, { now = Date.now() } = {}) {
  try {
    const guild = member.guild;
    if (member.user?.bot) return;
    const { enabled, config } = await getFeature(ctx.db, guild.id, 'autorole');
    if (!enabled) return;
    const cfg = readConfig(config);
    if (!cfg.reassign) return;
    const ids = [...(member.roles?.cache?.keys() ?? [])].filter((id) => id !== guild.id);
    // A partial member's roles are unknown and would wipe a good memory. A full member's list is
    // authoritative (members are fetched at ready), so no roles overwrites an older memory with [].
    if (member.partial) return;
    const keep = ids.filter((id) => !cfg.blacklist.includes(id) && assignable(guild, id));
    await rememberRoles(ctx.db, guild.id, member.id, keep, now);
  } catch (err) {
    console.warn(`Auto role memory failed in ${member.guild?.id}: ${err.message}`);
  }
}

export async function runDue(ctx, { now = Date.now() } = {}) {
  try {
    // Before the client is ready the guild cache is cold: leave the rows for a later tick.
    if (ctx.client.isReady?.() === false) return;
    // Rows are deleted before the role is given, so a crash mid-run loses at most the batch (fine for a 30 s ticker).
    const due = await takeDue(ctx.db, now);
    const configs = new Map();
    for (const { guildId, userId, roleId } of due) {
      try {
        if (!configs.has(guildId)) {
          const { enabled, config } = await getFeature(ctx.db, guildId, 'autorole');
          configs.set(guildId, enabled ? readConfig(config) : null);
        }
        const cfg = configs.get(guildId);
        if (!cfg || !cfg.timed.some((t) => t.roleId === roleId)) continue;
        const guild = ctx.client.guilds.cache.get(guildId);
        if (!guild) continue;
        const member = await guild.members.fetch(userId);
        await member.roles.add(roleId);
      } catch (err) {
        if (err.code === UNKNOWN_MEMBER || err.code === UNKNOWN_ROLE) continue;
        console.warn(`Auto role failed in ${guildId}: ${err.message}`);
      }
    }
    await purgeOld(ctx.db, now, MEMORY_MAX_AGE_MS);
  } catch (err) {
    console.warn(`Auto role run failed: ${err.message}`);
  }
}

export function startTicker(ctx, { intervalMs = 30000 } = {}) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDue(ctx);
    } catch (err) {
      console.warn(`Auto role ticker failed: ${err.message}`);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

export const events = [
  { name: Events.GuildMemberAdd, execute: assignAutoRole },
  { name: Events.GuildMemberRemove, execute: rememberMemberRoles },
];
