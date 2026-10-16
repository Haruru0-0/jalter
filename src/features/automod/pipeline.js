// Auto-mod pipeline: decides what a message violates and enforces it. handleMessage never throws.
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { runAction as realRunAction } from '../moderation/actions.js';
import { readConfig as readModConfig } from '../moderation/config.js';
import { sendLog as realSendLog } from '../logging/send-log.js';
import { readConfig } from './config.js';
import { addHistory as realAddHistory } from './history.js';
import { createStrikeStore, stepReached, isTopStep } from './strikes.js';
import { createSpamTracker } from './detect-spam.js';
import { extractLinks, extractInviteCodes, evaluateLinks, evaluateInvites } from './detect-links.js';
import { effectiveWords, findBadWord } from './detect-words.js';
import { isExempt } from './exempt.js';

const UNKNOWN_MESSAGE = 10008;
const MAX_WINDOW_MS = 86_400_000;
const DEFAULT_TIMEOUT_SECONDS = 600;
const INVITE_TIMEOUT_MS = 3000;
const INVITE_TTL_MS = 10 * 60 * 1000;
const INVITE_CACHE_MAX = 500;

const UNKNOWN_INVITE = 10006;

/** Resolves an invite code. Returns a guild id, null (unknown or foreign invite, cached 10 min as a
 *  negative result for Unknown Invite 10006) or undefined (lookup failed or timed out: not cached, fail open). */
export function createInviteResolver({ timeoutMs = INVITE_TIMEOUT_MS, ttlMs = INVITE_TTL_MS } = {}) {
  const cache = new Map();
  const remember = (code, guildId) => {
    if (cache.size >= INVITE_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(code, { guildId, until: Date.now() + ttlMs });
  };
  return async function resolveInvite(code, ctx) {
    const hit = cache.get(code);
    if (hit && hit.until > Date.now()) return hit.guildId;
    let timer;
    try {
      const invite = await Promise.race([
        ctx.client.fetchInvite(code),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('invite timeout')), timeoutMs); }),
      ]);
      const guildId = invite?.guild?.id ?? null;
      remember(code, guildId);
      return guildId;
    } catch (err) {
      if (err?.code === UNKNOWN_INVITE) {
        remember(code, null);
        return null;
      }
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}

const warn = (what, err) => console.warn(`Auto-mod ${what} failed: ${err?.message ?? err}`);

/** Runs fn, logs and swallows any failure. */
async function attempt(what, fn) {
  try {
    return await fn();
  } catch (err) {
    warn(what, err);
    return undefined;
  }
}

function ignorable(message, ctx) {
  if (!message || typeof message !== 'object') return true;
  if (message.author?.bot || message.webhookId || message.system) return true;
  if (!message.guild || !message.guildId || !message.author?.id) return true;
  return message.author.id === ctx.client?.user?.id;
}

/** deps overrides (tests): runAction, sendLog, addHistory, resolveInvite(code, ctx), now(). */
export function createEngine(deps = {}) {
  const runAction = deps.runAction ?? realRunAction;
  const sendLog = deps.sendLog ?? realSendLog;
  const addHistory = deps.addHistory ?? realAddHistory;
  const resolveInvite = deps.resolveInvite ?? createInviteResolver();
  const clock = deps.now ?? Date.now;
  const strikes = createStrikeStore();
  const spam = createSpamTracker();

  /** Returns the names of rules the message trips, cheap rules first, invites last. */
  async function evaluate(ctx, message, content, rules, now, edited) {
    const tripped = [];
    // An edit is not a new burst, attachment or link-rate event.
    if (rules.spam.enabled && !edited) {
      const mentions = (message.mentions?.users?.size ?? 0) + (message.mentions?.roles?.size ?? 0);
      const found = spam.check({
        guildId: message.guildId,
        userId: message.author.id,
        channelId: message.channelId,
        content,
        mentionCount: mentions,
        attachmentCount: message.attachments?.size ?? 0,
        linkCount: extractLinks(content).length + extractInviteCodes(content).length,
      }, rules.spam, now);
      if (found.length) tripped.push('spam');
    }
    if (rules.words.enabled && findBadWord(content, effectiveWords(rules.words))) tripped.push('words');
    if (rules.links.enabled && evaluateLinks(content, rules.links).violated) tripped.push('links');
    if (rules.invites.enabled && extractInviteCodes(content).length) {
      const result = await evaluateInvites(content, rules.invites, {
        ownGuildId: message.guildId,
        resolve: (code) => resolveInvite(code, ctx),
      });
      if (result.violated) tripped.push('invites');
    }
    return tripped;
  }

  async function process(ctx, message, opts) {
    if (ignorable(message, ctx)) return;
    const guildId = message.guildId;
    const { enabled, config } = await getFeature(ctx.db, guildId, 'automod');
    if (!enabled) return;
    const auto = readConfig(config);

    let member = message.member;
    if (!member) member = await message.guild.members.fetch(message.author.id).catch(() => null);
    const mod = readModConfig((await getFeature(ctx.db, guildId, 'moderation')).config);
    const { config: panel } = await getFeature(ctx.db, guildId, 'panel');
    const managerRoleId = panel?.managerRoleId && panel.managerRoleId !== guildId ? panel.managerRoleId : null;
    if (isExempt(member, message.channel, auto, mod, managerRoleId)) return;

    const content = typeof message.content === 'string' ? message.content : '';
    if (opts?.edited && opts.oldContent !== undefined && opts.oldContent === content) return;

    const now = clock();
    const tripped = await evaluate(ctx, message, content, auto.rules, now, Boolean(opts?.edited));
    if (!tripped.length) return;

    const lang = await getLang(ctx.db, guildId);
    const userId = message.author.id;
    const actions = [];
    let caseNumber = null;

    const counts = tripped.map((rule) => ({
      rule,
      step: null,
      ...strikes.add(guildId, userId, rule, now, auto.rules[rule].windowSeconds * 1000),
    }));

    if (tripped.some((rule) => auto.rules[rule].delete)) {
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

    // One enforcement per message: the most severe step among the rules that crossed one.
    const crossed = counts
      .map((c) => ({ rule: c.rule, step: stepReached(auto.rules[c.rule].steps, c.previous, c.count) }))
      .filter((c) => c.step);
    if (crossed.length) {
      const secondsOf = (step) => (step.action === 'timeout' ? (step.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) : 0);
      const severity = (step) => (step.action === 'timeout' ? 1 : 0);
      const best = crossed.map((c) => c.step).reduce((a, b) => (
        severity(b) > severity(a) || (severity(b) === severity(a) && secondsOf(b) > secondsOf(a)) ? b : a
      ));
      // Reset before awaiting so strikes added during the await are not wiped.
      for (const c of crossed) {
        if (isTopStep(auto.rules[c.rule].steps, c.step)) strikes.reset(guildId, userId, c.rule);
      }
      const result = await attempt('action', () => runAction(ctx, {
        guild: message.guild,
        actor: message.guild.members.me,
        type: best.action,
        targetId: userId,
        target: member,
        config: mod,
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

    if (caseNumber === null) {
      await attempt('log', () => sendLog(ctx, guildId, 'modAction', {
        title: t(lang, 'automod.log.title'),
        description: `<@${userId}> <#${message.channelId}>`,
        fields: [
          { name: t(lang, 'automod.log.rules'), value: tripped.join(', ') },
          { name: t(lang, 'automod.log.actions'), value: actions.length ? actions.join(', ') : '—' },
        ],
      }));
    }

    await attempt('history', () => addHistory(ctx.db, {
      guildId, userId, rules: tripped, messageId: message.id, actions, caseNumber,
    }));
  }

  return {
    strikes,
    spam,
    /** Task 9 calls this on a timer: drops expired strikes (max window 24h) and spam events. */
    prune(now = clock()) {
      strikes.prune(now, MAX_WINDOW_MS);
      spam.prune(now);
    },
    async handleMessage(ctx, message, opts = {}) {
      try {
        await process(ctx, message, opts);
      } catch (err) {
        warn('handler', err);
      }
    },
  };
}
