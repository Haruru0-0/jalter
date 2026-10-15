import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkToolAccess, postNotice, logTool } from '../../src/features/moderation/tools-common.js';
import { t } from '../../src/i18n/index.js';

const perms = (list) => ({ has: (p) => list.includes(p) });
// canUseAction reads member.permissions/roles, so use a richer member that doubles as the channel key.
function setup({ memberPerms = ['ManageMessages'], mod, bot } = {}) {
  const member = { permissions: perms(memberPerms), roles: { cache: { has: () => false } } };
  const me = {};
  const channel = {
    permissionsFor: (who) => (who === member ? perms(mod ?? ['ViewChannel']) : perms(bot ?? ['ViewChannel', 'ManageMessages'])),
  };
  return {
    interaction: { member, guild: { members: { me } } },
    channel,
    config: {},
    botPermissions: ['ViewChannel', 'ManageMessages'],
  };
}

test('checkToolAccess ok', () => {
  assert.deepEqual(checkToolAccess({ ...setup(), action: 'purge' }), { ok: true });
});

test('checkToolAccess refusal reasons', () => {
  assert.deepEqual(checkToolAccess({ ...setup({ memberPerms: [] }), action: 'purge' }), { ok: false, reason: 'not_allowed' });
  assert.deepEqual(checkToolAccess({ ...setup({ mod: [] }), action: 'purge' }), { ok: false, reason: 'no_view' });
  assert.deepEqual(checkToolAccess({ ...setup({ bot: ['ViewChannel'] }), action: 'purge' }), { ok: false, reason: 'bot_missing' });
  assert.deepEqual(checkToolAccess({ ...setup({ bot: ['ManageMessages'] }), action: 'purge' }), { ok: false, reason: 'bot_missing' });
  assert.deepEqual(checkToolAccess({ ...setup(), channel: null, action: 'purge' }), { ok: false, reason: 'bad_channel' });
});

test('checkToolAccess checks permission before channel visibility', () => {
  assert.deepEqual(checkToolAccess({ ...setup({ memberPerms: [], mod: [] }), action: 'purge' }), { ok: false, reason: 'not_allowed' });
});

test('postNotice', async () => {
  assert.equal(await postNotice({ send: async () => ({ id: '1' }) }, { content: 'x' }), true);
  assert.equal(await postNotice({ send: async () => { throw new Error('nope'); } }, { content: 'x' }), false);
  assert.equal(await postNotice(null, { content: 'x' }), false);
});

test('logTool never throws, even with logging unavailable', async () => {
  const guild = { id: 'g1' };
  const ctx = { db: { query: async () => { throw new Error('db down'); } }, client: {} };
  await logTool(ctx, guild, 'en', { tool: 'purge', actorId: '1', channelId: '2' });
});

test('logTool builds the embed and sends to the modAction event', async () => {
  const calls = [];
  const fake = async (...args) => { calls.push(args); return null; };
  const ctx = {};
  await logTool(ctx, { id: 'g1' }, 'en', { tool: 'Lock', actorId: '10', channelId: '20', detail: '5 messages', reason: 'spam' }, { sendLog: fake });
  assert.equal(calls.length, 1);
  const [c, gid, event, embed] = calls[0];
  assert.equal(c, ctx);
  assert.equal(gid, 'g1');
  assert.equal(event, 'modAction');
  assert.equal(embed.title, t('en', 'moderation.tools.log.title', { tool: 'Lock' }));
  const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
  assert.equal(byName[t('en', 'moderation.tools.log.moderator')], '<@10>');
  assert.equal(byName[t('en', 'moderation.tools.log.channel')], '<#20>');
  assert.equal(byName[t('en', 'moderation.tools.log.reason')], 'spam');
  assert.equal(embed.fields.length, 4);
});

test('logTool omits empty optional fields and swallows a throwing sendLog', async () => {
  const calls = [];
  await logTool({}, { id: 'g' }, 'en', { tool: 'x', actorId: '1', channelId: '2' }, { sendLog: async (...a) => { calls.push(a); } });
  assert.equal(calls[0][3].fields.length, 2);
  await logTool({}, { id: 'g' }, 'en', { tool: 'x', actorId: '1', channelId: '2' }, { sendLog: async () => { throw new Error('boom'); } });
});
