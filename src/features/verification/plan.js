// Pure permission planner for the verification gate. Plain data in, plain data
// out, bigint bit math only: no Discord objects, no I/O.
//
// Snapshot = { id, type, everyoneBase: bigint,
//              overwrites: [{ id, type: 0 (role) | 1 (member), allow: bigint, deny: bigint }] }
//
// A planned overwrite is the existing one (or 0n/0n when there is none) with
// only the gate's bits moved: bits to allow are set in allow and cleared from
// deny, bits to deny are set in deny and cleared from allow. Every other bit is
// kept as it was, and other roles' and members' overwrites are never planned.
import { PermissionFlagsBits as P, ChannelType } from 'discord.js';

const ROLE = 0;
const MEMBER = 1;

export const VIEW_BIT = P.ViewChannel;

export const SEND_BITS = P.SendMessages
  | P.SendMessagesInThreads
  | P.CreatePublicThreads
  | P.CreatePrivateThreads
  | P.AddReactions
  | P.UseApplicationCommands;

export const VOICE_BITS = P.Connect | P.Speak;

export const BOT_VERIFY_BITS = P.ViewChannel
  | P.SendMessages
  | P.ReadMessageHistory
  | P.EmbedLinks
  | P.AttachFiles
  | P.ManageMessages;

const KINDS = new Set(['gated', 'public', 'verify', 'skip']);

const isVoice = (type) => type === ChannelType.GuildVoice || type === ChannelType.GuildStageVoice;

function findOverwrite(snap, id, type) {
  return (snap.overwrites ?? []).find((o) => o.id === id && o.type === type) ?? null;
}

// The existing overwrite with `allowBits` moved to allow and `denyBits` moved to deny.
function apply(existing, { allowBits = 0n, denyBits = 0n }) {
  let allow = existing?.allow ?? 0n;
  let deny = existing?.deny ?? 0n;
  allow = (allow | allowBits) & ~denyBits;
  deny = (deny | denyBits) & ~allowBits;
  return { allow, deny };
}

// The computed permission of the @everyone role alone: the guild-level bits,
// minus the channel's @everyone deny, plus its @everyone allow. Other roles and
// member overwrites are ignored on purpose.
export function canEveryoneView(snap, everyoneId) {
  const base = snap.everyoneBase ?? 0n;
  if ((base & P.Administrator) === P.Administrator) return true;
  const o = findOverwrite(snap, everyoneId, ROLE);
  const perms = (base & ~(o?.deny ?? 0n)) | (o?.allow ?? 0n);
  return (perms & P.ViewChannel) === P.ViewChannel;
}

// Ids of roles other than @everyone and Verified whose overwrite in this
// channel explicitly allows View Channel (they keep it visible to unverified
// members holding that role).
export function roleViewers(snap, everyoneId, verifiedId) {
  return (snap.overwrites ?? [])
    .filter((o) => o.type === ROLE && o.id !== everyoneId && o.id !== verifiedId)
    .filter((o) => (o.allow & P.ViewChannel) === P.ViewChannel)
    .map((o) => o.id);
}

export function planChannel(snap, kind, { everyoneId, verifiedId, botId }) {
  if (!KINDS.has(kind)) throw new Error(`verification plan: unknown kind ${kind}`);
  if (kind === 'skip') return { skip: true, reason: 'kind_skip' };
  if (!canEveryoneView(snap, everyoneId)) return { skip: true, reason: 'private' };

  const everyoneOw = findOverwrite(snap, everyoneId, ROLE);
  const verifiedOw = findOverwrite(snap, verifiedId, ROLE);

  if (kind === 'gated') {
    return {
      skip: false,
      everyone: apply(everyoneOw, { denyBits: P.ViewChannel }),
      verified: apply(verifiedOw, { allowBits: P.ViewChannel }),
    };
  }

  if (kind === 'public') {
    const bits = isVoice(snap.type) ? SEND_BITS | VOICE_BITS : SEND_BITS;
    return {
      skip: false,
      everyone: apply(everyoneOw, { denyBits: bits }),
      verified: apply(verifiedOw, { allowBits: bits }),
    };
  }

  // verify
  return {
    skip: false,
    everyone: apply(everyoneOw, { denyBits: SEND_BITS }),
    verified: apply(verifiedOw, { denyBits: P.ViewChannel }),
    bot: apply(findOverwrite(snap, botId, MEMBER), { allowBits: BOT_VERIFY_BITS }),
  };
}
