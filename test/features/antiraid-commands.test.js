import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createAntiraidCommand } from '../../src/features/antiraid/commands.js';
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
  await setFeature(db, G, 'antiraid', {
    enabled: true, config: { state: 'locked', lockedUntil: NOW + 1000, invitesPausedByUs: true },
  });
  const i = await run({ sub: 'end' });
  assert.equal(last(i).content, t('en', 'antiraid.end.done'));
  const config = await cfgOf();
  assert.equal(config.state, 'idle');
  assert.deepEqual(incidentCalls, [{ invitesDisabledUntil: null }]);
});

test('disable ends an active lockdown first', async () => {
  const { guild, incidentCalls } = makeGuild();
  guildRef.guild = guild;
  await setFeature(db, G, 'antiraid', {
    enabled: true, config: { state: 'locked', lockedUntil: NOW + 1000, invitesPausedByUs: true },
  });
  const i = await run({ sub: 'disable' });
  assert.equal(last(i).content, t('en', 'antiraid.disable.ended'));
  const { enabled, config } = await getFeature(db, G, 'antiraid');
  assert.equal(enabled, false);
  assert.equal(config.state, 'idle');
  assert.deepEqual(incidentCalls, [{ invitesDisabledUntil: null }]);
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
