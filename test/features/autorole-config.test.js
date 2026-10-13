import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, readConfig, addRole, removeRole, addTimed, removeTimed,
  addBlacklist, removeBlacklist, setReassign, isValidRoleId, pruneRoles,
} from '../../src/features/autorole/config.js';

const ids = (n, p = 'r') => Array.from({ length: n }, (_, i) => `${p}${i}`);

test('readConfig defaults and legacy fold', () => {
  assert.deepEqual(readConfig({}), { roles: [], botRoles: [], timed: [], reassign: false, blacklist: [] });
  const c = readConfig({ humanRoleId: 'H', botRoleId: 'B' });
  assert.deepEqual(c.roles, ['H']);
  assert.deepEqual(c.botRoles, ['B']);
  assert.deepEqual(readConfig({ roles: ['X'], humanRoleId: 'H' }).roles, ['X']);
});

test('addRole: exists, full, independent lists, legacy dropped', () => {
  const a = addRole({ humanRoleId: 'H' }, 'humans', 'R');
  assert.equal(a.ok, true);
  assert.deepEqual(a.config.roles, ['H', 'R']);
  assert.equal('humanRoleId' in a.config, false);
  assert.deepEqual(addRole(a.config, 'humans', 'R'), { ok: false, reason: 'exists' });
  const b = addRole(a.config, 'bots', 'R');
  assert.equal(b.ok, true);
  assert.deepEqual(b.config.botRoles, ['R']);
  let cfg = { roles: ids(10) };
  assert.deepEqual(addRole(cfg, 'humans', 'new'), { ok: false, reason: 'full' });
  assert.equal(LIMITS.roles, 10);
});

test('removeRole humans, bots, both, missing', () => {
  const cfg = { roles: ['a', 'b'], botRoles: ['b'] };
  assert.deepEqual(removeRole(cfg, 'humans', 'b').config.roles, ['a']);
  assert.deepEqual(removeRole(cfg, 'humans', 'b').config.botRoles, ['b']);
  assert.deepEqual(removeRole(cfg, 'bots', 'b').config.botRoles, []);
  const both = removeRole(cfg, 'both', 'b').config;
  assert.deepEqual([both.roles, both.botRoles], [['a'], []]);
  assert.equal(removeRole({ roles: ['a'], botRoles: ['c'] }, 'both', 'c').ok, true);
  assert.deepEqual(removeRole(cfg, 'both', 'zzz'), { ok: false, reason: 'missing' });
  assert.deepEqual(removeRole(cfg, 'bots', 'a'), { ok: false, reason: 'missing' });
});

test('timed roles: add, update, cap, remove', () => {
  const a = addTimed({}, 'T', 600);
  assert.deepEqual(a.config.timed, [{ roleId: 'T', seconds: 600 }]);
  const u = addTimed(a.config, 'T', 900);
  assert.equal(u.ok, true);
  assert.deepEqual(u.config.timed, [{ roleId: 'T', seconds: 900 }]);
  const full = { timed: ids(10).map((roleId) => ({ roleId, seconds: 60 })) };
  assert.deepEqual(addTimed(full, 'new', 60), { ok: false, reason: 'full' });
  assert.equal(addTimed(full, 'r3', 120).ok, true);
  assert.deepEqual(removeTimed(u.config, 'T').config.timed, []);
  assert.deepEqual(removeTimed(u.config, 'nope'), { ok: false, reason: 'missing' });
});

test('blacklist: add, exists, cap, remove', () => {
  const a = addBlacklist({}, 'x');
  assert.deepEqual(a.config.blacklist, ['x']);
  assert.deepEqual(addBlacklist(a.config, 'x'), { ok: false, reason: 'exists' });
  assert.deepEqual(addBlacklist({ blacklist: ids(25) }, 'new'), { ok: false, reason: 'full' });
  assert.equal(LIMITS.blacklist, 25);
  assert.deepEqual(removeBlacklist(a.config, 'x').config.blacklist, []);
  assert.deepEqual(removeBlacklist(a.config, 'y'), { ok: false, reason: 'missing' });
});

test('setReassign', () => {
  assert.equal(setReassign({ roles: ['a'] }, true).reassign, true);
  assert.equal(setReassign({ reassign: true }, false).reassign, false);
});

test('isValidRoleId rejects @everyone and managed roles', () => {
  assert.equal(isValidRoleId({ id: 'G', managed: false }, 'G'), false);
  assert.equal(isValidRoleId({ id: 'R', managed: true }, 'G'), false);
  assert.equal(isValidRoleId({ id: 'R', managed: false }, 'G'), true);
});

test('helpers never mutate their input', () => {
  const make = () => ({
    humanRoleId: 'H', roles: ['a'], botRoles: ['b'], timed: [{ roleId: 't', seconds: 60 }],
    blacklist: ['x'], reassign: false,
  });
  const snapshot = JSON.stringify(make());
  const calls = [
    (c) => readConfig(c),
    (c) => addRole(c, 'humans', 'n'),
    (c) => addRole(c, 'bots', 'n'),
    (c) => removeRole(c, 'both', 'a'),
    (c) => addTimed(c, 't', 120),
    (c) => addTimed(c, 'n', 120),
    (c) => removeTimed(c, 't'),
    (c) => addBlacklist(c, 'n'),
    (c) => removeBlacklist(c, 'x'),
    (c) => setReassign(c, true),
  ];
  for (const call of calls) {
    const c = make();
    call(c);
    assert.equal(JSON.stringify(c), snapshot);
  }
});

test('readConfig ignores null legacy keys', () => {
  const c = readConfig({ roles: [], botRoles: [], humanRoleId: null, botRoleId: null });
  assert.deepEqual([c.roles, c.botRoles], [[], []]);
});

test('readConfig gives empty lists when arrays are absent and legacy keys are null', () => {
  const c = readConfig({ humanRoleId: null, botRoleId: null });
  assert.deepEqual([c.roles, c.botRoles], [[], []]);
});

test('pruneRoles drops missing ids everywhere and folds legacy keys', () => {
  const keep = (id) => id !== 'x';
  const c = pruneRoles({ humanRoleId: 'x', botRoles: ['a', 'x'], blacklist: ['x', 'b'],
    timed: [{ roleId: 'x', seconds: 60 }, { roleId: 't', seconds: 60 }], reassign: true }, keep);
  assert.deepEqual(c, { roles: [], botRoles: ['a'], timed: [{ roleId: 't', seconds: 60 }], reassign: true, blacklist: ['b'] });
});
