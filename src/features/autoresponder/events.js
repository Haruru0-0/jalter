// Autoresponder message listener. Runs after auto-mod's listener and waits for its verdict.
import { Events } from 'discord.js';
import { getLang } from '../../i18n/index.js';
import { safe } from '../logging/send-log.js';
import { awaitOutcome } from '../../core/message-outcome.js';
import { getRules } from './cache.js';
import { chooseRule } from './match.js';
import { evaluate } from './script/evaluate.js';
import { prepareRun } from './script/run.js';
import { buildScriptVars } from './script/placeholders.js';
import { executePlan, sendGateNotice } from './execute.js';
import { createThrottle } from './throttle.js';
import { logRunError } from './log.js';
import { claimCooldown } from './cooldown.js';

const NOTICE_EVERY_MS = 30_000;
const FK_VIOLATION = '23503';

/** Builds the event list. Each call gets its own notice throttle; tests pass fakes through `deps`. */
export function createEvents(deps = {}) {
  const choose = deps.chooseRule ?? chooseRule;
  const run = deps.executePlan ?? executePlan;
  const notice = deps.sendGateNotice ?? sendGateNotice;
  const logError = deps.logRunError ?? logRunError;
  const claim = deps.claimCooldown ?? claimCooldown;
  const prepare = deps.prepareRun ?? prepareRun;
  const throttle = deps.noticeThrottle ?? createThrottle(NOTICE_EVERY_MS);

  const onCreate = safe('autoresponderMessage', async (ctx, message) => {
    if (message.author?.bot || message.webhookId || message.system || !message.guild) return;
    if (message.author.id === ctx.client.user?.id) return;
    const guild = message.guild;

    const rules = await getRules(ctx.db, guild.id);
    if (!rules.length) return;
    const rule = choose(rules, message.content);
    if (!rule) return;

    if ((await awaitOutcome(message.id)) === 'acted') return;

    let member = message.member;
    if (!member) {
      try {
        member = await guild.members.fetch(message.author.id);
      } catch {
        return;
      }
    }
    if (!member) return;

    const lang = await getLang(ctx.db, guild.id);
    const vars = buildScriptVars({ message, member, guild, lang });
    const prepared = await prepare({ compiled: rule.compiled, rule, text: message.content, guild, rng: deps.rng });
    const plan = evaluate(rule.compiled, { member, channelId: message.channelId, vars, ...prepared });
    const noticeKey = `${guild.id}:${rule.id}:${member.id}`;

    if (plan.status === 'skip') {
      if (plan.notice && throttle.allow(noticeKey)) {
        const detail = plan.gate === 'arg' ? { kind: 'arg', n: plan.arg.n, type: plan.arg.type } : { kind: 'role' };
        await notice(ctx, message, lang, detail);
      }
      return;
    }

    if (plan.cooldown) {
      let claimed;
      try {
        claimed = await claim(ctx.db, rule.id, member.id, plan.cooldown);
      } catch (err) {
        if (err?.code === FK_VIOLATION) return; // the rule was deleted while this message was processed
        throw err;
      }
      if (!claimed.ok) {
        if (!plan.flags.silent && throttle.allow(noticeKey)) {
          await notice(ctx, message, lang, { kind: 'cooldown', seconds: Math.ceil(claimed.retryAfterMs / 1000) });
        }
        return;
      }
    }

    const { errors } = await run(ctx, { rule, message, member, plan, lang, vars });
    if (errors?.length) await logError(ctx, guild, lang, { ruleId: rule.id, errors });
  });

  return [{ name: Events.MessageCreate, execute: onCreate }];
}

export const events = createEvents();
