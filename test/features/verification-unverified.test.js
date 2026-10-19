import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { readConfig } from '../../src/features/verification/config.js';
import {
  POLICIES, effectiveWarnSeconds, checkTimes,
} from '../../src/features/verification/unverified.js';
import { createVerificationCommand } from '../../src/features/verification/commands.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const H = 3600;

function makeInteraction({ sub, options = {}, manage = true } = {}) {
  const replies = [];
  return {
    replies, guildId: G, guild: { id: G },
    user: { id: 'admin' },
    member: {
      id: 'admin', guild: { id: G }, permissions: { has: () => manage },
      roles: { cache: new Map(), highest: { position: 10 } },
    },
    inGuild: () => true,
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => null,
      getString: (n) => options[n] ?? null,
    },
    reply: async (p) => { replies.push(p); },
  };
}
const cmd = createVerificationCommand();
const ctx = () => ({ db, client: {} });
const run = async (args) => {
  const i = makeInteraction(args);
  await cmd.execute(i, ctx());
  return i;
};
const last = (i) => i.replies[i.replies.length - 1];
const raw = async () => (await getFeature(db, G, 'verification')).config;
const unverified = (options) => run({ sub: 'unverified', options });

test('readConfig defaults the three keys', () => {
  const cfg = readConfig({});
  assert.equal(cfg.unverifiedPolicy, 'none');
  assert.equal(cfg.kickAfterSeconds, 86400);
  assert.equal(cfg.warnAfterSeconds, null);
  assert.deepEqual(POLICIES, ['none', 'kick', 'warn_kick']);
  const good = readConfig({ unverifiedPolicy: 'warn_kick', kickAfterSeconds: 7200, warnAfterSeconds: 3600 });
  assert.equal(good.unverifiedPolicy, 'warn_kick');
  assert.equal(good.kickAfterSeconds, 7200);
  assert.equal(good.warnAfterSeconds, 3600);
});

test('readConfig rejects a bad policy and non-positive seconds', () => {
  const cfg = readConfig({ unverifiedPolicy: 'ban', kickAfterSeconds: 0, warnAfterSeconds: -5 });
  assert.equal(cfg.unverifiedPolicy, 'none');
  assert.equal(cfg.kickAfterSeconds, 86400);
  assert.equal(cfg.warnAfterSeconds, null);
  const odd = readConfig({ kickAfterSeconds: 'x', warnAfterSeconds: Infinity });
  assert.equal(odd.kickAfterSeconds, 86400);
  assert.equal(odd.warnAfterSeconds, null);
});

test('checkTimes accepts 24h kick and 12h default warn', () => {
  assert.equal(effectiveWarnSeconds({ kickAfterSeconds: 86400, warnAfterSeconds: null }), 43200);
  assert.deepEqual(checkTimes({ policy: 'warn_kick', kickAfterSeconds: 86400, warnAfterSeconds: null }), { ok: true });
  assert.deepEqual(checkTimes({ policy: 'kick', kickAfterSeconds: 86400, warnAfterSeconds: null }), { ok: true });
});

test('checkTimes rejects a 5 minute kick as kick_range and a 31 day kick as kick_range', () => {
  for (const kickAfterSeconds of [300, 31 * 86400]) {
    assert.deepEqual(checkTimes({ policy: 'kick', kickAfterSeconds, warnAfterSeconds: null }),
      { ok: false, reason: 'kick_range' });
  }
  assert.equal(checkTimes({ policy: 'kick', kickAfterSeconds: 600, warnAfterSeconds: null }).ok, true);
  assert.equal(checkTimes({ policy: 'kick', kickAfterSeconds: 2592000, warnAfterSeconds: null }).ok, true);
});

test('checkTimes rejects warn 23h55m against kick 24h as warn_gap but only for warn_kick', () => {
  const times = { kickAfterSeconds: 86400, warnAfterSeconds: 23 * H + 55 * 60 };
  assert.deepEqual(checkTimes({ policy: 'warn_kick', ...times }), { ok: false, reason: 'warn_gap' });
  assert.equal(checkTimes({ policy: 'kick', ...times }).ok, true);
  assert.equal(checkTimes({ policy: 'none', ...times }).ok, true);
  assert.equal(checkTimes({ policy: 'warn_kick', kickAfterSeconds: 86400, warnAfterSeconds: 23 * H + 50 * 60 }).ok, true);
});

test('the subcommand saves policy and merges kickAfterSeconds without dropping other config keys', async () => {
  await setFeature(db, G, 'verification', { config: { grantDone: true, state: 'active', mode: 'captcha' } });
  const i = await unverified({ policy: 'kick', kick_after: '2h' });
  assert.equal(last(i).flags, 64);
  assert.match(last(i).content, /2h/);
  const c = await raw();
  assert.equal(c.unverifiedPolicy, 'kick');
  assert.equal(c.kickAfterSeconds, 7200);
  assert.equal(c.grantDone, true);
  assert.equal(c.state, 'active');
  assert.equal(c.mode, 'captcha');
  assert.equal('warnAfterSeconds' in c, false);

  await unverified({ policy: 'warn_kick', warn_after: '1h' });
  const c2 = await raw();
  assert.equal(c2.warnAfterSeconds, 3600);
  assert.equal(c2.kickAfterSeconds, 7200);
  assert.equal(c2.grantDone, true);
});

test('bad_duration reply and nothing saved for kick_after:abc', async () => {
  const i = await unverified({ policy: 'kick', kick_after: 'abc' });
  assert.match(last(i).content, /abc|duration|1d12h/i);
  assert.equal(last(i).flags, 64);
  assert.equal((await raw())?.unverifiedPolicy, undefined);
});

test('kick_range reply and nothing saved', async () => {
  const i = await unverified({ policy: 'kick', kick_after: '5m' });
  assert.match(last(i).content, /10m|30d/);
  assert.equal((await raw())?.unverifiedPolicy, undefined);
  const j = await unverified({ policy: 'kick', kick_after: '31d' });
  assert.match(last(j).content, /10m|30d/);
  assert.equal((await raw())?.kickAfterSeconds, undefined);
});

test('warn_gap reply and nothing saved for warn_kick', async () => {
  const i = await unverified({ policy: 'warn_kick', kick_after: '24h', warn_after: '23h55m' });
  assert.match(last(i).content, /10m/);
  assert.equal((await raw())?.unverifiedPolicy, undefined);
  // The same times are fine for plain kick.
  await unverified({ policy: 'kick', kick_after: '24h', warn_after: '23h55m' });
  assert.equal((await raw()).unverifiedPolicy, 'kick');
});

test('warn_gap is judged against the saved kick time when only warn_after is given', async () => {
  await setFeature(db, G, 'verification', { config: { kickAfterSeconds: 7200 } });
  const i = await unverified({ policy: 'warn_kick', warn_after: '2h' });
  assert.match(last(i).content, /10m/);
  assert.equal((await raw()).unverifiedPolicy, undefined);
});

test('policy none is saved even with the times omitted', async () => {
  await setFeature(db, G, 'verification', { config: { unverifiedPolicy: 'kick', kickAfterSeconds: 7200 } });
  const i = await unverified({ policy: 'none' });
  assert.equal(last(i).flags, 64);
  const c = await raw();
  assert.equal(c.unverifiedPolicy, 'none');
  assert.equal(c.kickAfterSeconds, 7200);
});

test('a non-manager is refused and nothing is saved', async () => {
  await run({ sub: 'unverified', options: { policy: 'kick' }, manage: false });
  assert.equal((await raw())?.unverifiedPolicy, undefined);
});

test('status shows the policy line', async () => {
  await setFeature(db, G, 'verification', {
    enabled: true, config: { unverifiedPolicy: 'warn_kick', kickAfterSeconds: 86400, warnAfterSeconds: 3600 },
  });
  let i = await run({ sub: 'status' });
  assert.match(last(i).content, /warn_kick|warn/i);
  assert.match(last(i).content, /1d/);
  assert.match(last(i).content, /1h/);
  await setFeature(db, G, 'verification', { config: { unverifiedPolicy: 'none' } });
  i = await run({ sub: 'status' });
  assert.match(last(i).content, /unverified/i);
});

test('the builder lists the unverified subcommand with its options', () => {
  const data = cmd.data.toJSON();
  const sub = data.options.find((o) => o.name === 'unverified');
  assert.deepEqual(sub.options.map((o) => o.name), ['policy', 'kick_after', 'warn_after']);
  assert.equal(sub.options[0].required, true);
  assert.deepEqual(sub.options[0].choices.map((c) => c.value), ['none', 'kick', 'warn_kick']);
});
