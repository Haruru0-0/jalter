import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore } from '../../src/features/autoresponder/builder/drafts.js';
import { newDraft } from '../../src/features/autoresponder/builder/draft.js';

const clock = (start = 1000) => { const c = { t: start, now: () => c.t }; return c; };

test('open then get returns the entry', () => {
  const s = createDraftStore();
  const d = newDraft();
  const id = s.open('g', 'u', d);
  const e = s.get(id);
  assert.equal(e.panelId, id);
  assert.equal(e.guildId, 'g');
  assert.equal(e.userId, 'u');
  assert.equal(e.draft, d);
  assert.equal(e.saving, false);
  assert.equal(e.pending, null);
  assert.equal(typeof e.page, 'string');
});

test('ids are 8 chars and unique over 1000 opens', () => {
  const s = createDraftStore({ max: 5000 });
  const ids = new Set();
  for (let i = 0; i < 1000; i++) ids.add(s.open('g', `u${i}`, newDraft()));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^[0-9a-z]{8}$/);
});

test('opening again for the same member and server drops the first panel', () => {
  const s = createDraftStore();
  const a = s.open('g', 'u', newDraft());
  const b = s.open('g', 'u', newDraft());
  assert.equal(s.get(a), null);
  assert.ok(s.get(b));
  assert.equal(s.size(), 1);
});

test('other servers and members do not interfere', () => {
  const s = createDraftStore();
  const a = s.open('g1', 'u', newDraft());
  const b = s.open('g2', 'u', newDraft());
  const c = s.open('g1', 'v', newDraft());
  assert.ok(s.get(a) && s.get(b) && s.get(c));
  assert.equal(s.size(), 3);
});

test('an expired entry returns null and is removed', () => {
  const c = clock();
  const s = createDraftStore({ now: c.now, ttlMs: 100 });
  const id = s.open('g', 'u', newDraft());
  c.t += 101;
  assert.equal(s.get(id), null);
  assert.equal(s.size(), 0);
});

test('get inside the window slides the expiry', () => {
  const c = clock();
  const s = createDraftStore({ now: c.now, ttlMs: 100 });
  const id = s.open('g', 'u', newDraft());
  c.t += 80;
  assert.ok(s.get(id));
  c.t += 80;
  assert.ok(s.get(id));
  c.t += 101;
  assert.equal(s.get(id), null);
});

test('update merges the patch and slides expiry; missing id gives null', () => {
  const c = clock();
  const s = createDraftStore({ now: c.now, ttlMs: 100 });
  const id = s.open('g', 'u', newDraft());
  c.t += 80;
  const e = s.update(id, { page: 'gates', pending: 'x' });
  assert.equal(e.page, 'gates');
  assert.equal(s.get(id).pending, 'x');
  assert.equal(e.expiresAt, 1180);
  assert.equal(s.update('nope', { page: 'a' }), null);
});

test('the 501st open evicts the oldest', () => {
  const c = clock();
  const s = createDraftStore({ now: c.now });
  const first = s.open('g', 'u0', newDraft());
  for (let i = 1; i < 500; i++) { c.t += 1; s.open('g', `u${i}`, newDraft()); }
  assert.equal(s.size(), 500);
  assert.ok(s.get(first));
  c.t += 1;
  const second = s.open('g', 'u500', newDraft());
  assert.equal(s.size(), 500);
  assert.ok(second);
});

test('eviction removes the oldest entry', () => {
  const s = createDraftStore({ max: 3 });
  const a = s.open('g', 'a', newDraft());
  const b = s.open('g', 'b', newDraft());
  const c = s.open('g', 'c', newDraft());
  const d = s.open('g', 'd', newDraft());
  assert.equal(s.size(), 3);
  assert.equal(s.get(a), null);
  assert.ok(s.get(b) && s.get(c) && s.get(d));
});

test('beginSave twice gives an entry then null', () => {
  const s = createDraftStore();
  const id = s.open('g', 'u', newDraft());
  assert.equal(s.beginSave(id).saving, true);
  assert.equal(s.beginSave(id), null);
});

test('endSave(false) allows another beginSave', () => {
  const s = createDraftStore();
  const id = s.open('g', 'u', newDraft());
  s.beginSave(id);
  s.endSave(id, false);
  assert.ok(s.beginSave(id));
});

test('endSave(true) removes the entry', () => {
  const s = createDraftStore();
  const id = s.open('g', 'u', newDraft());
  s.beginSave(id);
  s.endSave(id, true);
  assert.equal(s.get(id), null);
  assert.equal(s.size(), 0);
});

test('beginSave on a missing or expired entry gives null; drop removes', () => {
  const c = clock();
  const s = createDraftStore({ now: c.now, ttlMs: 10 });
  assert.equal(s.beginSave('nope'), null);
  const id = s.open('g', 'u', newDraft());
  c.t += 11;
  assert.equal(s.beginSave(id), null);
  const id2 = s.open('g', 'u', newDraft());
  s.drop(id2);
  assert.equal(s.get(id2), null);
});
