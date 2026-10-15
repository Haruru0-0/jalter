import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, MAX_PERMITTED, readConfig, addPermittedRole, removePermittedRole } from '../../src/features/moderation/config.js';

test('readConfig fills defaults on empty input', () => {
  assert.deepEqual(readConfig({}), DEFAULTS);
  assert.deepEqual(readConfig(), DEFAULTS);
  assert.deepEqual(readConfig(null), DEFAULTS);
  assert.deepEqual(DEFAULTS, {
    reasonRequired: true, dm: true, timeoutDefaultSeconds: 600, banDeleteDays: 0, muteRoleId: null, permittedRoles: [],
  });
});

test('readConfig keeps valid values', () => {
  const c = readConfig({ reasonRequired: false, dm: false, timeoutDefaultSeconds: 60, banDeleteDays: 7, muteRoleId: 'M', permittedRoles: ['a'] });
  assert.deepEqual(c, { reasonRequired: false, dm: false, timeoutDefaultSeconds: 60, banDeleteDays: 7, muteRoleId: 'M', permittedRoles: ['a'] });
  assert.equal(readConfig({ timeoutDefaultSeconds: 2_419_200 }).timeoutDefaultSeconds, 2_419_200);
});

test('readConfig replaces invalid values with defaults', () => {
  const c = readConfig({
    reasonRequired: 'yes', dm: 1, timeoutDefaultSeconds: 59, banDeleteDays: 8, muteRoleId: 5, permittedRoles: 'x',
  });
  assert.deepEqual(c, DEFAULTS);
  assert.equal(readConfig({ timeoutDefaultSeconds: 2_419_201 }).timeoutDefaultSeconds, 600);
  assert.equal(readConfig({ banDeleteDays: -1 }).banDeleteDays, 0);
  assert.equal(readConfig({ banDeleteDays: 1.5 }).banDeleteDays, 0);
  assert.equal(readConfig({ timeoutDefaultSeconds: NaN }).timeoutDefaultSeconds, 600);
  assert.equal(readConfig({ timeoutDefaultSeconds: '600' }).timeoutDefaultSeconds, 600);
  assert.equal(readConfig({ muteRoleId: '' }).muteRoleId, null);
});

test('readConfig cleans, de-duplicates and caps permittedRoles', () => {
  assert.deepEqual(readConfig({ permittedRoles: ['a', 'a', 5, '', 'b'] }).permittedRoles, ['a', 'b']);
  const many = Array.from({ length: 15 }, (_, i) => `r${i}`);
  assert.deepEqual(readConfig({ permittedRoles: many }).permittedRoles, many.slice(0, MAX_PERMITTED));
});

test('addPermittedRole', () => {
  const r = addPermittedRole({}, 'a');
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.permittedRoles, ['a']);
  const input = { permittedRoles: ['a'] };
  assert.deepEqual(addPermittedRole(input, 'a'), { ok: false, reason: 'exists' });
  const next = addPermittedRole(input, 'b');
  assert.deepEqual(next.config.permittedRoles, ['a', 'b']);
  assert.deepEqual(input.permittedRoles, ['a']);
  const full = Array.from({ length: MAX_PERMITTED }, (_, i) => `r${i}`);
  assert.deepEqual(addPermittedRole({ permittedRoles: full }, 'extra'), { ok: false, reason: 'full' });
  assert.equal(addPermittedRole({ permittedRoles: full.slice(1) }, 'extra').ok, true);
});

test('removePermittedRole', () => {
  const input = { permittedRoles: ['a', 'b'] };
  const r = removePermittedRole(input, 'a');
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.permittedRoles, ['b']);
  assert.deepEqual(input.permittedRoles, ['a', 'b']);
  assert.deepEqual(removePermittedRole(input, 'zzz'), { ok: false, reason: 'missing' });
});
