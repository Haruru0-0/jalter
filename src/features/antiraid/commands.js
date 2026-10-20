// /antiraid: enable, disable, config, status, start and end.
//
// Every reply is ephemeral and needs Manage Server or the bot manager role. The feature is not
// required to be on for `config` and `status`: an admin must be able to prepare and read the
// settings before turning the feature on. `start` and `end` are refused while the feature is off.
import { SlashCommandBuilder } from 'discord.js';
import { toggleSubcommands } from '../../core/toggle.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { parseDuration, formatDuration } from '../../core/duration.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';
import { FEATURES, setupCommand } from '../../core/registry.js';
import { readConfig, checkConfig, resolvePingRole } from './config.js';
import { joins } from './joins.js';
import { startLockdown, endLockdown } from './lockdown.js';

const FEATURE = 'antiraid';
const SETUP = `/${setupCommand(FEATURES.find((f) => f.key === FEATURE) ?? { key: FEATURE })}`;

// The option that carries each time setting, and the config key it is saved under.
const TIMES = [
  ['window', 'windowSeconds'],
  ['account_age', 'accountAgeSeconds'],
  ['duration', 'durationSeconds'],
];

export function createAntiraidCommand(deps = {}) {
  const store = deps.joins ?? joins;
  const now = deps.now ?? Date.now;
  const start = deps.startLockdown ?? startLockdown;
  const end = deps.endLockdown ?? endLockdown;

  const data = toggleSubcommands(
    new SlashCommandBuilder().setName('antiraid').setDescription('Anti-raid settings'),
  )
    .addSubcommand((s) => s.setName('config').setDescription('Change the anti-raid settings')
      .addIntegerOption((o) => o.setName('joins').setDescription('Joins in the window that start a lockdown (3-100)'))
      .addStringOption((o) => o.setName('window').setDescription('Detection window, like 60s or 10m (10s-10m)'))
      .addStringOption((o) => o.setName('account_age').setDescription('Kick accounts younger than this, like 7d (1h-90d)'))
      .addStringOption((o) => o.setName('duration').setDescription('How long a lockdown lasts, like 30m (5m-24h)'))
      .addRoleOption((o) => o.setName('ping_role').setDescription('The role to ping when a lockdown starts')))
    .addSubcommand((s) => s.setName('status').setDescription('Show the anti-raid settings and any lockdown'))
    .addSubcommand((s) => s.setName('start').setDescription('Start a lockdown by hand'))
    .addSubcommand((s) => s.setName('end').setDescription('End the lockdown'));

  async function execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    const tools = { store, now, start, end };
    if (sub === 'enable') return executeEnable(interaction, ctx, tools, deps);
    if (sub === 'disable') return executeDisable(interaction, ctx, tools, deps);
    if (sub === 'config') return executeConfig(interaction, ctx);
    if (sub === 'status') return executeStatus(interaction, ctx);
    if (sub === 'start') return executeStart(interaction, ctx, tools, deps);
    if (sub === 'end') return executeEnd(interaction, ctx, tools, deps);
    return undefined;
  }

  return { data, execute };
}

// ---- config --------------------------------------------------------------------------------

async function executeConfig(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const patch = {};

  const joinsOption = interaction.options.getInteger('joins');
  if (joinsOption !== null && joinsOption !== undefined) patch.joins = joinsOption;

  // Parse first: a time that does not make sense is refused before anything else is read.
  for (const [option, key] of TIMES) {
    const raw = interaction.options.getString(option);
    if (raw === null || raw === undefined) continue;
    const seconds = parseDuration(raw);
    if (seconds === null) {
      await interaction.reply(ephemeral(t(lang, 'antiraid.config.bad_duration')));
      return;
    }
    patch[key] = seconds;
  }

  const role = interaction.options.getRole('ping_role');
  if (role) {
    // The @everyone role shares the guild id: it would ping the whole server.
    if (role.id === interaction.guildId) {
      await interaction.reply(ephemeral(t(lang, 'antiraid.config.bad_role')));
      return;
    }
    patch.pingRoleId = role.id;
  }

  const check = checkConfig(patch);
  if (!check.ok) {
    await interaction.reply(ephemeral(t(lang, `antiraid.config.${check.reason}`)));
    return;
  }

  // Only the given keys are written: setFeature merges, so the lockdown state stays.
  await setFeature(ctx.db, interaction.guildId, FEATURE, { config: patch });
  await interaction.reply(ephemeral(t(lang, 'antiraid.config.saved')));
}

// ---- status --------------------------------------------------------------------------------

async function executeStatus(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const guildId = interaction.guildId;
  const { enabled, config } = await getFeature(ctx.db, guildId, FEATURE);
  const cfg = readConfig(config);

  const lines = [
    t(lang, 'antiraid.status.enabled', { value: t(lang, enabled ? 'common.on' : 'common.off') }),
    t(lang, 'antiraid.status.joins', { joins: cfg.joins, window: formatDuration(cfg.windowSeconds) }),
    t(lang, 'antiraid.status.age', { age: formatDuration(cfg.accountAgeSeconds) }),
    t(lang, 'antiraid.status.duration', { duration: formatDuration(cfg.durationSeconds) }),
  ];

  const ping = await resolvePingRole(ctx, guildId, cfg);
  if (ping.roleId) {
    lines.push(t(lang, ping.isDefault ? 'antiraid.status.ping_role_default' : 'antiraid.status.ping_role',
      { role: `<@&${ping.roleId}>` }));
  } else {
    lines.push(t(lang, 'antiraid.status.no_ping_role'));
  }

  if (cfg.state === 'locked') {
    const until = cfg.lockedUntil ? `<t:${Math.floor(cfg.lockedUntil / 1000)}:F>` : '?';
    lines.push(t(lang, 'antiraid.status.locked', { until }));
    lines.push(t(lang, 'antiraid.status.kicked', { count: cfg.kicked }));
    lines.push(t(lang, 'antiraid.status.invite_result', { value: t(lang, `antiraid.status.invite_${cfg.inviteResult}`) }));
    lines.push(t(lang, 'antiraid.status.alert_result', { value: t(lang, `antiraid.status.alert_${cfg.alertResult}`) }));
  } else {
    lines.push(t(lang, 'antiraid.status.idle'));
  }

  await interaction.reply(ephemeral(lines.join('\n')));
}

// ---- start and end --------------------------------------------------------------------------

async function executeStart(interaction, ctx, tools, deps) {
  const { store, now, start } = tools;
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const guild = interaction.guild;
  const { config } = await getFeature(ctx.db, guild.id, FEATURE);
  const cfg = readConfig(config);
  if (cfg.state === 'locked') {
    await interaction.reply(ephemeral(t(lang, 'antiraid.start.already')));
    return;
  }

  // The candidates are the joins of the detection window: a manual start right after a
  // restart may find none, and then it removes nobody.
  const windowMs = cfg.windowSeconds * 1000;
  const at = now();
  const candidates = store.recent(guild.id, at, windowMs);
  const res = await start(ctx, guild, {
    trigger: 'manual', startedBy: interaction.user.id, joinedCount: candidates.length, candidates,
  }, deps);
  if (!res.ok) {
    const keys = {
      disabled: 'common.featureOff',
      schedule_failed: 'antiraid.start.failed',
      ended: 'antiraid.start.ended',
    };
    const key = keys[res.reason] ?? 'antiraid.start.already';
    const vars = res.reason === 'disabled' ? { command: SETUP } : {};
    await interaction.reply(ephemeral(t(lang, key, vars)));
    return;
  }

  const after = readConfig((await getFeature(ctx.db, guild.id, FEATURE)).config);
  const until = after.lockedUntil ? `<t:${Math.floor(after.lockedUntil / 1000)}:F>` : '?';
  await interaction.reply(ephemeral(t(lang, 'antiraid.start.done', {
    kicked: res.kicked,
    until,
    invite: t(lang, `antiraid.status.invite_${after.inviteResult}`),
    alert: t(lang, `antiraid.status.alert_${after.alertResult}`),
  })));
}

async function executeEnd(interaction, ctx, tools, deps) {
  const { end } = tools;
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const { config } = await getFeature(ctx.db, interaction.guildId, FEATURE);
  if (readConfig(config).state !== 'locked') {
    await interaction.reply(ephemeral(t(lang, 'antiraid.end.not_locked')));
    return;
  }
  const res = await end(ctx, interaction.guild, { by: 'manual', actorId: interaction.user.id }, deps);
  if (!res.ok) {
    await interaction.reply(ephemeral(t(lang, 'antiraid.end.not_locked')));
    return;
  }
  await interaction.reply(ephemeral(t(lang, 'antiraid.end.done')));
}

// ---- enable and disable ---------------------------------------------------------------------

const toggledText = (lang, on) => t(lang, on ? 'common.enabledMsg' : 'common.disabledMsg', {
  feature: t(lang, `feature.${FEATURE}`),
});

// Turning the feature on does not resume a lockdown left over past its end time (a disable
// whose end failed, and an end job that failed too): it is ended right away. A lockdown that
// has not reached its end time stays; its end job still ends it.
async function executeEnable(interaction, ctx, tools, deps) {
  const { end, now } = tools;
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  await setFeature(ctx.db, interaction.guildId, FEATURE, { enabled: true });
  await interaction.reply(ephemeral(toggledText(lang, true)));
  try {
    const cfg = readConfig((await getFeature(ctx.db, interaction.guildId, FEATURE)).config);
    if (cfg.state === 'locked' && cfg.lockedUntil && cfg.lockedUntil <= now()) {
      await end(ctx, interaction.guild, { by: 'timer' }, deps);
    }
  } catch (err) {
    console.warn(`antiraid: ending a stale lockdown on enable failed in ${interaction.guildId}:`, err);
  }
}

// Turning the feature off ends a running lockdown: a lockdown that outlives its feature would
// keep kicking young accounts with nothing to turn it off.
//
// Off first, then always the end, without reading the state in between: a start can only lock
// while the feature is on, so once it is off no new lockdown can begin, and the end catches one
// that an auto start locked just before the off write. If the end fails, only the end job is
// left to finish it: the next-join expiry check in events.js does not run while the feature is
// off, and enabling the feature again ends the lockdown if its end time has passed.
async function executeDisable(interaction, ctx, tools, deps) {
  const { end } = tools;
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const guildId = interaction.guildId;
  await setFeature(ctx.db, guildId, FEATURE, { enabled: false });
  let ended = false;
  try {
    const res = await end(ctx, interaction.guild, { by: 'disable', actorId: interaction.user.id }, deps);
    ended = res?.ok === true;
  } catch (err) {
    console.warn(`antiraid: ending the lockdown on disable failed in ${guildId}:`, err);
    // The end failed: say so only when a lockdown was really there.
    try {
      ended = readConfig((await getFeature(ctx.db, guildId, FEATURE)).config).state === 'locked';
    } catch {
      ended = true;
    }
  }
  await interaction.reply(ephemeral(ended ? t(lang, 'antiraid.disable.ended') : toggledText(lang, false)));
}
