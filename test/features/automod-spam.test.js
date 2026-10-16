import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpamTracker, countEmoji } from '../../src/features/automod/detect-spam.js';

const on = (o = {}) => ({ enabled: true, ...o });
const off = { enabled: false };
const allOff = () => ({
  burst: off, identical: off, caps: off, emoji: off, mentions: off, attachments: off, linkRate: off,
});
const cfg = (o = {}) => ({ ...allOff(), ...o });
const msg = (o = {}) => ({
  guildId: 'g', userId: 'u', channelId: 'c', content: 'hello', mentionCount: 0, attachmentCount: 0, linkCount: 0, ...o,
});

test('burst trips on the sixth message in five seconds', () => {
  const t = createSpamTracker();
  const c = cfg({ burst: on({ messages: 5, seconds: 5 }) });
  for (let i = 0; i < 5; i++) assert.deepEqual(t.check(msg({ content: `m${i}`, channelId: `c${i}` }), c, i * 500), []);
  assert.deepEqual(t.check(msg({ content: 'm5' }), c, 2500), ['burst']);
  assert.deepEqual(t.check(msg({ content: 'late' }), c, 60_000), []);
});

test('identical trips on the fourth repeat and not when another message is between', () => {
  const c = cfg({ identical: on({ count: 4, seconds: 60 }) });
  const t = createSpamTracker();
  assert.deepEqual(t.check(msg({ content: 'Buy NOW' }), c, 0), []);
  assert.deepEqual(t.check(msg({ content: 'buy now' }), c, 1000), []);
  assert.deepEqual(t.check(msg({ content: 'BUY   now' }), c, 2000), []);
  assert.deepEqual(t.check(msg({ content: 'buy now' }), c, 3000), ['identical']);
  const u = createSpamTracker();
  u.check(msg({ content: 'a' }), c, 0);
  u.check(msg({ content: 'a' }), c, 1);
  u.check(msg({ content: 'a' }), c, 2);
  u.check(msg({ content: 'other' }), c, 3);
  assert.deepEqual(u.check(msg({ content: 'a' }), c, 4), []);
  const w = createSpamTracker();
  for (let i = 0; i < 3; i++) w.check(msg({ content: 'a' }), c, i);
  assert.deepEqual(w.check(msg({ content: 'a' }), c, 120_000), []);
});

test('identical ignores empty normalised content', () => {
  const t = createSpamTracker();
  const c = cfg({ identical: on({ count: 2, seconds: 60 }) });
  t.check(msg({ content: '' }), c, 0);
  assert.deepEqual(t.check(msg({ content: '   ' }), c, 1), []);
  assert.deepEqual(t.check(msg({ content: '' }), c, 2), []);
});

test('caps ignores short messages', () => {
  const t = createSpamTracker();
  const c = cfg({ caps: on({ minLength: 10, percent: 70 }) });
  assert.deepEqual(t.check(msg({ content: 'HELLO' }), c, 0), []);
});

test('caps trips at the percent', () => {
  const t = createSpamTracker();
  const c = cfg({ caps: on({ minLength: 10, percent: 70 }) });
  assert.deepEqual(t.check(msg({ content: 'HELLO THERE FRIENDS' }), c, 0), ['caps']);
  assert.deepEqual(t.check(msg({ content: 'HELLOWO world a b' }), c, 1), []);
  assert.deepEqual(t.check(msg({ content: 'SEVENxxxxx 123456789' }), c, 2), []);
  assert.deepEqual(t.check(msg({ content: 'ABCDEFGhij 1234' }), c, 3), ['caps']);
  assert.deepEqual(t.check(msg({ content: 'مرحبا بكم في الخادم الجديد' }), c, 4), []);
  assert.deepEqual(t.check(msg({ content: '1234567890 !!!!' }), c, 5), []);
});

test('emoji counts custom and unicode', () => {
  assert.equal(countEmoji('hi'), 0);
  assert.equal(countEmoji(''), 0);
  assert.equal(countEmoji('<:a:123> <a:b:456>'), 2);
  assert.equal(countEmoji('😀😀🎉'), 3);
  assert.equal(countEmoji('👨‍👩‍👧‍👦'), 1);
  assert.equal(countEmoji('👍🏽'), 1);
  assert.equal(countEmoji('❤️'), 1);
  assert.equal(countEmoji('🇫🇷🇱🇧'), 2);
  assert.equal(countEmoji('1️⃣ 2'), 1);
  const t = createSpamTracker();
  const c = cfg({ emoji: on({ max: 3 }) });
  assert.deepEqual(t.check(msg({ content: '😀😀😀 <:a:1>' }), c, 0), ['emoji']);
  assert.deepEqual(t.check(msg({ content: '😀😀😀' }), c, 1), []);
});

test('mentions per message', () => {
  const t = createSpamTracker();
  const c = cfg({ mentions: on({ max: 5 }) });
  assert.deepEqual(t.check(msg({ mentionCount: 5 }), c, 0), []);
  assert.deepEqual(t.check(msg({ mentionCount: 200 }), c, 1), ['mentions']);
});

test('attachments total over time', () => {
  const t = createSpamTracker();
  const c = cfg({ attachments: on({ count: 5, seconds: 30 }) });
  assert.deepEqual(t.check(msg({ attachmentCount: 2 }), c, 0), []);
  assert.deepEqual(t.check(msg({ attachmentCount: 2 }), c, 10_000), []);
  assert.deepEqual(t.check(msg({ attachmentCount: 1 }), c, 20_000), ['attachments']);
  assert.deepEqual(t.check(msg({ attachmentCount: 0 }), c, 100_000), []);
});

test('linkRate total over time', () => {
  const t = createSpamTracker();
  const c = cfg({ linkRate: on({ count: 3, seconds: 30 }) });
  assert.deepEqual(t.check(msg({ linkCount: 1 }), c, 0), []);
  assert.deepEqual(t.check(msg({ linkCount: 1 }), c, 1000), []);
  assert.deepEqual(t.check(msg({ linkCount: 1 }), c, 2000), ['linkRate']);
  assert.deepEqual(t.check(msg({ linkCount: 1 }), c, 90_000), []);
});

test('attachments and linkRate only trip when the current message contributes', () => {
  const c = cfg({ attachments: on({ count: 5, seconds: 30 }), linkRate: on({ count: 3, seconds: 30 }) });
  const t = createSpamTracker();
  assert.deepEqual(t.check(msg({ attachmentCount: 5 }), c, 0), ['attachments']);
  assert.deepEqual(t.check(msg({ content: 'just text' }), c, 1000), []);
  assert.deepEqual(t.check(msg({ attachmentCount: 1 }), c, 2000), ['attachments']);
  const u = createSpamTracker();
  assert.deepEqual(u.check(msg({ linkCount: 3 }), c, 0), ['linkRate']);
  assert.deepEqual(u.check(msg({ content: 'plain' }), c, 1000), []);
  assert.deepEqual(u.check(msg({ linkCount: 1 }), c, 2000), ['linkRate']);
});

test('disabled checks never trip', () => {
  const t = createSpamTracker();
  const c = allOff();
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(t.check(msg({ content: 'SAME SAME SAME', mentionCount: 99, attachmentCount: 9, linkCount: 9 }), c, i), []);
  }
});

test('empty content does not throw', () => {
  const t = createSpamTracker();
  const c = cfg({ burst: on({ messages: 5, seconds: 5 }), caps: on({ minLength: 1, percent: 10 }), emoji: on({ max: 1 }), identical: on({ count: 2, seconds: 60 }) });
  assert.deepEqual(t.check(msg({ content: '' }), c, 0), []);
  assert.deepEqual(t.check(msg({ content: undefined }), c, 1), []);
  assert.doesNotThrow(() => t.check(msg({ content: 'x'.repeat(4000) }), c, 2));
});

test('state is per guild and user, and inputs are not mutated', () => {
  const t = createSpamTracker();
  const c = cfg({ burst: on({ messages: 2, seconds: 5 }) });
  const copy = structuredClone(c);
  t.check(msg({ userId: 'a' }), c, 0);
  t.check(msg({ userId: 'a' }), c, 1);
  assert.deepEqual(t.check(msg({ userId: 'b' }), c, 2), []);
  assert.deepEqual(t.check(msg({ guildId: 'h', userId: 'a' }), c, 3), []);
  assert.deepEqual(t.check(msg({ userId: 'a' }), c, 4), ['burst']);
  assert.deepEqual(c, copy);
});

test('prune frees old state', () => {
  const t = createSpamTracker();
  const c = cfg({ burst: on({ messages: 2, seconds: 5 }), identical: on({ count: 3, seconds: 60 }) });
  t.check(msg(), c, 0);
  t.prune(10_000);
  // identical window is 60s, so the entry is still needed
  t.check(msg(), c, 10_001);
  t.check(msg(), c, 10_002);
  assert.deepEqual(t.check(msg(), c, 10_003), ['burst', 'identical']);
  t.prune(10_000_000);
  assert.equal(t.size(), 0);
  assert.deepEqual(t.check(msg(), c, 10_000_001), []);
});
