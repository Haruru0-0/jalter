import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidePick, decideMenu } from '../../src/features/reactionroles/rules.js';

// Small message factory so each row reads as the business rule, not the shape.
const makeMsg = ({ type = 'normal', entries = [], limit = null, whitelist = [], blacklist = [] } = {}) => ({
  type,
  entries,
  limit,
  whitelist,
  blacklist,
});

const setOf = (...ids) => new Set(ids);

// ── decidePick: normal / reactions ──────────────────────────────────────────
test('normal add of an unheld role adds it', () => {
  const out = decidePick({
    message: makeMsg({ entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: true, add: ['A'], remove: [], clearReaction: false });
});

test('normal remove of a held role removes it', () => {
  const out = decidePick({
    message: makeMsg({ entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'remove',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: true, add: [], remove: ['A'], clearReaction: false });
});

test('normal remove of an unheld role is nothing', () => {
  const out = decidePick({
    message: makeMsg({ entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'remove',
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: false, reason: 'nothing', clearReaction: false });
});

// ── decidePick: normal / toggle ─────────────────────────────────────────────
test('normal toggle on a held role removes it', () => {
  const out = decidePick({
    message: makeMsg({ entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'toggle',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: true, add: [], remove: ['A'], clearReaction: false });
});

test('normal toggle on an unheld role adds it', () => {
  const out = decidePick({
    message: makeMsg({ entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'toggle',
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: true, add: ['A'], remove: [], clearReaction: false });
});

// ── decidePick: unique ──────────────────────────────────────────────────────
test('unique add of B while holding A swaps to B', () => {
  const out = decidePick({
    message: makeMsg({ type: 'unique', entries: [{ roleId: 'A' }, { roleId: 'B' }] }),
    entry: { roleId: 'B' },
    action: 'add',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: true, add: ['B'], remove: ['A'], clearReaction: false });
});

test('unique remove action removes the role', () => {
  const out = decidePick({
    message: makeMsg({ type: 'unique', entries: [{ roleId: 'A' }, { roleId: 'B' }] }),
    entry: { roleId: 'A' },
    action: 'remove',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: true, add: [], remove: ['A'], clearReaction: false });
});

// ── decidePick: verify ──────────────────────────────────────────────────────
test('verify add of an unheld role adds it and asks for reaction clear', () => {
  const out = decidePick({
    message: makeMsg({ type: 'verify', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: true, add: ['A'], remove: [], clearReaction: true });
});

test('verify remove of a held role is nothing and asks for reaction clear', () => {
  const out = decidePick({
    message: makeMsg({ type: 'verify', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'remove',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: false, reason: 'nothing', clearReaction: true });
});

test('verify toggle of a held role is nothing and asks for reaction clear', () => {
  const out = decidePick({
    message: makeMsg({ type: 'verify', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'toggle',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: false, reason: 'nothing', clearReaction: true });
});

// ── decidePick: drop ────────────────────────────────────────────────────────
test('drop add action removes a held role and asks for reaction clear', () => {
  const out = decidePick({
    message: makeMsg({ type: 'drop', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: true, add: [], remove: ['A'], clearReaction: true });
});

test('drop add action on an unheld role is nothing and asks for reaction clear', () => {
  const out = decidePick({
    message: makeMsg({ type: 'drop', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: false, reason: 'nothing', clearReaction: true });
});

// ── decidePick: reversed ────────────────────────────────────────────────────
test('reversed add action removes a held role', () => {
  const out = decidePick({
    message: makeMsg({ type: 'reversed', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: true, add: [], remove: ['A'], clearReaction: false });
});

test('reversed remove action adds an unheld role', () => {
  const out = decidePick({
    message: makeMsg({ type: 'reversed', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'remove',
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: true, add: ['A'], remove: [], clearReaction: false });
});

// ── decidePick: binding ─────────────────────────────────────────────────────
test('binding first pick adds the role and asks for reaction clear', () => {
  const out = decidePick({
    message: makeMsg({ type: 'binding', entries: [{ roleId: 'A' }, { roleId: 'B' }] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf(),
    binding: null,
  });
  assert.deepEqual(out, { ok: true, add: ['A'], remove: [], clearReaction: true });
});

test('binding with a stored binding refuses with bound and asks for reaction clear', () => {
  const out = decidePick({
    message: makeMsg({ type: 'binding', entries: [{ roleId: 'A' }, { roleId: 'B' }] }),
    entry: { roleId: 'B' },
    action: 'add',
    memberRoleIds: setOf(),
    binding: 'A',
  });
  assert.deepEqual(out, { ok: false, reason: 'bound', clearReaction: true });
});

// ── decidePick: lock ────────────────────────────────────────────────────────
test('lock always refuses with locked and asks for reaction clear', () => {
  const out = decidePick({
    message: makeMsg({ type: 'lock', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: false, reason: 'locked', clearReaction: true });
});

test('lock refuses regardless of the held state', () => {
  const out = decidePick({
    message: makeMsg({ type: 'lock', entries: [{ roleId: 'A' }] }),
    entry: { roleId: 'A' },
    action: 'remove',
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: false, reason: 'locked', clearReaction: true });
});

// ── decidePick: check order — blacklist, whitelist ─────────────────────────
test('a blacklisted member is refused with blacklisted and the reaction is cleared on add', () => {
  const out = decidePick({
    message: makeMsg({ entries: [{ roleId: 'A' }], blacklist: ['x'] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf('x'),
  });
  assert.deepEqual(out, { ok: false, reason: 'blacklisted', clearReaction: true });
});

test('a member outside the whitelist is refused with not_whitelisted on add', () => {
  const out = decidePick({
    message: makeMsg({ entries: [{ roleId: 'A' }], whitelist: ['w'] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: false, reason: 'not_whitelisted', clearReaction: true });
});

test('the gate prefers lock over blacklist over whitelist', () => {
  const out = decidePick({
    message: makeMsg({ type: 'lock', entries: [{ roleId: 'A' }], blacklist: ['x'], whitelist: ['w'] }),
    entry: { roleId: 'A' },
    action: 'add',
    memberRoleIds: setOf('x', 'w'),
  });
  assert.deepEqual(out, { ok: false, reason: 'locked', clearReaction: true });
});

// ── decidePick: limit ───────────────────────────────────────────────────────
test('limit refuses an add when the member already holds the maximum number of entry roles', () => {
  const out = decidePick({
    message: makeMsg({
      entries: [{ roleId: 'A' }, { roleId: 'B' }, { roleId: 'C' }],
      limit: 2,
    }),
    entry: { roleId: 'C' },
    action: 'add',
    memberRoleIds: setOf('A', 'B'),
  });
  assert.deepEqual(out, { ok: false, reason: 'limit', clearReaction: true });
});

test('limit does not block a remove action', () => {
  const out = decidePick({
    message: makeMsg({
      entries: [{ roleId: 'A' }, { roleId: 'B' }, { roleId: 'C' }],
      limit: 2,
    }),
    entry: { roleId: 'A' },
    action: 'remove',
    memberRoleIds: setOf('A', 'B', 'C'),
  });
  assert.deepEqual(out, { ok: true, add: [], remove: ['A'], clearReaction: false });
});

test('unique ignores limit and swaps to the new role', () => {
  const out = decidePick({
    message: makeMsg({
      type: 'unique',
      entries: [{ roleId: 'A' }, { roleId: 'B' }, { roleId: 'C' }],
      limit: 2,
    }),
    entry: { roleId: 'C' },
    action: 'add',
    memberRoleIds: setOf('A', 'B'),
  });
  assert.deepEqual(out, { ok: true, add: ['C'], remove: ['A', 'B'], clearReaction: false });
});

// ── decideMenu ──────────────────────────────────────────────────────────────
test('a two-value selection on a unique menu is refused with limit', () => {
  const out = decideMenu({
    message: makeMsg({ type: 'unique', entries: [{ roleId: 'A' }, { roleId: 'B' }, { roleId: 'C' }] }),
    selectedRoleIds: ['A', 'B'],
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: false, reason: 'limit', clearReaction: false });
});

test('a two-value selection on a binding menu is also refused with limit', () => {
  const out = decideMenu({
    message: makeMsg({ type: 'binding', entries: [{ roleId: 'A' }, { roleId: 'B' }] }),
    selectedRoleIds: ['A', 'B'],
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: false, reason: 'limit', clearReaction: false });
});

test('empty selection on a verify menu is refused with nothing', () => {
  const out = decideMenu({
    message: makeMsg({ type: 'verify', entries: [{ roleId: 'A' }, { roleId: 'B' }] }),
    selectedRoleIds: [],
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: false, reason: 'nothing', clearReaction: false });
});

test('empty selection on a binding menu is refused with nothing', () => {
  const out = decideMenu({
    message: makeMsg({ type: 'binding', entries: [{ roleId: 'A' }, { roleId: 'B' }] }),
    selectedRoleIds: [],
    memberRoleIds: setOf(),
  });
  assert.deepEqual(out, { ok: false, reason: 'nothing', clearReaction: false });
});

test('empty selection on a lock menu is refused with locked', () => {
  const out = decideMenu({
    message: makeMsg({ type: 'lock', entries: [{ roleId: 'A' }] }),
    selectedRoleIds: [],
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: false, reason: 'locked', clearReaction: false });
});

test('empty selection on a normal menu removes every held entry role', () => {
  const out = decideMenu({
    message: makeMsg({ entries: [{ roleId: 'A' }, { roleId: 'B' }, { roleId: 'C' }] }),
    selectedRoleIds: [],
    memberRoleIds: setOf('A', 'C'),
  });
  assert.deepEqual(out, { ok: true, add: [], remove: ['A', 'C'], clearReaction: false });
});

test('a selection that would push the member past limit is refused whole', () => {
  const out = decideMenu({
    message: makeMsg({
      entries: [{ roleId: 'A' }, { roleId: 'B' }, { roleId: 'C' }, { roleId: 'D' }],
      limit: 2,
    }),
    selectedRoleIds: ['B', 'C', 'D'],
    memberRoleIds: setOf('A'),
  });
  assert.deepEqual(out, { ok: false, reason: 'limit', clearReaction: false });
});
