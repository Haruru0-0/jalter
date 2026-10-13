import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmbedName, createEmbed, getEmbed, saveEmbed, listEmbeds, deleteEmbed,
} from '../../src/features/embeds/store.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE embeds'); });
after(async () => { await db.end(); });

test('normalizeEmbedName trims, lower-cases and rejects bad names', () => {
  assert.equal(normalizeEmbedName('  Rules_1 '), 'rules_1');
  assert.equal(normalizeEmbedName('a'.repeat(16)), 'a'.repeat(16));
  for (const bad of ['', '   ', 'has space', 'a'.repeat(17), 'weird!', undefined]) {
    assert.equal(normalizeEmbedName(bad), null, String(bad));
  }
});

test('createEmbed makes an empty embed once', async () => {
  assert.equal(await createEmbed(db, 'g1', 'rules'), true);
  assert.equal(await createEmbed(db, 'g1', 'rules'), false);
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), {});
});

test('saveEmbed updates an existing embed and never creates one', async () => {
  assert.equal(await saveEmbed(db, 'g1', 'nope', { title: 'x' }), false);
  await createEmbed(db, 'g1', 'rules');
  assert.equal(await saveEmbed(db, 'g1', 'rules', { title: 'Rules', color: '#5865F2' }), true);
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), { title: 'Rules', color: '#5865F2' });
});

test('embeds are per guild, listed sorted, and deletable', async () => {
  await createEmbed(db, 'g1', 'b');
  await createEmbed(db, 'g1', 'a');
  await createEmbed(db, 'g2', 'c');
  assert.deepEqual(await listEmbeds(db, 'g1'), ['a', 'b']);
  assert.equal(await getEmbed(db, 'g2', 'a'), null);
  assert.equal(await deleteEmbed(db, 'g1', 'a'), true);
  assert.equal(await deleteEmbed(db, 'g1', 'a'), false);
});
