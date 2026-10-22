import { getBinding, setBinding } from './store.js';
import { decidePick, decideMenu } from './rules.js';
import { botCanGive as defaultBotCanGive, isDangerousRole } from '../../core/role-safety.js';
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

// A failure before or outside the decision: the member's real state is unknown. Clearing the reaction of a
// reversed message would fire a Remove event that grants the role, so a reversed message keeps it.
const unknownFailure = (message) => ({ ok: false, reason: 'discord_failed', clearReaction: message.type !== 'reversed' });

/** Applies one pick ({kind:'entry', entry, action} or {kind:'menu', roleIds}) to a member. Never throws. */
export function applyPick(ctx, member, message, pick, deps = {}) {
  return serialize(`${message.messageId}:${member.id}`, async () => {
    try {
      return await run(ctx, member, message, pick, deps);
    } catch (err) {
      console.warn(`Reaction role pick failed: ${err?.message ?? err}`);
      return unknownFailure(message);
    }
  });
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

/**
 * Applies the role changes one role at a time, adds first, so a failure never leaves the member with
 * none of the roles. The single-role calls are atomic PUT / DELETE requests that never read the cached
 * roles; the array forms would PATCH the whole role set computed from a cache that is only updated
 * when the gateway event arrives. On a failure the changes already made are undone (best effort).
 */
async function changeRoles(member, add, remove) {
  const done = [];
  try {
    for (const id of add) {
      await member.roles.add(id, REASON);
      done.push(['add', id]);
    }
    for (const id of remove) {
      await member.roles.remove(id, REASON);
      done.push(['remove', id]);
    }
    return true;
  } catch (err) {
    console.warn(`Reaction role change failed: ${err?.message ?? err}`);
    await undo(member, done);
    return false;
  }
}

// Best-effort reversal of the single-role changes in `done`, newest first.
async function undo(member, done) {
  for (const [verb, id] of [...done].reverse()) {
    try {
      if (verb === 'add') await member.roles.remove(id, REASON);
      else await member.roles.add(id, REASON);
    } catch (e) {
      console.warn(`Reaction role rollback failed: ${e?.message ?? e}`);
    }
  }
}

async function run(ctx, member, message, pick, deps) {
  const botCanGive = deps.botCanGive ?? defaultBotCanGive;
  const alert = deps.alert ?? grantAlert;
  const guild = member.guild;
  // Inside the per-member lock, decide on Discord's current roles: the cached roles do not show the
  // previous pick's change until the gateway event arrives, so a quick second pick could pass limit or unique.
  const fresh = await guild.members.fetch({ user: member.id, force: true }).catch(() => null);
  if (!fresh) return unknownFailure(message);
  const binding = message.type === 'binding' ? await getBinding(ctx.db, message.messageId, member.id) : null;
  const memberRoleIds = new Set(fresh.roles.cache.keys());
  const decision = pick.kind === 'menu'
    ? decideMenu({ message, selectedRoleIds: pick.roleIds, memberRoleIds, binding })
    : decidePick({ message, entry: pick.entry, action: pick.action, memberRoleIds, binding });
  if (!decision.ok) return decision;

  // A refusal after the rules approved a reaction add: the role was not given, so the reaction goes too
  // (its Remove event then finds nothing to change).
  const refuse = (reason) => ({ ok: false, reason, clearReaction: decision.clearReaction || pick.action === 'add' });
  for (const id of decision.add) {
    const role = guild.roles.cache.get(id);
    if (!role) return refuse('role_missing');
    if (isDangerousRole(role) || !botCanGive(guild, role)) {
      // Tell staff exactly once per message per hour; the member sees the normal 'cannot_give'.
      alert(ctx, guild, message, role);
      return refuse('cannot_give');
    }
  }
  if (!(await changeRoles(fresh, decision.add, decision.remove))) return refuse('discord_failed');
  if (message.type === 'binding' && decision.add.length) {
    try {
      await setBinding(ctx.db, {
        guildId: guild.id,
        messageId: message.messageId,
        userId: member.id,
        roleId: decision.add[0],
      });
    } catch (err) {
      // Without the binding row the member could pick again; undo the grant so state stays consistent.
      console.warn(`Reaction role binding save failed: ${err?.message ?? err}`);
      await undo(fresh, decision.add.map((id) => ['add', id]));
      return refuse('discord_failed');
    }
  }
  return { ok: true, added: decision.add, removed: decision.remove, clearReaction: decision.clearReaction };
}
