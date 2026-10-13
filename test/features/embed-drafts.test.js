import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putDraft, getDraft, clearDraft, draftKey, draftCount } from '../../src/features/embeds/drafts.js';

test('a draft is returned before it expires and dropped after 15 minutes', () => {
  const key = draftKey('g1', 'u1');
  putDraft(key, { title: 'a' }, 1000);
  assert.deepEqual(getDraft(key, 1000 + 14 * 60 * 1000), { title: 'a' });
  assert.equal(getDraft(key, 1000 + 16 * 60 * 1000), null);
});

test('clearDraft removes a draft', () => {
  const key = draftKey('g1', 'u2');
  putDraft(key, { title: 'a' }, 1000);
  clearDraft(key);
  assert.equal(getDraft(key, 1001), null);
});

test('a draft belongs to one guild', () => {
  putDraft(draftKey('g1', 'u3'), { title: 'a' }, 1000);
  assert.deepEqual(getDraft(draftKey('g1', 'u3'), 1001), { title: 'a' });
  assert.equal(getDraft(draftKey('g2', 'u3'), 1001), null);
  assert.notEqual(draftKey('g1', 'u3'), draftKey('g2', 'u3'));
});

test('storing a draft sweeps expired ones', () => {
  const later = 10 ** 12;
  putDraft(draftKey('g9', 'old1'), { title: 'a' }, later);
  putDraft(draftKey('g9', 'old2'), { title: 'a' }, later);
  putDraft(draftKey('g9', 'new'), { title: 'b' }, later + 16 * 60 * 1000);
  assert.equal(draftCount(), 1);
});
