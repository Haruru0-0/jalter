import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_PERMISSIONS, canUseAction, checkTarget, checkDuration } from '../../src/features/moderation/rules.js';

const member = (id, position, { perms = [], roles = [] } = {}) => ({
  id,
  permissions: { has: (p) => perms.includes(p) },
  roles: { highest: { position }, cache: { has: (r) => roles.includes(r) } },
});
const guild = { ownerId: 'owner' };
const bot = member('bot', 10);

test('ACTION_PERMISSIONS maps every action', () => {
  assert.equal(ACTION_PERMISSIONS.kick, 'KickMembers');
  assert.equal(ACTION_PERMISSIONS.ban, 'BanMembers');
  assert.equal(ACTION_PERMISSIONS.unban, 'BanMembers');
  for (const a of ['warn', 'warnings', 'timeout', 'untimeout', 'mute', 'unmute', 'reason']) {
    assert.equal(ACTION_PERMISSIONS[a], 'ModerateMembers');
  }
});

test('canUseAction', () => {
  const cfg = { permittedRoles: ['P'] };
  assert.equal(canUseAction(member('a', 1, { perms: ['KickMembers'] }), 'kick', cfg), true);
  assert.equal(canUseAction(member('a', 1, { perms: ['KickMembers'] }), 'ban', cfg), false);
  assert.equal(canUseAction(member('a', 1, { roles: ['P'] }), 'ban', cfg), true);
  assert.equal(canUseAction(member('a', 1), 'warn', cfg), false);
  assert.equal(canUseAction(member('a', 1, { perms: ['ModerateMembers'] }), 'nuke', cfg), false);
  assert.equal(canUseAction(member('a', 1, { roles: ['P'] }), 'nuke', cfg), false);
  assert.equal(canUseAction(member('a', 1, { roles: ['P'] }), 'toString', cfg), false);
  assert.equal(canUseAction(member('a', 1), 'warn', {}), false);
  assert.equal(canUseAction(member('a', 1, { roles: ['P'] }), 'warn', { permittedRoles: [] }), false);
});

const check = (over) => checkTarget({
  guild, actor: member('actor', 5), target: member('t', 3), targetId: 't', botMember: bot, ...over,
});

test('checkTarget basic refusals', () => {
  assert.deepEqual(check({}), { ok: true });
  assert.deepEqual(check({ targetId: 'owner', target: member('owner', 1) }), { ok: false, reason: 'owner' });
  assert.deepEqual(check({ targetId: 'actor', target: member('actor', 5) }), { ok: false, reason: 'self' });
  assert.deepEqual(check({ targetId: 'bot', target: bot }), { ok: false, reason: 'bot_self' });
});

test('checkTarget hierarchy', () => {
  assert.deepEqual(check({ target: member('t', 5) }), { ok: false, reason: 'actor_hierarchy' });
  assert.deepEqual(check({ target: member('t', 6) }), { ok: false, reason: 'actor_hierarchy' });
  assert.deepEqual(check({ target: member('t', 4) }), { ok: true });
  assert.deepEqual(check({ actor: member('actor', 20), target: member('t', 10) }), { ok: false, reason: 'bot_hierarchy' });
  assert.deepEqual(check({ actor: member('actor', 20), target: member('t', 11) }), { ok: false, reason: 'bot_hierarchy' });
  assert.deepEqual(check({ actor: member('actor', 20), target: member('t', 9) }), { ok: true });
});

test('checkTarget guild owner actor', () => {
  const actor = member('owner', 1);
  assert.deepEqual(checkTarget({ guild, actor, target: member('t', 9), targetId: 't', botMember: bot }), { ok: true });
  assert.deepEqual(checkTarget({ guild, actor, target: member('t', 10), targetId: 't', botMember: bot }), { ok: false, reason: 'bot_hierarchy' });
  assert.deepEqual(checkTarget({ guild, actor, target: bot, targetId: 'bot', botMember: bot }), { ok: false, reason: 'bot_self' });
  assert.deepEqual(checkTarget({ guild, actor, target: actor, targetId: 'owner', botMember: bot }), { ok: false, reason: 'owner' });
});

test('checkTarget with a user not in the server', () => {
  const base = { guild, actor: member('actor', 5), target: null, botMember: bot };
  assert.deepEqual(checkTarget({ ...base, targetId: 'gone' }), { ok: true });
  assert.deepEqual(checkTarget({ ...base, targetId: 'owner' }), { ok: false, reason: 'owner' });
  assert.deepEqual(checkTarget({ ...base, targetId: 'actor' }), { ok: false, reason: 'self' });
  assert.deepEqual(checkTarget({ ...base, targetId: 'bot' }), { ok: false, reason: 'bot_self' });
});

test('checkDuration', () => {
  assert.deepEqual(checkDuration('timeout', 59), { ok: false, reason: 'too_short' });
  assert.deepEqual(checkDuration('timeout', 60), { ok: true });
  assert.deepEqual(checkDuration('timeout', 2_419_200), { ok: true });
  assert.deepEqual(checkDuration('timeout', 2_419_201), { ok: false, reason: 'too_long' });
  assert.deepEqual(checkDuration('ban', 31_536_000), { ok: true });
  assert.deepEqual(checkDuration('ban', 59), { ok: false, reason: 'too_short' });
  assert.deepEqual(checkDuration('mute', 60), { ok: true });
  assert.deepEqual(checkDuration('timeout', null), { ok: true });
  assert.deepEqual(checkDuration('ban', null), { ok: true });
});
