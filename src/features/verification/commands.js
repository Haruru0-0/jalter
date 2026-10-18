import {
  SlashCommandBuilder, ChannelType, PermissionFlagsBits as P, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { botCanGive } from '../../core/role-safety.js';
import { ensureChannel } from '../../core/auto-channel.js';
import { cancelJobs } from '../../core/scheduler.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';
import { MODES, classify, readConfig } from './config.js';
import { planChannel, roleViewers, canEveryoneView } from './plan.js';
import { snapshotOf, revertChannel } from './apply.js';
import { listRecords, deleteRecord, countRecords } from './store.js';
import { logVerification } from './log.js';
import { GRANT_JOB, GATE_JOB, ROLLOUT_KEY, startRollout } from './rollout.js';
import { handle, postPanel } from './verify.js';

const FEATURE = 'verification';
const CONFIRM_TTL_MS = 120_000;
const LIST_MAX = 10;
const BOT_PERMS = [
  ['ManageRoles', P.ManageRoles], ['ManageChannels', P.ManageChannels], ['ViewChannel', P.ViewChannel],
  ['SendMessages', P.SendMessages], ['EmbedLinks', P.EmbedLinks], ['AttachFiles', P.AttachFiles],
];

// Setup choices are too big for a custom id: kept in memory until the confirm expires.
const pending = new Map();
const pendingKey = (userId, createdAt) => `${userId}:${createdAt}`;
// Guilds with a setup confirm or a remove running right now.
const inFlight = new Set();

const mentions = (ids) => {
  const shown = ids.slice(0, LIST_MAX).map((id) => `<#${id}>`).join(' ');
  return ids.length > LIST_MAX ? `${shown} +${ids.length - LIST_MAX}` : shown;
};

export function createVerificationCommand() {
  const data = toggleSubcommands(
    new SlashCommandBuilder().setName('verification').setDescription('Verification settings'),
  )
    .addSubcommand((s) => s.setName('setup').setDescription('Set up the verification gate')
      .addStringOption((o) => o.setName('mode').setDescription('How members verify')
        .addChoices(...MODES.map((m) => ({ name: m, value: m }))))
      .addRoleOption((o) => o.setName('role').setDescription('Use this role as Verified (default: create one)'))
      .addChannelOption((o) => o.setName('channel').setDescription('Verify channel (default: create one)')
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('status').setDescription('Show the verification status'))
    .addSubcommand((s) => s.setName('remove').setDescription('Undo the gate and turn verification off'));

  async function execute(interaction, ctx) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'enable' || sub === 'disable') return handleToggle(interaction, ctx, FEATURE);
    if (sub === 'setup') return executeSetup(interaction, ctx);
    if (sub === 'status') return executeStatus(interaction, ctx);
    if (sub === 'remove') return executeRemove(interaction, ctx);
    return undefined;
  }

  return { data, execute, components: { prefix: 'verification', handle } };
}

// ---- setup -------------------------------------------------------------------------------

/** Everything setup needs. Returns { problem, vars } or { role, channel } (null = to be created). */
function checkSetup(guild, cfg, { roleId, channelId }) {
  if (cfg.state !== 'none') return { problem: 'not_none' };
  const missing = BOT_PERMS.filter(([, bit]) => !guild.members.me?.permissions?.has(bit)).map(([name]) => name);
  if (missing.length) return { problem: 'missing_perms', vars: { perms: missing.join(', ') } };
  if (guild.roles.everyone.permissions?.has(P.Administrator)) return { problem: 'everyone_admin' };

  const wantedRole = roleId ?? cfg.roleId;
  const role = wantedRole ? (guild.roles.cache.get(wantedRole) ?? null) : null;
  if (role && !botCanGive(guild, role)) return { problem: 'role_unusable' };

  // The gate skips a channel @everyone cannot view, so the verify channel must be viewable.
  const wantedChannel = channelId ?? cfg.channelId;
  const channel = wantedChannel ? (guild.channels.cache.get(wantedChannel) ?? null) : null;
  if (channel && !canEveryoneView(snapshotOf(channel, guild), guild.roles.everyone.id)) {
    return { problem: 'channel_private' };
  }
  return { role, channel };
}

/** Counts what the gate would do and lists gated channels where another role keeps an explicit View allow. */
async function previewOf(guild, cfg, role, channel) {
  const everyoneId = guild.roles.everyone.id;
  const verifiedId = role?.id ?? cfg.roleId ?? 'verified';
  const botId = guild.members.me?.id ?? 'bot';
  const view = { ...cfg, channelId: channel?.id ?? cfg.channelId };
  const out = { gated: 0, public: 0, skipped: 0, private: 0, leaks: [] };
  const fetched = await guild.channels.fetch();
  for (const c of [...fetched.values()].filter((x) => x && !x.isThread?.())) {
    const kind = classify(c.id, view);
    if (kind === 'skip') { out.skipped += 1; continue; }
    // A channel synced with a category of the same kind is handled by the category.
    if (c.permissionsLocked && c.parent && classify(c.parent.id, view) === kind) continue;
    const snap = snapshotOf(c, guild);
    const plan = planChannel(snap, kind, { everyoneId, verifiedId, botId });
    if (plan.skip) { out.private += 1; continue; }
    if (kind === 'public') out.public += 1;
    else if (kind === 'gated') {
      out.gated += 1;
      if (roleViewers(snap, everyoneId, verifiedId).length) out.leaks.push(c.id);
    }
  }
  return out;
}

async function executeSetup(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const { guild } = interaction;
  const { config } = await getFeature(ctx.db, guild.id, FEATURE);
  const cfg = readConfig(config);
  const opts = {
    mode: interaction.options.getString('mode') ?? cfg.mode,
    roleId: interaction.options.getRole('role')?.id ?? null,
    channelId: interaction.options.getChannel('channel')?.id ?? null,
  };
  const check = checkSetup(guild, cfg, opts);
  if (check.problem) {
    await interaction.reply(ephemeral(t(lang, `verification.setup.${check.problem}`, check.vars)));
    return;
  }
  await interaction.deferReply(ephemeral({}));
  let preview;
  try {
    preview = await previewOf(guild, cfg, check.role, check.channel);
  } catch (err) {
    console.warn('verification: preview failed:', err?.message ?? err);
    await interaction.editReply({ content: t(lang, 'verification.setup.failed') });
    return;
  }
  const lines = [t(lang, 'verification.setup.preview', {
    gated: preview.gated, public: preview.public, skipped: preview.skipped, private: preview.private,
    members: guild.memberCount ?? guild.members.cache?.size ?? 0,
  })];
  if (preview.leaks.length) {
    lines.push(t(lang, 'verification.setup.preview_leaks', { channels: mentions(preview.leaks) }));
  }
  lines.push(t(lang, 'verification.setup.preview_ask'));

  const createdAt = Date.now();
  const key = pendingKey(interaction.user.id, createdAt);
  pending.set(key, opts);
  setTimeout(() => pending.delete(key), CONFIRM_TTL_MS + 5000).unref?.();
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`verification:setup:ok:${interaction.user.id}:${createdAt}`)
      .setLabel(t(lang, 'verification.setup.confirm')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`verification:setup:no:${interaction.user.id}`)
      .setLabel(t(lang, 'verification.setup.cancel')).setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ content: lines.join('\n'), components: [row] });
}

/** Confirm / Cancel buttons of the setup preview: `verification:setup:ok|no:<userId>[:<createdAt>]`. */
export async function handleSetupButton(interaction, ctx) {
  const [, , action, userId, createdRaw] = interaction.customId.split(':');
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  if (interaction.user.id !== userId) {
    await interaction.reply(ephemeral(t(lang, 'verification.setup.not_yours')));
    return;
  }
  if (action === 'no') {
    for (const k of pending.keys()) if (k.startsWith(`${userId}:`)) pending.delete(k);
    await interaction.update({ content: t(lang, 'verification.setup.cancelled'), components: [] });
    return;
  }
  const age = Date.now() - Number(createdRaw);
  const key = pendingKey(userId, createdRaw);
  const opts = pending.get(key);
  if (!Number.isFinite(age) || age > CONFIRM_TTL_MS || age < -5000 || !opts) {
    pending.delete(key);
    await interaction.update({ content: t(lang, 'verification.setup.expired'), components: [] });
    return;
  }
  const guildId = interaction.guildId;
  if (inFlight.has(guildId)) {
    await interaction.reply(ephemeral(t(lang, 'verification.setup.in_progress')));
    return;
  }
  inFlight.add(guildId);
  pending.delete(key);
  try {
    await interaction.deferUpdate();
    const content = await runSetup(interaction, ctx, lang, opts);
    await interaction.editReply({ content, components: [] });
  } catch (err) {
    console.warn('verification: setup confirm failed:', err?.message ?? err);
    try {
      await interaction.editReply({ content: t(lang, 'verification.setup.failed'), components: [] });
    } catch (editErr) {
      console.warn('verification: could not report the failure:', editErr?.message ?? editErr);
    }
  } finally {
    inFlight.delete(guildId);
  }
}

// Does the work after Confirm; returns the text for the admin.
async function runSetup(interaction, ctx, lang, opts) {
  const { guild } = interaction;
  const { config } = await getFeature(ctx.db, guild.id, FEATURE);
  const cfg = readConfig(config);
  const check = checkSetup(guild, cfg, opts);
  if (check.problem) return t(lang, `verification.setup.${check.problem}`, check.vars);

  let { role, channel } = check;
  if (!role) {
    const botTop = guild.members.me.roles.highest.position;
    try {
      role = await guild.roles.create({
        name: t(lang, 'verification.setup.role_name'), permissions: [], hoist: false, mentionable: false,
        position: Math.max(1, botTop - 1), reason: 'Verification setup',
      });
    } catch (err) {
      console.warn('verification: could not create the role:', err?.message ?? err);
      return t(lang, 'verification.setup.role_failed');
    }
    if (!botCanGive(guild, role)) {
      await role.delete?.('Verification setup').catch(() => {});
      return t(lang, 'verification.setup.role_failed');
    }
    // Saved at once so a retry reuses it instead of creating another.
    await setFeature(ctx.db, guild.id, FEATURE, { config: { roleId: role.id } });
  }
  if (!channel) {
    channel = await ensureChannel(guild, { name: t(lang, 'verification.setup.channel_name') });
    if (!channel) return t(lang, 'verification.setup.channel_failed');
    if (!canEveryoneView(snapshotOf(channel, guild), guild.roles.everyone.id)) {
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: true });
      } catch (err) {
        console.warn('verification: could not open the verify channel:', err?.message ?? err);
        await channel.delete?.('Verification setup').catch(() => {});
        return t(lang, 'verification.setup.channel_failed');
      }
    }
    await setFeature(ctx.db, guild.id, FEATURE, { config: { channelId: channel.id } });
  }
  const messageId = await postPanel(ctx, guild, channel, lang);
  if (!messageId) return t(lang, 'verification.setup.panel_failed');

  await setFeature(ctx.db, guild.id, FEATURE, {
    enabled: true, config: { mode: opts.mode, roleId: role.id, channelId: channel.id, messageId },
  });
  await logVerification(ctx, guild.id, lang, { kind: 'setup', actorId: interaction.user.id, detail: opts.mode });
  await startRollout(ctx, guild, lang, interaction.user.id);
  return t(lang, 'verification.setup.done', { role: `<@&${role.id}>`, channel: `<#${channel.id}>` });
}

// ---- status ------------------------------------------------------------------------------

async function executeStatus(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const guildId = interaction.guildId;
  const { enabled, config } = await getFeature(ctx.db, guildId, FEATURE);
  const cfg = readConfig(config);
  const raw = config ?? {};
  const { rows: jobRows } = await ctx.db.query(
    'SELECT type FROM scheduled_jobs WHERE guild_id = $1 AND type IN ($2, $3)', [guildId, GRANT_JOB, GATE_JOB],
  );
  const unset = t(lang, 'verification.status.unset');
  const lines = [
    t(lang, 'verification.status.enabled', { value: t(lang, enabled ? 'common.on' : 'common.off') }),
    t(lang, 'verification.status.mode', { value: cfg.mode }),
    t(lang, 'verification.status.role', { value: cfg.roleId ? `<@&${cfg.roleId}>` : unset }),
    t(lang, 'verification.status.channel', { value: cfg.channelId ? `<#${cfg.channelId}>` : unset }),
    t(lang, 'verification.status.state', { value: t(lang, `verification.status.state.${cfg.state}`) }),
  ];
  if (cfg.state === 'rolling_out') {
    if (jobRows.length === 0) lines.push(t(lang, 'verification.status.stuck'));
    else lines.push(t(lang, `verification.status.progress.${raw.grantDone === true ? 'gate' : 'grant'}`));
  } else if (cfg.state === 'failed') {
    lines.push(t(lang, 'verification.status.failed', { count: Number(raw.failedChannels) || 0 }));
  }
  lines.push(t(lang, 'verification.status.lists', {
    public: cfg.publicChannels.length, skipped: cfg.skippedChannels.length,
  }));
  lines.push(t(lang, 'verification.status.records', { count: await countRecords(ctx.db, guildId) }));
  await interaction.reply(ephemeral(lines.join('\n')));
}

// ---- remove ------------------------------------------------------------------------------

async function executeRemove(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const { guild } = interaction;
  if (inFlight.has(guild.id)) {
    await interaction.reply(ephemeral(t(lang, 'verification.remove.in_progress')));
    return;
  }
  inFlight.add(guild.id);
  try {
    await interaction.deferReply(ephemeral({}));
    await interaction.editReply({ content: await runRemove(interaction, ctx, lang) });
  } catch (err) {
    console.warn('verification: remove failed:', err?.message ?? err);
    await interaction.editReply({ content: t(lang, 'verification.remove.error') }).catch(() => {});
  } finally {
    inFlight.delete(guild.id);
  }
}

async function runRemove(interaction, ctx, lang) {
  const { guild } = interaction;
  const { enabled, config } = await getFeature(ctx.db, guild.id, FEATURE);
  const cfg = readConfig(config);
  const records = await listRecords(ctx.db, guild.id);
  if (cfg.state === 'none' && !enabled && records.length === 0) return t(lang, 'verification.remove.nothing');

  // No rollout job may gate a channel while (or after) it is being restored.
  await cancelJobs(ctx.db, { guildId: guild.id, type: GRANT_JOB, key: ROLLOUT_KEY });
  await cancelJobs(ctx.db, { guildId: guild.id, type: GATE_JOB, key: ROLLOUT_KEY });

  const failed = [];
  for (const rec of records) {
    let channel = guild.channels.cache.get(rec.channelId) ?? null;
    if (!channel) {
      try {
        channel = await guild.channels.fetch(rec.channelId);
      } catch (err) {
        if (err?.code !== 10003) { failed.push(rec.channelId); continue; }
      }
    }
    // The channel no longer exists: nothing left to restore.
    if (!channel) { await deleteRecord(ctx.db, guild.id, rec.channelId); continue; }
    if ((await revertChannel(ctx, guild, channel)) === 'failed') failed.push(rec.channelId);
  }

  await logVerification(ctx, guild.id, lang, {
    kind: 'undo', actorId: interaction.user.id,
    detail: failed.length ? `${failed.length} channel(s) could not be restored` : undefined,
  });
  if (failed.length) {
    return t(lang, 'verification.remove.partial', { count: failed.length, channels: mentions(failed) });
  }

  if (cfg.channelId && cfg.messageId) {
    try {
      const panelChannel = guild.channels.cache.get(cfg.channelId) ?? await guild.channels.fetch(cfg.channelId);
      await panelChannel?.messages.delete(cfg.messageId);
    } catch (err) {
      console.warn('verification: could not delete the panel:', err?.message ?? err);
    }
  }
  await setFeature(ctx.db, guild.id, FEATURE, { enabled: false, config: { state: 'none', messageId: null } });
  return t(lang, 'verification.remove.done');
}
