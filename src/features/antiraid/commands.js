// /antiraid: enable, disable, config and status.
//
// Every reply is ephemeral and needs Manage Server or the bot manager role. The feature is not
// required to be on for `config` and `status`: an admin must be able to prepare and read the
// settings before turning the feature on.
import { SlashCommandBuilder } from 'discord.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { parseDuration, formatDuration } from '../../core/duration.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';
import { readConfig, checkConfig, resolvePingRole } from './config.js';

const FEATURE = 'antiraid';

// The option that carries each time setting, and the config key it is saved under.
const TIMES = [
  ['window', 'windowSeconds'],
  ['account_age', 'accountAgeSeconds'],
  ['duration', 'durationSeconds'],
];

export function createAntiraidCommand() {
  const data = toggleSubcommands(
    new SlashCommandBuilder().setName('antiraid').setDescription('Anti-raid settings'),
  )
    .addSubcommand((s) => s.setName('config').setDescription('Change the anti-raid settings')
      .addIntegerOption((o) => o.setName('joins').setDescription('Joins in the window that start a lockdown (3-100)'))
      .addStringOption((o) => o.setName('window').setDescription('Detection window, like 60s or 10m (10s-10m)'))
      .addStringOption((o) => o.setName('account_age').setDescription('Kick accounts younger than this, like 7d (1h-90d)'))
      .addStringOption((o) => o.setName('duration').setDescription('How long a lockdown lasts, like 30m (5m-24h)'))
      .addRoleOption((o) => o.setName('ping_role').setDescription('The role to ping when a lockdown starts')))
    .addSubcommand((s) => s.setName('status').setDescription('Show the anti-raid settings and any lockdown'));

  async function execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, FEATURE);
    if (sub === 'config') return executeConfig(interaction, ctx);
    if (sub === 'status') return executeStatus(interaction, ctx);
    return undefined;
  }

  return { data, execute };
}

// ---- config --------------------------------------------------------------------------------

async function executeConfig(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const patch = {};

  const joins = interaction.options.getInteger('joins');
  if (joins !== null && joins !== undefined) patch.joins = joins;

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
