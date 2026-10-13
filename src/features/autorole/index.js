import { SlashCommandBuilder } from 'discord.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { guard } from '../../core/guard.js';
import { handleToggle } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { capList } from '../../core/lists.js';
import { t } from '../../i18n/index.js';
import {
  readConfig, addRole, removeRole, addTimed, removeTimed, addBlacklist, removeBlacklist,
  setReassign, isValidRoleId, pruneRoles, LIMITS, MAX_TIMED,
} from './config.js';
import { parseDuration, formatDuration, MIN_DELAY, MAX_DELAY } from './duration.js';
import { cancelRole } from './store.js';
import { events } from './assign.js';

const roleOption = (description) => (o) => o.setName('role').setDescription(description).setRequired(true);

const data = new SlashCommandBuilder()
  .setName('autorole')
  .setDescription('Give new members roles automatically')
  .addSubcommand((s) =>
    s.setName('add').setDescription('Give a role to every new member or bot')
      .addRoleOption(roleOption('Role to give'))
      .addStringOption((o) =>
        o.setName('target').setDescription('Who gets it (default: humans)')
          .addChoices({ name: 'humans', value: 'humans' }, { name: 'bots', value: 'bots' })))
  .addSubcommand((s) =>
    s.setName('remove').setDescription('Stop giving a role automatically')
      .addRoleOption(roleOption('Role to stop giving')))
  .addSubcommand((s) => s.setName('show').setDescription('Show the auto role settings'))
  .addSubcommand((s) =>
    s.setName('reassign').setDescription('Give returning members their old roles back')
      .addStringOption((o) =>
        o.setName('state').setDescription('On or off')
          .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }).setRequired(true)))
  .addSubcommandGroup((g) =>
    g.setName('blacklist').setDescription('Roles that are never given back to returning members')
      .addSubcommand((s) =>
        s.setName('add').setDescription('Never give this role back to a returning member')
          .addRoleOption(roleOption('Role to never give back')))
      .addSubcommand((s) =>
        s.setName('remove').setDescription('Allow this role to be given back again')
          .addRoleOption(roleOption('Role to give back again'))))
  .addSubcommandGroup((g) =>
    g.setName('timed').setDescription('Roles given some time after joining')
      .addSubcommand((s) =>
        s.setName('add').setDescription('Give a role a while after a member joins')
          .addStringOption((o) =>
            o.setName('delay').setDescription('How long to wait, like 30m, 12h or 1d (1m to 30d)')
              .setMaxLength(32).setRequired(true))
          .addRoleOption(roleOption('Role to give')))
      .addSubcommand((s) =>
        s.setName('remove').setDescription('Stop giving a role after a delay')
          .addRoleOption(roleOption('Role to stop giving'))))
  .addSubcommand((s) => s.setName('disable').setDescription('Turn auto role off'));

const mention = (id) => `<@&${id}>`;
const reply = (interaction, content) =>
  interaction.reply(ephemeral({ content, allowedMentions: { parse: [] } }));

// The config helpers return the whole normalised config without the legacy keys;
// the null patch stops setFeature's top-level merge from bringing them back.
const save = (ctx, guildId, config, enabled) =>
  setFeature(ctx.db, guildId, 'autorole', {
    ...(enabled ? { enabled: true } : {}),
    config: { ...config, humanRoleId: null, botRoleId: null },
  });

function roleLine(guild, botTop, lang, id) {
  const role = guild.roles.cache.get(id);
  if (!role) return `\`${id}\` (${t(lang, 'autorole.deletedRole')})`;
  return botTop !== undefined && role.position >= botTop
    ? `${mention(id)} (${t(lang, 'autorole.tooHighShort')})`
    : mention(id);
}

function showText(interaction, lang, config) {
  const guild = interaction.guild;
  const botTop = guild.members.me?.roles.highest.position;
  const list = (items) =>
    capList(items, { max: 350, more: (count) => t(lang, 'common.more', { count }) });
  const roles = (ids) => list(ids.map((id) => roleLine(guild, botTop, lang, id)));
  const sections = [
    ['humans', config.roles.length && roles(config.roles)],
    ['bots', config.botRoles.length && roles(config.botRoles)],
    ['timed', config.timed.length && list(config.timed.map(({ roleId, seconds }) =>
      `${roleLine(guild, botTop, lang, roleId)} ${formatDuration(seconds)}`))],
    ['blacklist', config.blacklist.length && list(config.blacklist.map((id) => roleLine(guild, undefined, lang, id)))],
  ].filter(([, value]) => value);
  if (!sections.length && !config.reassign) return t(lang, 'autorole.nothing');
  const lines = sections.map(([key, value]) => `**${t(lang, `autorole.${key}`)}**: ${value}`);
  lines.push(`**${t(lang, 'autorole.sticky')}**: ${t(lang, config.reassign ? 'common.on' : 'common.off')}`);
  return `**${t(lang, 'autorole.showTitle')}**\n${lines.join('\n')}`;
}

async function execute(interaction, ctx) {
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  if (!group && sub === 'disable') return handleToggle(interaction, ctx, 'autorole');
  const lang = await guard(interaction, ctx, 'autorole', { requireEnabled: false });
  if (!lang) return;
  const guildId = interaction.guildId;
  const stored = (await getFeature(ctx.db, guildId, 'autorole')).config;
  // Deleted roles cannot be picked in a command option, so every change drops them first.
  const cache = interaction.guild.roles.cache;
  const config = cache.size ? pruneRoles(stored, (id) => cache.has(id)) : stored;
  const prunedTimed = readConfig(stored).timed.filter((x) => !readConfig(config).timed.some((y) => y.roleId === x.roleId));
  const saveAll = async (next, enabled) => {
    await save(ctx, guildId, next, enabled);
    for (const { roleId } of prunedTimed) await cancelRole(ctx.db, guildId, roleId);
  };
  const failure = (result, fullKey = 'autorole.full', limit = LIMITS.roles) =>
    reply(interaction, t(lang, { full: fullKey, exists: 'autorole.exists', missing: 'autorole.notListed' }[result.reason], { limit }));

  if (!group && sub === 'show') return reply(interaction, showText(interaction, lang, readConfig(stored)));

  if (!group && sub === 'reassign') {
    const on = interaction.options.getString('state', true) === 'on';
    await saveAll(setReassign(config, on));
    return reply(interaction, t(lang, on ? 'autorole.reassignOn' : 'autorole.reassignOff'));
  }

  const role = interaction.options.getRole('role', true);

  if (!group && sub === 'add') {
    if (!isValidRoleId(role, guildId)) return reply(interaction, t(lang, 'autorole.badRole'));
    const target = interaction.options.getString('target') === 'bots' ? 'bots' : 'humans';
    const result = addRole(config, target, role.id);
    if (!result.ok) return failure(result, 'autorole.full');
    await saveAll(result.config, true);
    const botTop = interaction.guild.members.me?.roles.highest.position;
    const warn = botTop !== undefined && role.position >= botTop ? `\n${t(lang, 'autorole.tooHigh')}` : '';
    return reply(interaction, t(lang, 'autorole.added', {
      role: mention(role.id), target: t(lang, target === 'bots' ? 'autorole.targetBots' : 'autorole.targetHumans'),
    }) + warn);
  }

  if (!group && sub === 'remove') {
    const result = removeRole(config, 'both', role.id);
    if (!result.ok) return failure(result);
    await saveAll(result.config);
    return reply(interaction, t(lang, 'autorole.removed', { role: mention(role.id) }));
  }

  if (group === 'blacklist') {
    const result = sub === 'add' ? addBlacklist(config, role.id) : removeBlacklist(config, role.id);
    if (!result.ok) return failure(result, 'autorole.blacklistFull', LIMITS.blacklist);
    await saveAll(result.config);
    return reply(interaction, t(lang, sub === 'add' ? 'autorole.blacklistAdded' : 'autorole.blacklistRemoved',
      { role: mention(role.id) }));
  }

  if (group === 'timed' && sub === 'add') {
    if (!isValidRoleId(role, guildId)) return reply(interaction, t(lang, 'autorole.badRole'));
    const text = interaction.options.getString('delay', true).trim();
    const seconds = parseDuration(text);
    if (seconds === null || seconds < MIN_DELAY || seconds > MAX_DELAY) {
      return reply(interaction, t(lang, 'autorole.badDelay',
        { min: formatDuration(MIN_DELAY), max: formatDuration(MAX_DELAY) }));
    }
    const result = addTimed(config, role.id, seconds);
    if (!result.ok) return failure(result, 'autorole.full', MAX_TIMED);
    await saveAll(result.config, true);
    return reply(interaction, t(lang, 'autorole.timedAdded', { role: mention(role.id), delay: formatDuration(seconds) }));
  }

  if (group === 'timed' && sub === 'remove') {
    const result = removeTimed(config, role.id);
    if (!result.ok) return failure(result);
    await saveAll(result.config);
    await cancelRole(ctx.db, guildId, role.id);
    return reply(interaction, t(lang, 'autorole.timedRemoved', { role: mention(role.id) }));
  }
}

export const commands = [{ data, execute }];
export { events };
