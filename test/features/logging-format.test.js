import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncate, formatMessageEdit, formatMessageDelete, diffRoles, formatRoleChange, formatRename,
} from '../../src/features/logging/format.js';

test('truncate shortens long text and handles null', () => {
  assert.equal(truncate('a'.repeat(2000)).length, 1024);
  assert.equal(truncate(null), '—');
});

test('formatMessageEdit includes old and new content', () => {
  const e = formatMessageEdit(
    { content: 'old text', author: { username: 'Sam' }, channelId: 'c1' },
    { content: 'new text', author: { username: 'Sam' }, channelId: 'c1', url: 'https://discord.com/x' },
    'en',
  );
  assert.equal(e.fields[0].value, 'old text');
  assert.equal(e.fields[1].value, 'new text');
});

test('formatMessageEdit marks unavailable old content (uncached message)', () => {
  const e = formatMessageEdit({ content: null, partial: true }, { content: 'new', author: { username: 'S' }, channelId: 'c' }, 'en');
  assert.match(e.fields[0].value, /not available/i);
});

test('formatMessageDelete shows content, or the unavailable text for partials', () => {
  const full = formatMessageDelete({ content: 'bye', author: { username: 'Sam' }, channelId: 'c1' }, 'en');
  assert.equal(full.fields[0].value, 'bye');
  assert.match(full.description, /Sam/);
  const partial = formatMessageDelete({ content: null, partial: true, channelId: 'c1' }, 'en');
  assert.match(partial.fields[0].value, /not available/i);
  assert.match(partial.description, /\?/);
});

test('diffRoles returns added and removed role ids', () => {
  const d = diffRoles(['a', 'b', 'c'], ['b', 'c', 'd', 'e']);
  assert.deepEqual(d, { added: ['d', 'e'], removed: ['a'] });
  assert.deepEqual(diffRoles(['a'], ['a']), { added: [], removed: [] });
});

test('formatRoleChange lists mentions and skips empty sides', () => {
  const e = formatRoleChange('u1', { added: ['r1', 'r2'], removed: [] }, 'en');
  assert.equal(e.fields.length, 1);
  assert.match(e.fields[0].value, /<@&r1> <@&r2>/);
  assert.match(e.description, /<@u1>/);
});

test('formatRename shows old and new names', () => {
  const e = formatRename('Channel renamed', 'general', 'chat', 'en');
  assert.equal(e.title, 'Channel renamed');
  assert.equal(e.fields[0].value, 'general');
  assert.equal(e.fields[1].value, 'chat');
});
