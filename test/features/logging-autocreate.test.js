import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendLog } from '../../src/features/logging/send-log.js';
import { setFeature, getFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
let warn;
let warnings;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
  warn = console.warn;
  warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
});
after(async () => { console.warn = warn; await db.end(); });

// A fake client whose guild can create channels and whose channels can be fetched and sent to.
function world({ fail = false, existing = [] } = {}) {
  const channels = new Map(existing.map((id) => [id, { id, isTextBased: () => true, send: async () => ({}) }]));
  const created = [];
  const sent = [];
  const guild = {
    id: 'g1',
    roles: { everyone: { id: 'everyone' } },
    members: { me: { id: 'bot' } },
    channels: {
      create: async (opts) => {
        await new Promise((r) => setTimeout(r, 5));
        if (fail) throw new Error('Missing Permissions');
        const id = `new${created.length + 1}`;
        const ch = {
          id, ...opts, isTextBased: () => opts.type === 0,
          send: async (p) => { sent.push({ id, p }); return { id: 'm', channelId: id }; },
        };
        created.push(ch);
        channels.set(id, ch);
        return ch;
      },
      fetch: async (id) => channels.get(id) ?? null,
    },
  };
  const client = {
    guilds: { cache: new Map([['g1', guild]]), fetch: async () => guild },
    channels: { fetch: async (id) => { const c = channels.get(id); if (!c) throw new Error('Unknown Channel'); return c; } },
  };
  return { ctx: { db, client }, created, sent, channels };
}
const embed = { title: 't' };
const enable = (config = {}) => setFeature(db, 'g1', 'logging', { enabled: true, config });

test('10 concurrent logs with no channel create one channel and one category', async () => {
  const w = world();
  await enable();
  await Promise.all(Array.from({ length: 10 }, () => sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' })));
  const channels = w.created.filter((c) => c.type === 0);
  assert.equal(channels.length, 1);
  assert.equal(channels[0].name, 'messages-logs');
  assert.equal(w.created.filter((c) => c.type === 4).length, 1);
  assert.equal(w.sent.length, 10);
  const { config } = await getFeature(db, 'g1', 'logging');
  assert.equal(config.channels.messages, channels[0].id);
  assert.equal(config.categoryId, w.created.find((c) => c.type === 4).id);
});

test('hidden modAction goes to a mod-logs channel', async () => {
  const w = world();
  await enable();
  await sendLog(w.ctx, 'g1', 'modAction', embed);
  assert.equal(w.created.find((c) => c.type === 0).name, 'mod-logs');
});

test('a chosen category channel or a default channel means nothing is created', async () => {
  const w = world({ existing: ['LOG', 'DEF'] });
  await enable({ channels: { messages: 'LOG' } });
  await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  await enable({ channels: { default: 'DEF' } });
  await sendLog(w.ctx, 'g1', 'roleCreate', embed, { sourceChannelId: 'x' });
  assert.equal(w.created.length, 0);
});

test('a configured channel that was deleted is not recreated', async () => {
  const w = world();
  await enable({ channels: { messages: 'GONE' } });
  await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  assert.equal(w.created.length, 0);
});

test('disabled feature, disabled event and ignored source create nothing', async () => {
  const w = world();
  await sendLog(w.ctx, 'g1', 'messageDelete', embed);
  await enable({ disabledEvents: ['messageDelete'] });
  await sendLog(w.ctx, 'g1', 'messageDelete', embed);
  await enable({ disabledEvents: [], ignore: { channels: ['ign'] } });
  await sendLog(w.ctx, 'g1', 'messageDelete', embed, { ignore: { channelId: 'ign' } });
  assert.equal(w.created.length, 0);
});

test('failed creation returns null, warns once and does not throw', async () => {
  const w = world({ fail: true });
  await enable();
  assert.equal(await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' }), null);
  assert.equal(warnings.length, 1);
});

test('a stored categoryId is reused', async () => {
  const w = world({ existing: ['CAT'] });
  await enable({ categoryId: 'CAT' });
  await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].parent, 'CAT');
});

test('a stored categoryId that is gone gets a new category', async () => {
  const w = world();
  await enable({ categoryId: 'OLD' });
  await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  const cat = w.created.find((c) => c.type === 4);
  assert.ok(cat);
  assert.equal(w.created.find((c) => c.type === 0).parent, cat.id);
  const { config } = await getFeature(db, 'g1', 'logging');
  assert.equal(config.categoryId, cat.id);
});
