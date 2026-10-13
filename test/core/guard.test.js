import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../../src/core/guard.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

function fakeInteraction({ manage }) {
  const replies = [];
  return {
    replies,
    guildId: 'g1',
    inGuild: () => true,
    member: {
      guild: { id: 'g1' },
      permissions: { has: () => manage },
      roles: { cache: { has: () => false } },
    },
    reply: async (o) => { replies.push(o); },
  };
}

test('guard refuses a non-manager with an ephemeral message', async () => {
  const i = fakeInteraction({ manage: false });
  assert.equal(await guard(i, { db }, 'welcome'), null);
  assert.match(i.replies[0].content, /Manage Server/);
  assert.ok(i.replies[0].flags);
});

test('guard refuses when the feature is off and names the enable command', async () => {
  const i = fakeInteraction({ manage: true });
  assert.equal(await guard(i, { db }, 'embeds'), null);
  assert.match(i.replies[0].content, /\/embed enable/);
});

test('guard names the setup command for features without an enable subcommand', async () => {
  const i = fakeInteraction({ manage: true });
  assert.equal(await guard(i, { db }, 'welcome'), null);
  assert.match(i.replies[0].content, /\/welcome setup/);
});

test('guard returns the language when allowed and enabled', async () => {
  await setFeature(db, 'g1', 'welcome', { enabled: true });
  const i = fakeInteraction({ manage: true });
  assert.equal(await guard(i, { db }, 'welcome'), 'en');
  assert.equal(i.replies.length, 0);
});

test('requireEnabled:false lets a manager through while the feature is off', async () => {
  const i = fakeInteraction({ manage: true });
  assert.equal(await guard(i, { db }, 'media', { requireEnabled: false }), 'en');
});
