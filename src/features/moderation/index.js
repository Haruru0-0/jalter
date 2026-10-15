import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { capList } from '../../core/lists.js';
import { parseDuration, formatDuration } from '../../core/duration.js';
import { t } from '../../i18n/index.js';
import { readConfig, addPermittedRole, removePermittedRole, MAX_PERMITTED } from './config.js';
import { actionCommands } from './commands-actions.js';
import { warningCommands } from './commands-warnings.js';
import { events, jobs } from './actions.js';

const TIMEOUT_MIN = 60;
const TIMEOUT_MAX = 2_419_200;
const MUTE_DENY = { SendMessages: false, AddReactions: false, Speak: false };

const stateOption = (o) =>
  o.setName('state').setDescription('On or off').setRequired(true)
    .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' });
const roleOption = (description) => (o) => o.setName('role').setDescription(description).setRequired(true);

const data = toggleSubcommands(
  new SlashCommandBuilder().setName('moderation').setDescription('Moderation settings'),
)
  .addSubcommand((s) => s.setName('status').setDescription('Show the moderation settings'))
  .addSubcommand((s) =>
    s.setName('reason-required').setDescription('Require a reason for moderation actions')
      .addStringOption(stateOption))
  .addSubcommand((s) =>
    s.setName('dm').setDescription('Send members a message when they are moderated')
      .addStringOption(stateOption))
  .addSubcommand((s) =>
    s.setName('timeout-default').setDescription('Set the default timeout length')
      .addStringOption((o) =>
        o.setName('duration').setDescription('For example 10m, 2h or 1d (1 minute to 28 days)')
          .setMaxLength(32).setRequired(true)))
  .addSubcommand((s) =>
    s.setName('ban-delete-days').setDescription('Days of messages to delete when banning')
      .addIntegerOption((o) =>
        o.setName('days').setDescription('0 to 7').setMinValue(0).setMaxValue(7).setRequired(true)))
  .addSubcommand((s) =>
    s.setName('mute-role').setDescription('Choose the role given by /mute')
      .addRoleOption(roleOption('Role to use for mutes'))
      .addBooleanOption((o) =>
        o.setName('apply').setDescription('Also deny talking and reacting for this role in every channel')))
  .addSubcommand((s) =>
    s.setName('permitted-role-add').setDescription('Let a role use the moderation commands')
      .addRoleOption(roleOption('Role to allow')))
  .addSubcommand((s) =>
    s.setName('permitted-role-remove').setDescription('Stop a role from using the moderation commands')
      .addRoleOption(roleOption('Role to remove')));

const mention = (id) => `<@&${id}>`;
const reply = (interaction, content) => {
  const payload = ephemeral({ content, allowedMentions: { parse: [] } });
  return interaction.deferred || interaction.replied ? interaction.editReply(payload) : interaction.reply(payload);
};

function statusText(lang, enabled, config) {
  const onOff = (v) => t(lang, v ? 'common.on' : 'common.off');
  const roles = config.permittedRoles.length
    ? capList(config.permittedRoles.map(mention), { max: 350, more: (count) => t(lang, 'common.more', { count }) })
    : t(lang, 'moderation.settings.none');
  return [
    `**${t(lang, 'moderation.settings.status_title')}**`,
    t(lang, enabled ? 'moderation.settings.status_on' : 'moderation.settings.status_off'),
    `**${t(lang, 'moderation.settings.reason_required')}**: ${onOff(config.reasonRequired)}`,
    `**${t(lang, 'moderation.settings.dm')}**: ${onOff(config.dm)}`,
    `**${t(lang, 'moderation.settings.timeout_default')}**: ${formatDuration(config.timeoutDefaultSeconds)}`,
    `**${t(lang, 'moderation.settings.ban_delete_days')}**: ${config.banDeleteDays}`,
    `**${t(lang, 'moderation.settings.mute_role')}**: ${config.muteRoleId ? mention(config.muteRoleId) : t(lang, 'moderation.settings.none')}`,
    `**${t(lang, 'moderation.settings.permitted_roles')}**: ${roles}`,
  ].join('\n');
}

/** Denies talking and reacting for the role on every channel the bot can manage. */
async function applyMuteRole(guild, role) {
  let ok = 0;
  let failed = 0;
  const channels = [...guild.channels.cache.values()]
    .filter((c) => c.manageable && c.permissionOverwrites?.edit);
  for (const channel of channels) {
    try {
      await channel.permissionOverwrites.edit(role, MUTE_DENY);
      ok += 1;
    } catch {
      failed += 1;
    }
  }
  return { ok, failed };
}

async function execute(interaction, ctx) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, 'moderation');
  const lang = await guard(interaction, ctx, 'moderation', { requireEnabled: false });
  if (!lang) return;
  const guildId = interaction.guildId;
  const { enabled, config: raw } = await getFeature(ctx.db, guildId, 'moderation');
  const config = readConfig(raw);
  const save = (next) => setFeature(ctx.db, guildId, 'moderation', { config: next });

  if (sub === 'status') return reply(interaction, statusText(lang, enabled, config));

  if (sub === 'reason-required' || sub === 'dm') {
    const on = interaction.options.getString('state', true) === 'on';
    const key = sub === 'dm' ? 'dm' : 'reasonRequired';
    await save({ ...config, [key]: on });
    const base = sub === 'dm' ? 'moderation.settings.dm' : 'moderation.settings.reason_required';
    return reply(interaction, t(lang, on ? `${base}_on` : `${base}_off`));
  }

  if (sub === 'timeout-default') {
    const seconds = parseDuration(interaction.options.getString('duration', true));
    if (seconds === null || seconds < TIMEOUT_MIN || seconds > TIMEOUT_MAX) {
      return reply(interaction, t(lang, 'moderation.settings.bad_timeout'));
    }
    await save({ ...config, timeoutDefaultSeconds: seconds });
    return reply(interaction, t(lang, 'moderation.settings.timeout_set', { duration: formatDuration(seconds) }));
  }

  if (sub === 'ban-delete-days') {
    const days = interaction.options.getInteger('days', true);
    await save({ ...config, banDeleteDays: days });
    return reply(interaction, t(lang, 'moderation.settings.ban_days_set', { days }));
  }

  const role = interaction.options.getRole('role', true);

  if (sub === 'mute-role') {
    if (role.id === guildId) return reply(interaction, t(lang, 'moderation.settings.role_everyone'));
    if (role.managed) return reply(interaction, t(lang, 'moderation.settings.role_managed'));
    const botTop = interaction.guild.members.me?.roles.highest.position;
    if (botTop === undefined || role.position >= botTop) {
      return reply(interaction, t(lang, 'moderation.settings.role_too_high'));
    }
    const apply = interaction.options.getBoolean('apply') === true;
    if (apply) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await save({ ...config, muteRoleId: role.id });
    if (!apply) return reply(interaction, t(lang, 'moderation.settings.mute_role_set', { role: mention(role.id) }));
    const { ok, failed } = await applyMuteRole(interaction.guild, role);
    return reply(interaction, t(lang, 'moderation.settings.mute_role_applied', { role: mention(role.id), ok, failed }));
  }

  if (sub === 'permitted-role-add') {
    if (role.id === guildId) return reply(interaction, t(lang, 'moderation.settings.role_everyone'));
    const result = addPermittedRole(config, role.id);
    if (!result.ok) {
      return reply(interaction, t(lang, result.reason === 'full'
        ? 'moderation.settings.permitted_full' : 'moderation.settings.permitted_exists', { limit: MAX_PERMITTED }));
    }
    await save(result.config);
    return reply(interaction, t(lang, 'moderation.settings.permitted_added', { role: mention(role.id) }));
  }

  if (sub === 'permitted-role-remove') {
    const result = removePermittedRole(config, role.id);
    if (!result.ok) return reply(interaction, t(lang, 'moderation.settings.permitted_missing'));
    await save(result.config);
    return reply(interaction, t(lang, 'moderation.settings.permitted_removed', { role: mention(role.id) }));
  }
}

export const commands = [{ data, execute }, ...actionCommands, ...warningCommands];
export { events, jobs };
