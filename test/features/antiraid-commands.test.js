import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createAntiraidCommand } from '../../src/features/antiraid/commands.js';
import { endLockdown } from '../../src/features/antiraid/lockdown.js';
import { createJoinStore } from '../../src/features/antiraid/joins.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
  await db.query('DELETE FROM scheduled_jobs');
});
after(async () => { await db.end?.(); });

const G = 'g1';
const NOW = 1_700_000_000_000;

function makeGuild() {
  const incidentCalls = [];
  const guild = {
    id: G,
    ownerId: 'owner',
    members: {
      me: {
        id: 'bot1',
        guild: { id: G },
        roles: { highest: { position: 10 } },
        permissions: { has: () => true },
      },
      fetch: async () => { const e = new Error('Unknown Member'); e.code = 10007; throw e; },
    },
    setIncidentActions: async (payload) => { incidentCalls.push(payload); },
  };
  return { guild, incidentCalls };
}

function makeInteraction(guild, { sub, options = {}, userId = 'admin', manage = true } = {}) {
  const replies = [];
  return {
    replies,
    guild,
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

const calls = { log: [], sent: [], run: [] };

const cmd = createAntiraidCommand({
  joins: createJoinStore(),
  now: () => NOW,
  sendLog: async (ctx, guildId, event, embed) => { calls.log.push({ guildId, event, embed }); return { channelId: 'modchan', messageId: 'm1' }; },
  trySend: async (channel, payload) => { calls.sent.push(payload); return { id: 'p1', channelId: channel.id }; },
  fetchSendable: async (client, channelId) => ({ id: channelId, isTextBased: () => true }),
  runAction: async (ctx, params) => { calls.run.push(params); return { ok: true, modCase: { number: 1 }, warnings: [] }; },
});

const ctx = () => ({ db, client: { guilds: { cache: new Map([[G, guildRef.guild]]) } } });
const guildRef = { guild: null };

const run = async (args) => {
  const i = makeInteraction(guildRef.guild, args);
  await cmd.execute(i, ctx());
  return i;
};
const last = (i) => i.replies[i.replies.length - 1];
const cfgOf = async () => (await getFeature(db, G, 'antiraid')).config;

beforeEach(() => {
  calls.log.length = 0;
  calls.sent.length = 0;
  calls.run.length = 0;
});

test('start refuses while locked', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: { state: 'locked' } });
  const i = await run({ sub: 'start' });
  assert.equal(last(i).content, t('en', 'antiraid.start.already'));
  assert.equal(last(i).flags, 64);
  assert.equal(calls.run.length, 0);
});

test('start works with an empty join list (kicks nobody) and says so', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: {} });
  const i = await run({ sub: 'start' });
  assert.equal(last(i).content, t('en', 'antiraid.start.done', {
    kicked: 0,
    until: `<t:${Math.floor((NOW + 1800 * 1000) / 1000)}:F>`,
    invite: t('en', 'antiraid.status.invite_paused'),
    alert: t('en', 'antiraid.status.alert_sent'),
  }));
  const config = await cfgOf();
  assert.equal(config.state, 'locked');
  assert.equal(config.kicked, 0);
  assert.equal(calls.run.length, 0, 'nobody is kicked');
});

test('start is refused while the feature is off', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: false, config: {} });
  const i = await run({ sub: 'start' });
  assert.match(last(i).content, /\/antiraid enable/);
  assert.equal((await cfgOf()).state, undefined);
});

test('end refuses while idle', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: {} });
  const i = await run({ sub: 'end' });
  assert.equal(last(i).content, t('en', 'antiraid.end.not_locked'));
});

test('end ends the lockdown and lifts our pause', async () => {
  const { guild, incidentCalls } = makeGuild();
  guildRef.guild = guild;
  guild.incidentsData = { invitesDisabledUntil: new Date(NOW + 1000) };
  await setFeature(db, G, 'antiraid', {
    enabled: true, config: { state: 'locked', lockedUntil: NOW + 1000, invitesPausedByUs: true },
  });
  const i = await run({ sub: 'end' });
  assert.equal(last(i).content, t('en', 'antiraid.end.done'));
  const config = await cfgOf();
  assert.equal(config.state, 'idle');
  assert.deepEqual(incidentCalls, [{ invitesDisabledUntil: null, dmsDisabledUntil: null }]);
});

test('disable turns the feature off, then ends the active lockdown', async () => {
  const { guild, incidentCalls } = makeGuild();
  guildRef.guild = guild;
  guild.incidentsData = { invitesDisabledUntil: new Date(NOW + 1000) };
  await setFeature(db, G, 'antiraid', {
    enabled: true, config: { state: 'locked', lockedUntil: NOW + 1000, invitesPausedByUs: true },
  });
  const i = await run({ sub: 'disable' });
  assert.equal(last(i).content, t('en', 'antiraid.disable.ended'));
  const { enabled, config } = await getFeature(db, G, 'antiraid');
  assert.equal(enabled, false);
  assert.equal(config.state, 'idle');
  assert.deepEqual(incidentCalls, [{ invitesDisabledUntil: null, dmsDisabledUntil: null }]);
});

async function runWith(deps, args) {
  const c = createAntiraidCommand({ joins: createJoinStore(), now: () => NOW, ...deps });
  const i = makeInteraction(guildRef.guild, args);
  await c.execute(i, ctx());
  return i;
}

test('disable turns the feature off even when ending the lockdown throws', async (tc) => {
  tc.mock.method(console, 'warn', () => {});
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: { state: 'locked', lockedUntil: NOW + 1000 } });
  const i = await runWith({ endLockdown: async () => { throw new Error('boom'); } }, { sub: 'disable' });
  assert.equal(last(i).content, t('en', 'antiraid.disable.ended'));
  assert.equal((await getFeature(db, G, 'antiraid')).enabled, false);
});

test('disable turns the feature off before it ends the lockdown', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: { state: 'locked', lockedUntil: NOW + 1000 } });
  let enabledAtEnd = null;
  await runWith({
    endLockdown: async () => {
      enabledAtEnd = (await getFeature(db, G, 'antiraid')).enabled;
      return { ok: true };
    },
  }, { sub: 'disable' });
  assert.equal(enabledAtEnd, false);
});

test('start replies with the failure text on schedule_failed', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: {} });
  const i = await runWith({ startLockdown: async () => ({ ok: false, reason: 'schedule_failed' }) }, { sub: 'start' });
  assert.equal(last(i).content, t('en', 'antiraid.start.failed'));
});

test('start replies with the ended text when the lockdown was ended while starting', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: {} });
  const i = await runWith({ startLockdown: async () => ({ ok: false, reason: 'ended' }) }, { sub: 'start' });
  assert.equal(last(i).content, t('en', 'antiraid.start.ended'));
});

test('enable and disable still toggle the feature', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  let i = await run({ sub: 'enable' });
  assert.equal(last(i).content, t('en', 'common.enabledMsg', { feature: t('en', 'feature.antiraid') }));
  assert.equal((await getFeature(db, G, 'antiraid')).enabled, true);

  i = await run({ sub: 'disable' });
  assert.equal(last(i).content, t('en', 'common.disabledMsg', { feature: t('en', 'feature.antiraid') }));
  assert.equal((await getFeature(db, G, 'antiraid')).enabled, false);
});

test('only a manager can run start and end', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: {} });
  let i = await run({ sub: 'start', manage: false });
  assert.equal(last(i).content, t('en', 'common.notAllowed'));
  assert.equal((await cfgOf()).state, undefined);

  i = await run({ sub: 'end', manage: false });
  assert.equal(last(i).content, t('en', 'common.notAllowed'));
});

test('disable ends a lockdown that an auto start locked just before the off write', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', { enabled: true, config: {} });
  let raced = false;
  const racing = {
    query: async (sql, params) => {
      if (!raced && /INSERT INTO guild_settings/.test(sql) && params[1] === 'antiraid' && params[2] === false) {
        raced = true;
        // The auto start wins its flip right before the feature is turned off.
        await db.query(
          `UPDATE guild_settings SET config = config || $2::jsonb WHERE guild_id = $1 AND feature = 'antiraid'`,
          [G, JSON.stringify({ state: 'locked', lockedAt: NOW, lockedUntil: NOW + 1000 })],
        );
      }
      return db.query(sql, params);
    },
  };
  const i = makeInteraction(guild, { sub: 'disable' });
  await cmd.execute(i, { ...ctx(), db: racing });
  assert.equal(raced, true);
  const { enabled, config } = await getFeature(db, G, 'antiraid');
  assert.equal(enabled, false);
  assert.equal(config.state, 'idle', 'no lockdown runs with the feature off');
  assert.equal(last(i).content, t('en', 'antiraid.disable.ended'));
});

test('enable ends a lockdown left over past its end time', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', {
    enabled: false, config: { state: 'locked', lockedAt: NOW - 5000, lockedUntil: NOW - 1000 },
  });
  const i = await run({ sub: 'enable' });
  assert.equal(last(i).content, t('en', 'common.enabledMsg', { feature: t('en', 'feature.antiraid') }));
  const { enabled, config } = await getFeature(db, G, 'antiraid');
  assert.equal(enabled, true);
  assert.equal(config.state, 'idle');
});

test('enable leaves a lockdown that has not reached its end time alone', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', {
    enabled: false, config: { state: 'locked', lockedAt: NOW - 5000, lockedUntil: NOW + 60_000 },
  });
  await run({ sub: 'enable' });
  assert.equal((await cfgOf()).state, 'locked');
});

function enableCmd(endLockdown) {
  return createAntiraidCommand({
    joins: createJoinStore(),
    now: () => NOW,
    sendLog: async () => ({ channelId: 'modchan', messageId: 'm1' }),
    trySend: async (channel) => ({ id: 'p1', channelId: channel.id }),
    fetchSendable: async (client, channelId) => ({ id: channelId, isTextBased: () => true }),
    runAction: async () => ({ ok: true, modCase: { number: 1 }, warnings: [] }),
    endLockdown,
  });
}

test('enable passes the expired lock\'s lockedUntil to the end', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', {
    enabled: false, config: { state: 'locked', lockedAt: NOW - 5000, lockedUntil: NOW - 1000 },
  });
  const seen = [];
  const c = enableCmd(async (_ctx, _guild, opts) => { seen.push(opts); return { ok: true }; });
  await c.execute(makeInteraction(guild, { sub: 'enable' }), ctx());
  assert.equal(seen.length, 1);
  assert.equal(seen[0].by, 'timer');
  assert.equal(seen[0].lockedUntil, NOW - 1000);
});

test('enable does not end a newer lockdown that replaced the expired one', async () => {
  const { guild } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', {
    enabled: false, config: { state: 'locked', lockedAt: NOW - 5000, lockedUntil: NOW - 1000 },
  });
  const c = enableCmd(async (cx, g, opts, d) => {
    // A join ended the expired lock and a burst started a new live one before enable's end ran.
    await setFeature(db, G, 'antiraid', {
      enabled: true, config: { state: 'locked', lockedAt: NOW, lockedUntil: NOW + 60_000 },
    });
    return endLockdown(cx, g, opts, d);
  });
  await c.execute(makeInteraction(guild, { sub: 'enable' }), ctx());
  const cfg = await cfgOf();
  assert.equal(cfg.state, 'locked');
  assert.equal(cfg.lockedUntil, NOW + 60_000);
});
