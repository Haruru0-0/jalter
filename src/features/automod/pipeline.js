// Auto-mod pipeline: decides what a message violates and enforces it. handleMessage never throws.
import { getFeature } from '../../db/settings.js';
import { getLang } from '../../i18n/index.js';
import { runAction as realRunAction } from '../moderation/actions.js';
import { readConfig as readModConfig } from '../moderation/config.js';
import { sendLog as realSendLog } from '../logging/send-log.js';
import { readConfig } from './config.js';
import { addHistory as realAddHistory } from './history.js';
import { createStrikeStore } from './strikes.js';
import { enforce, attempt, warn } from './enforce.js';
import { createSpamTracker } from './detect-spam.js';
import { extractLinks, extractInviteCodes, evaluateLinks, evaluateInvites } from './detect-links.js';
import { effectiveWords, findBadWord, findPattern } from './detect-words.js';
import { isExempt } from './exempt.js';
import { checkMember as realCheckMember } from './nickname.js';

const MAX_WINDOW_MS = 86_400_000;
const INVITE_TIMEOUT_MS = 3000;
const INVITE_TTL_MS = 10 * 60 * 1000;
const INVITE_CACHE_MAX = 500;
const MEMBER_SET_MAX = 5000;

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

const userIdOf = (message) => message.author.id;

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
  const checkMemberImpl = deps.checkMember ?? realCheckMember;
  const checkedMembers = new Set();
  const lastRenamed = new Map();
  const checkMember = (ctx, member) => checkMemberImpl(ctx, member, { lastRenamed, sendLog, now: clock });

  /** Returns the findings [{ rule, reason }] for the rules the message trips, cheap rules first, invites last. */
  async function evaluate(ctx, message, content, rules, now, edited) {
    const tripped = [];
    const trip = (rule, reason = rule) => tripped.push({ rule, reason });
    if (rules.spam.enabled) {
      const mentions = (message.mentions?.users?.size ?? 0) + (message.mentions?.roles?.size ?? 0);
      const found = spam.check({
        guildId: message.guildId,
        userId: message.author.id,
        channelId: message.channelId,
        content,
        mentionCount: mentions,
        attachmentCount: message.attachments?.size ?? 0,
        linkCount: extractLinks(content).length + extractInviteCodes(content).length,
      }, rules.spam, now, { edited });
      if (found.length) trip('spam');
    }
    if (rules.words.enabled) {
      if (findBadWord(content, effectiveWords(rules.words))) trip('words');
      else if (message.guildId && findPattern(content, rules.words, message.guildId)) trip('words', 'pattern');
    }
    if (rules.links.enabled && evaluateLinks(content, rules.links).violated) trip('links');
    if (rules.invites.enabled && extractInviteCodes(content).length) {
      const result = await evaluateInvites(content, rules.invites, {
        ownGuildId: message.guildId,
        resolve: (code) => resolveInvite(code, ctx),
      });
      if (result.violated) trip('invites');
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

    // First message of a member since start: check their nickname once. Never blocks scanning.
    const memberKey = `${guildId}:${userIdOf(message)}`;
    if (!checkedMembers.has(memberKey)) {
      if (checkedMembers.size >= MEMBER_SET_MAX) checkedMembers.delete(checkedMembers.values().next().value);
      checkedMembers.add(memberKey);
      await attempt('nickname check', () => checkMember(ctx, member));
    }

    const content = typeof message.content === 'string' ? message.content : '';
    if (opts?.edited && opts.oldContent !== undefined && opts.oldContent === content) return;

    const now = clock();
    const tripped = await evaluate(ctx, message, content, auto.rules, now, Boolean(opts?.edited));
    if (!tripped.length) return;

    const lang = await getLang(ctx.db, guildId);
    await enforce(ctx, {
      guild: message.guild,
      member,
      message,
      findings: tripped,
      autoConfig: auto,
      modConfig: mod,
      lang,
      deps: { runAction, sendLog, addHistory, now: clock },
      strikes,
    });
  }

  return {
    strikes,
    spam,
    checkMember,
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
