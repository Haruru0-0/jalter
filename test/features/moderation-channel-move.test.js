import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { moveChannelId, mediaHoldsChannel } from '../../src/features/moderation/channel-move.js';
import { setFeature, getFeature } from '../../src/db/settings.js';
import { resetDb } from '../../src/db/index.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); });
after(async () => { await db.end(); });

const G = 'g1';
const OLD = '111';
const NEW = '222';

test('replaces ids in logging channels and ignore channels', async () => {
  await setFeature(db, G, 'logging', {
    enabled: true,
    config: {
      channels: { default: OLD, join: OLD, voice: '999' },
      ignore: { channels: [OLD, '888'], members: [OLD] },
      toggles: { a: true },
    },
  });
  const r = await moveChannelId(db, G, OLD, NEW);
  assert.deepEqual(r, { moved: 1 });
  const { config, enabled } = await getFeature(db, G, 'logging');
  assert.equal(enabled, true);
  assert.deepEqual(config.channels, { default: NEW, join: NEW, voice: '999' });
  assert.deepEqual(config.ignore, { channels: [NEW, '888'], members: [OLD] });
  assert.deepEqual(config.toggles, { a: true });
});

test('replaces channelId for greet, leave, boost and media', async () => {
  for (const k of ['greet', 'leave', 'boost', 'media']) {
    await setFeature(db, G, k, { enabled: true, config: { channelId: OLD, extra: k } });
  }
  const r = await moveChannelId(db, G, OLD, NEW);
  assert.deepEqual(r, { moved: 4 });
  for (const k of ['greet', 'leave', 'boost', 'media']) {
    const { config } = await getFeature(db, G, k);
    assert.deepEqual(config, { channelId: NEW, extra: k });
  }
});

test('leaves non-matching ids alone and returns moved 0', async () => {
  await setFeature(db, G, 'greet', { enabled: true, config: { channelId: '555' } });
  await setFeature(db, G, 'logging', { config: { channels: { default: '555' }, ignore: { channels: ['555'] } } });
  assert.deepEqual(await moveChannelId(db, G, OLD, NEW), { moved: 0 });
  assert.equal((await getFeature(db, G, 'greet')).config.channelId, '555');
  assert.deepEqual((await getFeature(db, G, 'logging')).config.ignore.channels, ['555']);
});

test('no settings rows returns moved 0', async () => {
  assert.deepEqual(await moveChannelId(db, G, OLD, NEW), { moved: 0 });
});

test('other guilds are untouched', async () => {
  await setFeature(db, G, 'greet', { config: { channelId: OLD } });
  await setFeature(db, 'g2', 'greet', { config: { channelId: OLD } });
  assert.deepEqual(await moveChannelId(db, G, OLD, NEW), { moved: 1 });
  assert.equal((await getFeature(db, 'g2', 'greet')).config.channelId, OLD);
});

test('a failure rolls back every change', async () => {
  await setFeature(db, G, 'greet', { config: { channelId: OLD } });
  await setFeature(db, G, 'leave', { config: { channelId: OLD } });
  let released = false;
  const wrapped = {
    connect: async () => {
      const client = await db.connect();
      const q = client.query.bind(client);
      return {
        query: async (sql, params) => {
          if (typeof sql === 'string' && sql.startsWith('UPDATE') && params?.[2] === 'leave') {
            throw new Error('boom');
          }
          return q(sql, params);
        },
        release: () => { released = true; client.release(); },
      };
    },
  };
  await assert.rejects(moveChannelId(wrapped, G, OLD, NEW), /boom/);
  assert.equal(released, true);
  assert.equal((await getFeature(db, G, 'greet')).config.channelId, OLD);
  assert.equal((await getFeature(db, G, 'leave')).config.channelId, OLD);
});

test('mediaHoldsChannel', async () => {
  await db.query(
    "INSERT INTO media_items (guild_id, name, channel_id, message_id) VALUES ($1,'a',$2,'m')",
    [G, OLD],
  );
  assert.equal(await mediaHoldsChannel(db, G, OLD), true);
  assert.equal(await mediaHoldsChannel(db, G, NEW), false);
  assert.equal(await mediaHoldsChannel(db, 'g2', OLD), false);
});
