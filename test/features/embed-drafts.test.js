import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putDraft, getDraft, clearDraft } from '../../src/features/embeds/drafts.js';

test('a draft is returned before it expires and dropped after 15 minutes', () => {
  putDraft('u1', { title: 'a' }, 1000);
  assert.deepEqual(getDraft('u1', 1000 + 14 * 60 * 1000), { title: 'a' });
  assert.equal(getDraft('u1', 1000 + 16 * 60 * 1000), null);
});

test('clearDraft removes a draft', () => {
  putDraft('u2', { title: 'a' }, 1000);
  clearDraft('u2');
  assert.equal(getDraft('u2', 1001), null);
});
