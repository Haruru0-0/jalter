import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { autocompleteEmbed } from '../../src/features/embeds/index.js';
import { createEmbed } from '../../src/features/embeds/store.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE embeds'); });
after(async () => { await db.end(); });

const ctx = () => ({ db, client: {} });

function fake({ focused = { name: 'embed', value: '' }, manage = true, guildId = 'g1' } = {}) {
  const responses = [];
  return {
    responses,
    guildId,
    member: { guild: { id: guildId }, permissions: { has: () => manage }, roles: { cache: new Map() } },
    options: { getFocused: (full) => (full ? focused : focused.value) },
    respond: async (choices) => { responses.push(choices); },
  };
}

test('suggests the saved embed names for the embed option', async () => {
  for (const name of ['rules', 'welcome', 'news']) await createEmbed(db, 'g1', name);
  const i = fake();
  await autocompleteEmbed(i, ctx());
  assert.deepEqual(i.responses[0], [
    { name: 'news', value: 'news' }, { name: 'rules', value: 'rules' }, { name: 'welcome', value: 'welcome' },
  ]);
});

test('filters by what has been typed, ignoring case', async () => {
  for (const name of ['rules', 'welcome', 'wel_two']) await createEmbed(db, 'g1', name);
  const i = fake({ focused: { name: 'embed', value: 'WEL' } });
  await autocompleteEmbed(i, ctx());
  assert.deepEqual(i.responses[0].map((c) => c.value).sort(), ['wel_two', 'welcome']);
});

test('shows at most 25 suggestions', async () => {
  for (let n = 0; n < 30; n += 1) await createEmbed(db, 'g1', `e${String(n).padStart(2, '0')}`);
  const i = fake();
  await autocompleteEmbed(i, ctx());
  assert.equal(i.responses[0].length, 25);
});

test('only this server is listed', async () => {
  await createEmbed(db, 'g1', 'mine');
  await createEmbed(db, 'g2', 'theirs');
  const i = fake();
  await autocompleteEmbed(i, ctx());
  assert.deepEqual(i.responses[0].map((c) => c.value), ['mine']);
});

test('members who cannot manage the bot see no suggestions', async () => {
  await createEmbed(db, 'g1', 'rules');
  const i = fake({ manage: false });
  await autocompleteEmbed(i, ctx());
  assert.deepEqual(i.responses[0], []);
});

test('other options and direct messages get no suggestions', async () => {
  await createEmbed(db, 'g1', 'rules');
  const other = fake({ focused: { name: 'name', value: '' } });
  await autocompleteEmbed(other, ctx());
  assert.deepEqual(other.responses[0], []);
  const dm = fake();
  dm.guildId = null;
  await autocompleteEmbed(dm, ctx());
  assert.deepEqual(dm.responses[0], []);
});
