// Auto-mod enforcement: strikes, delete, action, log and history for a set of findings. Never throws.
import { t } from '../../i18n/index.js';
import { runAction as realRunAction } from '../moderation/actions.js';
import { sendLog as realSendLog } from '../logging/send-log.js';
import { addHistory as realAddHistory } from './history.js';
import { stepReached, isTopStep } from './strikes.js';
import { grantTimedRole } from './role-effect.js';

const UNKNOWN_MESSAGE = 10008;
const DEFAULT_TIMEOUT_SECONDS = 600;

export const warn = (what, err) => console.warn(`Auto-mod ${what} failed: ${err?.message ?? err}`);

/** Runs fn, logs and swallows any failure. */
export async function attempt(what, fn) {
  try {
    return await fn();
  } catch (err) {
    warn(what, err);
    return undefined;
  }
}

/** Enforces findings [{ rule, reason }] against a member. message may be null (nothing to delete);
 *  channelId/messageId fill in the log and history when there is no message object.
 *  deps overrides (tests): runAction, sendLog, addHistory, now(). */
export async function enforce(ctx, { guild, member, message, channelId, messageId, findings, autoConfig, modConfig, lang, deps = {}, strikes }) {
  try {
    const runAction = deps.runAction ?? realRunAction;
    const sendLog = deps.sendLog ?? realSendLog;
    const addHistory = deps.addHistory ?? realAddHistory;
    const now = (deps.now ?? Date.now)();
    const guildId = guild.id;
    const userId = member?.id ?? message?.author?.id;
    const rules = autoConfig.rules;
    // A finding for a rule missing from the config is skipped, not fatal.
    const tripped = findings.map((f) => f.rule).filter((rule) => rules[rule]);
    if (!tripped.length) return;
    const logChannelId = message?.channelId ?? channelId ?? null;
    const actions = [];
    let caseNumber = null;

    const counts = tripped.map((rule) => ({
      rule,
      step: null,
      ...strikes.add(guildId, userId, rule, now, rules[rule].windowSeconds * 1000),
    }));

    // One enforcement per message: the most severe step among the rules that crossed one.
    const crossed = counts
      .map((c) => ({ rule: c.rule, step: stepReached(rules[c.rule].steps, c.previous, c.count) }))
      .filter((c) => c.step);
    // Reset before any await so strikes added meanwhile (during the delete or the action) are not wiped.
    for (const c of crossed) {
      if (isTopStep(rules[c.rule].steps, c.step)) strikes.reset(guildId, userId, c.rule);
    }

    if (message && tripped.some((rule) => rules[rule].delete)) {
      const deleted = await attempt('delete', async () => {
        try {
          await message.delete();
          return true;
        } catch (err) {
          if (err?.code !== UNKNOWN_MESSAGE) warn('delete', err);
          return false;
        }
      });
      if (deleted) actions.push('delete');
    }

    if (crossed.length) {
      const secondsOf = (step) => (step.action === 'timeout' ? (step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) : 0);
      const severity = (step) => (step.action === 'timeout' ? 1 : 0);
      const best = crossed.map((c) => c.step).reduce((a, b) => (
        severity(b) > severity(a) || (severity(b) === severity(a) && secondsOf(b) > secondsOf(a)) ? b : a
      ));
      const result = await attempt('action', () => runAction(ctx, {
        guild,
        actor: guild.members.me,
        type: best.action,
        targetId: userId,
        target: member ?? undefined,
        config: modConfig,
        lang,
        reason: t(lang, 'automod.reason', { rules: crossed.map((c) => c.rule).join(', ') }),
        durationSeconds: best.action === 'timeout' ? secondsOf(best) : undefined,
      }));
      if (result?.ok) {
        actions.push(best.action);
        if (result.modCase) caseNumber = result.modCase.number ?? null;
      } else if (result) {
        console.warn(`Auto-mod ${best.action} refused in ${guildId}: ${result.reason}`);
      }
    }

    // Any step firing hands out the rule's timed role (e.g. a muted role), whatever the step's action.
    // Rules that give the same role are merged (longest time wins): a second grant would not see the
    // first in the role cache, and a failed second add would cancel the removal the first depends on.
    const grants = new Map();
    for (const c of crossed) {
      const give = rules[c.rule].giveRole;
      if (!give?.roleId || !member) continue;
      if (!grants.has(give.roleId) || give.seconds > grants.get(give.roleId).giveRole.seconds) {
        grants.set(give.roleId, rules[c.rule]);
      }
    }
    for (const ruleCfg of grants.values()) {
      const given = await attempt('role', () => grantTimedRole(ctx, member, ruleCfg, now));
      if (given) actions.push('role');
    }

    if (caseNumber === null) {
      await attempt('log', () => sendLog(ctx, guildId, 'modAction', {
        title: t(lang, 'automod.log.title'),
        description: logChannelId ? `<@${userId}> <#${logChannelId}>` : `<@${userId}>`,
        fields: [
          { name: t(lang, 'automod.log.rules'), value: tripped.join(', ') },
          { name: t(lang, 'automod.log.actions'), value: actions.length ? actions.join(', ') : '—' },
        ],
      }));
    }

    await attempt('history', () => addHistory(ctx.db, {
      guildId, userId, rules: tripped, messageId: message?.id ?? messageId ?? null, actions, caseNumber,
    }));
  } catch (err) {
    warn('enforce', err);
  }
}
