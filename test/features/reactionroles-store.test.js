import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import {
  createMessage, getMessage, addEntry, updateMessage, removeEntry, deleteMessage,
  deleteMessagesInChannel, deleteGuildMessages, clearEntries, deleteEntriesForRole,
  setBinding, getBinding, clearMemberBindings, removeRoleFromLists,
} from '../../src/features/reactionroles/store.js';

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

const base = { guildId: 'g1', messageId: 'm1', channelId: 'c1', style: 'reactions', createdBy: 'u1' };

test('createMessage then getMessage returns the defaults', async () => {
  await createMessage(db, base);
  const m = await getMessage(db, 'm1');
  assert.equal(m.type, 'normal');
  assert.equal(m.limit, null);
  assert.deepEqual(m.whitelist, []);
  assert.deepEqual(m.entries, []);
  assert.equal(m.selfdestructAt, null);
});

test('addEntry numbers positions and rejects duplicate roles and emoji', async () => {
  await createMessage(db, base);
  const a = await addEntry(db, 'm1', { roleId: 'r1', emoji: '😀' });
  const b = await addEntry(db, 'm1', { roleId: 'r2', emoji: '👍' });
  assert.deepEqual([a.position, b.position], [0, 1]);
  assert.equal(await addEntry(db, 'm1', { roleId: 'r1', emoji: '🎉' }), 'duplicate');
  assert.equal(await addEntry(db, 'm1', { roleId: 'r3', emoji: '😀' }), 'duplicate');
  assert.equal(await addEntry(db, 'nope', { roleId: 'r9', emoji: '🎉' }), 'missing');
});

test('addEntry refuses the 21st entry', async () => {
  await createMessage(db, { ...base, style: 'buttons' });
  for (let i = 0; i < 20; i += 1) assert.equal(typeof (await addEntry(db, 'm1', { roleId: `r${i}`, label: `L${i}` })), 'object');
  assert.equal(await addEntry(db, 'm1', { roleId: 'r20', label: 'L20' }), 'full');
});

test('two concurrent adds cannot pass the cap', async () => {
  await createMessage(db, { ...base, style: 'buttons' });
  for (let i = 0; i < 19; i += 1) await addEntry(db, 'm1', { roleId: `r${i}`, label: `L${i}` });
  const results = await Promise.all([
    addEntry(db, 'm1', { roleId: 'x1', label: 'X1' }),
    addEntry(db, 'm1', { roleId: 'x2', label: 'X2' }),
  ]);
  assert.equal(results.filter((r) => r === 'full').length, 1);
});

test('updateMessage changes fields; an unknown message returns false', async () => {
  await createMessage(db, base);
  assert.equal(await updateMessage(db, 'm1', { type: 'unique', limit: 2, whitelist: ['w'], blacklist: ['b'], selfdestructAt: new Date(0) }), true);
  const m = await getMessage(db, 'm1');
  assert.deepEqual([m.type, m.limit, m.whitelist, m.blacklist], ['unique', 2, ['w'], ['b']]);
  assert.equal(await updateMessage(db, 'nope', { type: 'verify' }), false);
  assert.equal(await updateMessage(db, 'm1', {}), false);
});

test('deleteMessage cascades entries and bindings; removeEntry removes one', async () => {
  await createMessage(db, base);
  await addEntry(db, 'm1', { roleId: 'r1', emoji: '😀' });
  await addEntry(db, 'm1', { roleId: 'r2', emoji: '👍' });
  await setBinding(db, { guildId: 'g1', messageId: 'm1', userId: 'u2', roleId: 'r1' });
  assert.equal(await removeEntry(db, 'm1', 'r1'), true);
  assert.equal((await getMessage(db, 'm1')).entries.length, 1);
  assert.equal(await deleteMessage(db, 'm1'), true);
  assert.equal(await getBinding(db, 'm1', 'u2'), null);
});

test('deleteEntriesForRole returns each affected message once', async () => {
  await createMessage(db, base);
  await createMessage(db, { ...base, messageId: 'm2' });
  await addEntry(db, 'm1', { roleId: 'r1', emoji: '😀' });
  await addEntry(db, 'm2', { roleId: 'r1', emoji: '😀' });
  assert.deepEqual((await deleteEntriesForRole(db, 'g1', 'r1')).sort(), ['m1', 'm2']);
});

test('bindings are one per member and message, and clearMemberBindings is per guild', async () => {
  await createMessage(db, base);
  await setBinding(db, { guildId: 'g1', messageId: 'm1', userId: 'u2', roleId: 'r1' });
  await setBinding(db, { guildId: 'g1', messageId: 'm1', userId: 'u2', roleId: 'r2' });
  assert.equal(await getBinding(db, 'm1', 'u2'), 'r1');
  await clearMemberBindings(db, 'g2', 'u2');
  assert.equal(await getBinding(db, 'm1', 'u2'), 'r1');
  await clearMemberBindings(db, 'g1', 'u2');
  assert.equal(await getBinding(db, 'm1', 'u2'), null);
});

test('deleteMessagesInChannel and deleteGuildMessages return the deleted ids', async () => {
  await createMessage(db, base);
  await createMessage(db, { ...base, messageId: 'm2' });
  await createMessage(db, { ...base, messageId: 'm3', channelId: 'c2' });
  assert.deepEqual((await deleteMessagesInChannel(db, 'g1', 'c1')).sort(), ['m1', 'm2']);
  await createMessage(db, { ...base, messageId: 'm4', channelId: 'c2' });
  assert.deepEqual((await deleteGuildMessages(db, 'g1')).sort(), ['m3', 'm4']);
});

test('clearEntries removes the entries of one message and keeps the message', async () => {
  await createMessage(db, base);
  await createMessage(db, { ...base, messageId: 'm2' });
  await addEntry(db, 'm1', { roleId: 'r1', label: 'A' });
  await addEntry(db, 'm1', { roleId: 'r2', label: 'B' });
  await addEntry(db, 'm2', { roleId: 'r1', label: 'A' });
  assert.equal(await clearEntries(db, 'm1'), 2);
  assert.equal((await getMessage(db, 'm1')).entries.length, 0);
  assert.equal((await getMessage(db, 'm2')).entries.length, 1);
  assert.equal(await clearEntries(db, 'm1'), 0);
});

test('removeRoleFromLists strips the role from both lists of every message of that guild only', async () => {
  await createMessage(db, base);
  await createMessage(db, { ...base, messageId: 'm2' });
  await createMessage(db, { ...base, guildId: 'g2', messageId: 'm3' });
  await updateMessage(db, 'm1', { whitelist: ['r1', 'r2'], blacklist: ['r1'] });
  await updateMessage(db, 'm2', { blacklist: ['r3', 'r1'] });
  await updateMessage(db, 'm3', { whitelist: ['r1'] });
  await removeRoleFromLists(db, 'g1', 'r1');
  const [m1, m2, m3] = await Promise.all(['m1', 'm2', 'm3'].map((id) => getMessage(db, id)));
  assert.deepEqual([m1.whitelist, m1.blacklist, m2.whitelist, m2.blacklist, m3.whitelist], [['r2'], [], [], ['r3'], ['r1']]);
});
