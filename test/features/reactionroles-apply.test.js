import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { applyPick, createGrantAlert } from '../../src/features/reactionroles/apply.js';
import { logRoleDanger } from '../../src/features/reactionroles/log.js';
import { createMessage, addEntry, getMessage } from '../../src/features/reactionroles/store.js';

let db;
before(async () => {
  db = await testDb();
});
after(async () => {
  await db.end();
});
beforeEach(async () => {
  await resetDb(db);
});

// A guild with roles A, B, C and a member whose role changes land after a tick, like the real API.
function fakeMember(id, held = []) {
  const roles = new Map([['A', {}], ['B', {}], ['C', {}]]);
  const cache = new Map(held.map((id) => [id, {}]));
  const calls = [];
  return {
    id,
    calls,
    guild: { id: 'g1', roles: { cache: roles } },
    roles: {
      cache,
      async add(ids) {
        await new Promise((r) => setImmediate(r));
        calls.push(['add', ids]);
        for (const id of ids) cache.set(id, {});
      },
      async remove(ids) {
        await new Promise((r) => setImmediate(r));
        calls.push(['remove', ids]);
        for (const id of ids) cache.delete(id);
      },
    },
  };
}

async function seed(type, msgId = 'm1') {
  await createMessage(db, { guildId: 'g1', messageId: msgId, channelId: 'c1', style: 'buttons', type, createdBy: 'x' });
  for (const id of ['A', 'B', 'C']) await addEntry(db, msgId, { roleId: id, label: id });
  return getMessage(db, msgId);
}

const ctx = () => ({ db });
const allow = { botCanGive: () => true };
const toggle = (message, roleId) => ({ kind: 'entry', entry: message.entries.find((e) => e.roleId === roleId), action: 'toggle' });
const addEntryPick = (message, roleId) => ({ kind: 'entry', entry: message.entries.find((e) => e.roleId === roleId), action: 'add' });

test('adds a role and returns it', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), allow);
  assert.deepEqual([result.ok, result.added], [true, ['A']]);
  assert.ok(member.roles.cache.has('A'));
});

test('removes the old role of a unique message (both calls recorded)', async () => {
  const message = await seed('unique');
  const member = fakeMember('u1', ['A']);
  const result = await applyPick(ctx(), member, message, toggle(message, 'B'), allow);
  assert.equal(result.ok, true);
  assert.equal(result.added.length, 1);
  assert.equal(result.removed.length, 1);
  assert.equal(member.calls.length, 2);
  assert.deepEqual(member.calls[0], ['remove', ['A']]);
  assert.deepEqual(member.calls[1], ['add', ['B']]);
  assert.equal(member.roles.cache.has('A'), false);
  assert.equal(member.roles.cache.has('B'), true);
});

test('refuses a role deleted from the guild with role_missing and changes nothing', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  member.guild.roles.cache.delete('A');
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), allow);
  assert.deepEqual([result.ok, result.reason], [false, 'role_missing']);
  assert.equal(member.calls.length, 0);
});

test('refuses with cannot_give when botCanGive is false at pick time', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), { botCanGive: () => false });
  assert.equal(result.reason, 'cannot_give');
  assert.equal(member.calls.length, 0);
});

test('a Discord error from roles.add yields discord_failed and never throws', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  member.roles.add = async () => { throw new Error('Missing Permissions'); };
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), allow);
  assert.equal(result.reason, 'discord_failed');
});

test('a binding pick is stored and a second pick returns bound', async () => {
  const message = await seed('binding');
  const member = fakeMember('u1');
  assert.equal((await applyPick(ctx(), member, message, addEntryPick(message, 'A'), allow)).ok, true);
  member.roles.cache.delete('A');
  assert.equal((await applyPick(ctx(), member, message, addEntryPick(message, 'B'), allow)).reason, 'bound');
});

test('two simultaneous picks on a unique message leave exactly one role (per-member lock)', async () => {
  const message = await seed('unique');
  const member = fakeMember('u1');
  await Promise.all([
    applyPick(ctx(), member, message, addEntryPick(message, 'A'), allow),
    applyPick(ctx(), member, message, addEntryPick(message, 'B'), allow),
  ]);
  const held = ['A', 'B', 'C'].filter((id) => member.roles.cache.has(id));
  assert.equal(held.length, 1);
});

test('two simultaneous picks for different members are not serialized against each other', async () => {
  const message = await seed('normal');
  const m1 = fakeMember('u1');
  const m2 = fakeMember('u2');
  const [r1, r2] = await Promise.all([
    applyPick(ctx(), m1, message, addEntryPick(message, 'A'), allow),
    applyPick(ctx(), m2, message, addEntryPick(message, 'A'), allow),
  ]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.ok(m1.roles.cache.has('A'));
  assert.ok(m2.roles.cache.has('A'));
});

// ── Ruling E: throttle test using an injectable log ───────────────────────────

test('createGrantAlert writes at most one alert per message per hour', async () => {
  let n = 0;
  const log = async () => { n += 1; };
  const alert = createGrantAlert({ now: () => 100, log, everyMs: 1000 });
  const guild = { id: 'g1' };
  const message = { messageId: 'm1' };
  const role = { id: 'A' };
  await alert({}, guild, message, role);
  await alert({}, guild, message, role);
  await alert({}, guild, message, role);
  assert.equal(n, 1);
});

test('createGrantAlert gives each message its own throttle window', async () => {
  let n = 0;
  const log = async () => { n += 1; };
  const alert = createGrantAlert({ now: () => 100, log, everyMs: 1000 });
  const guild = { id: 'g1' };
  await alert({}, guild, { messageId: 'm1' }, { id: 'A' });
  await alert({}, guild, { messageId: 'm2' }, { id: 'A' });
  await alert({}, guild, { messageId: 'm1' }, { id: 'A' }); // same as first, suppressed
  assert.equal(n, 2);
});

test('createGrantAlert emits again after the window expires', async () => {
  let n = 0;
  const t = [100];
  const log = async () => { n += 1; };
  const alert = createGrantAlert({ now: () => t[0], log, everyMs: 1000 });
  const guild = { id: 'g1' };
  await alert({}, guild, { messageId: 'm1' }, { id: 'A' });
  t[0] = 1200;
  await alert({}, guild, { messageId: 'm1' }, { id: 'A' });
  assert.equal(n, 2);
});

test('createGrantAlert never throws when the log throws', async () => {
  const log = async () => { throw new Error('boom'); };
  const alert = createGrantAlert({ now: () => 100, log, everyMs: 1000 });
  const guild = { id: 'g1' };
  const message = { messageId: 'm1' };
  await alert({}, guild, message, { id: 'A' });
  await alert({}, guild, message, { id: 'A' });
});

test('a database error reading the binding yields discord_failed and never rejects', async () => {
  const message = await seed('binding');
  const member = fakeMember('u1');
  const broken = { db: { query: async () => { throw new Error('db down'); } } };
  const result = await applyPick(broken, member, message, addEntryPick(message, 'A'), allow);
  assert.deepEqual([result.ok, result.reason], [false, 'discord_failed']);
  assert.equal(member.calls.length, 0);
});

test('a setBinding failure after a successful add rolls the role back', async () => {
  const message = await seed('binding');
  const member = fakeMember('u1');
  // getBinding (a SELECT) works; the binding INSERT throws.
  const flaky = { db: { query: (sql, ...rest) => {
    if (/insert/i.test(String(sql?.text ?? sql))) throw new Error('write failed');
    return db.query(sql, ...rest);
  } } };
  const result = await applyPick(flaky, member, message, addEntryPick(message, 'A'), allow);
  assert.deepEqual([result.ok, result.reason], [false, 'discord_failed']);
  assert.equal(member.roles.cache.has('A'), false);
  assert.deepEqual(member.calls.map((c) => c[0]), ['add', 'remove']);
});

test('logRoleDanger puts the message id and role mention into the localized text', async () => {
  let sent;
  await logRoleDanger({}, 'g1', 'en', { messageId: 'm42', roleId: 'r7' }, { sendLog: async (c, g, ev, embed) => { sent = embed; } });
  assert.match(sent.description, /m42/);
  assert.match(sent.description, /<@&r7>/);
  assert.equal(sent.fields, undefined);
});
