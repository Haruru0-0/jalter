import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findExecutor } from '../../src/features/logging/audit.js';

const NOW = 1_000_000;
const guildWith = (entries) => ({
  fetchAuditLogs: async () => ({ entries: new Map(entries.map((e, i) => [String(i), e])) }),
});

test('returns executor of a fresh matching entry', async () => {
  const g = guildWith([{ target: { id: 'u1' }, executor: { id: 'mod1' }, createdTimestamp: NOW - 2000 }]);
  assert.equal(await findExecutor(g, 22, 'u1', NOW), 'mod1');
});

test('ignores entries 11s old', async () => {
  const g = guildWith([{ target: { id: 'u1' }, executor: { id: 'mod1' }, createdTimestamp: NOW - 11_000 }]);
  assert.equal(await findExecutor(g, 22, 'u1', NOW), null);
});

test('ignores entries for another target', async () => {
  const g = guildWith([{ target: { id: 'u2' }, executor: { id: 'mod1' }, createdTimestamp: NOW - 1000 }]);
  assert.equal(await findExecutor(g, 22, 'u1', NOW), null);
});

test('picks the newest matching entry', async () => {
  const g = guildWith([
    { target: { id: 'u1' }, executor: { id: 'old' }, createdTimestamp: NOW - 5000 },
    { target: { id: 'u1' }, executor: { id: 'new' }, createdTimestamp: NOW - 1000 },
  ]);
  assert.equal(await findExecutor(g, 22, 'u1', NOW), 'new');
});

test('returns null when fetchAuditLogs rejects', async () => {
  const g = { fetchAuditLogs: async () => { throw new Error('Missing Permissions'); } };
  assert.equal(await findExecutor(g, 22, 'u1', NOW), null);
});

test('returns null when executor is missing', async () => {
  const g = guildWith([{ target: { id: 'u1' }, executor: null, createdTimestamp: NOW - 1000 }]);
  assert.equal(await findExecutor(g, 22, 'u1', NOW), null);
});
