import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createRule, updateRule } from '../../src/features/autoresponder/store.js';
import { clearCache } from '../../src/features/autoresponder/cache.js';
import { createAutoresponderCommand, buildData } from '../../src/features/autoresponder/commands.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();
const flags = (over = {}) => ({ silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null, ...over });
const comp = (over = {}) => ({ version: 1, template: [{ t: 'text', v: 'hi ' }, { t: 'ph', name: 'user_name' }], gates: [], actions: [], ...over, flags: flags(over.flags) });
const base = (over = {}) => ({ guildId: G, trigger: 'hello', matchMode: 'exact', script: 'hi', compiled: comp(), createdBy: 'u1', ...over });

const boom = (name) => () => { throw new Error(`side effect: ${name}`); };

function env({ roles = [] } = {}) {
  const user = { id: 'staff', username: 'Sam', globalName: null, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'a.png', tag: 'Sam#0' };
  const guild = {
    id: G, name: 'Srv', ownerId: 'owner', memberCount: 5, createdTimestamp: 1_500_000_000_000, iconURL: () => 'i.png',
    channels: { cache: new Map() }, roles: { cache: new Map() }, members: { me: { id: 'bot' } },
  };
  const member = {
    id: 'staff', displayName: 'Sam', user, guild, permissions: { has: () => true },
    roles: { cache: new Map(roles.map((r) => [r, {}])), add: boom('roles.add'), remove: boom('roles.remove') },
    send: boom('member.send'), setNickname: boom('setNickname'),
  };
  const channel = { id: 'c1', name: 'general', send: boom('channel.send'), reply: boom('channel.reply') };
  const replies = [];
  const interaction = {
    guildId: G, channelId: 'c1', guild, member, user, channel, replies,
    inGuild: () => true,
    options: { getSubcommand: () => 'test', getString: (n) => (n === 'message' ? interaction.msg : null), getInteger: () => null },
    reply: async (p) => { replies.push(p); },
  };
  return { interaction, ctx: { db, client: { user: { id: 'bot' }, channels: { fetch: boom('channels.fetch') } } } };
}

const on = () => setFeature(db, G, 'autoresponder', { enabled: true });
async function dry(msg, over) {
  const e = env(over);
  e.interaction.msg = msg;
  await command.execute(e.interaction, e.ctx);
  return e.interaction.replies.at(-1);
}

test('the command definition has a required message option on test', () => {
  const sub = buildData().toJSON().options.find((o) => o.name === 'test');
  assert.equal(sub.options[0].name, 'message');
  assert.equal(sub.options[0].required, true);
});

test('a matching rule is shown with its passing gates and the text rendered for the invoking member', async () => {
  await on();
  const rule = await createRule(db, base({ compiled: comp({ gates: [{ fn: 'cooldown', seconds: 30 }, { fn: 'requireuser', userIds: ['staff'] }] }) }));
  const r = await dry('hello');
  assert.equal(r.flags, MessageFlags.Ephemeral);
  assert.ok(r.content.includes(t('en', 'autoresponder.test.rule', { id: rule.id, trigger: 'hello', mode: 'exact' })));
  assert.ok(r.content.includes(t('en', 'autoresponder.test.gate.pass', { gate: 'requireuser' })));
  assert.ok(r.content.includes(t('en', 'autoresponder.test.gate.cooldown', { seconds: 30 })));
  assert.ok(r.content.includes('hi Sam'));
  assert.ok(!r.content.includes(t('en', 'autoresponder.test.disabled')));
});

test('two matching rules show only the winner', async () => {
  await on();
  await createRule(db, base({ trigger: 'hello', matchMode: 'includes', compiled: comp({ template: [{ t: 'text', v: 'loser' }] }) }));
  const win = await createRule(db, base({ trigger: 'hello there', matchMode: 'includes', compiled: comp({ template: [{ t: 'text', v: 'winner' }] }) }));
  const r = await dry('hello there');
  assert.ok(r.content.includes('winner'));
  assert.ok(!r.content.includes('loser'));
  assert.ok(r.content.includes(t('en', 'autoresponder.test.rule', { id: win.id, trigger: 'hello there', mode: 'includes' })));
});

test('a failing requirerole gate shows fail for that gate and no text or actions', async () => {
  await on();
  await createRule(db, base({ compiled: comp({ gates: [{ fn: 'requirerole', roleIds: ['r9'] }], actions: [{ fn: 'react', emoji: 'A' }] }) }));
  const r = await dry('hello');
  assert.ok(r.content.includes(t('en', 'autoresponder.test.gate.fail', { gate: 'requirerole' })));
  assert.ok(!r.content.includes(t('en', 'autoresponder.test.text')));
  assert.ok(!r.content.includes(t('en', 'autoresponder.test.actions')));
  const ok = await dry('hello', { roles: ['r9'] });
  assert.ok(ok.content.includes(t('en', 'autoresponder.test.gate.pass', { gate: 'requirerole' })));
});

test('a disabled matching rule is tried and flagged', async () => {
  await on();
  const rule = await createRule(db, base());
  await updateRule(db, G, rule.id, { enabled: false });
  const r = await dry('hello');
  assert.ok(r.content.includes(t('en', 'autoresponder.test.disabled')));
  assert.ok(r.content.includes('hi Sam'));
});

test('no match replies test.none', async () => {
  await on();
  await createRule(db, base());
  assert.equal((await dry('something else')).content, t('en', 'autoresponder.test.none'));
});

test('the action list follows the execution order', async () => {
  await on();
  await createRule(db, base({
    compiled: comp({
      flags: { delete: true, sendTo: 'c7', deleteReplyAfter: 10, silent: true },
      actions: [
        { fn: 'react', emoji: 'A' }, { fn: 'setnick', text: 'Mr {user_name}' }, { fn: 'removerole', roleId: 'r2' },
        { fn: 'addrole', roleId: 'r1' }, { fn: 'reactreply', emoji: 'B' },
      ],
    }),
  }));
  const c = (await dry('hello')).content;
  const marks = [
    t('en', 'autoresponder.test.action.delete'),
    t('en', 'autoresponder.test.action.removerole', { detail: '<@&r2>' }),
    t('en', 'autoresponder.test.action.addrole', { detail: '<@&r1>' }),
    t('en', 'autoresponder.test.action.setnick', { detail: 'Mr Sam' }),
    t('en', 'autoresponder.test.action.sendto', { detail: '<#c7>' }),
    t('en', 'autoresponder.test.action.reactreply', { detail: 'B' }),
    t('en', 'autoresponder.test.action.delete_reply', { detail: 10 }),
    t('en', 'autoresponder.test.action.silent'),
  ];
  const at = marks.map((m) => c.indexOf(m));
  assert.ok(at.every((p) => p >= 0), `${at}\n${c}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(!c.includes(t('en', 'autoresponder.test.action.react', { detail: 'A' })), 'react is skipped after delete');
});

test('the dry run makes no Discord write, no database write and no log line, and fits 2000 characters', async () => {
  await on();
  const long = 'x'.repeat(1900);
  await createRule(db, base({
    compiled: comp({ template: [{ t: 'text', v: long }], gates: [{ fn: 'cooldown', seconds: 60 }], actions: [{ fn: 'addrole', roleId: 'r1' }], flags: { dm: true } }),
  }));
  const queries = [];
  const spy = { query: (sql, ...rest) => { queries.push(String(sql)); return db.query(sql, ...rest); } };
  const e = env();
  e.interaction.msg = 'hello';
  await command.execute(e.interaction, { ...e.ctx, db: spy });
  assert.ok(queries.length > 0);
  assert.ok(queries.every((q) => /^\s*SELECT/i.test(q)), queries.join(' | '));
  const r = e.interaction.replies.at(-1);
  assert.ok(r.content.length <= 2000);
  const { rows } = await db.query('SELECT 1 FROM autoresponder_cooldowns');
  assert.equal(rows.length, 0);
});

test('it uses the same guard: refused when the feature is off or for non-managers', async () => {
  assert.equal((await dry('hello')).content, t('en', 'common.featureOff', { command: '/autoresponder enable' }));
  await on();
  const e = env();
  e.interaction.msg = 'hello';
  e.interaction.member.permissions.has = () => false;
  await command.execute(e.interaction, e.ctx);
  assert.equal(e.interaction.replies.at(-1).content, t('en', 'common.notAllowed'));
});

test('every test key exists in en, fr and ar', () => {
  const fns = ['delete', 'addrole', 'removerole', 'setnick', 'react', 'reactreply', 'dm', 'sendto', 'embed', 'delete_reply', 'silent', 'reply', 'replyChannel', 'none'];
  const keys = [
    ...['none', 'rule', 'disabled', 'gates', 'gate.pass', 'gate.fail', 'gate.cooldown', 'text', 'text.empty', 'actions'].map((k) => `autoresponder.test.${k}`),
    ...fns.map((f) => `autoresponder.test.action.${f}`),
  ];
  for (const lang of ['en', 'fr', 'ar']) for (const k of keys) assert.notEqual(t(lang, k), k, `${lang} ${k}`);
});

test('delete with reply text and no dm or sendto shows the channel reply after the delete line', async () => {
  await on();
  await createRule(db, base({ compiled: comp({ flags: { delete: true } }) }));
  const c = (await dry('hello')).content;
  const del = c.indexOf(t('en', 'autoresponder.test.action.delete'));
  const route = c.indexOf(t('en', 'autoresponder.test.action.replyChannel'));
  assert.ok(del >= 0 && route > del, c);
  assert.ok(!c.includes(t('en', 'autoresponder.test.action.reply')));
});
