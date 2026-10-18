import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logVerification } from '../../src/features/verification/log.js';

test('logVerification sends one modAction embed and never throws when sendLog rejects', async () => {
  const calls = [];
  const ok = async (...args) => { calls.push(args); };
  await logVerification({}, 'g1', 'en', { kind: 'manual_verify', userId: '1', actorId: '2', detail: 'x' }, { sendLog: ok });
  assert.equal(calls.length, 1);
  const [, guildId, event, embed] = calls[0];
  assert.equal(guildId, 'g1');
  assert.equal(event, 'modAction');
  assert.ok(embed.title && !embed.title.startsWith('verification.'));
  assert.equal(embed.fields.length, 3);
  assert.equal(embed.fields[0].value, '<@1>');
  assert.equal(embed.fields[1].value, '<@2>');

  const boom = async () => { throw new Error('nope'); };
  await assert.doesNotReject(logVerification({}, 'g1', 'fr', { kind: 'undo' }, { sendLog: boom }));
});
