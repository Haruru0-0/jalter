import { getBinding, setBinding } from './store.js';
import { decidePick, decideMenu } from './rules.js';
import { botCanGive as defaultBotCanGive } from '../../core/role-safety.js';
import { serialize } from '../../core/auto-channel.js';
import { logRoleDanger as defaultLogRoleDanger } from './log.js';
import { getLang as defaultGetLang } from '../../i18n/index.js';

const REASON = 'Reaction roles';

// One alert factory per process: keeps the per-message throttle map between calls.
const grantAlert = createGrantAlert();

// Default `log` for createGrantAlert — resolves the guild language and writes one mod-log embed.
async function defaultGrantLog(ctx, guild, message, role) {
  const lang = await defaultGetLang(ctx.db, guild.id);
  await defaultLogRoleDanger(ctx, guild.id, lang, {
    messageId: message.messageId,
    roleId: role?.id ?? role,
  });
}

/** Applies one pick ({kind:'entry', entry, action} or {kind:'menu', roleIds}) to a member. Never throws. */
export function applyPick(ctx, member, message, pick, deps = {}) {
  return serialize(`${message.messageId}:${member.id}`, () => run(ctx, member, message, pick, deps));
}

/**
 * Throttled staff alert for "we couldn't give the role, the bot no longer can" refusals. The spec
 * says at most one alert per message per hour so a broken message does not spam the mod log.
 *
 * `deps.log` is the actual writer; defaults to `defaultGrantLog` which posts via `logRoleDanger`.
 * Tests inject a counting `log` to assert the throttle without Discord or the mod channel.
 */
export function createGrantAlert({ now = Date.now, log = defaultGrantLog, everyMs = 60 * 60 * 1000 } = {}) {
  const last = new Map();
  return async function alert(ctx, guild, message, role) {
    try {
      const t = now();
      const prev = last.get(message.messageId);
      // First call for this message (prev undefined) always fires; subsequent ones skip while inside the window.
      if (prev !== undefined && t - prev < everyMs) return;
      last.set(message.messageId, t);
      await log(ctx, guild, message, role);
    } catch (err) {
      console.warn(`reaction role alert failed: ${err?.message ?? err}`);
    }
  };
}

async function run(ctx, member, message, pick, deps) {
  const botCanGive = deps.botCanGive ?? defaultBotCanGive;
  const binding = await getBinding(ctx.db, message.messageId, member.id);
  const memberRoleIds = new Set(member.roles.cache.keys());
  const decision = pick.kind === 'menu'
    ? decideMenu({ message, selectedRoleIds: pick.roleIds, memberRoleIds, binding })
    : decidePick({ message, entry: pick.entry, action: pick.action, memberRoleIds, binding });
  if (!decision.ok) return decision;

  const refuse = (reason) => ({ ok: false, reason, clearReaction: decision.clearReaction });
  const guild = member.guild;
  for (const id of decision.add) {
    const role = guild.roles.cache.get(id);
    if (!role) return refuse('role_missing');
    if (!botCanGive(guild, role)) {
      // Tell staff exactly once per message per hour; the member sees the normal 'cannot_give'.
      grantAlert(ctx, guild, message, role);
      return refuse('cannot_give');
    }
  }
  try {
    if (decision.remove.length) await member.roles.remove(decision.remove, REASON);
    if (decision.add.length) await member.roles.add(decision.add, REASON);
  } catch (err) {
    console.warn(`Reaction role change failed: ${err.message}`);
    return refuse('discord_failed');
  }
  if (message.type === 'binding' && decision.add.length) {
    await setBinding(ctx.db, {
      guildId: guild.id,
      messageId: message.messageId,
      userId: member.id,
      roleId: decision.add[0],
    });
  }
  return { ok: true, added: decision.add, removed: decision.remove, clearReaction: decision.clearReaction };
}
