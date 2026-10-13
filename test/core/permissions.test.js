import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { canManage } from '../../src/core/permissions.js';
import { setFeature } from '../../src/db/settings.js';
import { testDb } from '../helpers/db.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });

const member = ({ manage = false, roles = [] } = {}) => ({
  guild: { id: 'g1' },
  permissions: { has: (p) => manage && p === 'ManageGuild' },
  roles: { cache: { has: (id) => roles.includes(id) } },
});

test('Manage Server can manage', async () => {
  assert.equal(await canManage(db, member({ manage: true })), true);
});

test('a plain member cannot', async () => {
  assert.equal(await canManage(db, member()), false);
});

test('the configured manager role can; other roles cannot', async () => {
  await setFeature(db, 'g1', 'panel', { config: { managerRoleId: 'R1' } });
  assert.equal(await canManage(db, member({ roles: ['R1'] })), true);
  assert.equal(await canManage(db, member({ roles: ['R2'] })), false);
});
