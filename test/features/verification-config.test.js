import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig, classify } from '../../src/features/verification/config.js';
import { FEATURES } from '../../src/core/registry.js';
import { modules } from '../../src/modules.js';

test('readConfig fills defaults', () => {
  assert.deepEqual(readConfig(undefined), {
    mode: 'button', roleId: null, channelId: null, messageId: null, state: 'none',
    publicChannels: [], skippedChannels: [], cutoff: null,
  });
  assert.deepEqual(readConfig(null), readConfig({}));
});

test('readConfig keeps good values', () => {
  const cfg = readConfig({
    mode: 'captcha', roleId: '1', channelId: '2', messageId: '3', state: 'active',
    publicChannels: ['4'], skippedChannels: ['5'], cutoff: 1700000000000,
  });
  assert.equal(cfg.mode, 'captcha');
  assert.equal(cfg.state, 'active');
  assert.equal(cfg.roleId, '1');
  assert.equal(cfg.cutoff, 1700000000000);
  assert.deepEqual(cfg.publicChannels, ['4']);
});

test('readConfig rejects a bad mode and state', () => {
  const cfg = readConfig({ mode: 'weird', state: 'bogus', roleId: 5, cutoff: 'x' });
  assert.equal(cfg.mode, 'button');
  assert.equal(cfg.state, 'none');
  assert.equal(cfg.roleId, null);
  assert.equal(cfg.cutoff, null);
});

test('readConfig dedupes and caps lists', () => {
  const many = Array.from({ length: 300 }, (_, i) => String(i));
  const cfg = readConfig({ publicChannels: ['a', 'a', 'b', 7, ''], skippedChannels: [...many, ...many] });
  assert.deepEqual(cfg.publicChannels, ['a', 'b']);
  assert.equal(cfg.skippedChannels.length, 200);
  assert.deepEqual(readConfig({ publicChannels: 'nope' }).publicChannels, []);
});

test('classify gives verify, public, skip, gated in that order of precedence', () => {
  const cfg = readConfig({ channelId: 'v', publicChannels: ['v', 'p', 's'], skippedChannels: ['p', 's'] });
  assert.equal(classify('v', cfg), 'verify');
  assert.equal(classify('p', cfg), 'public');
  assert.equal(classify('s', cfg), 'public');
  const cfg2 = readConfig({ channelId: 'v', publicChannels: ['p'], skippedChannels: ['s'] });
  assert.equal(classify('s', cfg2), 'skip');
  assert.equal(classify('x', cfg2), 'gated');
});

test('verification is listed as a real command in the registry', () => {
  const f = FEATURES.find((x) => x.key === 'verification');
  assert.equal(f.command, 'verification');
  assert.equal(f.enableCommand, 'verification enable');
  const mod = modules.find((m) => m.commands?.some((c) => c.data.name === 'verification'));
  assert.ok(mod);
  const data = mod.commands[0].data.toJSON();
  assert.deepEqual(data.options.map((o) => o.name), ['enable', 'disable']);
});
