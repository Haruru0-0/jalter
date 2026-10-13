import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { saveTemplate, getTemplate, listTemplates, deleteTemplate } from '../../src/features/embeds/templates.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE embed_templates'); });
after(async () => { await db.end(); });

test('save then get returns the same spec', async () => {
  const spec = { title: 'Rules', color: '#5865F2' };
  await saveTemplate(db, 'g1', 'rules', spec);
  assert.deepEqual(await getTemplate(db, 'g1', 'rules'), spec);
});

test('saving the same name twice keeps one row with the latest spec', async () => {
  await saveTemplate(db, 'g1', 'a', { title: 'one' });
  await saveTemplate(db, 'g1', 'a', { title: 'two' });
  assert.deepEqual(await listTemplates(db, 'g1'), ['a']);
  assert.equal((await getTemplate(db, 'g1', 'a')).title, 'two');
});

test('templates are per guild and delete reports whether it removed one', async () => {
  await saveTemplate(db, 'g1', 'a', { title: 'x' });
  assert.deepEqual(await listTemplates(db, 'g2'), []);
  assert.equal(await deleteTemplate(db, 'g1', 'a'), true);
  assert.equal(await deleteTemplate(db, 'g1', 'a'), false);
  assert.equal(await getTemplate(db, 'g1', 'a'), null);
});
