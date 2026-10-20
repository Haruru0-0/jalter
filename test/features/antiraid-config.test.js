import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { readConfig, checkConfig, DEFAULTS, RANGES } from '../../src/features/antiraid/config.js';
import { createAntiraidCommand } from '../../src/features/antiraid/commands.js';
import { FEATURES } from '../../src/core/registry.js';
import { modules } from '../../src/modules.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
});
after(async () => { await db.end?.(); });

const G = 'g1';

function makeInteraction({ sub, options = {}, userId = 'admin', manage = true } = {}) {
  const replies = [];
  return {
    replies,
    guildId: G,
    user: { id: userId },
    member: {
      id: userId,
      guild: { id: G },
      permissions: { has: () => manage },
      roles: { cache: new Map(), highest: { position: 10 } },
    },
    inGuild: () => true,
    options: {
      getSubcommand: () => sub,
      getInteger: (n) => options[n] ?? null,
      getString: (n) => options[n] ?? null,
      getRole: (n) => (options[n] ? { id: options[n] } : null),
    },
    reply: async (p) => { replies.push(p); },
  };
}

const cmd = createAntiraidCommand();
const ctx = () => ({ db, client: { guilds: { cache: new Map() } } });
const run = async (args) => {
  const i = makeInteraction(args);
  await cmd.execute(i, ctx());
  return i;
};
const last = (i) => i.replies[i.replies.length - 1];
const raw = async () => (await getFeature(db, G, 'antiraid')).config;
const say = (i, key) => {
  const text = t('en', key);
  assert.equal(last(i).content, text);
  assert.notEqual(text, key, `the key ${key} has no English text`);
};

test('readConfig fills the defaults', () => {
  assert.deepEqual(readConfig(undefined), {
    joins: 10, windowSeconds: 60, accountAgeSeconds: 604800, durationSeconds: 1800,
    pingRoleId: null,
    state: 'idle', lockedAt: null, lockedUntil: null, startedBy: null, kicked: 0,
    invitesPausedByUs: false, inviteResult: 'none', alertResult: 'none',
  });
  assert.deepEqual(readConfig(null), readConfig({}));
  assert.deepEqual(readConfig('nope'), readConfig({}));
  assert.equal(readConfig({}).joins, DEFAULTS.joins);
  assert.equal(readConfig({}).windowSeconds, DEFAULTS.windowSeconds);
  assert.equal(readConfig({}).accountAgeSeconds, DEFAULTS.accountAgeSeconds);
  assert.equal(readConfig({}).durationSeconds, DEFAULTS.durationSeconds);
});

test('readConfig keeps good values', () => {
  const cfg = readConfig({
    joins: 25, windowSeconds: 120, accountAgeSeconds: 3600, durationSeconds: 3600,
    pingRoleId: 'r9', state: 'locked', lockedAt: 10, lockedUntil: 20, startedBy: 'auto',
    kicked: 7, invitesPausedByUs: true, inviteResult: 'paused', alertResult: 'sent',
  });
  assert.equal(cfg.joins, 25);
  assert.equal(cfg.windowSeconds, 120);
  assert.equal(cfg.accountAgeSeconds, 3600);
  assert.equal(cfg.durationSeconds, 3600);
  assert.equal(cfg.pingRoleId, 'r9');
  assert.equal(cfg.state, 'locked');
  assert.equal(cfg.lockedAt, 10);
  assert.equal(cfg.lockedUntil, 20);
  assert.equal(cfg.startedBy, 'auto');
  assert.equal(cfg.kicked, 7);
  assert.equal(cfg.invitesPausedByUs, true);
  assert.equal(cfg.inviteResult, 'paused');
  assert.equal(cfg.alertResult, 'sent');
});

test('readConfig rejects bad numbers, a bad state and a non-string role', () => {
  const cfg = readConfig({
    joins: 'many', windowSeconds: 1.5, accountAgeSeconds: -5, durationSeconds: null,
    pingRoleId: 5, state: 'weird', lockedAt: 'x', lockedUntil: 'y', startedBy: 7, kicked: 'z',
    invitesPausedByUs: 'yes', inviteResult: 'nope', alertResult: 'nope',
  });
  assert.equal(cfg.joins, 10);
  assert.equal(cfg.windowSeconds, 60);
  assert.equal(cfg.accountAgeSeconds, 604800);
  assert.equal(cfg.durationSeconds, 1800);
  assert.equal(cfg.pingRoleId, null);
  assert.equal(cfg.state, 'idle');
  assert.equal(cfg.lockedAt, null);
  assert.equal(cfg.lockedUntil, null);
  assert.equal(cfg.startedBy, null);
  assert.equal(cfg.kicked, 0);
  assert.equal(cfg.invitesPausedByUs, false);
  assert.equal(cfg.inviteResult, 'none');
  assert.equal(cfg.alertResult, 'none');
});

test('readConfig falls back to the defaults for a value outside its range', () => {
  assert.equal(readConfig({ joins: 2 }).joins, 10);
  assert.equal(readConfig({ joins: 101 }).joins, 10);
  assert.equal(readConfig({ windowSeconds: 9 }).windowSeconds, 60);
  assert.equal(readConfig({ accountAgeSeconds: 3599 }).accountAgeSeconds, 604800);
  assert.equal(readConfig({ durationSeconds: 86401 }).durationSeconds, 1800);
});

test('checkConfig accepts the defaults and each range edge', () => {
  assert.deepEqual(checkConfig({}), { ok: true });
  assert.deepEqual(checkConfig({
    joins: DEFAULTS.joins, windowSeconds: DEFAULTS.windowSeconds,
    accountAgeSeconds: DEFAULTS.accountAgeSeconds, durationSeconds: DEFAULTS.durationSeconds,
  }), { ok: true });
  assert.deepEqual(checkConfig({ joins: RANGES.joins[0] }), { ok: true });
  assert.deepEqual(checkConfig({ joins: RANGES.joins[1] }), { ok: true });
  assert.deepEqual(checkConfig({ windowSeconds: RANGES.windowSeconds[0] }), { ok: true });
  assert.deepEqual(checkConfig({ windowSeconds: RANGES.windowSeconds[1] }), { ok: true });
  assert.deepEqual(checkConfig({ accountAgeSeconds: RANGES.accountAgeSeconds[0] }), { ok: true });
  assert.deepEqual(checkConfig({ accountAgeSeconds: RANGES.accountAgeSeconds[1] }), { ok: true });
  assert.deepEqual(checkConfig({ durationSeconds: RANGES.durationSeconds[0] }), { ok: true });
  assert.deepEqual(checkConfig({ durationSeconds: RANGES.durationSeconds[1] }), { ok: true });
});

test('checkConfig rejects 2 and 101 joins, a 9 second window, a 59 minute age and a 4 minute duration as the matching reason', () => {
  assert.deepEqual(checkConfig({ joins: 2 }), { ok: false, reason: 'joins_range' });
  assert.deepEqual(checkConfig({ joins: 101 }), { ok: false, reason: 'joins_range' });
  assert.deepEqual(checkConfig({ windowSeconds: 9 }), { ok: false, reason: 'window_range' });
  assert.deepEqual(checkConfig({ windowSeconds: 601 }), { ok: false, reason: 'window_range' });
  assert.deepEqual(checkConfig({ accountAgeSeconds: 59 * 60 }), { ok: false, reason: 'age_range' });
  assert.deepEqual(checkConfig({ durationSeconds: 4 * 60 }), { ok: false, reason: 'duration_range' });
});

test('checkConfig only looks at the keys that are present', () => {
  assert.deepEqual(checkConfig({ joins: 50 }), { ok: true });
  assert.deepEqual(checkConfig({ windowSeconds: 30 }), { ok: true });
  assert.deepEqual(checkConfig({ joins: undefined }), { ok: true });
});

test('config saves only the given keys and keeps lockdown state keys', async () => {
  await setFeature(db, G, 'antiraid', {
    enabled: true,
    config: { state: 'locked', lockedUntil: 1234, kicked: 3, joins: 5, windowSeconds: 90 },
  });
  const i = await run({ sub: 'config', options: { window: '2m' } });
  assert.equal(last(i).flags, 64);
  const config = await raw();
  assert.equal(config.windowSeconds, 120);
  assert.equal(config.joins, 5, 'a key that was not given is kept');
  assert.equal(config.windowSeconds, 120);
  assert.equal(config.state, 'locked');
  assert.equal(config.lockedUntil, 1234);
  assert.equal(config.kicked, 3);
});

test('config parses the times and saves them as seconds', async () => {
  await run({ sub: 'config', options: { window: '10m', account_age: '7d', duration: '24h' } });
  const config = await raw();
  assert.equal(config.windowSeconds, 600);
  assert.equal(config.accountAgeSeconds, 604800);
  assert.equal(config.durationSeconds, 86400);
});

test('config refuses a bad duration string and a range violation and saves nothing', async () => {
  let i = await run({ sub: 'config', options: { duration: 'abc' } });
  say(i, 'antiraid.config.bad_duration');
  assert.deepEqual(await raw(), {});

  i = await run({ sub: 'config', options: { joins: 500 } });
  say(i, 'antiraid.config.joins_range');
  assert.deepEqual(await raw(), {});

  i = await run({ sub: 'config', options: { window: '5s' } });
  say(i, 'antiraid.config.window_range');
  assert.deepEqual(await raw(), {});

  i = await run({ sub: 'config', options: { account_age: '30m' } });
  say(i, 'antiraid.config.age_range');
  assert.deepEqual(await raw(), {});

  i = await run({ sub: 'config', options: { duration: '1m' } });
  say(i, 'antiraid.config.duration_range');
  assert.deepEqual(await raw(), {});
});

test('config refuses @everyone as the ping role', async () => {
  const i = await run({ sub: 'config', options: { ping_role: G } });
  say(i, 'antiraid.config.bad_role');
  assert.deepEqual(await raw(), {});
});

test('config saves the ping role it is given', async () => {
  const i = await run({ sub: 'config', options: { ping_role: 'r9' } });
  assert.equal(last(i).content, t('en', 'antiraid.config.saved'));
  assert.equal((await raw()).pingRoleId, 'r9');
});

test('a config call without ping_role never clears a saved ping role', async () => {
  await setFeature(db, G, 'antiraid', { config: { pingRoleId: 'r9' } });
  await run({ sub: 'config', options: { joins: 20 } });
  assert.equal((await raw()).pingRoleId, 'r9');
  await run({ sub: 'config', options: { joins: 21 } });
  assert.equal((await raw()).pingRoleId, 'r9');
});

test('status shows the numbers and idle', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: {} });
  const i = await run({ sub: 'status' });
  const text = last(i).content;
  assert.equal(last(i).flags, 64);
  assert.match(text, /On/);
  assert.match(text, /10/);
  assert.match(text, /1m/);
  assert.match(text, /7d/);
  assert.match(text, /30m/);
  assert.ok(text.includes(t('en', 'antiraid.status.idle')));
});

test('status works while the feature is off', async () => {
  const i = await run({ sub: 'status' });
  const text = last(i).content;
  assert.match(text, /Off/);
  assert.match(text, /10/);
  assert.ok(text.includes(t('en', 'antiraid.status.idle')));
});

test('status names the ping role, and the manager role as the default', async () => {
  await setFeature(db, G, 'antiraid', { enabled: true, config: { pingRoleId: 'r9' } });
  let i = await run({ sub: 'status' });
  assert.match(last(i).content, /<@&r9>/);

  await setFeature(db, G, 'antiraid', { enabled: true, config: { pingRoleId: null } });
  await setFeature(db, G, 'panel', { config: { managerRoleId: 'mgr' } });
  i = await run({ sub: 'status' });
  assert.match(last(i).content, /<@&mgr>/);
});

test('status shows the lockdown block when a lockdown is on', async () => {
  await setFeature(db, G, 'antiraid', {
    enabled: true,
    config: {
      state: 'locked', lockedUntil: 1800000000000, kicked: 4, inviteResult: 'paused', alertResult: 'sent',
    },
  });
  const i = await run({ sub: 'status' });
  const text = last(i).content;
  assert.match(text, /4/);
  assert.match(text, /<t:1800000000:F>/);
  assert.ok(!/idle/i.test(text));
});

test('only a manager can use the antiraid commands', async () => {
  const i = makeInteraction({ sub: 'status', manage: false });
  await cmd.execute(i, ctx());
  assert.equal(last(i).content, t('en', 'common.notAllowed'));
  assert.equal((await getFeature(db, G, 'antiraid')).enabled, false);
});

test('antiraid is a real command in the registry', () => {
  const f = FEATURES.find((x) => x.key === 'antiraid');
  assert.equal(f.command, 'antiraid');
  assert.equal(f.enableCommand, 'antiraid enable');
  assert.equal(f.phase, 2);
  const mod = modules.find((m) => m.commands?.some((c) => c.data.name === 'antiraid'));
  assert.ok(mod);
  const data = mod.commands[0].data.toJSON();
  assert.deepEqual(data.options.map((o) => o.name), ['enable', 'disable', 'config', 'status']);
  const config = data.options.find((o) => o.name === 'config');
  assert.deepEqual(config.options.map((o) => o.name), ['joins', 'window', 'account_age', 'duration', 'ping_role']);
});
