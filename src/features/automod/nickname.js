// Auto-mod nickname check: replaces a nickname (or username) containing a listed word or pattern with a placeholder.
import { randomInt } from 'node:crypto';
import { getFeature } from '../../db/settings.js';
import { getLang, t } from '../../i18n/index.js';
import { readConfig as readModConfig } from '../moderation/config.js';
import { sendLog as realSendLog } from '../logging/send-log.js';
import { readConfig } from './config.js';
import { effectiveWords, findBadWord, findPattern } from './detect-words.js';
import { isExempt } from './exempt.js';

const RENAME_COOLDOWN_MS = 10_000;
const MAP_MAX = 5000;
const PLACEHOLDER = /^Moderated Nickname \d{4}$/;

export function placeholderName() {
  return `Moderated Nickname ${String(randomInt(0, 10_000)).padStart(4, '0')}`;
}

/** Checks one member's nickname and username; never throws.
 *  opts: lastRenamed (Map guildId:userId -> ms), sendLog and now (tests). */
export async function checkMember(ctx, member, { lastRenamed = new Map(), sendLog = realSendLog, now = Date.now } = {}) {
  try {
    const guildId = member?.guild?.id;
    if (!guildId || !member.user || member.user.bot) return;
    const { enabled, config } = await getFeature(ctx.db, guildId, 'automod');
    if (!enabled) return;
    const auto = readConfig(config);
    if (!auto.nickname.enabled) return;

    const mod = readModConfig((await getFeature(ctx.db, guildId, 'moderation')).config);
    const { config: panel } = await getFeature(ctx.db, guildId, 'panel');
    const managerRoleId = panel?.managerRoleId && panel.managerRoleId !== guildId ? panel.managerRoleId : null;
    if (isExempt(member, null, auto, mod, managerRoleId)) return;

    // Already a placeholder (the username is the offender): renaming again would loop.
    if (typeof member.nickname === 'string' && PLACEHOLDER.test(member.nickname)) return;

    const words = effectiveWords(auto.rules.words);
    const texts = [member.nickname ?? member.displayName ?? member.user.username, member.user.username];
    const bad = (text) => typeof text === 'string'
      && (findBadWord(text, words) || findPattern(text, auto.rules.words, guildId));
    if (!texts.some(bad)) return;

    const at = now();
    const key = `${guildId}:${member.id}`;
    const last = lastRenamed.get(key);
    if (last !== undefined && at - last < RENAME_COOLDOWN_MS) return;
    if (lastRenamed.size >= MAP_MAX) lastRenamed.delete(lastRenamed.keys().next().value);
    lastRenamed.set(key, at);

    const lang = await getLang(ctx.db, guildId);
    const name = placeholderName();
    await member.setNickname(name, t(lang, 'automod.nickname.reason'));
    try {
      await sendLog(ctx, guildId, 'modAction', {
        title: t(lang, 'automod.log.title'),
        description: t(lang, 'automod.nickname.log', { user: `<@${member.id}>`, name }),
      });
    } catch (err) {
      console.warn(`Auto-mod nickname log failed: ${err?.message ?? err}`);
    }
  } catch (err) {
    console.warn(`Auto-mod nickname check failed: ${err?.message ?? err}`);
  }
}
