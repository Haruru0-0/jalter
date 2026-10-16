import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLinks,
  extractInviteCodes,
  domainMatches,
  evaluateLinks,
  evaluateInvites,
} from '../../src/features/automod/detect-links.js';
import { readConfig } from '../../src/features/automod/config.js';

const linksCfg = (o = {}) => ({ ...readConfig({}).rules.links, ...o });
const invCfg = (o = {}) => ({ ...readConfig({}).rules.invites, ...o });

test('extracts hosts from urls and bare domains', () => {
  assert.deepEqual(
    extractLinks('see HTTPS://Example.COM/a?b=1, and foo.org/x. also [t](http://sub.bar.net/p) plus a.b!'),
    ['example.com', 'foo.org', 'sub.bar.net'],
  );
  assert.deepEqual(extractLinks('https://discord.gg@evil.com/x'), ['evil.com']);
  assert.deepEqual(extractLinks('mail me at bob@example.com'), []);
  assert.deepEqual(extractLinks(''), []);
  assert.deepEqual(extractLinks(undefined), []);
});

test('ignores invite links in extractLinks', () => {
  assert.deepEqual(extractLinks('discord.gg/abc https://discord.com/invite/xyz discordapp.com/invite/q'), []);
  assert.deepEqual(extractLinks('https://discord.com/channels/1/2'), ['discord.com']);
});

test('extracts invite codes from all three forms', () => {
  const t = 'discord.gg/abc123 https://discord.com/invite/Xyz-9 http://discordapp.com/invite/q1w2 discord.gg/abc123';
  assert.deepEqual(extractInviteCodes(t), ['abc123', 'Xyz-9', 'q1w2']);
  assert.deepEqual(extractInviteCodes('https://discord.gg@evil.com'), []);
  assert.deepEqual(extractInviteCodes('notdiscord.gg/abc'), []);
});

test('subdomains match a listed domain', () => {
  assert.equal(domainMatches('a.example.com', ['example.com']), true);
  assert.equal(domainMatches('example.com', ['Example.com']), true);
  assert.equal(domainMatches('badexample.com', ['example.com']), false);
  assert.equal(domainMatches('example.com', []), false);
});

test('allow beats block', () => {
  const cfg = linksCfg({ allow: ['example.com'], block: ['example.com', 'evil.com'] });
  assert.deepEqual(evaluateLinks('example.com evil.com', cfg), { violated: true, matches: ['evil.com'] });
  assert.deepEqual(evaluateLinks('www.example.com', cfg), { violated: false, matches: [] });
});

test('blockAllExceptAllowed blocks unlisted links', () => {
  const cfg = linksCfg({ allow: ['ok.com'], blockAllExceptAllowed: true });
  assert.deepEqual(evaluateLinks('ok.com other.org', cfg), { violated: true, matches: ['other.org'] });
  assert.equal(evaluateLinks('other.org', linksCfg({ blockAllExceptAllowed: false })).violated, false);
});

test('own server invite passes', async () => {
  const r = await evaluateInvites('discord.gg/abc', invCfg(), { ownGuildId: 'G1', resolve: async () => 'G1' });
  assert.deepEqual(r, { violated: false, matches: [] });
});

test('foreign invite violates by default', async () => {
  const r = await evaluateInvites('discord.gg/abc', invCfg(), { ownGuildId: 'G1', resolve: async () => 'G2' });
  assert.deepEqual(r, { violated: true, matches: ['abc'] });
});

test('allowed server id passes', async () => {
  const r = await evaluateInvites('discord.gg/abc', invCfg({ allow: ['G2'] }), {
    ownGuildId: 'G1',
    resolve: async () => 'G2',
  });
  assert.equal(r.violated, false);
});

test('resolve failure is treated as foreign', async () => {
  const a = await evaluateInvites('discord.gg/abc', invCfg(), { ownGuildId: 'G1', resolve: async () => null });
  assert.equal(a.violated, true);
  const b = await evaluateInvites('discord.gg/abc', invCfg(), {
    ownGuildId: 'G1',
    resolve: async () => {
      throw new Error('unknown invite');
    },
  });
  assert.equal(b.violated, true);
});

test('resolve is called once per distinct code', async () => {
  const calls = [];
  await evaluateInvites('discord.gg/abc discord.com/invite/abc discord.gg/def', invCfg(), {
    ownGuildId: 'G1',
    resolve: async (c) => (calls.push(c), 'G2'),
  });
  assert.deepEqual(calls, ['abc', 'def']);
});

test('hostile input stays bounded', async () => {
  const big = 'a.'.repeat(2000);
  assert.ok(extractLinks(big).length <= 20);
  const many = Array.from({ length: 100 }, (_, i) => `h${i}.com`).join(' ');
  assert.equal(extractLinks(many).length, 20);
  assert.ok(extractLinks('x'.repeat(4000) + ' ' + 'http://' + 'a'.repeat(4000)).length <= 20);
  const r = await evaluateInvites('', invCfg(), { ownGuildId: 'G1', resolve: async () => 'G2' });
  assert.equal(r.violated, false);
});
