import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../../src/features/panel/index.js';
import { getFeature, setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings'); });
after(async () => { await db.end(); });

const { execute } = commands[0];

function interaction({ sub, role, manage = false, roles = [] }) {
  const replies = [];
  return {
    replies,
    guildId: 'g1',
    inGuild: () => true,
    member: {
      guild: { id: 'g1' },
      permissions: { has: (p) => manage && p === 'ManageGuild' },
      roles: { cache: { has: (id) => roles.includes(id) } },
    },
    options: { getSubcommand: () => sub, getRole: () => role },
    reply: async (p) => { replies.push(p); },
  };
}

const managerRole = async () => (await getFeature(db, 'g1', 'panel')).config.managerRoleId;

test('@everyone cannot be the manager role', async () => {
  const i = interaction({ sub: 'manager-role', role: { id: 'g1', name: '@everyone', managed: false }, manage: true });
  await execute(i, { db });
  assert.equal(i.replies[0].content, t('en', 'panel.everyoneRole'));
  assert.equal(await managerRole(), undefined);
});

test('a managed (bot or integration) role cannot be the manager role', async () => {
  const i = interaction({ sub: 'manager-role', role: { id: 'R9', name: 'SomeBot', managed: true }, manage: true });
  await execute(i, { db });
  assert.equal(i.replies[0].content, t('en', 'panel.managedRole'));
  assert.equal(await managerRole(), undefined);
});

test('Manage Server can set a normal manager role', async () => {
  const i = interaction({ sub: 'manager-role', role: { id: 'R1', name: 'Staff', managed: false }, manage: true });
  await execute(i, { db });
  assert.equal(await managerRole(), 'R1');
});

test('a manager-role holder without Manage Server cannot change or clear the manager role', async () => {
  await setFeature(db, 'g1', 'panel', { config: { managerRoleId: 'R1' } });
  const set = interaction({ sub: 'manager-role', role: { id: 'R2', name: 'Other', managed: false }, roles: ['R1'] });
  await execute(set, { db });
  assert.equal(set.replies[0].content, t('en', 'panel.needManageServer'));
  const clear = interaction({ sub: 'manager-role-clear', roles: ['R1'] });
  await execute(clear, { db });
  assert.equal(clear.replies[0].content, t('en', 'panel.needManageServer'));
  assert.equal(await managerRole(), 'R1');
});

test('a manager-role holder can still open the overview', async () => {
  await setFeature(db, 'g1', 'panel', { config: { managerRoleId: 'R1' } });
  const i = interaction({ sub: 'overview', roles: ['R1'] });
  await execute(i, { db });
  assert.ok(i.replies[0].embeds);
});
