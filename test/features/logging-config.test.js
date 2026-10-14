import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS } from '../../src/features/logging/events.js';
import {
  isEventEnabled, resolveChannelId, isIgnored, encodeSettings, decodeSettings,
} from '../../src/features/logging/config.js';

test('the catalog has 24 events', () => {
  assert.equal(Object.keys(EVENTS).length, 24);
});

test('joins fall back to members, then default, and use their own channel when set', () => {
  assert.equal(resolveChannelId({ channels: { members: 'm' } }, 'memberJoin'), 'm');
  assert.equal(resolveChannelId({ channels: { members: 'm', join: 'j' } }, 'memberJoin'), 'j');
  assert.equal(resolveChannelId({ channels: { default: 'd' } }, 'memberJoin'), 'd');
  assert.equal(resolveChannelId({ channels: { default: 'd' } }, 'ban'), 'd');
  assert.equal(resolveChannelId({}, 'ban'), null);
});

test('an event is on unless listed as disabled', () => {
  assert.equal(isEventEnabled({}, 'ban'), true);
  assert.equal(isEventEnabled({ disabledEvents: ['ban'] }, 'ban'), false);
  assert.equal(isEventEnabled({ disabledEvents: ['ban'] }, 'unban'), true);
});

test('ignore matches channel, member and prefix, and survives missing data', () => {
  const cfg = { ignore: { channels: ['c1'], members: ['u1'], prefixes: ['!'] } };
  assert.equal(isIgnored(cfg, { channelId: 'c1' }), true);
  assert.equal(isIgnored(cfg, { userId: 'u1' }), true);
  assert.equal(isIgnored(cfg, { content: '!help' }), true);
  assert.equal(isIgnored(cfg, { channelId: 'c2', userId: 'u2', content: 'hi' }), false);
  assert.equal(isIgnored({}, { channelId: 'c1' }), false);
  assert.equal(isIgnored(cfg, {}), false);
  assert.equal(isIgnored(cfg, { content: null }), false);
});

test('settings round-trip and bad codes are rejected', () => {
  const cfg = { disabledEvents: ['ban', 'voiceJoin'], ignore: { prefixes: ['!', '?'] } };
  assert.deepEqual(decodeSettings(encodeSettings(cfg)), { disabledEvents: ['ban', 'voiceJoin'], prefixes: ['!', '?'] });
  assert.equal(decodeSettings('%%%'), null);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(decodeSettings(enc({ v: 2, disabledEvents: [], prefixes: [] })), null);
  assert.equal(decodeSettings(enc({ v: 1, disabledEvents: ['nope'], prefixes: [] })), null);
  assert.equal(decodeSettings(enc({ v: 1, disabledEvents: ['constructor'], prefixes: [] })), null);
  assert.equal(decodeSettings('a'.repeat(2001)), null);
});
