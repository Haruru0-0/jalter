// Discord's own AutoMod: reacts to its executions with strikes, and lists its rules. The bot never creates or edits them.
import { getFeature } from '../../db/settings.js';
import { getLang } from '../../i18n/index.js';
import { runAction as realRunAction } from '../moderation/actions.js';
import { readConfig as readModConfig } from '../moderation/config.js';
import { sendLog as realSendLog } from '../logging/send-log.js';
import { readConfig } from './config.js';
import { addHistory as realAddHistory } from './history.js';
import { createStrikeStore } from './strikes.js';
import { enforce, warn } from './enforce.js';
import { passesAge } from './age.js';
import { isExempt } from './exempt.js';

const DEDUPE_MS = 5000;
const UNKNOWN_MESSAGE = 10008;
const MISSING_PERMISSIONS = 50013;

/** Every native rule of the guild as [{ id, name, enabled }]. Empty when the bot cannot read them (it needs Manage Server). */
export async function listNativeRules(guild) {
  try {
    const rules = await guild.autoModerationRules.fetch();
    return [...rules.values()].map((r) => ({ id: r.id, name: r.name, enabled: Boolean(r.enabled) }));
  } catch {
    return [];
  }
}

/** deps overrides (tests): runAction, sendLog, addHistory, now(), strikes. */
export function createNativeHandler(deps = {}) {
  const runAction = deps.runAction ?? realRunAction;
  const sendLog = deps.sendLog ?? realSendLog;
  const addHistory = deps.addHistory ?? realAddHistory;
  const clock = deps.now ?? Date.now;
  const strikes = deps.strikes ?? createStrikeStore();
  // ruleId:userId:messageId -> when it was first seen. Discord can report one hit more than once.
  const seen = new Map();

  /** Drops expired keys, then records this one. True when it was already seen inside the window. */
  function duplicate(key, now) {
    for (const [k, at] of seen) {
      if (now - at >= DEDUPE_MS) seen.delete(k);
    }
    if (seen.has(key)) return true;
    seen.set(key, now);
    return false;
  }

  /** The offending message, or null when it is gone or unreachable (Discord may have blocked it before it posted). */
  async function fetchMessage(execution) {
    const { guild, channelId, messageId } = execution;
    try {
      const channel = guild.channels.cache.get(channelId) ?? await guild.channels.fetch(channelId);
      return (await channel?.messages?.fetch(messageId)) ?? null;
    } catch (err) {
      if (err?.code !== UNKNOWN_MESSAGE && err?.code !== MISSING_PERMISSIONS) warn('native message fetch', err);
      return null;
    }
  }

  async function process(ctx, execution) {
    const guild = execution?.guild;
    if (!guild?.id || !execution.userId || !execution.ruleId) return;
    const { enabled, config } = await getFeature(ctx.db, guild.id, 'automod');
    if (!enabled) return;
    const auto = readConfig(config);
    const rule = auto.rules.native;
    if (!rule.enabled) return;
    if (rule.ruleIds.length && !rule.ruleIds.includes(execution.ruleId)) return;

    const now = clock();
    if (duplicate(`${execution.ruleId}:${execution.userId}:${execution.messageId ?? ''}`, now)) return;

    const member = await guild.members.fetch(execution.userId).catch(() => null);
    if (!member) return;
    const mod = readModConfig((await getFeature(ctx.db, guild.id, 'moderation')).config);
    const { config: panel } = await getFeature(ctx.db, guild.id, 'panel');
    const managerRoleId = panel?.managerRoleId && panel.managerRoleId !== guild.id ? panel.managerRoleId : null;
    const channel = guild.channels?.cache?.get(execution.channelId) ?? null;
    if (isExempt(member, channel, auto, mod, managerRoleId)) return;
    if (!passesAge(member, rule, now)) return;

    // enforce deletes it (ignoring an already-gone message), so the handler only fetches it.
    const message = execution.messageId && rule.delete ? await fetchMessage(execution) : null;
    const lang = await getLang(ctx.db, guild.id);
    await enforce(ctx, {
      guild,
      member,
      message,
      findings: [{ rule: 'native', reason: execution.autoModerationRule?.name ?? execution.ruleId }],
      autoConfig: auto,
      modConfig: mod,
      lang,
      deps: { runAction, sendLog, addHistory, now: clock },
      strikes,
    });
  }

  return {
    strikes,
    /** Keys currently remembered for de-duplication. */
    size: () => seen.size,
    async handle(ctx, execution) {
      try {
        await process(ctx, execution);
      } catch (err) {
        warn('native handler', err);
      }
    },
  };
}
