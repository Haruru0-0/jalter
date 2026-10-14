import { SlashCommandBuilder } from 'discord.js';
import { FEATURES } from '../../core/registry.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { listFeatures } from '../../db/settings.js';
import { t } from '../../i18n/index.js';

const SUB = 1;
const GROUP = 2;

const nestedOf = (node) => (node.options ?? []).filter((o) => o.type === SUB || o.type === GROUP);

/** Every runnable path of a command, such as `set greet channel`, with its description. */
export function commandPaths(json, key, byKey) {
  const paths = [];
  const walk = (prefix, node) => {
    const nested = nestedOf(node);
    if (!nested.length) paths.push({ path: prefix, description: node.description });
    for (const child of nested) walk(`${prefix} ${child.name}`, child);
  };
  const top = nestedOf(json);
  if (!top.length) walk(json.name, json);
  for (const child of byKey ? top.filter((o) => o.name === key) : top) {
    walk(`${json.name} ${child.name}`, child);
  }
  return paths;
}

function featurePaths(feature, commands) {
  return (feature.commands ?? [feature.command]).flatMap((name) => {
    const command = commands.get(name);
    return command ? commandPaths(command.data.toJSON(), feature.key, feature.byKey) : [];
  });
}

function statusOf(feature, enabled, lang) {
  if (feature.alwaysOn) return t(lang, 'panel.core');
  return enabled.get(feature.key)?.enabled ? t(lang, 'common.on') : t(lang, 'common.off');
}

function overview(lang, enabled, commands) {
  const lines = [];
  const soon = [];
  for (const feature of FEATURES) {
    if (feature.command === null) {
      soon.push(t(lang, feature.nameKey));
      continue;
    }
    const tops = new Set(featurePaths(feature, commands).map((p) => p.path.split(' ').slice(0, 2).join(' ')));
    const list = [...tops].map((p) => `/${p}`).join(', ');
    lines.push(`**${t(lang, feature.nameKey)}** (${statusOf(feature, enabled, lang)}): ${list}`);
  }
  lines.push('', t(lang, 'help.more'), '', `${t(lang, 'panel.comingSoon')}: ${soon.join(', ')}`);
  return { title: t(lang, 'help.title'), description: lines.join('\n') };
}

function detail(lang, feature, enabled, commands) {
  const lines = featurePaths(feature, commands).map((p) => `\`/${p.path}\`: ${p.description}`);
  return {
    title: `${t(lang, feature.nameKey)} (${statusOf(feature, enabled, lang)})`,
    description: lines.join('\n').slice(0, 4000),
  };
}

export function findFeature(query, lang) {
  const q = query.trim().toLowerCase();
  return FEATURES.find((f) => f.command !== null && (f.key === q || t(lang, f.nameKey).toLowerCase() === q));
}

/** The help embed: an overview, or one feature when `query` names it. Returns null for an unknown name. */
export function buildHelp(lang, enabled, commands, query = null) {
  if (!query) return overview(lang, enabled, commands);
  const feature = findFeature(query, lang);
  return feature ? detail(lang, feature, enabled, commands) : null;
}

const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('List the bot features and their commands')
  .addStringOption((o) =>
    o.setName('feature').setDescription('A feature name, such as autorole, to see all of its commands'));

async function execute(interaction, ctx) {
  const lang = await guard(interaction, ctx, 'help', { requireManager: false, requireEnabled: false });
  if (!lang) return;
  const enabled = await listFeatures(ctx.db, interaction.guildId);
  const query = interaction.options.getString('feature');
  const embed = buildHelp(lang, enabled, ctx.commands, query);
  if (!embed) {
    await interaction.reply(ephemeral(t(lang, 'help.unknown', { name: query })));
    return;
  }
  await interaction.reply(ephemeral({ embeds: [embed] }));
}

export const commands = [{ data, execute }];
export const events = [];
