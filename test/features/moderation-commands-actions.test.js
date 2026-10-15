import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { actionCommands } from '../../src/features/moderation/commands-actions.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const NAMES = ['warn', 'timeout', 'untimeout', 'mute', 'unmute', 'kick', 'ban', 'unban'];
const byName = (n) => actionCommands.find((c) => c.data.name === n);

// ---- structure ----

test('the module exposes the eight commands in order', () => {
  assert.deepEqual(actionCommands.map((c) => c.data.name), NAMES);
});

test('option names and order match the documented signatures', () => {
  const shape = (n) => byName(n).data.toJSON().options.map((o) => [o.name, !!o.required]);
  assert.deepEqual(shape('warn'), [['user', true], ['reason', false]]);
  assert.deepEqual(shape('timeout'), [['user', true], ['duration', false], ['reason', false]]);
  assert.deepEqual(shape('untimeout'), [['user', true], ['reason', false]]);
  assert.deepEqual(shape('mute'), [['user', true], ['duration', false], ['reason', false]]);
  assert.deepEqual(shape('unmute'), [['user', true], ['reason', false]]);
  assert.deepEqual(shape('kick'), [['user', true], ['reason', false]]);
  assert.deepEqual(shape('ban'), [['user', true], ['duration', false], ['delete_days', false], ['reason', false]]);
  assert.deepEqual(shape('unban'), [['user', true], ['reason', false]]);
});

test('descriptions are 1-100 chars, required options come first, no default permissions', () => {
  for (const c of actionCommands) {
    const json = c.data.toJSON();
    assert.ok(json.description.length >= 1 && json.description.length <= 100, json.name);
    assert.equal(json.default_member_permissions ?? null, null, `${json.name} permissions`);
    let optional = false;
    for (const o of json.options) {
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${json.name} ${o.name}`);
      assert.ok(!(optional && o.required), `${json.name} ${o.name} order`);
      if (!o.required) optional = true;
    }
  }
});

test('reason is a string up to 400 chars and delete_days is an integer 0 to 7', () => {
  const opts = byName('ban').data.toJSON().options;
  assert.equal(opts.find((o) => o.name === 'reason').max_length, 400);
  const days = opts.find((o) => o.name === 'delete_days');
  assert.equal(days.min_value, 0);
  assert.equal(days.max_value, 7);
});

// ---- execute ----

let db;
const realWarn = console.warn;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  console.warn = () => {};
  await db.query('TRUNCATE guild_settings, scheduled_jobs, mod_cases, mod_counters');
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: { reasonRequired: false, dm: false } });
});
after(async () => { console.warn = realWarn; await db.end(); });

const err = (status, code) => Object.assign(new Error('x'), { status, code });

function member(id, position, { perms = [], roles = [] } = {}) {
  return {
    id,
    roles: { highest: { position }, cache: { has: (r) => roles.includes(r) } },
    permissions: { has: (p) => perms.includes(p) },
    send: async () => {},
    timeout: async () => {},
    kick: async () => {},
  };
}

function fake({ opts = {}, perms = ['ModerateMembers', 'KickMembers', 'BanMembers'], roles = [], targets = {}, banned = [] } = {}) {
  const calls = { replies: [], discord: [] };
  const bans = new Set(banned);
  const members = new Map(Object.entries(targets));
  const actor = member('mod', 5, { perms, roles });
  const guild = {
    id: 'g1', name: 'Guild', ownerId: 'owner',
    roles: { cache: new Map() },
    bans: { fetch: async (id) => { if (!bans.has(id)) throw err(404, 10026); return {}; } },
    members: {
      me: { id: 'bot', roles: { highest: { position: 10 } } },
      fetch: async (id) => { const m = members.get(id); if (!m) throw err(404, 10007); return m; },
      ban: async (id, o) => { calls.discord.push(['ban', id, o]); bans.add(id); },
      unban: async (id) => { calls.discord.push(['unban', id]); bans.delete(id); },
    },
  };
  const values = { reason: null, duration: null, delete_days: null, ...opts };
  const interaction = {
    guildId: 'g1', guild, member: actor, user: { id: 'mod' },
    inGuild: () => true,
    options: {
      getUser: () => ({ id: 'u1' }),
      getString: (n) => values[n] ?? null,
      getInteger: (n) => values[n] ?? null,
    },
    deferReply: async (o) => { calls.deferred = o; },
    reply: async (p) => { calls.replies.push(p); },
    editReply: async (p) => { calls.replies.push(p); },
  };
  const ctx = {
    db,
    client: { user: { id: 'bot' }, guilds: { cache: new Map([['g1', guild]]) }, channels: { fetch: async () => null } },
  };
  return { interaction, ctx, calls, guild };
}
const run = (name, f) => byName(name).execute(f.interaction, f.ctx);
const last = (f) => f.calls.replies.at(-1).content;

test('a member without permission or permitted role is refused', async () => {
  const f = fake({ perms: [], targets: { u1: member('u1', 1) } });
  await run('kick', f);
  assert.equal(last(f), t('en', 'moderation.err.not_allowed'));
  assert.equal(f.calls.replies.length, 1);
});

test('a permitted-role holder is allowed', async () => {
  await setFeature(db, 'g1', 'moderation', { config: { reasonRequired: false, dm: false, permittedRoles: ['R'] } });
  const f = fake({ perms: [], roles: ['R'], targets: { u1: member('u1', 1) } });
  await run('warn', f);
  assert.match(last(f), /#1/);
});

test('the feature being off gives the standard off message', async () => {
  await setFeature(db, 'g1', 'moderation', { enabled: false });
  const f = fake({ targets: { u1: member('u1', 1) } });
  await run('warn', f);
  assert.match(last(f), /This feature is off/);
});

test('duration options are at most 32 characters', () => {
  for (const name of ['timeout', 'mute', 'ban']) {
    const opt = byName(name).data.toJSON().options.find((o) => o.name === 'duration');
    assert.equal(opt.max_length, 32, name);
  }
});

test('a huge ban duration is refused before anything happens', async () => {
  const f = fake({ opts: { duration: '1000000000d', reason: 'r' }, targets: { u1: member('u1', 1) } });
  await run('ban', f);
  assert.equal(last(f), t('en', 'moderation.err.too_long'));
  assert.deepEqual(f.calls.discord, []);
  assert.equal(Number((await db.query('SELECT count(*) FROM mod_cases')).rows[0].count), 0);
  assert.equal(Number((await db.query('SELECT count(*) FROM scheduled_jobs')).rows[0].count), 0);
});

test('an unparseable duration is reported and nothing runs', async () => {
  const f = fake({ opts: { duration: 'soon' }, targets: { u1: member('u1', 1) } });
  await run('timeout', f);
  assert.equal(last(f), t('en', 'moderation.err.bad_duration'));
  assert.equal(Number((await db.query('SELECT count(*) FROM mod_cases')).rows[0].count), 0);
});

test('success replies show the case number; warn shows the warning id; replies are ephemeral', async () => {
  const f = fake({ opts: { reason: 'spam' }, targets: { u1: member('u1', 1) } });
  await run('warn', f);
  assert.match(last(f), /#1/);
  assert.match(last(f), /[Ww]arning/);
  assert.ok(f.calls.deferred.flags !== undefined);
  const f2 = fake({ opts: { reason: 'x' }, targets: { u1: member('u1', 1) } });
  await run('kick', f2);
  assert.match(last(f2), /#2/);
});

test('an engine failure replies with the matching error key', async () => {
  await setFeature(db, 'g1', 'moderation', { config: { reasonRequired: true, dm: false } });
  const f = fake({ targets: { u1: member('u1', 1) } });
  await run('warn', f);
  assert.equal(last(f), t('en', 'moderation.err.reason_required'));
});

test('warnings are appended as notes', async () => {
  await setFeature(db, 'g1', 'moderation', { config: { reasonRequired: false, dm: true } });
  const target = member('u1', 1);
  target.send = async () => { throw new Error('closed'); };
  const f = fake({ targets: { u1: target } });
  await run('warn', f);
  assert.match(last(f), /#1/);
  assert.ok(last(f).includes(t('en', 'moderation.warning.dm_failed')));
});

test('ban and unban pass target null when the user is not in the server', async () => {
  const f = fake({ opts: { delete_days: 3, reason: 'bad' } });
  await run('ban', f);
  assert.match(last(f), /#1/);
  assert.equal(f.calls.discord[0][0], 'ban');
  assert.equal(f.calls.discord[0][2].deleteMessageSeconds, 3 * 86400);
  const g = fake({ banned: ['u1'] });
  await run('unban', g);
  assert.match(last(g), /#2/);
});

test('timeout with a duration parses it and shows it', async () => {
  const f = fake({ opts: { duration: '1h', reason: 'r' }, targets: { u1: member('u1', 1) } });
  await run('timeout', f);
  assert.match(last(f), /#1/);
  assert.match(last(f), /1h/);
});

test('a member lookup that fails for another reason stops the action instead of skipping hierarchy', async () => {
  for (const name of ['ban', 'kick', 'warn']) {
    const f = fake({ opts: { reason: 'r' } });
    f.guild.members.fetch = async () => { throw err(503, 0); };
    await assert.rejects(run(name, f), /x/, name);
    assert.deepEqual(f.calls.discord, [], name);
  }
  assert.equal(Number((await db.query('SELECT count(*) FROM mod_cases')).rows[0].count), 0);
});

test('kick of a user not in the server reports not_in_server', async () => {
  const f = fake();
  await run('kick', f);
  assert.equal(last(f), t('en', 'moderation.err.not_in_server'));
});
