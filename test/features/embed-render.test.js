import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmbedPayload } from '../../src/features/embeds/render.js';

const noDb = { query: async () => ({ rows: [] }) };
const ctx = { db: noDb, client: {} };
const vars = { user_name: 'Sam', user_avatar: 'https://a.test/a.png', server_icon: '', server_name: 'Home' };

test('placeholders in text and image parts are rendered and images resolved', async () => {
  const { embeds } = await buildEmbedPayload(ctx, 'g1', {
    title: 'Hi {user_name}', author: { text: '{user_name}', icon: '{user_avatar}' },
    thumbnail: '{server_icon}', image: 'https://a.test/i.png', timestamp: true,
  }, vars, { now: 0 });
  assert.equal(embeds[0].title, 'Hi Sam');
  assert.deepEqual(embeds[0].author, { name: 'Sam', icon_url: 'https://a.test/a.png' });
  assert.equal(embeds[0].thumbnail, undefined);               // empty after rendering = no image
  assert.deepEqual(embeds[0].image, { url: 'https://a.test/i.png' });
  assert.equal(embeds[0].timestamp, '1970-01-01T00:00:00.000Z');
});

test('an unknown stored image name throws image-not-found and nothing is built', async () => {
  await assert.rejects(buildEmbedPayload(ctx, 'g1', { title: 't', image: 'missing' }, vars), /image-not-found/);
});

test('a rendered embed that breaks a limit throws embed-invalid with the errors', async () => {
  await assert.rejects(
    buildEmbedPayload(ctx, 'g1', { title: '{user_name}' }, { user_name: 'x'.repeat(300) }),
    (err) => err.message === 'embed-invalid' && err.errors.includes('embeds.err.titleTooLong'),
  );
});

test('an empty embed is refused', async () => {
  await assert.rejects(buildEmbedPayload(ctx, 'g1', {}, vars),
    (err) => err.message === 'embed-invalid' && err.errors.includes('embeds.err.empty'));
});
