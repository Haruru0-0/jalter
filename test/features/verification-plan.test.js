import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canEveryoneView, roleViewers, planChannel, SEND_BITS,
} from '../../src/features/verification/plan.js';

// Literal Discord permission bits, written out by hand so the tests check the
// planner against the real values rather than against its own constants.
const ADMIN = 1n << 3n;          // Administrator
const REACT = 1n << 6n;          // AddReactions
const VIEW = 1n << 10n;          // ViewChannel
const SEND = 1n << 11n;          // SendMessages
const MANAGE_MSG = 1n << 13n;    // ManageMessages
const EMBED = 1n << 14n;         // EmbedLinks
const ATTACH = 1n << 15n;        // AttachFiles
const HISTORY = 1n << 16n;       // ReadMessageHistory
const CONNECT = 1n << 20n;       // Connect
const SPEAK = 1n << 21n;         // Speak
const APP_CMDS = 1n << 31n;      // UseApplicationCommands
const PUB_THREADS = 1n << 35n;   // CreatePublicThreads
const PRIV_THREADS = 1n << 36n;  // CreatePrivateThreads
const THREAD_SEND = 1n << 38n;   // SendMessagesInThreads
const MENTION_EVERYONE = 1n << 17n; // unrelated bit used to check preservation
const MANAGE_CHANNELS = 1n << 4n;   // unrelated bit

const EXPECTED_SEND = SEND | THREAD_SEND | PUB_THREADS | PRIV_THREADS | REACT | APP_CMDS;

const G = '100';   // guild id == @everyone role id
const V = '200';   // Verified role id
const B = '300';   // bot user id
const ids = { everyoneId: G, verifiedId: V, botId: B };

const TEXT = 0, VOICE = 2, CATEGORY = 4, ANNOUNCE = 5, STAGE = 13, FORUM = 15;

const snap = ({ type = TEXT, base = VIEW | SEND, overwrites = [] } = {}) => ({
  id: '999', type, everyoneBase: base, overwrites,
});
const ow = (id, type, allow = 0n, deny = 0n) => ({ id, type, allow, deny });

const noOverlap = (o) => assert.equal(o.allow & o.deny, 0n, `allow ${o.allow} and deny ${o.deny} share bits`);

test('SEND_BITS is exactly the six listed bits', () => {
  assert.equal(SEND_BITS, EXPECTED_SEND);
});

test('canEveryoneView follows the base bit and the @everyone overwrite and ignores other roles', () => {
  assert.equal(canEveryoneView(snap({ base: VIEW }), G), true);
  assert.equal(canEveryoneView(snap({ base: SEND }), G), false);
  // @everyone overwrite deny hides
  assert.equal(canEveryoneView(snap({ base: VIEW, overwrites: [ow(G, 0, 0n, VIEW)] }), G), false);
  // @everyone overwrite allow opens
  assert.equal(canEveryoneView(snap({ base: 0n, overwrites: [ow(G, 0, VIEW, 0n)] }), G), true);
  // another role's allow does not count
  assert.equal(canEveryoneView(snap({ base: 0n, overwrites: [ow('555', 0, VIEW, 0n)] }), G), false);
  assert.equal(canEveryoneView(snap({ base: VIEW, overwrites: [ow(G, 0, 0n, VIEW), ow('555', 0, VIEW, 0n)] }), G), false);
  // a member overwrite (type 1) with the guild id is not the @everyone overwrite
  assert.equal(canEveryoneView(snap({ base: VIEW, overwrites: [ow(G, 1, 0n, VIEW)] }), G), true);
  // another role's deny does not count either
  assert.equal(canEveryoneView(snap({ base: VIEW, overwrites: [ow('555', 0, 0n, VIEW)] }), G), true);
  // Administrator on @everyone sees everything
  assert.equal(canEveryoneView(snap({ base: ADMIN, overwrites: [ow(G, 0, 0n, VIEW)] }), G), true);
});

test('a channel @everyone cannot view is skipped for every kind', () => {
  const s = snap({ base: VIEW, overwrites: [ow(G, 0, 0n, VIEW), ow('555', 0, VIEW, 0n)] });
  for (const kind of ['gated', 'public', 'verify', 'skip']) {
    const p = planChannel(s, kind, ids);
    assert.equal(p.skip, true, kind);
    assert.equal(p.everyone, undefined);
    assert.equal(p.verified, undefined);
    assert.equal(p.bot, undefined);
  }
  assert.equal(planChannel(s, 'gated', ids).reason, 'private');
  assert.equal(planChannel(s, 'public', ids).reason, 'private');
  assert.equal(planChannel(snap({ base: 0n }), 'verify', ids).reason, 'private');
});

test('skip returns skip true', () => {
  const p = planChannel(snap(), 'skip', ids);
  assert.deepEqual(p, { skip: true, reason: 'kind_skip' });
});

test('gated adds the View deny for @everyone and the View allow for Verified and changes no other bit', () => {
  const p = planChannel(snap(), 'gated', ids);
  assert.equal(p.skip, false);
  assert.deepEqual(p.everyone, { allow: 0n, deny: VIEW });
  assert.deepEqual(p.verified, { allow: VIEW, deny: 0n });
  assert.equal(p.bot, undefined);

  // existing View allow on @everyone moves to deny; existing View deny on Verified moves to allow
  const s = snap({
    overwrites: [ow(G, 0, VIEW | SEND, HISTORY), ow(V, 0, EMBED, VIEW | ATTACH)],
  });
  const q = planChannel(s, 'gated', ids);
  assert.deepEqual(q.everyone, { allow: SEND, deny: HISTORY | VIEW });
  assert.deepEqual(q.verified, { allow: EMBED | VIEW, deny: ATTACH });
});

test('existing unrelated bits in the @everyone overwrite are preserved', () => {
  const extraAllow = MENTION_EVERYONE | MANAGE_CHANNELS | HISTORY;
  const extraDeny = CONNECT | EMBED;
  const s = snap({ overwrites: [ow(G, 0, extraAllow, extraDeny), ow('555', 0, VIEW, SEND)] });
  for (const kind of ['gated', 'public', 'verify']) {
    const p = planChannel(s, kind, ids);
    const touched = kind === 'gated' ? VIEW : SEND_BITS;
    assert.equal(p.everyone.allow & ~touched, extraAllow & ~touched, kind);
    assert.equal(p.everyone.deny & ~touched, extraDeny & ~touched, kind);
  }
  // planner never returns a plan for another role
  const p = planChannel(s, 'gated', ids);
  assert.deepEqual(Object.keys(p).sort(), ['everyone', 'skip', 'verified']);
  // input is not mutated
  assert.equal(s.overwrites[0].allow, extraAllow);
  assert.equal(s.overwrites[0].deny, extraDeny);
});

test('public denies exactly SEND_BITS', () => {
  for (const type of [TEXT, CATEGORY, ANNOUNCE, FORUM]) {
    const p = planChannel(snap({ type }), 'public', ids);
    assert.deepEqual(p.everyone, { allow: 0n, deny: EXPECTED_SEND }, `type ${type}`);
    assert.deepEqual(p.verified, { allow: EXPECTED_SEND, deny: 0n }, `type ${type}`);
    assert.equal(p.everyone.deny & VIEW, 0n, 'public never denies View');
    assert.equal(p.bot, undefined);
  }
  // an @everyone allow of SendMessages is removed; View allow is kept
  const p = planChannel(snap({ overwrites: [ow(G, 0, VIEW | SEND | REACT, 0n)] }), 'public', ids);
  assert.deepEqual(p.everyone, { allow: VIEW, deny: EXPECTED_SEND });
});

test('public voice also denies Connect and Speak', () => {
  for (const type of [VOICE, STAGE]) {
    const p = planChannel(snap({ type }), 'public', ids);
    const bits = EXPECTED_SEND | CONNECT | SPEAK;
    assert.deepEqual(p.everyone, { allow: 0n, deny: bits }, `type ${type}`);
    assert.deepEqual(p.verified, { allow: bits, deny: 0n }, `type ${type}`);
  }
  // text channels do not get Connect/Speak
  const t = planChannel(snap({ type: TEXT }), 'public', ids);
  assert.equal(t.everyone.deny & (CONNECT | SPEAK), 0n);
});

test('verify hides the channel from Verified and gives the bot its allows', () => {
  const p = planChannel(snap(), 'verify', ids);
  assert.equal(p.skip, false);
  assert.deepEqual(p.everyone, { allow: 0n, deny: EXPECTED_SEND });
  assert.deepEqual(p.verified, { allow: 0n, deny: VIEW });
  assert.deepEqual(p.bot, { allow: VIEW | SEND | HISTORY | EMBED | ATTACH | MANAGE_MSG, deny: 0n });

  // existing bot member deny on Send moves to allow; existing Verified View allow moves to deny;
  // the bot overwrite is matched by member type, not a role with the same id
  const s = snap({
    overwrites: [
      ow(V, 0, VIEW | EMBED, 0n),
      ow(B, 1, CONNECT, SEND | SPEAK),
      ow(B, 0, 0n, VIEW),
    ],
  });
  const q = planChannel(s, 'verify', ids);
  assert.deepEqual(q.verified, { allow: EMBED, deny: VIEW });
  assert.deepEqual(q.bot, {
    allow: CONNECT | VIEW | SEND | HISTORY | EMBED | ATTACH | MANAGE_MSG,
    deny: SPEAK,
  });
});

test('allow and deny never share a bit', () => {
  const ALL = (1n << 50n) - 1n;
  const nasty = snap({
    type: VOICE,
    overwrites: [ow(G, 0, ALL & ~VIEW, ALL & ~VIEW), ow(V, 0, ALL, ALL), ow(B, 1, ALL, ALL)],
  });
  // overlapping inputs are not something Discord produces, but the output must still be clean
  // for the bits we touch
  for (const kind of ['gated', 'public', 'verify']) {
    const p = planChannel(snap({ type: VOICE, overwrites: [ow(G, 0, SEND | VIEW | CONNECT, REACT | SPEAK), ow(V, 0, VIEW, SEND | REACT | CONNECT), ow(B, 1, SEND, VIEW | MANAGE_MSG)] }), kind, ids);
    for (const k of ['everyone', 'verified', 'bot']) if (p[k]) noOverlap(p[k]);
  }
  const touchedBy = {
    gated: { everyone: VIEW, verified: VIEW },
    public: { everyone: EXPECTED_SEND | CONNECT | SPEAK, verified: EXPECTED_SEND | CONNECT | SPEAK },
    verify: { everyone: EXPECTED_SEND, verified: VIEW, bot: VIEW | SEND | HISTORY | EMBED | ATTACH | MANAGE_MSG },
  };
  for (const [kind, t] of Object.entries(touchedBy)) {
    const p = planChannel(nasty, kind, ids);
    for (const [k, bits] of Object.entries(t)) {
      assert.equal(p[k].allow & p[k].deny & bits, 0n, `${kind}.${k}`);
    }
  }
});

test('roleViewers lists roles with an explicit View allow', () => {
  const s = snap({
    overwrites: [
      ow(G, 0, VIEW, 0n),            // @everyone: excluded
      ow(V, 0, VIEW, 0n),            // Verified: excluded
      ow('501', 0, VIEW | SEND, 0n), // listed
      ow('502', 0, SEND, VIEW),      // deny only: not listed
      ow('503', 0, SEND, 0n),        // no View: not listed
      ow('504', 1, VIEW, 0n),        // member overwrite: not a role
      ow('505', 0, VIEW, 0n),        // listed
    ],
  });
  assert.deepEqual(roleViewers(s, G, V), ['501', '505']);
  assert.deepEqual(roleViewers(snap(), G, V), []);
});

test('an unknown kind throws', () => {
  assert.throws(() => planChannel(snap(), 'open', ids), /kind/);
});
