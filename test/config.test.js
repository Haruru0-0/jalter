import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('loadConfig returns values and defaults', () => {
  const cfg = loadConfig({ DISCORD_TOKEN: 't', CLIENT_ID: 'c' });
  assert.equal(cfg.token, 't');
  assert.equal(cfg.clientId, 'c');
  assert.equal(cfg.devGuildId, null);
  assert.match(cfg.databaseUrl, /\/bot$/);
});

test('loadConfig names the missing variable', () => {
  assert.throws(() => loadConfig({ CLIENT_ID: 'c' }), /DISCORD_TOKEN/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 't' }), /CLIENT_ID/);
});
