import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { applyPick, createGrantAlert } from '../../src/features/reactionroles/apply.js';
import { logRoleDanger } from '../../src/features/reactionroles/log.js';
import { createMessage, addEntry, getMessage, updateMessage } from '../../src/features/reactionroles/store.js';
import { fakeDiscordMember, heldRoles } from '../helpers/discord-member.js';

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

// A guild with roles A, B, C and a member that behaves like discord.js: role calls do not update the
// cached roles (only the gateway does, later), array calls PATCH the whole set from that cache.
function fakeMember(id, held = []) {
  const guild = { id: 'g1', roles: { cache: new Map([['A', { id: 'A' }], ['B', { id: 'B' }], ['C', { id: 'C' }]]) } };
  return fakeDiscordMember(guild, { id, held });
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

// Runs fn with console.warn silenced (the applier warns on every Discord failure).
async function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

test('adds a role and returns it', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), allow);
  assert.deepEqual([result.ok, result.added], [true, ['A']]);
  assert.deepEqual(heldRoles(member), ['A']);
});

// C1: the array forms PATCH the whole role set from a stale cache, so remove-then-add restored the old role.
test('a unique swap leaves exactly the new role even while the cached roles are stale', async () => {
  const message = await seed('unique');
  const member = fakeMember('u1', ['A']);
  const result = await applyPick(ctx(), member, message, toggle(message, 'B'), allow);
  assert.deepEqual([result.ok, result.added, result.removed], [true, ['B'], ['A']]);
  assert.deepEqual(heldRoles(member), ['B']);
  // Single-role calls, the add before the remove so a failure never leaves the member with nothing.
  assert.deepEqual(member.calls, [['put', 'B'], ['delete', 'A']]);
});

test('a mixed menu submission applies every add and every remove', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1', ['A', 'B']);
  const result = await applyPick(ctx(), member, message, { kind: 'menu', roleIds: ['A', 'C'] }, allow);
  assert.deepEqual([result.ok, result.added, result.removed], [true, ['C'], ['B']]);
  assert.deepEqual(heldRoles(member), ['A', 'C']);
});

// T3#3: a swap that fails halfway is undone, so the member never ends with no role.
test('a unique swap whose add fails keeps the old role', async () => {
  const message = await seed('unique');
  const member = fakeMember('u1', ['A']);
  member.failOn.add('put');
  const result = await quiet(() => applyPick(ctx(), member, message, toggle(message, 'B'), allow));
  assert.deepEqual([result.ok, result.reason], [false, 'discord_failed']);
  assert.deepEqual(heldRoles(member), ['A']);
});

test('a unique swap whose remove fails is rolled back to the old role', async () => {
  const message = await seed('unique');
  const member = fakeMember('u1', ['A']);
  member.failOn.add('delete:A');
  const result = await quiet(() => applyPick(ctx(), member, message, toggle(message, 'B'), allow));
  assert.deepEqual([result.ok, result.reason], [false, 'discord_failed']);
  assert.deepEqual(heldRoles(member), ['A']);
  assert.deepEqual(member.calls, [['put', 'B'], ['delete', 'A'], ['delete', 'B']]);
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
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), { botCanGive: () => false, alert: async () => {} });
  assert.equal(result.reason, 'cannot_give');
  assert.equal(member.calls.length, 0);
});

// I1: a role that gained a staff permission after setup is no longer handed out.
test('a role that has since gained Administrator is refused with cannot_give and alerted', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  member.guild.roles.cache.set('A', { id: 'A', permissions: { has: (p) => p === 'Administrator' } });
  const alerts = [];
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), {
    ...allow, alert: async (c, g, m, role) => { alerts.push(role.id); },
  });
  assert.deepEqual([result.ok, result.reason], [false, 'cannot_give']);
  assert.deepEqual(alerts, ['A']);
  assert.equal(member.calls.length, 0);
});

// I3: a refusal decided after the rules clears the reaction of an entry add, so no reaction sits without a role.
test('role_missing, cannot_give and discord_failed on an entry add ask to clear the reaction', async () => {
  const message = await seed('normal');
  const missing = fakeMember('u1');
  missing.guild.roles.cache.delete('A');
  const cannot = fakeMember('u2');
  const failed = fakeMember('u3');
  failed.failOn.add('put');
  const results = await quiet(async () => [
    await applyPick(ctx(), missing, message, addEntryPick(message, 'A'), allow),
    await applyPick(ctx(), cannot, message, addEntryPick(message, 'A'), { botCanGive: () => false, alert: async () => {} }),
    await applyPick(ctx(), failed, message, addEntryPick(message, 'A'), allow),
  ]);
  assert.deepEqual(results.map((r) => [r.reason, r.clearReaction]),
    [['role_missing', true], ['cannot_give', true], ['discord_failed', true]]);
});

test('a Discord error from roles.add yields discord_failed and never throws', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  member.failOn.add('put');
  const result = await quiet(() => applyPick(ctx(), member, message, toggle(message, 'A'), allow));
  assert.equal(result.reason, 'discord_failed');
});

test('a binding pick is stored and a second pick returns bound', async () => {
  const message = await seed('binding');
  const member = fakeMember('u1');
  assert.equal((await applyPick(ctx(), member, message, addEntryPick(message, 'A'), allow)).ok, true);
  member.server.delete('A');
  assert.equal((await applyPick(ctx(), member, message, addEntryPick(message, 'B'), allow)).reason, 'bound');
});

// C2: the per-member lock only helps if each pick decides on Discord's current roles, not the stale cache.
test('two simultaneous picks on a unique message leave exactly one role (per-member lock)', async () => {
  const message = await seed('unique');
  const member = fakeMember('u1');
  await Promise.all([
    applyPick(ctx(), member, message, addEntryPick(message, 'A'), allow),
    applyPick(ctx(), member, message, addEntryPick(message, 'B'), allow),
  ]);
  assert.equal(heldRoles(member).length, 1);
});

test('two simultaneous picks on a limit-1 message: the second is refused with limit', async () => {
  await seed('normal');
  await updateMessage(db, 'm1', { limit: 1 });
  const message = await getMessage(db, 'm1');
  const member = fakeMember('u1');
  const results = await Promise.all([
    applyPick(ctx(), member, message, addEntryPick(message, 'A'), allow),
    applyPick(ctx(), member, message, addEntryPick(message, 'B'), allow),
  ]);
  assert.deepEqual(results.map((r) => (r.ok ? 'ok' : r.reason)), ['ok', 'limit']);
  assert.deepEqual(heldRoles(member), ['A']);
});

test('the decision uses a forced fetch of the member, not the cached roles', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  member.server.add('A'); // Discord has A; the gateway has not told the cache yet
  const result = await applyPick(ctx(), member, message, toggle(message, 'A'), allow);
  assert.deepEqual([result.ok, result.removed], [true, ['A']]);
  assert.deepEqual(member.guild.members.fetches, [{ user: 'u1', force: true }]);
  assert.deepEqual(heldRoles(member), []);
});

test('a failed member fetch refuses with discord_failed and changes nothing', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  member.guild.members.failFetch = true;
  const result = await quiet(() => applyPick(ctx(), member, message, addEntryPick(message, 'A'), allow));
  assert.deepEqual([result.ok, result.reason], [false, 'discord_failed']);
  assert.equal(member.calls.length, 0);
});

// M1: on a reversed message an unexpected failure must keep the reaction: its removal would grant the role.
test('an unexpected failure keeps the reaction on a reversed message and clears it elsewhere', async () => {
  const reversed = await seed('reversed', 'm1');
  const normal = await seed('normal', 'm2');
  const boom = { botCanGive: () => { throw new Error('boom'); } };
  const r = await quiet(() => applyPick(ctx(), fakeMember('u1'), reversed, { kind: 'entry', entry: reversed.entries[0], action: 'remove' }, boom));
  const n = await quiet(() => applyPick(ctx(), fakeMember('u1'), normal, addEntryPick(normal, 'A'), boom));
  assert.deepEqual([r.reason, r.clearReaction], ['discord_failed', false]);
  assert.deepEqual([n.reason, n.clearReaction], ['discord_failed', true]);
});

test('a failed member fetch on a reversed message keeps the reaction', async () => {
  const message = await seed('reversed');
  const member = fakeMember('u1');
  member.guild.members.failFetch = true;
  const result = await quiet(() => applyPick(ctx(), member, message, addEntryPick(message, 'A'), allow));
  assert.deepEqual([result.reason, result.clearReaction], ['discord_failed', false]);
});

test('the binding table is read only for a binding message', async () => {
  const message = await seed('normal');
  const member = fakeMember('u1');
  const noDb = { db: { query: async () => { throw new Error('no query expected'); } } };
  const result = await applyPick(noDb, member, message, addEntryPick(message, 'A'), allow);
  assert.equal(result.ok, true);
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
  assert.deepEqual(heldRoles(m1), ['A']);
  assert.deepEqual(heldRoles(m2), ['A']);
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
  assert.deepEqual(heldRoles(member), []);
  assert.deepEqual(member.calls, [['put', 'A'], ['delete', 'A']]);
});

test('logRoleDanger puts the message id and role mention into the localized text', async () => {
  let sent;
  await logRoleDanger({}, 'g1', 'en', { messageId: 'm42', roleId: 'r7' }, { sendLog: async (c, g, ev, embed) => { sent = embed; } });
  assert.match(sent.description, /m42/);
  assert.match(sent.description, /<@&r7>/);
  assert.equal(sent.fields, undefined);
});
