import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { listHistory } from '../../src/features/automod/history.js';
import { isExempt } from '../../src/features/automod/exempt.js';
import { createEngine } from '../../src/features/automod/pipeline.js';

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); });

const G = 'g1';
const member = (id, { perms = [], roles = [] } = {}) => ({
  id,
  permissions: { has: (p) => perms.includes(p) },
  roles: { cache: new Set(roles), highest: { position: 1 } },
});
const botMember = member('bot');

function setup(over = {}) {
  const calls = { runAction: [], sendLog: [], deleted: 0 };
  const guild = { id: G, ownerId: 'owner', members: { me: botMember } };
  const deps = {
    runAction: async (ctx, p) => {
      calls.runAction.push(p);
      return over.runAction ? over.runAction(p) : { ok: true, modCase: { number: 7 }, warnings: [] };
    },
    sendLog: async (ctx, gid, event, embed) => { calls.sendLog.push({ gid, event, embed }); return null; },
    resolveInvite: async () => 'foreign',
    now: () => 1_000_000,
  };
  const engine = createEngine(deps);
  const ctx = { db, client: { user: { id: 'bot' } } };
  const msg = (o = {}) => {
    const author = o.author ?? { id: 'u1', bot: false };
    return {
      id: o.id ?? 'm1',
      content: 'hello',
      author,
      webhookId: null,
      system: false,
      guild,
      guildId: G,
      channelId: 'c1',
      channel: { id: 'c1', parentId: null },
      member: member(author.id),
      mentions: { users: { size: 0 }, roles: { size: 0 } },
      attachments: { size: 0 },
      delete: async () => {
        if (o.deleteError) throw o.deleteError;
        calls.deleted++;
      },
      ...o,
    };
  };
  return { engine, ctx, calls, msg };
}

const words = (o = {}) => ({ enabled: true, custom: ['badword'], useBuiltin: false, steps: [{ strikes: 2, action: 'warn' }], ...o });
const enable = (rules = { words: words() }, extra = {}) =>
  setFeature(db, G, 'automod', { enabled: true, config: { rules, ...extra } });

test('ignores bot, webhook and DM messages', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword', author: { id: 'x', bot: true } }), {});
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword', webhookId: 'w' }), {});
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword', guild: null, guildId: null }), {});
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword', system: true }), {});
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword', author: { id: 'bot', bot: false } }), {});
  assert.equal(s.calls.deleted, 0);
  assert.equal(s.engine.strikes.size(), 0);
  assert.equal((await listHistory(db, G)).length, 0);
});

test('ignores when the feature is off', async () => {
  const s = setup();
  await setFeature(db, G, 'automod', { enabled: false, config: { rules: { words: words() } } });
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword' }), {});
  assert.equal(s.calls.deleted, 0);
  assert.equal(s.engine.strikes.size(), 0);
});

test('ignores exempt members, roles and channels', async () => {
  const s = setup();
  await enable({ words: words() }, { exemptRoles: ['R1'], exemptChannels: ['c9'] });
  await setFeature(db, G, 'panel', { config: { managerRoleId: 'MGR' } });
  await setFeature(db, G, 'moderation', { config: { permittedRoles: ['MOD'] } });
  const bad = { content: 'badword' };
  const as = (m) => ({ ...s.msg(bad), member: m });
  await s.engine.handleMessage(s.ctx, as(member('a', { perms: ['ManageGuild'] })), {});
  await s.engine.handleMessage(s.ctx, as(member('b', { roles: ['MGR'] })), {});
  await s.engine.handleMessage(s.ctx, as(member('c', { roles: ['MOD'] })), {});
  await s.engine.handleMessage(s.ctx, as(member('d', { roles: ['R1'] })), {});
  await s.engine.handleMessage(s.ctx, s.msg({ ...bad, channelId: 'c9', channel: { id: 'c9' } }), {});
  assert.equal(s.calls.deleted, 0);
  assert.equal(s.engine.strikes.size(), 0);
  await s.engine.handleMessage(s.ctx, s.msg(bad), {});
  assert.equal(s.calls.deleted, 1);
});

test('isExempt never treats the everyone role as manager role and covers thread parents', () => {
  const a = { exemptRoles: [], exemptChannels: ['p1'] };
  const m = { permittedRoles: [] };
  const mem = member('x', { roles: [G] });
  mem.guild = { id: G };
  assert.equal(isExempt(mem, { id: 't', parentId: null }, a, m, G), false);
  assert.equal(isExempt(mem, { id: 't', parentId: 'p1' }, a, m, null), true);
});

test('ignores an unchanged edit', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword' }), { edited: true, oldContent: 'badword' });
  assert.equal(s.calls.deleted, 0);
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword' }), { edited: true, oldContent: 'fine' });
  assert.equal(s.calls.deleted, 1);
});

test('deletes and counts a strike for a bad word', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'you BadWord' }), {});
  assert.equal(s.calls.deleted, 1);
  assert.equal(s.engine.strikes.size(), 1);
  assert.equal(s.calls.runAction.length, 0);
});

test('merges two tripped rules into one log line', async () => {
  const s = setup();
  await enable({
    words: words({ steps: [{ strikes: 5, action: 'warn' }] }),
    links: { enabled: true, blockAllExceptAllowed: true, steps: [{ strikes: 5, action: 'warn' }] },
  });
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword http://evil.com' }), {});
  assert.equal(s.calls.sendLog.length, 1);
  assert.equal(s.calls.sendLog[0].event, 'modAction');
  const text = JSON.stringify(s.calls.sendLog[0].embed);
  assert.ok(text.includes('words') && text.includes('links'));
  assert.equal(s.calls.deleted, 1);
});

test('fires warn at the threshold and resets the rule', async () => {
  const s = setup({ runAction: () => ({ ok: false, reason: 'x' }) });
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ id: 'a', content: 'badword' }), {});
  assert.equal(s.calls.runAction.length, 0);
  await s.engine.handleMessage(s.ctx, s.msg({ id: 'b', content: 'badword' }), {});
  assert.equal(s.calls.runAction.length, 1);
  const p = s.calls.runAction[0];
  assert.equal(p.type, 'warn');
  assert.equal(p.targetId, 'u1');
  assert.equal(p.actor, botMember);
  assert.equal(p.guild.id, G);
  assert.ok(p.reason.length > 0);
  assert.equal(s.engine.strikes.size(), 0);
});

test('timeout step uses timeoutSeconds', async () => {
  const s = setup();
  await enable({ words: words({ steps: [{ strikes: 1, action: 'timeout', timeoutSeconds: 120 }] }) });
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword' }), {});
  assert.equal(s.calls.runAction[0].type, 'timeout');
  assert.equal(s.calls.runAction[0].durationSeconds, 120);
});

test('only the highest step fires when two are crossed', async () => {
  const s = setup();
  await enable({
    words: words({
      steps: [{ strikes: 1, action: 'warn' }, { strikes: 2, action: 'timeout', timeoutSeconds: 300 }],
    }),
  });
  await s.engine.handleMessage(s.ctx, s.msg({ id: 'a', content: 'badword' }), {});
  await s.engine.handleMessage(s.ctx, s.msg({ id: 'b', content: 'badword' }), {});
  assert.deepEqual(s.calls.runAction.map((p) => p.type), ['warn', 'timeout']);
});

test('a failed delete (10008) does not stop the warn', async () => {
  const s = setup();
  await enable({ words: words({ steps: [{ strikes: 1, action: 'warn' }] }) });
  const err = Object.assign(new Error('Unknown Message'), { code: 10008 });
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword', deleteError: err }), {});
  assert.equal(s.calls.runAction.length, 1);
  assert.equal((await listHistory(db, G)).length, 1);
});

test('runAction failure does not throw', async () => {
  for (const mode of ['reject', 'fail']) {
    const s = setup({
      runAction: () => {
        if (mode === 'reject') throw new Error('boom');
        return { ok: false, reason: 'bot_hierarchy' };
      },
    });
    await enable({ words: words({ steps: [{ strikes: 1, action: 'warn' }] }) });
    await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword' }), {});
    assert.equal(s.calls.deleted, 1);
    assert.equal(s.calls.sendLog.length, 1);
  }
});

test('writes a history row', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ id: 'm42', content: 'badword' }), {});
  const rows = await listHistory(db, G);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].rules, ['words']);
  assert.equal(rows[0].messageId, 'm42');
  assert.equal(rows[0].userId, 'u1');
  assert.ok(rows[0].actions.includes('delete'));
});

test('no log line when runAction already created a case', async () => {
  const s = setup();
  await enable({ words: words({ steps: [{ strikes: 1, action: 'warn' }] }) });
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword' }), {});
  assert.equal(s.calls.runAction.length, 1);
  assert.equal(s.calls.sendLog.length, 0);
  assert.equal((await listHistory(db, G))[0].caseNumber, 7);
});

test('invites run only with an invite code; own guild is allowed', async () => {
  const s = setup();
  let resolved = 0;
  const engine = createEngine({
    runAction: async () => ({ ok: true, modCase: { number: 1 }, warnings: [] }),
    sendLog: async () => null,
    resolveInvite: async () => { resolved++; return G; },
  });
  await enable({ invites: { enabled: true, blockAllExceptAllowed: true, steps: [{ strikes: 9, action: 'warn' }] } });
  await engine.handleMessage(s.ctx, s.msg({ content: 'no invite here' }), {});
  assert.equal(resolved, 0);
  await engine.handleMessage(s.ctx, s.msg({ content: 'join discord.gg/abc123' }), {});
  assert.equal(resolved, 1);
  assert.equal(engine.strikes.size(), 0);
  const foreign = createEngine({
    resolveInvite: async () => 'other',
    runAction: async () => ({ ok: false }),
    sendLog: async () => null,
  });
  await foreign.handleMessage(s.ctx, s.msg({ content: 'join discord.gg/abc123' }), {});
  assert.equal(foreign.strikes.size(), 1);
});

test('hostile messages never throw', async () => {
  const s = setup();
  await enable({
    words: words(),
    spam: { enabled: true, steps: [{ strikes: 9, action: 'warn' }] },
    links: { enabled: true, blockAllExceptAllowed: true },
  });
  for (const content of ['', 'x'.repeat(4000), 'مرحبا بالعالم', '<@1> '.repeat(200)]) {
    await s.engine.handleMessage(s.ctx, s.msg({ content, mentions: { users: { size: 200 }, roles: { size: 0 } } }), {});
  }
  await s.engine.handleMessage(s.ctx, s.msg({ content: undefined, attachments: { size: 3 } }), {});
  await s.engine.handleMessage(s.ctx, { broken: true }, {});
  await s.engine.handleMessage(s.ctx, null, {});
});

test('engine.prune prunes strikes and spam', async () => {
  const s = setup();
  await enable();
  await s.engine.handleMessage(s.ctx, s.msg({ content: 'badword' }), {});
  assert.equal(s.engine.strikes.size(), 1);
  s.engine.prune(1_000_000 + 86_400_000 + 1);
  assert.equal(s.engine.strikes.size(), 0);
});
