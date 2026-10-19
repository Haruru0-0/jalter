// /verification unverified: what happens to members who never verify.
// Config writes are merge-style through setFeature (the stored config has extra keys that must survive).
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { parseDuration, formatDuration } from '../../core/duration.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';
import { readConfig } from './config.js';
import {
  POLICIES, KICK_MIN_SECONDS, KICK_MAX_SECONDS, MIN_GAP_SECONDS, effectiveWarnSeconds, checkTimes,
  cancelAllUnverifiedJobs,
} from './unverified.js';

const FEATURE = 'verification';

/** One phrase describing the policy and its times, shared by the reply and /verification status. */
export function describePolicy(lang, cfg) {
  return t(lang, `verification.unverified.value_${cfg.unverifiedPolicy}`, {
    kick: formatDuration(cfg.kickAfterSeconds),
    warn: formatDuration(effectiveWarnSeconds(cfg)),
  });
}

export async function executeUnverified(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const say = (text) => interaction.reply(ephemeral(text));
  const policy = interaction.options.getString('policy', true);
  if (!POLICIES.includes(policy)) return;

  const given = {};
  for (const [option, key] of [['kick_after', 'kickAfterSeconds'], ['warn_after', 'warnAfterSeconds']]) {
    const text = interaction.options.getString(option);
    if (text === null || text === undefined) continue;
    const seconds = parseDuration(text);
    if (seconds === null) return say(t(lang, 'verification.unverified.bad_duration', { value: text }));
    given[key] = seconds;
  }

  const { config } = await getFeature(ctx.db, interaction.guildId, FEATURE);
  const next = { ...readConfig(config), unverifiedPolicy: policy, ...given };
  const check = checkTimes({ policy, kickAfterSeconds: next.kickAfterSeconds, warnAfterSeconds: next.warnAfterSeconds });
  if (!check.ok) {
    return say(t(lang, `verification.unverified.${check.reason}`, {
      min: formatDuration(KICK_MIN_SECONDS),
      max: formatDuration(KICK_MAX_SECONDS),
      gap: formatDuration(MIN_GAP_SECONDS),
      warn: formatDuration(effectiveWarnSeconds(next)),
      kick: formatDuration(next.kickAfterSeconds),
    }));
  }

  await setFeature(ctx.db, interaction.guildId, FEATURE, { config: { unverifiedPolicy: policy, ...given } });
  if (policy === 'none') await cancelAllUnverifiedJobs(ctx.db, interaction.guildId);
  return say(t(lang, 'verification.unverified.saved', { value: describePolicy(lang, next) }));
}
