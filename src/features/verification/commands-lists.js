// /verification mode, public|skip add|remove|list, verify and unverify.
// Config writes are merge-style through setFeature: the stored config has extra keys
// (grantDone, cutoff, ...) that readConfig does not expose and that must never be replaced.
import { ChannelType } from 'discord.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { capList } from '../../core/lists.js';
import { botCanGive } from '../../core/role-safety.js';
import { getFeature, setFeature } from '../../db/settings.js';
import { t } from '../../i18n/index.js';
import { MODES, MAX_CHANNELS, readConfig } from './config.js';
import { canEveryoneView } from './plan.js';
import { snapshotOf, gateChannel, revertChannel } from './apply.js';
import { getRecord } from './store.js';
import { logVerification } from './log.js';
import { verifyMember } from './verify.js';

const FEATURE = 'verification';
const LIST_TEXT_MAX = 1500;
const KEY = { public: 'publicChannels', skip: 'skippedChannels' };
const CHANNEL_TYPES = [
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice,
  ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildCategory,
];

// Guilds with a list change running right now (read, save, re-apply must not interleave).
const busy = new Set();

/** Adds mode, public, skip, verify and unverify to the /verification builder. */
export function extendWithLists(builder) {
  const channel = (o) => o.setName('channel').setDescription('The channel').setRequired(true)
    .addChannelTypes(...CHANNEL_TYPES);
  const group = (name, description) => (g) => g.setName(name).setDescription(description)
    .addSubcommand((s) => s.setName('add').setDescription('Add a channel').addChannelOption(channel))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a channel').addChannelOption(channel))
    .addSubcommand((s) => s.setName('list').setDescription('Show the channels'));
  const member = (o) => o.setName('member').setDescription('The member').setRequired(true);
  return builder
    .addSubcommand((s) => s.setName('mode').setDescription('Choose how members verify')
      .addStringOption((o) => o.setName('mode').setDescription('How members verify').setRequired(true)
        .addChoices(...MODES.map((m) => ({ name: m, value: m })))))
    .addSubcommandGroup(group('public', 'Channels that stay visible but read-only before verifying'))
    .addSubcommandGroup(group('skip', 'Channels the gate never touches'))
    .addSubcommand((s) => s.setName('verify').setDescription('Verify a member by hand').addUserOption(member))
    .addSubcommand((s) => s.setName('unverify').setDescription('Remove the Verified role from a member')
      .addUserOption(member));
}

async function loadConfig(ctx, guildId) {
  const { config } = await getFeature(ctx.db, guildId, FEATURE);
  return readConfig(config);
}

// ---- mode --------------------------------------------------------------------------------

async function executeMode(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const mode = interaction.options.getString('mode', true);
  if (!MODES.includes(mode)) return;
  await setFeature(ctx.db, interaction.guildId, FEATURE, { config: { mode } });
  await interaction.reply(ephemeral(t(lang, 'verification.mode.saved', { mode })));
}

// ---- channel lists -----------------------------------------------------------------------

// Forced fetch: the cache can lag our own last write (see apply.js), and the visibility
// check below reads the overwrites. A failed fetch falls back to the cache.
async function resolveChannel(guild, id) {
  try {
    const live = await guild.channels.fetch(id, { force: true });
    if (live) return live;
  } catch (err) {
    if (err?.code === 10003) return null;
  }
  return guild.channels.cache.get(id) ?? null;
}

/**
 * Re-applies one channel after its list changed (the new lists are already saved in `next`):
 * revert from the recorded original, then gate with the new classification.
 * 'ok' | 'failed' (old state kept, record kept) | 'broken' (could not put the old gate back).
 */
async function reapply(ctx, guild, channel, next, prev) {
  const reverted = await revertChannel(ctx, guild, channel);
  if (reverted !== 'failed' && (await gateChannel(ctx, guild, channel, next)) !== 'failed') return 'ok';
  // A revert that failed may have restored part of the original (channel open), and a failed new
  // gate leaves it reverted: put the previous classification back either way.
  return (await gateChannel(ctx, guild, channel, prev)) === 'failed' ? 'broken' : 'failed';
}

// Was the channel visible to @everyone? A channel we gated has @everyone View denied by us, so
// judge it from the recorded original; without a record, from what it is now.
async function everyoneCanView(ctx, guild, channel) {
  const everyoneId = guild.roles.everyone.id;
  const rec = await getRecord(ctx.db, guild.id, channel.id);
  if (!rec) return canEveryoneView(snapshotOf(channel, guild), everyoneId);
  const base = BigInt(guild.roles.everyone.permissions.bitfield);
  const o = rec.everyone;
  const overwrites = o?.existed
    ? [{ id: everyoneId, type: 0, allow: BigInt(o.allow), deny: BigInt(o.deny) }] : [];
  return canEveryoneView({ everyoneBase: base, overwrites }, everyoneId);
}

async function executeChannelList(interaction, ctx, listName) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return;
  const { guild } = interaction;
  const sub = interaction.options.getSubcommand();
  const key = KEY[listName];
  const listLabel = t(lang, `verification.lists.name_${listName}`);
  const say = (text) => interaction.reply(ephemeral(text));

  if (sub === 'list') {
    const cfg = await loadConfig(ctx, guild.id);
    const ids = cfg[key];
    if (ids.length === 0) return say(t(lang, 'verification.lists.none', { list: listLabel }));
    const shown = capList(ids.map((id) => `<#${id}>`), {
      max: LIST_TEXT_MAX, sep: ' ', more: (count) => t(lang, 'verification.lists.more', { count }),
    });
    return say(`${t(lang, 'verification.lists.title', { list: listLabel, count: ids.length })}\n${shown}`);
  }

  if (busy.has(guild.id)) return say(t(lang, 'verification.lists.busy'));
  busy.add(guild.id);
  try {
    return await changeList(interaction, ctx, { lang, guild, sub, listName, key, listLabel, say });
  } catch (err) {
    console.warn('verification: list change failed:', err?.message ?? err);
    return say(t(lang, 'verification.lists.error'));
  } finally {
    busy.delete(guild.id);
  }
}

async function changeList(interaction, ctx, { lang, guild, sub, listName, key, listLabel, say }) {
  const channelId = interaction.options.getChannel('channel', true).id;
  const channelMention = `<#${channelId}>`;
  const prev = await loadConfig(ctx, guild.id);
  const current = prev[key];
  const adding = sub === 'add';

  if (adding) {
    const otherName = listName === 'public' ? 'skip' : 'public';
    if (channelId === prev.channelId) return say(t(lang, 'verification.lists.is_verify'));
    if (current.includes(channelId)) return say(t(lang, 'verification.lists.exists', { list: listLabel }));
    if (prev[KEY[otherName]].includes(channelId)) {
      return say(t(lang, 'verification.lists.other_list', { other: t(lang, `verification.lists.name_${otherName}`) }));
    }
    if (current.length >= MAX_CHANNELS) {
      return say(t(lang, 'verification.lists.full', { list: listLabel, max: MAX_CHANNELS }));
    }
  } else if (!current.includes(channelId)) {
    return say(t(lang, 'verification.lists.missing', { list: listLabel }));
  }

  const channel = await resolveChannel(guild, channelId);
  if (adding && listName === 'public') {
    if (!channel) return say(t(lang, 'verification.lists.not_found'));
    // Verified must never open a channel @everyone cannot see.
    if (!(await everyoneCanView(ctx, guild, channel))) {
      return say(t(lang, 'verification.lists.private'));
    }
  }

  const nextList = adding ? [...current, channelId] : current.filter((id) => id !== channelId);
  const next = { ...prev, [key]: nextList };
  // Saved first: gateChannel classifies from the config it is given.
  await setFeature(ctx.db, guild.id, FEATURE, { config: { [key]: nextList } });

  // Active: always re-apply. Rolling out or failed once the grant is done: the gate job may be
  // past this channel (or will not come back), so apply now (a later pass is a no-op). Before the
  // grant is done nothing may be gated early: a running gate job reads the new lists itself. A
  // channel that already has a record is gated either way, so it is always re-applied.
  const { config: rawNow } = await getFeature(ctx.db, guild.id, FEATURE);
  let needsApply = prev.state === 'active';
  if (prev.state === 'rolling_out' || prev.state === 'failed') {
    needsApply = rawNow?.grantDone === true || (await getRecord(ctx.db, guild.id, channelId)) != null;
  }
  if (needsApply && channel) {
    const outcome = await reapply(ctx, guild, channel, next, prev);
    if (outcome !== 'ok') {
      try {
        await setFeature(ctx.db, guild.id, FEATURE, { config: { [key]: current } });
      } catch (err) {
        console.warn('verification: could not roll the list back:', err?.message ?? err);
        return say(t(lang, 'verification.lists.apply_broken', { channel: channelMention }));
      }
      return say(t(lang, outcome === 'broken' ? 'verification.lists.apply_broken' : 'verification.lists.apply_failed',
        { channel: channelMention }));
    }
  }
  return say(t(lang, adding ? 'verification.lists.added' : 'verification.lists.removed',
    { channel: channelMention, list: listLabel }));
}

export function executeGroup(interaction, ctx, group) {
  return executeChannelList(interaction, ctx, group);
}

// ---- manual verify / unverify --------------------------------------------------------------

/** Common checks; returns { lang, guild, cfg, member } or null after replying. */
async function manualContext(interaction, ctx) {
  const lang = await guard(interaction, ctx, FEATURE, { requireEnabled: false });
  if (!lang) return null;
  const { guild } = interaction;
  const say = (key, vars) => interaction.editReply({ content: t(lang, key, vars) });
  const cfg = await loadConfig(ctx, guild.id);
  if (cfg.state === 'none') {
    await interaction.reply(ephemeral(t(lang, 'verification.manual.none')));
    return null;
  }
  await interaction.deferReply(ephemeral({}));
  let member;
  try {
    member = await guild.members.fetch({ user: interaction.options.getUser('member', true).id, force: true });
  } catch {
    await say('verification.manual.not_found');
    return null;
  }
  // Same convention as moderation (rules.js): not the owner, and strictly below the actor unless the actor is the owner.
  if (member.id === guild.ownerId) {
    await say('verification.manual.owner');
    return null;
  }
  const actorIsOwner = interaction.user.id === guild.ownerId;
  const actorTop = interaction.member?.roles?.highest?.position ?? 0;
  if (!actorIsOwner && (member.roles?.highest?.position ?? 0) >= actorTop) {
    await say('verification.manual.hierarchy');
    return null;
  }
  return { lang, guild, cfg, member, say };
}

const REASON_KEY = {
  no_role: 'verification.manual.no_role',
  role_too_high: 'verification.manual.role_too_high',
  role_dangerous: 'verification.manual.role_dangerous',
  already: 'verification.manual.already',
  discord_error: 'verification.manual.error',
};

async function executeVerify(interaction, ctx, deps) {
  const c = await manualContext(interaction, ctx);
  if (!c) return;
  const vars = { member: `<@${c.member.id}>` };
  // verifyMember already writes the manual_verify log line (with the actor): not logged again here.
  const result = await verifyMember(ctx, c.guild, c.member, { method: 'manual', actorId: interaction.user.id }, deps);
  await c.say(result.ok ? 'verification.manual.verified' : REASON_KEY[result.reason], vars);
}

async function executeUnverify(interaction, ctx, deps) {
  const c = await manualContext(interaction, ctx);
  if (!c) return;
  const { guild, cfg, member, lang } = c;
  const vars = { member: `<@${member.id}>` };
  if (member.user?.bot) return c.say('verification.manual.bot', vars);
  let role = cfg.roleId ? (guild.roles.cache.get(cfg.roleId) ?? null) : null;
  if (!role && cfg.roleId) role = await guild.roles.fetch(cfg.roleId).catch(() => null);
  if (!role) return c.say('verification.manual.no_role', vars);
  if (!botCanGive(guild, role)) return c.say('verification.manual.role_too_high', vars);
  if (!member.roles.cache.has(role.id)) return c.say('verification.manual.not_verified', vars);
  try {
    await member.roles.remove(role.id, 'Verification: manual unverify');
  } catch (err) {
    console.warn('verification: could not remove the role:', err?.message ?? err);
    return c.say('verification.manual.error', vars);
  }
  await (deps?.logVerification ?? logVerification)(ctx, guild.id, lang, {
    kind: 'manual_unverify', userId: member.id, actorId: interaction.user.id,
  });
  return c.say('verification.manual.unverified', vars);
}

export const listHandlers = { mode: executeMode, verify: executeVerify, unverify: executeUnverify };
