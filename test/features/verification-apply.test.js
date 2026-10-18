import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, ChannelType } from 'discord.js';
import { gateChannel, revertChannel, snapshotOf } from '../../src/features/verification/apply.js';
import { readConfig } from '../../src/features/verification/config.js';
import { getRecord, recordOriginal } from '../../src/features/verification/store.js';
import { setFeature } from '../../src/db/settings.js';
import { SEND_BITS } from '../../src/features/verification/plan.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE verification_overwrites');
  await db.query('TRUNCATE guild_settings');
});
after(async () => { await db.end(); });

const G = 'g1';
const EVERYONE = 'g1';
const VERIFIED = 'role-v';
const BOT = 'bot1';

const ow = (id, allow = 0n, deny = 0n, type = 0) => ({
  id, type, allow: { bitfield: allow }, deny: { bitfield: deny },
});

function fakeChannel(id, overwrites = [], extra = {}) {
  const calls = [];
  const cache = new Map(overwrites.map((o) => [o.id, o]));
  return {
    id,
    type: ChannelType.GuildText,
    permissionsLocked: false,
    parent: null,
    ...extra,
    calls,
    permissionOverwrites: {
      cache,
      edit: async (target, options) => {
        if (extra.fail) throw Object.assign(new Error('Missing Permissions'), { status: 403 });
        calls.push({ op: 'edit', target, options });
      },
      delete: async (target) => { calls.push({ op: 'delete', target }); },
    },
  };
}

const guild = {
  id: G,
  roles: { everyone: { id: EVERYONE, permissions: { bitfield: P.ViewChannel | P.SendMessages } } },
  members: { me: { id: BOT } },
};
const ctx = () => ({ db });
const cfg = (o = {}) => readConfig({ roleId: VERIFIED, channelId: 'verify', ...o });

test('snapshotOf reads bigint overwrites and the @everyone base', () => {
  const snap = snapshotOf(fakeChannel('c', [ow(EVERYONE, 4n, 8n)]), guild);
  assert.equal(snap.everyoneBase, P.ViewChannel | P.SendMessages);
  assert.deepEqual(snap.overwrites, [{ id: EVERYONE, type: 0, allow: 4n, deny: 8n }]);
});

test('gateChannel records the original before writing', async () => {
  const ch = fakeChannel('c1', [ow(EVERYONE, P.AddReactions, 0n)]);
  let recordedAtFirstWrite = null;
  const origEdit = ch.permissionOverwrites.edit;
  ch.permissionOverwrites.edit = async (...a) => {
    recordedAtFirstWrite ??= await getRecord(db, G, 'c1');
    return origEdit(...a);
  };
  assert.equal(await gateChannel(ctx(), guild, ch, cfg()), 'changed');
  assert.deepEqual(recordedAtFirstWrite.everyone, {
    existed: true, allow: String(P.AddReactions), deny: '0',
  });
  assert.deepEqual(recordedAtFirstWrite.verified, { existed: false, allow: '0', deny: '0' });
  const ev = ch.calls.find((c) => c.target === EVERYONE);
  assert.equal(ev.options.ViewChannel, false);
  assert.equal(ev.options.SendMessages, undefined);
});

test('a private channel is skipped and not recorded', async () => {
  const ch = fakeChannel('priv', [ow(EVERYONE, 0n, P.ViewChannel)]);
  assert.equal(await gateChannel(ctx(), guild, ch, cfg()), 'skipped');
  assert.equal(ch.calls.length, 0);
  assert.equal(await getRecord(db, G, 'priv'), null);
});

test('a skipped-list channel is untouched', async () => {
  const ch = fakeChannel('s1');
  assert.equal(await gateChannel(ctx(), guild, ch, cfg({ skippedChannels: ['s1'] })), 'skipped');
  assert.equal(ch.calls.length, 0);
  assert.equal(await getRecord(db, G, 's1'), null);
});

test('a second gate keeps the first record', async () => {
  const ch = fakeChannel('c2', [ow(EVERYONE, 0n, 0n)]);
  await gateChannel(ctx(), guild, ch, cfg({ publicChannels: ['c2'] }));
  const first = await getRecord(db, G, 'c2');
  // The channel now looks gated; planning uses it, the record must not change.
  const ch2 = fakeChannel('c2', [ow(EVERYONE, 0n, SEND_BITS), ow(VERIFIED, SEND_BITS, 0n)]);
  await gateChannel(ctx(), guild, ch2, cfg({ publicChannels: ['c2'] }));
  assert.deepEqual(await getRecord(db, G, 'c2'), first);
  assert.deepEqual(ch2.calls, []);
});

test('revert restores bits and deletes an overwrite that did not exist', async () => {
  await setFeature(db, G, 'verification', { enabled: true, config: { roleId: VERIFIED } });
  await recordOriginal(db, G, 'c3', {
    everyone: { existed: true, allow: String(P.AddReactions), deny: '0' },
    verified: { existed: false, allow: '0', deny: '0' },
    bot: null,
  });
  const ch = fakeChannel('c3', [
    ow(EVERYONE, P.AddReactions, P.ViewChannel),
    ow(VERIFIED, P.ViewChannel, 0n),
  ]);
  assert.equal(await revertChannel(ctx(), guild, ch), 'restored');
  const ev = ch.calls.find((c) => c.target === EVERYONE);
  assert.deepEqual(ev, { op: 'edit', target: EVERYONE, options: { ViewChannel: null } });
  assert.deepEqual(ch.calls.find((c) => c.target === VERIFIED), { op: 'delete', target: VERIFIED });
  assert.equal(await getRecord(db, G, 'c3'), null);
});

test('revert leaves bits it did not change alone', async () => {
  await setFeature(db, G, 'verification', { enabled: true, config: { roleId: VERIFIED } });
  await recordOriginal(db, G, 'c4', {
    everyone: { existed: true, allow: '0', deny: '0' },
    verified: { existed: false, allow: '0', deny: '0' },
    bot: null,
  });
  // An admin added non-gate bits later; they must survive the revert.
  const ch = fakeChannel('c4', [
    ow(EVERYONE, P.MentionEveryone, P.ViewChannel),
    ow(VERIFIED, P.ViewChannel | P.AttachFiles, 0n),
  ]);
  await revertChannel(ctx(), guild, ch);
  const ev = ch.calls.find((c) => c.target === EVERYONE);
  assert.deepEqual(ev.options, { ViewChannel: null });
  const vr = ch.calls.find((c) => c.target === VERIFIED);
  assert.deepEqual(vr, { op: 'edit', target: VERIFIED, options: { ViewChannel: null } });
  assert.equal(ch.calls.some((c) => c.op === 'delete'), false);
});

test('revert without a record is missing', async () => {
  assert.equal(await revertChannel(ctx(), guild, fakeChannel('nope')), 'missing');
});

test('a permanent error returns failed and does not throw', async () => {
  const ch = fakeChannel('c5', [], { fail: true });
  assert.equal(await gateChannel(ctx(), guild, ch, cfg()), 'failed');
});

test('a synced child of a gated category is skipped', async () => {
  const parent = fakeChannel('cat');
  const child = fakeChannel('kid', [], { permissionsLocked: true, parent });
  assert.equal(await gateChannel(ctx(), guild, child, cfg()), 'skipped');
  assert.equal(child.calls.length, 0);
  assert.equal(await getRecord(db, G, 'kid'), null);
});
