import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../../src/features/autoresponder/script/evaluate.js';

const deepFreeze = (o) => {
  if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
};
const flags = (over = {}) => ({ silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null, ...over });
const comp = (over = {}) => ({ version: 1, template: [{ t: 'text', v: 'hi' }], gates: [], actions: [], flags: flags(), ...over });
const member = ({ id = 'u1', roles = [], perms = [] } = {}) => ({
  id,
  roles: { cache: new Map(roles.map((r) => [r, { id: r }])) },
  permissions: { has: (p) => perms.includes(p) },
});
const ctx = (m = member(), over = {}) => ({ member: m, channelId: 'c1', vars: {}, ...over });

test('text-only script runs with its text', () => {
  const p = evaluate(comp(), ctx());
  assert.deepEqual(p, { status: 'run', cooldown: null, text: 'hi', flags: flags(), actions: [], allowedUsers: [] });
});

test('ph parts render from vars; unknown key renders empty', () => {
  const c = comp({ template: [{ t: 'text', v: 'a ' }, { t: 'ph', name: 'user' }, { t: 'text', v: ' b ' }, { t: 'ph', name: 'nope' }] });
  assert.equal(evaluate(c, ctx(member(), { vars: { user: 'Bob' } })).text, 'a Bob b');
});

test('text is trimmed but keeps inner line breaks', () => {
  const c = comp({ template: [{ t: 'text', v: '\n  one\ntwo  \n' }] });
  assert.equal(evaluate(c, ctx()).text, 'one\ntwo');
});

test('cooldown seconds returned, null when absent', () => {
  assert.equal(evaluate(comp({ gates: [{ fn: 'cooldown', seconds: 30 }] }), ctx()).cooldown, 30);
  assert.equal(evaluate(comp(), ctx()).cooldown, null);
});

test('requirerole: any-of passes, none fails with notice', () => {
  const c = comp({ gates: [{ fn: 'requirerole', roleIds: ['r1', 'r2'] }] });
  assert.equal(evaluate(c, ctx(member({ roles: ['r2'] }))).status, 'run');
  assert.deepEqual(evaluate(c, ctx(member())), { status: 'skip', gate: 'role', notice: true });
});

test('requirerole failure with silent has no notice', () => {
  const c = comp({ gates: [{ fn: 'requirerole', roleIds: ['r1'] }], flags: flags({ silent: true }) });
  assert.deepEqual(evaluate(c, ctx()), { status: 'skip', gate: 'role', notice: false });
});

test('denyrole fails on any, no notice', () => {
  const c = comp({ gates: [{ fn: 'denyrole', roleIds: ['r1', 'r2'] }] });
  assert.equal(evaluate(c, ctx(member({ roles: ['x'] }))).status, 'run');
  assert.deepEqual(evaluate(c, ctx(member({ roles: ['r2'] }))), { status: 'skip', gate: 'role', notice: false });
});

test('requireperm / denyperm', () => {
  const req = comp({ gates: [{ fn: 'requireperm', perms: ['ManageMessages', 'BanMembers'] }] });
  assert.equal(evaluate(req, ctx(member({ perms: ['BanMembers'] }))).status, 'run');
  assert.deepEqual(evaluate(req, ctx()), { status: 'skip', gate: 'perm', notice: false });
  const den = comp({ gates: [{ fn: 'denyperm', perms: ['ManageMessages', 'BanMembers'] }] });
  assert.equal(evaluate(den, ctx()).status, 'run');
  assert.deepEqual(evaluate(den, ctx(member({ perms: ['ManageMessages'] }))), { status: 'skip', gate: 'perm', notice: false });
});

test('requirechannel / denychannel', () => {
  const req = comp({ gates: [{ fn: 'requirechannel', channelIds: ['c1', 'c2'] }] });
  assert.equal(evaluate(req, ctx()).status, 'run');
  assert.deepEqual(evaluate(req, ctx(member(), { channelId: 'c9' })), { status: 'skip', gate: 'channel', notice: false });
  const den = comp({ gates: [{ fn: 'denychannel', channelIds: ['c1'] }] });
  assert.equal(evaluate(den, ctx(member(), { channelId: 'c9' })).status, 'run');
  assert.deepEqual(evaluate(den, ctx()), { status: 'skip', gate: 'channel', notice: false });
});

test('requireuser', () => {
  const c = comp({ gates: [{ fn: 'requireuser', userIds: ['u1', 'u2'] }] });
  assert.equal(evaluate(c, ctx()).status, 'run');
  assert.deepEqual(evaluate(c, ctx(member({ id: 'u9' }))), { status: 'skip', gate: 'user', notice: false });
});

test('first failing gate in script order wins', () => {
  const gates = [
    { fn: 'requirechannel', channelIds: ['c9'] },
    { fn: 'requirerole', roleIds: ['r1'] },
  ];
  assert.equal(evaluate(comp({ gates }), ctx()).gate, 'channel');
  assert.equal(evaluate(comp({ gates: gates.slice().reverse() }), ctx()).gate, 'role');
});

test('does not mutate a deep-frozen compiled; actions and flags pass through', () => {
  const actions = [{ fn: 'addrole', roleId: 'r1' }];
  const c = deepFreeze(comp({ actions, gates: [{ fn: 'cooldown', seconds: 5 }], flags: flags({ dm: true }) }));
  const p = evaluate(c, ctx());
  assert.equal(p.status, 'run');
  assert.deepEqual(p.actions, actions);
  assert.deepEqual(p.flags, flags({ dm: true }));
});

const tpl = (...parts) => comp({ template: parts });

test('allowedUsers holds the user mentions the script writer typed, once each', () => {
  const p = evaluate(tpl({ t: 'text', v: 'hey <@456> and <@!789> and <@456> @everyone <@&555>' }), ctx());
  assert.deepEqual(p.allowedUsers, ['456', '789']);
});

test('a mention inside {message_content} or a name placeholder is never allowed', () => {
  const c = tpl({ t: 'ph', name: 'message_content' }, { t: 'text', v: ' by ' }, { t: 'ph', name: 'user_name' });
  const p = evaluate(c, ctx(member(), { vars: { message_content: '<@123> <@!124> @everyone', user_name: '<@125>' } }));
  assert.equal(p.text, '<@123> <@!124> @everyone by <@125>');
  assert.deepEqual(p.allowedUsers, []);
});

test('{user} allows the triggering member', () => {
  const p = evaluate(tpl({ t: 'text', v: 'hi ' }, { t: 'ph', name: 'user' }), ctx(member({ id: 'u7' }), { vars: { user: '<@u7>' } }));
  assert.deepEqual(p.allowedUsers, ['u7']);
});

test('{server_owner} allows the owner the placeholder names, written by the script writer', () => {
  const p = evaluate(tpl({ t: 'ph', name: 'server_owner' }), ctx(member(), { vars: { server_owner: '<@999>' } }));
  assert.deepEqual(p.allowedUsers, ['999']);
});
