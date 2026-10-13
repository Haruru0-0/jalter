import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trySend, fetchSendable } from '../../src/core/send.js';

test('trySend returns the message on success', async () => {
  const msg = { id: 'm' };
  assert.equal(await trySend({ send: async () => msg }, { content: 'x' }), msg);
});

test('trySend returns null instead of throwing when sending fails', async () => {
  const ch = { send: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } };
  assert.equal(await trySend(ch, { content: 'x' }), null);
});

test('fetchSendable returns null for a missing id, a deleted channel, or a non-text channel', async () => {
  const client = (fn) => ({ channels: { fetch: fn } });
  assert.equal(await fetchSendable(client(async () => null), undefined), null);
  assert.equal(await fetchSendable(client(async () => { throw new Error('Unknown Channel'); }), '1'), null);
  assert.equal(await fetchSendable(client(async () => ({ isTextBased: () => false })), '1'), null);
});

test('fetchSendable returns a text channel', async () => {
  const ch = { isTextBased: () => true };
  assert.equal(await fetchSendable({ channels: { fetch: async () => ch } }, '1'), ch);
});
