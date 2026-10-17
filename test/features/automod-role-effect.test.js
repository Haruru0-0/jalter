import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { grantTimedRole, removeTimedRole, jobs } from '../../src/features/automod/role-effect.js';
import * as automod from '../../src/features/automod/index.js';
import { readConfig } from '../../src/features/automod/config.js';
import { enforce } from '../../src/features/automod/enforce.js';
import { createStrikeStore } from '../../src/features/automod/strikes.js';
import { getFeature } from '../../src/db/settings.js';
import { resetDb } from '../../src/db/index.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const G = 'g1';
const NOW = 1_000_000;
let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const rows = async () => (await db.query(
  'SELECT type, key, payload, (EXTRACT(EPOCH FROM due_at)*1000)::bigint AS due FROM scheduled_jobs',
)).rows;

const permsOf = (list) => ({ has: (p) => list.includes(p) });
const DANGEROUS = ['Administrator', 'ManageGuild', 'ManageRoles', 'BanMembers', 'KickMembers', 'ModerateMembers',
  'ManageChannels', 'ManageMessages', 'ManageWebhooks', 'MentionEveryone'];

/** A guild with a role, a bot at position 10, and a member who may already hold roles. */
function world({ has = [], rolePosition = 5, managed = false, noRole = false, perms = [], add, remove, fetch } = {}) {
  const calls = { add: [], remove: [] };
  const held = new Set(has);
  const role = { id: 'r1', position: rolePosition, managed, permissions: permsOf(perms) };
  const member = {
    id: 'u1',
    roles: {
      cache: { has: (id) => held.has(id) },
      add: add ?? (async (id, why) => { calls.add.push([id, why]); held.add(id); }),
      remove: remove ?? (async (id, why) => { calls.remove.push([id, why]); held.delete(id); }),
    },
  };
  const guild = {
    id: G,
    members: { me: { roles: { highest: { position: 10 } } }, fetch: fetch ?? (async () => member) },
    roles: { cache: new Map(noRole ? [] : [['r1', role]]) },
  };
  member.guild = guild;
  const ctx = { db, client: { guilds: { cache: new Map([[G, guild]]) } } };
  return { calls, member, guild, ctx, held };
}
const cfg = { giveRole: { roleId: 'r1', seconds: 600 } };
const job = { guildId: G, payload: { userId: 'u1', roleId: 'r1' } };
const apiError = (message, props) => Object.assign(new Error(message), props);

test('grants the role and schedules removal', async () => {
  const w = world();
  assert.equal(await grantTimedRole(w.ctx, w.member, cfg, NOW), true);
  assert.equal(w.calls.add.length, 1);
  assert.equal(w.calls.add[0][0], 'r1');
  const [row] = await rows();
  assert.equal(row.type, 'automod.removeRole');
  assert.equal(row.key, 'u1:r1');
  assert.deepEqual(row.payload, { userId: 'u1', roleId: 'r1' });
  assert.equal(Number(row.due), NOW + 600_000);
});

test('skips when the member already has the role', async () => {
  const w = world({ has: ['r1'] });
  assert.equal(await grantTimedRole(w.ctx, w.member, cfg, NOW), false);
  assert.equal(w.calls.add.length, 0);
  assert.equal((await rows()).length, 0);
});

test('does nothing without a configured role, a missing role, a managed role or one above the bot', async () => {
  for (const [w, c] of [
    [world(), { giveRole: { roleId: null, seconds: 600 } }],
    [world({ noRole: true }), cfg],
    [world({ managed: true }), cfg],
    [world({ rolePosition: 10 }), cfg],
    [world({ rolePosition: 11 }), cfg],
  ]) {
    assert.equal(await grantTimedRole(w.ctx, w.member, c, NOW), false);
    assert.equal(w.calls.add.length, 0);
  }
  assert.equal((await rows()).length, 0);
});

test('grant refuses a role that gained a dangerous permission, quietly with a warning', async (tc) => {
  const warn = tc.mock.method(console, 'warn', () => {});
  for (const perm of DANGEROUS) {
    const w = world({ perms: [perm] });
    assert.equal(await grantTimedRole(w.ctx, w.member, cfg, NOW), false, perm);
    assert.equal(w.calls.add.length, 0, perm);
  }
  assert.equal((await rows()).length, 0);
  assert.equal(warn.mock.callCount(), DANGEROUS.length);
  const harmless = world({ perms: ['SendMessages', 'AddReactions'] });
  assert.equal(await grantTimedRole(harmless.ctx, harmless.member, cfg, NOW), true);
});

test('a re-trigger moves the removal time', async () => {
  const w = world();
  await grantTimedRole(w.ctx, w.member, cfg, NOW);
  assert.equal(await grantTimedRole(w.ctx, w.member, { giveRole: { roleId: 'r1', seconds: 3600 } }, NOW + 1000), true);
  const all = await rows();
  assert.equal(all.length, 1);
  assert.equal(Number(all[0].due), NOW + 1000 + 3_600_000);
  assert.equal(w.calls.add.length, 1);
});

test('a failed add leaves no job behind', async () => {
  const w = world({ add: async () => { throw apiError('Missing Permissions', { status: 403 }); } });
  await assert.rejects(grantTimedRole(w.ctx, w.member, cfg, NOW));
  assert.equal((await rows()).length, 0);
});

test('the handler removes the role', async () => {
  const w = world({ has: ['r1'] });
  await removeTimedRole(w.ctx, job);
  assert.equal(w.calls.remove.length, 1);
  assert.equal(w.calls.remove[0][0], 'r1');
});

test('the handler is quiet when the member does not hold the role any more', async () => {
  const w = world();
  await removeTimedRole(w.ctx, job);
  assert.equal(w.calls.remove.length, 0);
});

test('the handler is quiet when the member left', async () => {
  const w = world({ fetch: async () => { throw apiError('Unknown Member', { code: 10007, status: 404 }); } });
  await removeTimedRole(w.ctx, job);
  assert.equal(w.calls.remove.length, 0);
});

test('the handler is quiet when the role was deleted', async () => {
  const gone = world({ noRole: true, has: ['r1'] });
  await removeTimedRole(gone.ctx, job);
  assert.equal(gone.calls.remove.length, 0);
  const race = world({ has: ['r1'], remove: async () => { throw apiError('Unknown Role', { code: 10011, status: 404 }); } });
  await removeTimedRole(race.ctx, job);
});

test('the handler is quiet when the guild is gone', async () => {
  const w = world();
  w.ctx.client.guilds.cache.clear();
  await removeTimedRole(w.ctx, job);
});

test('a permanent 4xx error finishes quietly and a transient one throws', async (tc) => {
  tc.mock.method(console, 'warn', () => {});
  const perm = world({ has: ['r1'], remove: async () => { throw apiError('Missing Permissions', { code: 50013, status: 403 }); } });
  await removeTimedRole(perm.ctx, job);
  for (const status of [500, 429, undefined]) {
    const w = world({ has: ['r1'], remove: async () => { throw apiError('boom', { status }); } });
    await assert.rejects(removeTimedRole(w.ctx, job));
  }
  const fetchFail = world({ fetch: async () => { throw apiError('boom', { status: 503 }); } });
  await assert.rejects(removeTimedRole(fetchFail.ctx, job));
});

test('the automod module exports the job for the loader', () => {
  assert.equal(automod.jobs['automod.removeRole'], removeTimedRole);
  assert.equal(jobs['automod.removeRole'], removeTimedRole);
});

test('config cleans giveRole', () => {
  assert.deepEqual(readConfig({}).rules.spam.giveRole, { roleId: null, seconds: 600 });
  const c = readConfig({ rules: {
    words: { giveRole: { roleId: 'r9', seconds: 3600 } },
    links: { giveRole: { roleId: '', seconds: 5 } },
    spam: { giveRole: { roleId: 7, seconds: 604_801 } },
    invites: { giveRole: 'x' },
  } });
  assert.deepEqual(c.rules.words.giveRole, { roleId: 'r9', seconds: 3600 });
  assert.deepEqual(c.rules.links.giveRole, { roleId: null, seconds: 600 });
  assert.deepEqual(c.rules.spam.giveRole, { roleId: null, seconds: 600 });
  assert.deepEqual(c.rules.invites.giveRole, { roleId: null, seconds: 600 });
});

function enforceWith(w, giveRole, { addThrows = false } = {}) {
  const autoConfig = readConfig({ rules: { words: { enabled: true, giveRole, steps: [{ strikes: 2, action: 'warn' }] } } });
  const strikes = createStrikeStore();
  const deps = {
    runAction: async () => ({ ok: true, modCase: { number: 1 }, warnings: [] }),
    sendLog: async () => null,
    addHistory: async () => {},
    now: () => NOW,
  };
  if (addThrows) w.member.roles.add = async () => { throw new Error('boom'); };
  return () => enforce(w.ctx, {
    guild: w.guild, member: w.member, message: null, findings: [{ rule: 'words', reason: 'x' }],
    autoConfig, modConfig: {}, lang: 'en', deps, strikes,
  });
}

test('enforce gives the role only when a step fires', async () => {
  const w = world();
  const go = enforceWith(w, { roleId: 'r1', seconds: 600 });
  await go();
  assert.equal(w.calls.add.length, 0);
  await go();
  assert.equal(w.calls.add.length, 1);
  assert.equal((await rows()).length, 1);
});

test('enforce never throws because of the role effect', async (tc) => {
  tc.mock.method(console, 'warn', () => {});
  const w = world();
  const go = enforceWith(w, { roleId: 'r1', seconds: 600 }, { addThrows: true });
  await go();
  await go();
  assert.equal((await rows()).length, 0);
});

// --- /automod role ---
const { commands } = automod;
function fake(strings, { role = null, off = null, callerId = 'mod', callerTop = 8 } = {}) {
  const calls = { reply: [] };
  return {
    calls,
    guildId: G,
    inGuild: () => true,
    member: { id: callerId, permissions: { has: () => true }, guild: { id: G }, roles: { cache: { has: () => false }, highest: { position: callerTop } } },
    guild: { id: G, ownerId: 'owner', members: { me: { roles: { highest: { position: 10 } } } } },
    options: {
      getSubcommand: () => 'role',
      getSubcommandGroup: () => null,
      getString: (n) => strings[n] ?? null,
      getRole: () => role,
      getBoolean: () => off,
      getInteger: () => null,
    },
    deferred: false,
    replied: false,
    reply: async (p) => { calls.reply.push(p); },
    editReply: async (p) => { calls.reply.push(p); },
  };
}
const run = (i) => commands[0].execute(i, { db });
const saved = async () => readConfig((await getFeature(db, G, 'automod')).config);

test('role command saves, keeps the duration when none is given, and clears', async () => {
  await run(fake({ rule: 'words', duration: '2h' }, { role: { id: 'r1', position: 5, managed: false } }));
  assert.deepEqual((await saved()).rules.words.giveRole, { roleId: 'r1', seconds: 7200 });
  await run(fake({ rule: 'words' }, { role: { id: 'r2', position: 5, managed: false } }));
  assert.deepEqual((await saved()).rules.words.giveRole, { roleId: 'r2', seconds: 7200 });
  await run(fake({ rule: 'words' }, { off: true }));
  assert.equal((await saved()).rules.words.giveRole.roleId, null);
});

test('setup refuses a role above the bot, a managed role, @everyone and a bad duration', async () => {
  const cases = [
    [{ id: 'r1', position: 10, managed: false }, 'automod.settings.role_too_high', {}],
    [{ id: 'r1', position: 11, managed: false }, 'automod.settings.role_too_high', {}],
    [{ id: 'r1', position: 1, managed: true }, 'automod.settings.role_managed', {}],
    [{ id: G, position: 0, managed: false }, 'automod.settings.role_everyone', {}],
    [{ id: 'r1', position: 1, managed: false }, 'automod.settings.bad_role_duration', { duration: '10s' }],
    [{ id: 'r1', position: 1, managed: false }, 'automod.settings.bad_role_duration', { duration: '8d' }],
  ];
  for (const [role, key, extra] of cases) {
    const i = fake({ rule: 'words', ...extra }, { role });
    await run(i);
    assert.equal(i.calls.reply.at(-1).content, t('en', key), key);
  }
  assert.equal((await saved()).rules.words.giveRole.roleId, null);
});

const plainRole = (o = {}) => ({ id: 'r1', position: 5, managed: false, permissions: permsOf(['SendMessages']), ...o });

test('setup refuses a role with a dangerous permission', async () => {
  for (const perm of DANGEROUS) {
    const i = fake({ rule: 'words' }, { role: plainRole({ permissions: permsOf([perm]) }) });
    await run(i);
    assert.equal(i.calls.reply.at(-1).content, t('en', 'automod.settings.role_dangerous'), perm);
  }
  assert.equal((await saved()).rules.words.giveRole.roleId, null);
});

test('setup refuses a role at or above the caller, unless the caller owns the server', async () => {
  for (const callerTop of [5, 4]) {
    const i = fake({ rule: 'words' }, { role: plainRole(), callerTop });
    await run(i);
    assert.equal(i.calls.reply.at(-1).content, t('en', 'automod.settings.role_above_you'), String(callerTop));
  }
  assert.equal((await saved()).rules.words.giveRole.roleId, null);
  await run(fake({ rule: 'words' }, { role: plainRole(), callerId: 'owner', callerTop: 1 }));
  assert.equal((await saved()).rules.words.giveRole.roleId, 'r1');
});

test('setup still takes a harmless role below the caller', async () => {
  const i = fake({ rule: 'words' }, { role: plainRole(), callerTop: 6 });
  await run(i);
  assert.equal((await saved()).rules.words.giveRole.roleId, 'r1');
});

test('the new refusal reasons exist in every language', () => {
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of ['automod.settings.role_dangerous', 'automod.settings.role_above_you']) {
      assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    }
  }
});
