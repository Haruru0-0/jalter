// Applies a planned verification gate to a real channel and reverts it from the
// undo record. The planner (plan.js) is pure; this file is the Discord/DB edge.
import { PermissionFlagsBits as P } from 'discord.js';
import { getFeature } from '../../db/settings.js';
import { classify, readConfig } from './config.js';
import { planChannel, SEND_BITS, VOICE_BITS, BOT_VERIFY_BITS, VIEW_BIT } from './plan.js';
import { recordOriginal, getRecord, deleteRecord } from './store.js';

// The bits the gate can change on @everyone/Verified (and, separately, on the
// bot); revert never touches anything outside them.
const ROLE_BITS = SEND_BITS | VOICE_BITS | VIEW_BIT;

const FLAGS = Object.entries(P);

export function snapshotOf(channel, guild) {
  return {
    id: channel.id,
    type: channel.type,
    everyoneBase: BigInt(guild.roles.everyone.permissions.bitfield),
    overwrites: [...channel.permissionOverwrites.cache.values()].map((o) => ({
      id: o.id,
      type: o.type,
      allow: BigInt(o.allow.bitfield),
      deny: BigInt(o.deny.bitfield),
    })),
  };
}

const find = (snap, id) => snap.overwrites.find((o) => o.id === id) ?? null;

const toRecord = (o) => ({
  existed: o != null,
  allow: String(o?.allow ?? 0n),
  deny: String(o?.deny ?? 0n),
});

// PermissionOverwriteOptions for the bits in `mask`: true = allow, false = deny, null = neutral.
function optionsFor(mask, allow, deny) {
  const out = {};
  for (const [name, bit] of FLAGS) {
    if ((mask & bit) !== bit) continue;
    out[name] = (allow & bit) === bit ? true : (deny & bit) === bit ? false : null;
  }
  return out;
}

async function writeTarget(channel, id, current, wanted) {
  const curAllow = current?.allow ?? 0n;
  const curDeny = current?.deny ?? 0n;
  const changed = (wanted.allow ^ curAllow) | (wanted.deny ^ curDeny);
  if (changed === 0n) return;
  await channel.permissionOverwrites.edit(id, optionsFor(changed, wanted.allow, wanted.deny));
}

export async function gateChannel(ctx, guild, channel, cfg) {
  try {
    const kind = classify(channel.id, cfg);
    if (kind === 'skip') return 'skipped';
    if (channel.permissionsLocked && channel.parent && classify(channel.parent.id, cfg) === kind) {
      return 'skipped';
    }
    const everyoneId = guild.roles.everyone.id;
    const botId = guild.members?.me?.id ?? ctx.client?.user?.id;
    const snap = snapshotOf(channel, guild);
    const plan = planChannel(snap, kind, { everyoneId, verifiedId: cfg.roleId, botId });
    if (plan.skip) return 'skipped';

    // Record the originals first; the first record per channel wins.
    await recordOriginal(ctx.db, guild.id, channel.id, {
      everyone: toRecord(find(snap, everyoneId)),
      verified: toRecord(find(snap, cfg.roleId)),
      bot: plan.bot ? toRecord(find(snap, botId)) : null,
    });

    // @everyone goes LAST: once it denies View a rerun would call the channel
    // private and never finish. Until then a rerun still treats it as gate-able.
    if (plan.bot) await writeTarget(channel, botId, find(snap, botId), plan.bot);
    await writeTarget(channel, cfg.roleId, find(snap, cfg.roleId), plan.verified);
    await writeTarget(channel, everyoneId, find(snap, everyoneId), plan.everyone);
    return 'changed';
  } catch (err) {
    console.error('verification gateChannel failed', channel?.id, err?.message ?? err);
    return 'failed';
  }
}

async function restoreTarget(channel, id, current, original, gateBits) {
  if (!original) return;
  const oAllow = BigInt(original.allow);
  const oDeny = BigInt(original.deny);
  const cAllow = current?.allow ?? 0n;
  const cDeny = current?.deny ?? 0n;
  if (!original.existed) {
    if (!current) return;
    // Nothing outside the gate's bits was added since: remove the overwrite entirely.
    if (((cAllow | cDeny) & ~gateBits) === 0n) {
      await channel.permissionOverwrites.delete(id);
      return;
    }
    const changed = (cAllow | cDeny) & gateBits;
    if (changed !== 0n) await channel.permissionOverwrites.edit(id, optionsFor(changed, 0n, 0n));
    return;
  }
  const changed = ((oAllow ^ cAllow) | (oDeny ^ cDeny)) & gateBits;
  if (changed === 0n) return;
  await channel.permissionOverwrites.edit(id, optionsFor(changed, oAllow, oDeny));
}

export async function revertChannel(ctx, guild, channel) {
  try {
    const rec = await getRecord(ctx.db, guild.id, channel.id);
    if (!rec) return 'missing';
    const everyoneId = guild.roles.everyone.id;
    const botId = guild.members?.me?.id ?? ctx.client?.user?.id;
    const snap = snapshotOf(channel, guild);
    // The record holds no role id: Verified is whatever the config names now.
    // Without it the Verified overwrite cannot be restored, so keep the record.
    const feature = await getFeature(ctx.db, guild.id, 'verification');
    const { roleId } = readConfig(feature?.config);
    if (rec.verified && !roleId) {
      console.error('verification revertChannel: no Verified role id in config', channel.id);
      return 'failed';
    }
    await restoreTarget(channel, everyoneId, find(snap, everyoneId), rec.everyone, ROLE_BITS);
    if (rec.verified) {
      await restoreTarget(channel, roleId, find(snap, roleId), rec.verified, ROLE_BITS);
    }
    if (rec.bot) await restoreTarget(channel, botId, find(snap, botId), rec.bot, BOT_VERIFY_BITS);
    await deleteRecord(ctx.db, guild.id, channel.id);
    return 'restored';
  } catch (err) {
    console.error('verification revertChannel failed', channel?.id, err?.message ?? err);
    return 'failed';
  }
}
