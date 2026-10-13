import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { parseImageInput, resolveImage } from '../../src/features/media/images.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE media_items'); });
after(async () => { await db.end(); });

const fakeClient = (fetchMessage) => ({
  channels: { fetch: async () => ({ messages: { fetch: fetchMessage } }) },
});

test('parseImageInput: URL, stored name, and empty input', () => {
  assert.deepEqual(parseImageInput('https://x.io/a.png'), { type: 'url', url: 'https://x.io/a.png' });
  assert.deepEqual(parseImageInput(' logo '), { type: 'stored', name: 'logo' });
  assert.throws(() => parseImageInput('  '), /invalid-image/);
});

test('resolveImage returns a URL ref unchanged', async () => {
  assert.equal(await resolveImage(db, {}, 'g1', { type: 'url', url: 'https://x.io/a.png' }), 'https://x.io/a.png');
});

test('resolveImage fetches a fresh URL for a stored image', async () => {
  await db.query(
    "INSERT INTO media_items (guild_id, name, channel_id, message_id) VALUES ('g1','logo','c1','m1')",
  );
  const client = fakeClient(async () => ({ attachments: new Map([['a', { url: 'https://cdn/fresh.png' }]]) }));
  assert.equal(await resolveImage(db, client, 'g1', { type: 'stored', name: 'logo' }), 'https://cdn/fresh.png');
});

test('resolveImage throws image-not-found for an unknown name', async () => {
  await assert.rejects(resolveImage(db, {}, 'g1', { type: 'stored', name: 'nope' }), /image-not-found/);
});

test('resolveImage throws image-not-found when the message was deleted', async () => {
  await db.query(
    "INSERT INTO media_items (guild_id, name, channel_id, message_id) VALUES ('g1','logo','c1','m1')",
  );
  const client = fakeClient(async () => { throw new Error('Unknown Message'); });
  await assert.rejects(resolveImage(db, client, 'g1', { type: 'stored', name: 'logo' }), /image-not-found/);
});
