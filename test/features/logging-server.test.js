import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { events } from '../../src/features/logging/handlers-server.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

const handler = (name) => events.find((e) => e.name === name).execute;

test('deleting a configured log channel is still logged', async () => {
  const sent = [];
  const target = { isTextBased: () => true, send: async (p) => { sent.push(p); } };
  const ctx = { db, client: { channels: { fetch: async () => target } } };
  await setFeature(db, 'g1', 'logging', { enabled: true, config: { channels: { default: 'LOG', server: 'LOG' } } });
  const guild = { id: 'g1', fetchAuditLogs: async () => { throw new Error('no'); } };
  await handler('channelDelete')(ctx, { id: 'LOG', guildId: 'g1', guild, name: 'logs' });
  assert.equal(sent.length, 1);
});
