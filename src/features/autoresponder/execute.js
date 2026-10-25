// Autoresponder executor: turns a run Plan into Discord side effects. Every step has its own try/catch
// and appends a RunError; nothing here throws.
import { trySend } from '../../core/send.js';
import { botCanGive, isDangerousRole } from '../../core/role-safety.js';
import { renderPlaceholders } from '../../core/placeholders.js';
import { renderScriptText } from './script/run.js';
import { buildEmbedPayload } from '../embeds/render.js';
import { getEmbed } from '../embeds/store.js';
import { t } from '../../i18n/index.js';

export const RUN_ERROR_CODES = [
  'ROLE_MISSING', 'ROLE_UNSAFE', 'ROLE_FAILED', 'CANNOT_MANAGE_NICK', 'NICK_TOO_LONG', 'NICK_EMPTY', 'CANNOT_DELETE', 'CANNOT_REACT',
  'CANNOT_DM', 'CANNOT_SEND', 'RENDERED_TOO_LONG', 'EMBED_FAILED',
  'TARGET_MISSING', 'TARGET_UNSAFE',
];

const REASON = 'Autoresponder';
const MAX_TEXT = 2000;
const MAX_NICK = 32;
const NOTICE_SECONDS = 8;

/** In-memory, best effort (not restart-safe): deletes `message` after `seconds`. */
export function scheduleDelete(message, seconds, deps = {}) {
  const timer = deps.setTimeout ?? setTimeout;
  const handle = timer(async () => {
    try {
      await message.delete();
    } catch {
      // already gone or no permission: nothing to do
    }
  }, seconds * 1000);
  handle?.unref?.();
}

/** A short, non-pinging reply that explains why a rule did not run. The caller handles throttling and {silent}. */
export async function sendGateNotice(ctx, message, lang, { kind, seconds, n, type }, deps = {}) {
  try {
    let text;
    if (kind === 'cooldown') text = t(lang, 'autoresponder.notice.cooldown', { seconds: String(seconds) });
    else if (kind === 'arg') text = t(lang, 'autoresponder.notice.arg', { n: String(n), type: t(lang, `autoresponder.argtype.${type ?? 'word'}`) });
    else text = t(lang, 'autoresponder.notice.role');
    const sent = await message.reply({
      content: text,
      allowedMentions: { parse: [], repliedUser: false },
      failIfNotExists: false,
    });
    if (sent) scheduleDelete(sent, NOTICE_SECONDS, deps);
  } catch (err) {
    console.warn(`Autoresponder notice failed: ${err?.message ?? err}`);
  }
}

const fail = (errors, code, action, detail) => {
  errors.push(detail === undefined ? { code, action } : { code, action, detail });
};

// The member a role action targets: a checked user word, fetched fresh. Refuses the owner, the bot's own
// member, and anyone the bot cannot manage (at or above its top role). Returns the member or null (error added).
async function resolveTarget(a, { guild, errors }) {
  let target = null;
  if (a.targetId) {
    try {
      target = await guild.members.fetch(a.targetId);
    } catch {
      target = null;
    }
  }
  if (!target) { fail(errors, 'TARGET_MISSING', a.fn, a.targetId ?? ''); return null; }
  const me = guild.members?.me;
  const above = target.roles?.highest && me?.roles?.highest
    ? target.roles.highest.comparePositionTo(me.roles.highest) >= 0
    : false;
  if (target.id === guild.ownerId || target.manageable !== true || above || target.id === me?.id) {
    fail(errors, 'TARGET_UNSAFE', a.fn, a.targetId);
    return null;
  }
  return target;
}

async function changeRole(a, { guild, member, deps, errors }) {
  const canGive = deps.botCanGive ?? botCanGive;
  const dangerous = deps.isDangerousRole ?? isDangerousRole;
  const role = guild.roles.cache.get(a.roleId);
  if (!role) return fail(errors, 'ROLE_MISSING', a.fn, a.roleId);
  // A script that names a target never touches the author: with no resolvable target the action is refused.
  const targeted = a.target != null;
  try {
    if (a.fn === 'addrole') {
      if (dangerous(role) || !canGive(guild, role)) return fail(errors, 'ROLE_UNSAFE', a.fn, a.roleId);
      const subject = targeted ? await resolveTarget(a, { guild, errors }) : member;
      if (!subject || subject.roles.cache.has(a.roleId)) return;
      await subject.roles.add(a.roleId, REASON);
    } else {
      // A targeted change re-checks the role first, like addrole. A self removerole keeps its stage 1 order
      // (a role the member does not hold is a quiet no-op, then only botCanGive).
      if (targeted && (dangerous(role) || !canGive(guild, role))) return fail(errors, 'ROLE_UNSAFE', a.fn, a.roleId);
      const subject = targeted ? await resolveTarget(a, { guild, errors }) : member;
      if (!subject || !subject.roles.cache.has(a.roleId)) return;
      if (!canGive(guild, role)) return fail(errors, 'ROLE_UNSAFE', a.fn, a.roleId);
      await subject.roles.remove(a.roleId, REASON);
    }
  } catch (err) {
    // The call itself failed (often Discord 50013, missing Manage Roles): not a safety refusal.
    fail(errors, 'ROLE_FAILED', a.fn, `${a.roleId} (${err?.code ?? err?.message ?? 'unknown'})`);
  }
}

async function resolveChannel(guild, id) {
  let channel = guild.channels?.cache?.get(id) ?? null;
  if (!channel && typeof guild.channels?.fetch === 'function') channel = await guild.channels.fetch(id).catch(() => null);
  if (!channel || channel.isTextBased?.() === false) return null;
  const perms = channel.permissionsFor?.(guild.members?.me);
  if (perms && !perms.has(['ViewChannel', 'SendMessages'])) return null;
  return channel;
}

// Builds the message payload; a named embed that cannot be built is reported and the text still goes out.
async function buildPayload(ctx, { guild, plan, vars, deps, errors }) {
  const text = plan.text;
  // Only the users evaluate allowed (chosen by the script writer) may ping; roles, everyone and here never do.
  const payload = { allowedMentions: { parse: [], users: [...(plan.allowedUsers ?? [])], repliedUser: false } };
  const embed = plan.flags.embed;
  if (embed?.kind === 'plain') {
    payload.embeds = [{ description: text, ...(embed.color != null ? { color: embed.color } : {}) }];
    return text ? payload : null;
  }
  if (text) payload.content = text;
  if (embed?.kind === 'named') {
    try {
      const spec = await (deps.getEmbed ?? getEmbed)(ctx.db, guild.id, embed.name);
      if (!spec) throw new Error('missing');
      const built = await (deps.buildEmbedPayload ?? buildEmbedPayload)(ctx, guild.id, spec, vars);
      payload.embeds = built.embeds;
    } catch {
      fail(errors, 'EMBED_FAILED', 'embed', embed.name);
    }
  }
  return payload.content || payload.embeds ? payload : null;
}

/**
 * Runs a 'run' Plan. `vars` are the rendered placeholder values, used to render a setnick text
 * (the Plan only carries the raw `action.text`). Returns { errors }.
 */
export async function executePlan(ctx, { rule, message, member, plan, lang, vars = {} }, deps = {}) {
  void rule; void lang;
  const errors = [];
  const guild = message.guild ?? member.guild;
  const send = deps.trySend ?? trySend;
  const actions = plan.actions ?? [];
  let triggerDeleted = false;

  if (plan.flags.delete) {
    try {
      await message.delete();
      triggerDeleted = true;
    } catch (err) {
      fail(errors, 'CANNOT_DELETE', 'delete', String(err?.code ?? ''));
    }
  }

  for (const a of actions.filter((x) => x.fn === 'addrole' || x.fn === 'removerole')) {
    await changeRole(a, { guild, member, deps, errors });
  }

  for (const a of actions.filter((x) => x.fn === 'setnick')) {
    try {
      if (!member.manageable) { fail(errors, 'CANNOT_MANAGE_NICK', 'setnick'); continue; }
      const nick = (plan.v2 ? renderScriptText(a.text, { words: plan.nickWords ?? plan.words, draws: plan.nickDraws ?? plan.draws, vars }) : renderPlaceholders(a.text, vars)).trim();
      if (!nick) { fail(errors, 'NICK_EMPTY', 'setnick'); continue; }
      if ([...nick].length > MAX_NICK) { fail(errors, 'NICK_TOO_LONG', 'setnick', String([...nick].length)); continue; }
      await member.setNickname(nick, REASON);
    } catch (err) {
      fail(errors, 'CANNOT_MANAGE_NICK', 'setnick', String(err?.code ?? ''));
    }
  }

  if (!triggerDeleted) {
    for (const a of actions.filter((x) => x.fn === 'react')) {
      try {
        await message.react(a.emoji);
      } catch (err) {
        fail(errors, 'CANNOT_REACT', 'react', String(err?.code ?? a.emoji));
      }
    }
  }

  let sent = null;
  if (plan.text.length > MAX_TEXT) {
    fail(errors, 'RENDERED_TOO_LONG', 'message', String(plan.text.length));
  } else {
    const payload = await buildPayload(ctx, { guild, plan, vars, deps, errors });
    if (payload) sent = await deliver(payload, { message, member, guild, plan, triggerDeleted, send, errors });
  }

  if (sent) {
    for (const a of actions.filter((x) => x.fn === 'reactreply')) {
      try {
        await sent.react(a.emoji);
      } catch (err) {
        fail(errors, 'CANNOT_REACT', 'reactreply', String(err?.code ?? a.emoji));
      }
    }
    if (plan.flags.deleteReplyAfter) scheduleDelete(sent, plan.flags.deleteReplyAfter, deps);
  }
  return { errors };
}

async function deliver(payload, { message, member, guild, plan, triggerDeleted, send, errors }) {
  if (plan.flags.dm) {
    try {
      return await member.send(payload) ?? null;
    } catch (err) {
      fail(errors, 'CANNOT_DM', 'dm', String(err?.code ?? ''));
      return null;
    }
  }
  if (plan.flags.sendTo) {
    const channel = await resolveChannel(guild, plan.flags.sendTo);
    const result = channel ? await send(channel, payload) : null;
    if (!result) fail(errors, 'CANNOT_SEND', 'sendto', plan.flags.sendTo);
    return result;
  }
  if (!triggerDeleted) {
    try {
      return await message.reply({ ...payload, failIfNotExists: false });
    } catch (err) {
      fail(errors, 'CANNOT_SEND', 'reply', String(err?.code ?? ''));
      return null;
    }
  }
  const result = await send(message.channel, payload);
  if (!result) fail(errors, 'CANNOT_SEND', 'send');
  return result;
}
