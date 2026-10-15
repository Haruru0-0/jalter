import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { sendLog } from '../../src/features/logging/send-log.js';
import { setFeature, getFeature } from '../../src/db/settings.js';
import { resetBackoff } from '../../src/core/auto-channel.js';
import { testDb } from '../helpers/db.js';

let db;
let warn;
let warnings;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings');
  resetBackoff();
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
  const deleted = [];
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
          delete: async () => { deleted.push(id); channels.delete(id); },
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
  return { ctx: { db, client }, created, sent, channels, deleted };
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

test('after a failed creation, later events within 10 minutes make no create call and return null', async () => {
  let t = 1_000_000;
  resetBackoff(() => t);
  const w = world({ fail: true });
  let attempts = 0;
  const guild = w.ctx.client.guilds.cache.get('g1');
  const create = guild.channels.create;
  guild.channels.create = async (o) => { attempts += 1; return create(o); };
  await enable();
  await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  const first = attempts;
  t += 9 * 60 * 1000;
  assert.equal(await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' }), null);
  assert.equal(attempts, first);
  assert.equal(warnings.length, 1);
  t += 2 * 60 * 1000;
  await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  assert.ok(attempts > first);
});

test('the backoff is per category and a success is never delayed', async () => {
  let t = 1_000_000;
  resetBackoff(() => t);
  const w = world();
  await enable();
  const guild = w.ctx.client.guilds.cache.get('g1');
  const create = guild.channels.create;
  let fail = true;
  guild.channels.create = async (o) => { if (fail) throw new Error('nope'); return create(o); };
  await sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' });
  fail = false;
  assert.ok(await sendLog(w.ctx, 'g1', 'roleCreate', embed, { sourceChannelId: 'x' }));
  assert.ok(await sendLog(w.ctx, 'g1', 'roleCreate', embed, { sourceChannelId: 'x' }));
  assert.equal(w.created.filter((c) => c.type === 0).length, 1);
});

test('two categories at once keep both channels and create one Logs category', async () => {
  const w = world();
  await enable();
  await Promise.all([
    sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' }),
    sendLog(w.ctx, 'g1', 'roleCreate', embed, { sourceChannelId: 'x' }),
    sendLog(w.ctx, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' }),
  ]);
  const { config } = await getFeature(db, 'g1', 'logging');
  assert.ok(config.channels.messages);
  assert.ok(config.channels.server);
  assert.equal(w.created.filter((c) => c.type === 4).length, 1);
  assert.equal(w.created.filter((c) => c.type === 0).length, 2);
  assert.equal(config.categoryId, w.created.find((c) => c.type === 4).id);
});

test('if saving fails after creation, the new channel and category are deleted and nothing throws', async () => {
  const w = world();
  await enable();
  const original = db.query.bind(db);
  const proxy = { ...w.ctx, db: new Proxy(db, { get: (t, k) => (k === 'query'
    ? (sql, ...a) => (/INSERT/i.test(String(sql)) ? Promise.reject(new Error('db down')) : original(sql, ...a))
    : t[k]) }) };
  assert.equal(await sendLog(proxy, 'g1', 'messageDelete', embed, { sourceChannelId: 'x' }), null);
  assert.equal(w.deleted.length, 2);
});
