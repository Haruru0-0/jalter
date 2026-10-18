import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits as P, ChannelType, Events } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { setFeature } from '../../src/db/settings.js';
import { gateChannel } from '../../src/features/verification/apply.js';
import { createEvents } from '../../src/features/verification/events.js';
import { collectModules } from '../../src/core/loader.js';
import * as feature from '../../src/features/verification/index.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE verification_overwrites');
  await db.query('TRUNCATE guild_settings');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const ctx = () => ({ db, client: { user: { id: 'bot1' } } });

async function setup(config = {}, enabled = true) {
  await setFeature(db, G, 'verification', {
    enabled,
    config: { mode: 'button', roleId: 'rv', channelId: 'cv', messageId: 'm1', state: 'active', ...config },
  });
}

const ow = (id, allow = 0n, deny = 0n, type = 0) => ({ id, type, allow: { bitfield: allow }, deny: { bitfield: deny } });

function fakeGuild() {
  return {
    id: G,
    roles: { everyone: { id: G, permissions: { bitfield: P.ViewChannel | P.SendMessages } } },
    members: { me: { id: 'bot1' } },
  };
}

function fakeChannel(id, overwrites = [], extra = {}) {
  const calls = [];
  const cache = new Map(overwrites.map((o) => [o.id, o]));
  const guild = fakeGuild();
  return {
    id, guild, guildId: G,
    type: ChannelType.GuildText,
    permissionsLocked: false,
    parent: null,
    ...extra,
    calls,
    permissionOverwrites: {
      cache,
      edit: async (target, options) => {
        if (extra.fail) throw Object.assign(new Error('Missing Permissions'), { status: 403 });
        calls.push({ target, options });
        const cur = cache.get(target) ?? ow(target);
        let allow = cur.allow.bitfield;
        let deny = cur.deny.bitfield;
        for (const [name, v] of Object.entries(options)) {
          const bit = P[name];
          allow &= ~bit; deny &= ~bit;
          if (v === true) allow |= bit;
          if (v === false) deny |= bit;
        }
        cache.set(target, ow(target, allow, deny, cur.type));
      },
      delete: async () => {},
    },
  };
}

function harness() {
  const verifyCalls = [];
  const logs = [];
  const events = createEvents({
    verifyMember: async (c, guild, member, opts, deps) => { verifyCalls.push({ member, opts, deps }); return { ok: true }; },
    logVerification: async (c, guildId, lang, entry) => { logs.push(entry); },
  });
  const byName = (n) => events.find((e) => e.name === n).execute;
  return { verifyCalls, logs, add: byName(Events.GuildMemberAdd), create: byName(Events.ChannelCreate) };
}

const member = (bot) => ({ id: 'u1', user: { bot }, guild: fakeGuild(), roles: { cache: new Map() } });

test('a joining bot is granted Verified', async () => {
  await setup();
  const h = harness();
  await h.add(ctx(), member(true));
  assert.equal(h.verifyCalls.length, 1);
  assert.equal(h.verifyCalls[0].opts.method, 'join');
  // silent: a bot join must not write a mod-log line
  await h.verifyCalls[0].deps.logVerification();
  assert.equal(h.logs.length, 0);
});

test('a joining bot is granted Verified while rolling out', async () => {
  await setup({ state: 'rolling_out' });
  const h = harness();
  await h.add(ctx(), member(true));
  assert.equal(h.verifyCalls.length, 1);
});

test('a joining human is not', async () => {
  await setup();
  const h = harness();
  await h.add(ctx(), member(false));
  assert.equal(h.verifyCalls.length, 0);
});

test('nothing happens when state is none, failed or the feature is off', async () => {
  for (const [cfg, enabled] of [[{ state: 'none' }, true], [{ state: 'failed' }, true], [{ state: 'active' }, false]]) {
    await setup(cfg, enabled);
    const h = harness();
    const ch = fakeChannel('c1');
    await h.add(ctx(), member(true));
    await h.create(ctx(), ch);
    assert.equal(h.verifyCalls.length, 0);
    assert.equal(ch.calls.length, 0);
    assert.equal(h.logs.length, 0);
  }
});

test('a new channel @everyone can view is gated', async () => {
  await setup();
  const h = harness();
  const ch = fakeChannel('c1');
  await h.create(ctx(), ch);
  const everyone = ch.permissionOverwrites.cache.get(G);
  assert.equal((everyone.deny.bitfield & P.ViewChannel), P.ViewChannel);
  assert.ok(ch.permissionOverwrites.cache.get('rv'));
  assert.equal(h.logs.length, 0);
});

test('a new channel is gated while rolling out, and a later gate pass is a no-op', async () => {
  await setup({ state: 'rolling_out' });
  const h = harness();
  const ch = fakeChannel('c1');
  await h.create(ctx(), ch);
  const n = ch.calls.length;
  assert.ok(n > 0);
  const cfg = { mode: 'button', roleId: 'rv', channelId: 'cv', messageId: 'm1', state: 'rolling_out', publicChannels: [], skippedChannels: [], cutoff: null };
  const again = await gateChannel(ctx(), ch.guild, ch, cfg);
  assert.equal(again, 'skipped');
  assert.equal(ch.calls.length, n);
});

test('a new channel follows its list kind', async () => {
  await setup({ skippedChannels: ['c1'], publicChannels: ['c2'] });
  const h = harness();
  const skipped = fakeChannel('c1');
  const pub = fakeChannel('c2');
  await h.create(ctx(), skipped);
  await h.create(ctx(), pub);
  assert.equal(skipped.calls.length, 0);
  const everyone = pub.permissionOverwrites.cache.get(G);
  assert.equal((everyone.deny.bitfield & P.SendMessages), P.SendMessages);
  assert.equal((everyone.deny.bitfield & P.ViewChannel), 0n);
});

test('a new private channel is left alone, with no log line', async () => {
  await setup();
  const h = harness();
  const ch = fakeChannel('c1', [ow(G, 0n, P.ViewChannel)]);
  await h.create(ctx(), ch);
  assert.equal(ch.calls.length, 0);
  assert.equal(h.logs.length, 0);
});

test('a synced child of a gated category is left alone, with no log line', async () => {
  await setup();
  const h = harness();
  const ch = fakeChannel('c1', [], { permissionsLocked: true, parent: { id: 'cat' } });
  await h.create(ctx(), ch);
  assert.equal(ch.calls.length, 0);
  assert.equal(h.logs.length, 0);
});

test('a failed gate logs gate_failed once, naming the channel', async () => {
  await setup();
  const h = harness();
  const ch = fakeChannel('c1', [], { fail: true });
  await h.create(ctx(), ch);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].kind, 'gate_failed');
  assert.match(h.logs[0].detail, /<#c1>/);
});

test('threads and DM channels are ignored', async () => {
  await setup();
  const h = harness();
  const thread = fakeChannel('t1', [], { isThread: () => true });
  await h.create(ctx(), thread);
  await h.create(ctx(), { id: 'dm1', permissionOverwrites: undefined });
  assert.equal(thread.calls.length, 0);
});

test('handlers never throw', async () => {
  await setup();
  const events = createEvents({
    verifyMember: async () => { throw new Error('boom'); },
    gateChannel: async () => { throw new Error('boom'); },
    logVerification: async () => { throw new Error('boom'); },
  });
  const bad = { id: 'x', guild: fakeGuild(), guildId: G, user: { bot: true } };
  for (const e of events) await e.execute({ db: null }, bad);
  for (const e of events) await e.execute(ctx(), bad);
});

test('events are exported from the feature and collected by the loader', () => {
  assert.ok(feature.events.some((e) => e.name === Events.GuildMemberAdd));
  assert.ok(feature.events.some((e) => e.name === Events.ChannelCreate));
  assert.equal(collectModules([feature]).events.length, feature.events.length);
});
