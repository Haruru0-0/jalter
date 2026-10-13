import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ordinal, renderPlaceholders, buildVars, extractEmbedRefs } from '../../src/core/placeholders.js';

test('ordinal follows English rules, French and Arabic styles', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map((n) => ordinal(n, 'en')),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st', '111th']);
  assert.equal(ordinal(1, 'fr'), '1er');
  assert.equal(ordinal(42, 'fr'), '42e');
  assert.equal(ordinal(42, 'ar'), '42');
});

test('renderPlaceholders replaces known names and keeps unknown ones', () => {
  assert.equal(renderPlaceholders('Hi {user_name} {nope} {count}', { user_name: 'Sam', count: 0 }), 'Hi Sam {nope} 0');
  assert.equal(renderPlaceholders('{user}', {}), '{user}');
  assert.equal(renderPlaceholders(undefined, {}), undefined);
});

test('a rendered value is not expanded again', () => {
  assert.equal(renderPlaceholders('{user_name}', { user_name: '{server_name}', server_name: 'Home' }), '{server_name}');
});

const user = {
  id: '7', username: 'sam', globalName: 'Sam!', tag: 'sam',
  displayAvatarURL: () => 'https://cdn.test/a.png',
};
const guild = {
  name: 'Home', iconURL: () => 'https://cdn.test/g.png', ownerId: '9',
  createdTimestamp: 1_700_000_000_000, memberCount: 42, premiumSubscriptionCount: 3,
};

test('buildVars provides every documented placeholder', () => {
  const v = buildVars({ user, guild, lang: 'en', now: 1_800_000_000_000 });
  assert.equal(v.user, '<@7>');
  assert.equal(v.user_name, 'Sam!');
  assert.equal(v.user_tag, 'sam');
  assert.equal(v.user_avatar, 'https://cdn.test/a.png');
  assert.equal(v.server_name, 'Home');
  assert.equal(v.server_icon, 'https://cdn.test/g.png');
  assert.equal(v.server_owner, '<@9>');
  assert.equal(v.server_createdate, '<t:1700000000:D>');
  assert.equal(v.server_membercount, 42);
  assert.equal(v.server_membercount_ordinal, '42nd');
  assert.equal(v.server_boostcount, 3);
  assert.equal(v.date, '<t:1800000000:D>');
  assert.equal(v.newline, '\n');
});

test('buildVars keeps the old aliases and prefers the member display name', () => {
  const v = buildVars({ user, member: { displayName: 'Nick' }, guild });
  assert.equal(v.user_name, 'Nick');
  assert.equal(v.username, 'sam');
  assert.equal(v.server, 'Home');
  assert.equal(v.count, 42);
  assert.equal(v.boosts, 3);
});

test('buildVars tolerates a guild without an icon or boosts', () => {
  const v = buildVars({ user, guild: { ...guild, iconURL: () => null, premiumSubscriptionCount: null } });
  assert.equal(v.server_icon, '');
  assert.equal(v.server_boostcount, 0);
});

test('extractEmbedRefs removes every tag and lowercases names', () => {
  assert.deepEqual(extractEmbedRefs('welcome, {user}! {embed:Greet_Embed}'),
    { text: 'welcome, {user}!', names: ['greet_embed'] });
  assert.deepEqual(extractEmbedRefs('{embed:a}{embed:b} hi'), { text: 'hi', names: ['a', 'b'] });
  assert.deepEqual(extractEmbedRefs('no tags'), { text: 'no tags', names: [] });
  assert.deepEqual(extractEmbedRefs('{embed:has space}'), { text: '{embed:has space}', names: [] });
});

test('inherited object keys are not placeholders', () => {
  assert.equal(renderPlaceholders('{constructor} {__proto__}', {}), '{constructor} {__proto__}');
});

test('extractEmbedRefs tolerates missing text', () => {
  assert.deepEqual(extractEmbedRefs(undefined), { text: '', names: [] });
});
