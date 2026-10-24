import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { listRules } from '../../src/features/autoresponder/store.js';
import { clearCache } from '../../src/features/autoresponder/cache.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';
import { drafts } from '../../src/features/autoresponder/builder/drafts.js';
import { builderId, parseBuilderId, PAGES, panelPayload } from '../../src/features/autoresponder/builder/panel.js';
import { newDraft } from '../../src/features/autoresponder/builder/draft.js';
import { generateScript } from '../../src/features/autoresponder/builder/generate.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();
const R1 = '111111111111111111';
const R2 = '222222222222222222';
const R3 = '999999999999999999';
const R_ADMIN = '333333333333333333';
const R_HIGH = '777777777777777777';
const R_MID = '888888888888888888';

function setup() {
  const roles = new Map();
  const addRole = (id, name, { position = 1, admin = false } = {}) =>
    roles.set(id, { id, name, position, managed: false, permissions: { has: (p) => admin && p === 'Administrator' } });
  addRole(R1, 'one'); addRole(R2, 'two'); addRole(R3, 'three');
  addRole(R_ADMIN, 'boss', { admin: true });
  addRole(R_HIGH, 'high', { position: 12 }); // above the bot (10)
  addRole(R_MID, 'mid', { position: 7 }); // below the bot, above the writer (5)
  const guild = { id: G, ownerId: 'owner', roles: { cache: roles }, channels: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } } };
  const logChannel = { isTextBased: () => true, send: async () => ({ id: 'log1', channelId: 'logch' }) };
  const ctx = { db, client: { user: { id: 'bot' }, channels: { fetch: async () => logChannel } } };
  const member = { id: 'staff', permissions: { has: () => true }, roles: { highest: { position: 5 }, cache: new Map() }, guild };
  return { guild, ctx, member };
}

function fake(env, extra = {}) {
  const calls = [];
  const i = {
    guildId: G, guild: env.guild, member: env.member, user: { id: extra.userId ?? 'staff' }, calls,
    deferred: false, replied: false,
    inGuild: () => true,
    isModalSubmit: () => Boolean(extra.fields),
    isFromMessage: () => true,
    values: extra.values,
    customId: extra.customId,
    options: { getSubcommand: () => extra.sub, getString: () => null, getInteger: () => null },
    fields: { getTextInputValue: (k) => (extra.fields ?? {})[k] ?? '' },
    update: async (p) => { i.replied = true; calls.push(['update', p]); },
    reply: async (p) => { i.replied = true; calls.push(['reply', p]); },
    showModal: async (m) => { calls.push(['showModal', m.toJSON()]); },
    deferUpdate: async () => { i.deferred = true; calls.push(['deferUpdate']); },
    editReply: async (p) => { calls.push(['editReply', p]); },
    followUp: async (p) => { calls.push(['followUp', p]); },
  };
  return i;
}

const on = async () => {
  await setFeature(db, G, 'logging', { enabled: true, config: { channels: { default: 'logch' } } });
  await setFeature(db, G, 'autoresponder', { enabled: true });
};
const last = (i) => i.calls.at(-1);
const flat = (components) => components.flatMap((r) => r.toJSON().components);
const kinds = (payload) => flat(payload.components).map((c) => c.custom_id.split(':')[2]);
const types = (payload) => flat(payload.components).map((c) => c.type);
const updated = (i) => i.calls.find((x) => x[0] === 'update')?.[1];
const SELECT = 3; const BUTTON = 2; const ROLE = 6;

async function open(env) {
  const i = fake(env, { sub: 'builder' });
  await command.execute(i, env.ctx);
  const [, payload] = last(i);
  return parseBuilderId(flat(payload.components)[0].custom_id).panelId;
}

async function press(env, panelId, action, { extra, userId = 'staff', ...rest } = {}) {
  const i = fake(env, { customId: builderId(action, userId, panelId, extra), userId, ...rest });
  await command.components.handle(i, env.ctx);
  return i;
}
const submitModal = (env, panelId, action, fields) => press(env, panelId, action, { fields });
const acts = (panelId) => drafts.get(panelId).draft.actions;

async function start() {
  const env = setup();
  await on();
  const panelId = await open(env);
  await press(env, panelId, 'nav', { values: ['actions'] });
  return { env, panelId };
}
const pend = async (env, panelId, kind) => updated(await press(env, panelId, 'act', { values: [kind] }));
const refusedWith = (i, code, detail) =>
  assert.ok(last(i)[1].content.includes(t('en', `autoresponder.error.${code}`, detail ? { detail: `"${detail}"` } : {})), `${code}: ${last(i)[1]?.content}`);

test('PAGES has conditions then actions before review', () => {
  assert.deepEqual(PAGES.slice(2), ['conditions', 'actions', 'review']);
});

test('the actions page stays within 5 rows, 25 options and 100 character ids in every state and language', () => {
  const userId = '9'.repeat(20);
  const panelId = 'z'.repeat(8);
  const list = [{ fn: 'addrole', id: R1 }, { fn: 'setnick', text: 'x' }, { fn: 'react', emoji: '🔥' }];
  for (const lang of ['en', 'fr', 'ar']) {
    for (const pending of [null, 'addrole', 'removerole', 'setnick', 'react', 'reactreply']) {
      for (const actions of [[], list]) {
        const payload = panelPayload(lang, { panelId, userId, page: 'actions', pending, draft: { ...newDraft(), actions } });
        assert.ok(payload.components.length <= 5);
        for (const c of flat(payload.components)) {
          assert.ok(c.custom_id.length <= 100);
          assert.ok((c.options ?? []).length <= 25);
        }
      }
    }
  }
});

test('the page shows the kind select, then the input that matches the pending kind', async () => {
  const { env, panelId } = await start();
  const none = updated(await press(env, panelId, 'nav', { values: ['actions'] }));
  assert.deepEqual(kinds(none), ['nav', 'act']);
  assert.deepEqual(flat(none.components)[1].options.map((o) => o.value), ['addrole', 'removerole', 'setnick', 'react', 'reactreply']);
  const expect = {
    addrole: [['nav', 'act', 'prole'], [SELECT, SELECT, ROLE]],
    removerole: [['nav', 'act', 'prole'], [SELECT, SELECT, ROLE]],
    setnick: [['nav', 'act', 'bnick'], [SELECT, SELECT, BUTTON]],
    react: [['nav', 'act', 'bemoji'], [SELECT, SELECT, BUTTON]],
    reactreply: [['nav', 'act', 'bemoji'], [SELECT, SELECT, BUTTON]],
  };
  for (const [kind, [ids, ts]] of Object.entries(expect)) {
    const p = await pend(env, panelId, kind);
    assert.deepEqual(kinds(p), ids, kind);
    assert.deepEqual(types(p), ts, kind);
    assert.equal(drafts.get(panelId).pending, kind);
  }
  const role = flat((await pend(env, panelId, 'addrole')).components)[2];
  assert.equal(role.max_values, 1);
  assert.equal((await press(env, panelId, 'act', { values: ['hax'] })).calls.length, 1);
  assert.equal(drafts.get(panelId).pending, 'addrole');
});

test('addrole with a normal role adds {addrole:<@&id>} and clears the pending kind', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'addrole');
  const i = await press(env, panelId, 'prole', { values: [R1] });
  assert.deepEqual(acts(panelId), [{ fn: 'addrole', id: R1 }]);
  assert.ok(generateScript(drafts.get(panelId).draft).includes(`{addrole:<@&${R1}>}`));
  assert.equal(drafts.get(panelId).pending, null);
  assert.ok(updated(i));
  await pend(env, panelId, 'removerole');
  await press(env, panelId, 'prole', { values: [R2] });
  assert.deepEqual(acts(panelId).at(-1), { fn: 'removerole', id: R2 });
});

test('a role above the bot, above the writer, or with staff powers is refused and reverted', async () => {
  const { env, panelId } = await start();
  for (const [role, code, detail] of [[R_HIGH, 'ROLE_ABOVE_BOT', 'high'], [R_MID, 'ROLE_ABOVE_YOU', 'mid'], [R_ADMIN, 'ROLE_DANGEROUS', 'boss']]) {
    await pend(env, panelId, 'addrole');
    const i = await press(env, panelId, 'prole', { values: [role] });
    assert.deepEqual(acts(panelId), [], code);
    assert.equal(updated(i), undefined);
    assert.equal(last(i)[0], 'followUp');
    refusedWith(i, code, detail);
    assert.equal(drafts.get(panelId).pending, 'addrole');
  }
});

test('a fourth role or nickname action is refused with TOO_MANY_ROLE_ACTIONS', async () => {
  const { env, panelId } = await start();
  for (const role of [R1, R2, R3]) {
    await pend(env, panelId, 'addrole');
    await press(env, panelId, 'prole', { values: [role] });
  }
  assert.equal(acts(panelId).length, 3);
  await pend(env, panelId, 'setnick');
  const i = await submitModal(env, panelId, 'mnick', { nick: 'Bob' });
  assert.equal(acts(panelId).length, 3);
  refusedWith(i, 'TOO_MANY_ROLE_ACTIONS');
  await pend(env, panelId, 'removerole');
  refusedWith(await press(env, panelId, 'prole', { values: [R1] }), 'TOO_MANY_ROLE_ACTIONS');
  assert.equal(acts(panelId).length, 3);
});

test('setnick: the button opens the modal, plain text is added, 33 characters are refused', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'setnick');
  const [kind, modal] = last(await press(env, panelId, 'bnick'));
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'mnick');
  assert.ok(modal.title.length <= 45);
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, 'nick');
  assert.equal(input.max_length, 32);
  assert.ok(input.label.length <= 45);
  await submitModal(env, panelId, 'mnick', { nick: 'Mr. Bot' });
  assert.deepEqual(acts(panelId), [{ fn: 'setnick', text: 'Mr. Bot' }]);
  await pend(env, panelId, 'setnick');
  const long = await submitModal(env, panelId, 'mnick', { nick: 'x'.repeat(33) });
  assert.equal(acts(panelId).length, 1);
  refusedWith(long, 'NICK_TOO_LONG', '32');
});

test('a nickname with a pipe and a backslash is escaped and compiles to the same text', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'setnick');
  const nick = 'a|b\\c';
  await submitModal(env, panelId, 'mnick', { nick });
  assert.equal(acts(panelId)[0].text, nick);
  assert.ok(generateScript(drafts.get(panelId).draft).includes('{setnick:a\\|b\\\\c}'));
  await press(env, panelId, 'nav', { values: ['basics'] });
  await submitModal(env, panelId, 'mtrigger', { trigger: 'hi' });
  await submitModal(env, panelId, 'mtext', { text: 'yo' });
  await press(env, panelId, 'save');
  const [rule] = await listRules(db, G);
  assert.equal(rule.compiled.actions[0].text, nick);
});

test('reactions: react adds, the sixth is refused, a custom emoji of another server is refused', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'react');
  const [kind, modal] = last(await press(env, panelId, 'bemoji'));
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'memoji');
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, 'emoji');
  assert.equal(input.max_length, 64);
  assert.ok(modal.title.length <= 45 && input.label.length <= 45);
  await submitModal(env, panelId, 'memoji', { emoji: '🔥' });
  assert.deepEqual(acts(panelId), [{ fn: 'react', emoji: '🔥' }]);
  for (const [k, e] of [['reactreply', '👍'], ['react', '😀'], ['reactreply', '🎉'], ['react', '🚀']]) {
    await pend(env, panelId, k);
    await submitModal(env, panelId, 'memoji', { emoji: e });
  }
  assert.equal(acts(panelId).length, 5);
  await pend(env, panelId, 'react');
  refusedWith(await submitModal(env, panelId, 'memoji', { emoji: '🌟' }), 'TOO_MANY_REACTIONS');
  assert.equal(acts(panelId).length, 5);
  const fresh = await start();
  await pend(fresh.env, fresh.panelId, 'react');
  const foreign = await submitModal(fresh.env, fresh.panelId, 'memoji', { emoji: '<:foo:123456789012345678>' });
  refusedWith(foreign, 'INVALID_EMOJI', '<:foo:123456789012345678>');
  assert.deepEqual(acts(fresh.panelId), []);
  const junk = await submitModal(fresh.env, fresh.panelId, 'memoji', { emoji: 'notanemoji' });
  refusedWith(junk, 'INVALID_EMOJI', 'notanemoji');
});

test('free text with a closing brace is refused with the noBrace message', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'setnick');
  const n = await submitModal(env, panelId, 'mnick', { nick: 'a}b' });
  assert.equal(last(n)[1].content, t('en', 'autoresponder.builder.noBrace'));
  await pend(env, panelId, 'react');
  const e = await submitModal(env, panelId, 'memoji', { emoji: '}' });
  assert.equal(last(e)[1].content, t('en', 'autoresponder.builder.noBrace'));
  assert.deepEqual(acts(panelId), []);
});

test('forged values, the wrong pending kind and non-modal calls never throw and never change the draft', async () => {
  const { env, panelId } = await start();
  for (const action of ['prole', 'rmact', 'act']) {
    for (const values of [undefined, [], ['1}{delete'], ['zzz']]) {
      assert.ok((await press(env, panelId, action, { values })).calls.length >= 1, action);
    }
  }
  await pend(env, panelId, 'addrole');
  assert.ok((await press(env, panelId, 'prole', { values: ['1}{delete'] })).calls.length >= 1);
  assert.ok((await press(env, panelId, 'prole', { values: [R1, R2] })).calls.length >= 1);
  assert.deepEqual(acts(panelId), []);
  for (const action of ['mnick', 'memoji']) {
    const click = await press(env, panelId, action);
    assert.equal(click.calls.length, 1);
    assert.equal(last(click)[0], 'reply');
  }
  assert.ok((await press(env, panelId, 'bnick')).calls.length >= 1);
  assert.ok((await press(env, panelId, 'bemoji')).calls.length >= 1);
  const wrong = await submitModal(env, panelId, 'memoji', { emoji: '🔥' });
  assert.ok(wrong.calls.length >= 1);
  assert.deepEqual(acts(panelId), []);
});

test('rmact lists the actions and removes exactly the chosen one', async () => {
  const { env, panelId } = await start();
  const empty = updated(await press(env, panelId, 'nav', { values: ['actions'] }));
  assert.ok(!kinds(empty).includes('rmact'));
  await pend(env, panelId, 'addrole');
  await press(env, panelId, 'prole', { values: [R1] });
  await pend(env, panelId, 'react');
  await submitModal(env, panelId, 'memoji', { emoji: '🔥' });
  await pend(env, panelId, 'setnick');
  await submitModal(env, panelId, 'mnick', { nick: 'Bob' });
  const page = updated(await press(env, panelId, 'nav', { values: ['actions'] }));
  const rm = flat(page.components).find((c) => c.custom_id.split(':')[2] === 'rmact');
  assert.equal(rm.options.length, 3);
  assert.ok(page.components.length <= 5);
  const i = await press(env, panelId, 'rmact', { values: ['1'] });
  assert.deepEqual(acts(panelId).map((a) => a.fn), ['addrole', 'setnick']);
  assert.ok(updated(i));
  assert.ok((await press(env, panelId, 'rmact', { values: ['9'] })).calls.length >= 1);
  assert.equal(acts(panelId).length, 2);
});

test('Save stores compiled actions that match the draft', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'addrole');
  await press(env, panelId, 'prole', { values: [R1] });
  await pend(env, panelId, 'react');
  await submitModal(env, panelId, 'memoji', { emoji: '🔥' });
  await pend(env, panelId, 'reactreply');
  await submitModal(env, panelId, 'memoji', { emoji: '👍' });
  await pend(env, panelId, 'setnick');
  await submitModal(env, panelId, 'mnick', { nick: 'Bob' });
  await press(env, panelId, 'nav', { values: ['basics'] });
  await submitModal(env, panelId, 'mtrigger', { trigger: 'hi' });
  await submitModal(env, panelId, 'mtext', { text: 'yo' });
  await press(env, panelId, 'save');
  const [rule] = await listRules(db, G);
  assert.deepEqual(rule.compiled.actions.map((a) => [a.fn, a.roleId ?? a.emoji ?? a.text]),
    [['addrole', R1], ['react', '🔥'], ['reactreply', '👍'], ['setnick', 'Bob']]);
});

test('every actions i18n key exists in en, fr and ar, with short labels', () => {
  const list = ['addrole', 'removerole', 'setnick', 'react', 'reactreply'];
  const keys = [
    'page.actions', ...list.map((k) => `act.kind.${k}`),
    'act.ph.kind', 'act.ph.role', 'act.ph.remove', 'act.btn.nick', 'act.btn.emoji',
    'act.modal.nick', 'act.modal.emoji', 'act.input.nick', 'act.input.emoji',
  ].map((k) => `autoresponder.builder.${k}`);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const key of ['act.modal.nick', 'act.modal.emoji', 'act.input.nick', 'act.input.emoji', ...list.map((k) => `act.kind.${k}`)]) {
      assert.ok(t(lang, `autoresponder.builder.${key}`).length <= 45, `${lang} ${key}`);
    }
  }
});
