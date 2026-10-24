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
const R_ADMIN = '333333333333333333';
const C1 = '444444444444444444';
const U1 = '555555555555555555';
const U2 = '666666666666666666';

function setup() {
  const roles = new Map();
  const addRole = (id, name, { position = 1, admin = false } = {}) =>
    roles.set(id, { id, name, position, managed: false, permissions: { has: (p) => admin && p === 'Administrator' } });
  addRole(R1, 'one'); addRole(R2, 'two'); addRole(R_ADMIN, 'boss', { admin: true });
  const guild = { id: G, ownerId: 'owner', roles: { cache: roles }, channels: { cache: new Map([[C1, { id: C1, name: 'general' }]]) }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } } };
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
const SELECT = 3; const BUTTON = 2; const USER = 5; const ROLE = 6; const CHANNEL = 8;

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
const gates = (panelId) => drafts.get(panelId).draft.gates;

async function start() {
  const env = setup();
  await on();
  const panelId = await open(env);
  await press(env, panelId, 'nav', { values: ['conditions'] });
  return { env, panelId };
}
const pend = async (env, panelId, kind) => updated(await press(env, panelId, 'cond', { values: [kind] }));

test('PAGES has conditions before review', () => {
  assert.deepEqual(PAGES.slice(0, 3), ['basics', 'reply', 'conditions']);
  assert.equal(PAGES.at(-1), 'review');
});

test('the conditions page stays within 5 rows, 25 options and 100 character ids in every state and language', () => {
  const userId = '9'.repeat(20);
  const panelId = 'z'.repeat(8);
  const gateList = [{ fn: 'cooldown', seconds: 5 }, { fn: 'requirerole', ids: [R1] }];
  for (const lang of ['en', 'fr', 'ar']) {
    for (const pending of [null, 'cooldown', 'requirerole', 'denyrole', 'requireperm', 'denyperm', 'requirechannel', 'denychannel', 'requireuser']) {
      for (const g of [[], gateList]) {
        const entry = { panelId, userId, page: 'conditions', pending, draft: { ...newDraft(), gates: g } };
        const payload = panelPayload(lang, entry);
        assert.ok(payload.components.length <= 5, `${pending} rows`);
        for (const c of flat(payload.components)) {
          assert.ok(c.custom_id.length <= 100);
          assert.ok((c.options ?? []).length <= 25);
          for (const o of c.options ?? []) assert.ok(o.label.length <= 100);
        }
      }
    }
  }
});

test('the page shows the kind select first, then the input that matches the pending kind', async () => {
  const { env, panelId } = await start();
  const none = updated(await press(env, panelId, 'nav', { values: ['conditions'] }));
  assert.deepEqual(kinds(none), ['nav', 'cond']);
  const sel = flat(none.components)[1];
  assert.deepEqual(sel.options.map((o) => o.value),
    ['cooldown', 'requirerole', 'denyrole', 'requireperm', 'denyperm', 'requirechannel', 'denychannel', 'requireuser']);
  const expect = {
    cooldown: [['nav', 'cond', 'bcool'], [SELECT, SELECT, BUTTON]],
    requirerole: [['nav', 'cond', 'prole'], [SELECT, SELECT, ROLE]],
    denyrole: [['nav', 'cond', 'prole'], [SELECT, SELECT, ROLE]],
    requireperm: [['nav', 'cond', 'pperm', 'bperm'], [SELECT, SELECT, SELECT, BUTTON]],
    denyperm: [['nav', 'cond', 'pperm', 'bperm'], [SELECT, SELECT, SELECT, BUTTON]],
    requirechannel: [['nav', 'cond', 'pchan'], [SELECT, SELECT, CHANNEL]],
    denychannel: [['nav', 'cond', 'pchan'], [SELECT, SELECT, CHANNEL]],
    requireuser: [['nav', 'cond', 'puser'], [SELECT, SELECT, USER]],
  };
  for (const [kind, [ids, ts]] of Object.entries(expect)) {
    const p = await pend(env, panelId, kind);
    assert.deepEqual(kinds(p), ids, kind);
    assert.deepEqual(types(p), ts, kind);
    assert.equal(drafts.get(panelId).pending, kind);
    assert.ok(p.components.length <= 5);
  }
  const perm = await pend(env, panelId, 'requireperm');
  const opts = flat(perm.components)[2].options.map((o) => o.value);
  assert.equal(opts.length <= 25, true);
  assert.equal(new Set(opts).size, opts.length);
  for (const must of ['ManageMessages', 'Administrator', 'ViewChannel', 'CreateInstantInvite']) assert.ok(opts.includes(must));
  const role = flat((await pend(env, panelId, 'requirerole')).components)[2];
  assert.equal(role.max_values, 10);
  assert.equal(role.min_values, 1);
  const bogus = await press(env, panelId, 'cond', { values: ['hax'] });
  assert.equal(drafts.get(panelId).pending, 'requirerole');
  assert.ok(updated(bogus));
  await press(env, panelId, 'cond', { values: [] });
  const nav = await press(env, panelId, 'nav', { values: ['basics'] });
  assert.ok(updated(nav));
  assert.equal(drafts.get(panelId).pending, null);
});

test('cooldown: the button opens the modal and 30 adds {cooldown:30}', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'cooldown');
  const click = await press(env, panelId, 'bcool');
  const [kind, modal] = last(click);
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'mcooldown');
  assert.ok(modal.title.length <= 45);
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, 'seconds');
  assert.ok(input.label.length <= 45);
  const done = await submitModal(env, panelId, 'mcooldown', { seconds: '30' });
  assert.deepEqual(gates(panelId), [{ fn: 'cooldown', seconds: '30' }]);
  assert.ok(generateScript(drafts.get(panelId).draft).includes('{cooldown:30}'));
  assert.ok(updated(done));
  assert.equal(drafts.get(panelId).pending, null);
});

test('cooldown 0, 604801 and abc are refused with the compiler error and the draft is unchanged', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'cooldown');
  for (const [value, code] of [['0', 'COOLDOWN_RANGE'], ['604801', 'COOLDOWN_RANGE'], ['abc', 'BAD_ARGUMENT']]) {
    const i = await submitModal(env, panelId, 'mcooldown', { seconds: value });
    assert.deepEqual(gates(panelId), [], value);
    assert.equal(updated(i), undefined);
    assert.equal(last(i)[0], 'followUp');
    assert.ok(last(i)[1].content.includes(t('en', `autoresponder.error.${code}`, { detail: `"${value}"` })), `${value} ${last(i)[1].content}`);
  }
  assert.equal(drafts.get(panelId).pending, 'cooldown');
});

test('a second cooldown replaces the first', async () => {
  const { env, panelId } = await start();
  await submitModal(env, panelId, 'mcooldown', { seconds: '30' });
  await submitModal(env, panelId, 'mcooldown', { seconds: '60' });
  assert.deepEqual(gates(panelId), [{ fn: 'cooldown', seconds: '60' }]);
});

test('free text with a closing brace is refused with the noBrace message', async () => {
  const { env, panelId } = await start();
  const i = await submitModal(env, panelId, 'mcooldown', { seconds: '30}{delete' });
  assert.deepEqual(gates(panelId), []);
  assert.equal(last(i)[1].content, t('en', 'autoresponder.builder.noBrace'));
  await pend(env, panelId, 'requireperm');
  const p = await submitModal(env, panelId, 'mperm', { perm: 'Manage}' });
  assert.equal(last(p)[1].content, t('en', 'autoresponder.builder.noBrace'));
});

test('role pickers add requirerole and denyrole, two roles join with a pipe', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'requirerole');
  const one = await press(env, panelId, 'prole', { values: [R1] });
  assert.deepEqual(gates(panelId), [{ fn: 'requirerole', ids: [R1] }]);
  assert.equal(drafts.get(panelId).pending, null);
  assert.ok(updated(one));
  await pend(env, panelId, 'denyrole');
  await press(env, panelId, 'prole', { values: [R1, R2] });
  const script = generateScript(drafts.get(panelId).draft);
  assert.ok(script.includes(`{requirerole:<@&${R1}>}`));
  assert.ok(script.includes(`{denyrole:<@&${R1}>|<@&${R2}>}`));
});

test('a role with staff powers is fine as a requirement: the compiler only refuses it for role actions', async () => {
  // Requiring or blocking a role grants nothing, so the language accepts it in gates (ROLE_DANGEROUS is for addrole/removerole).
  const { env, panelId } = await start();
  await pend(env, panelId, 'requirerole');
  const i = await press(env, panelId, 'prole', { values: [R_ADMIN] });
  assert.deepEqual(gates(panelId), [{ fn: 'requirerole', ids: [R_ADMIN] }]);
  assert.ok(updated(i));
});

test('permission pick, and the Other modal accepts ManageMessages and refuses Nope', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'requireperm');
  await press(env, panelId, 'pperm', { values: ['BanMembers'] });
  assert.deepEqual(gates(panelId), [{ fn: 'requireperm', perms: ['BanMembers'] }]);
  await pend(env, panelId, 'denyperm');
  const click = await press(env, panelId, 'bperm');
  const [kind, modal] = last(click);
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'mperm');
  assert.equal(modal.components[0].components[0].custom_id, 'perm');
  await submitModal(env, panelId, 'mperm', { perm: 'ManageMessages' });
  assert.deepEqual(gates(panelId).at(-1), { fn: 'denyperm', perms: ['ManageMessages'] });
  const before = gates(panelId).length;
  await pend(env, panelId, 'requireperm');
  const bad = await submitModal(env, panelId, 'mperm', { perm: 'Nope' });
  assert.equal(gates(panelId).length, before);
  assert.ok(last(bad)[1].content.includes(t('en', 'autoresponder.error.INVALID_PERMISSION', { detail: '"Nope"' })));
});

test('channel and user pickers add their gates', async () => {
  const { env, panelId } = await start();
  await pend(env, panelId, 'requirechannel');
  await press(env, panelId, 'pchan', { values: [C1] });
  await pend(env, panelId, 'requireuser');
  await press(env, panelId, 'puser', { values: [U1, U2] });
  assert.deepEqual(gates(panelId), [{ fn: 'requirechannel', ids: [C1] }, { fn: 'requireuser', ids: [U1, U2] }]);
  await pend(env, panelId, 'denychannel');
  await press(env, panelId, 'pchan', { values: [C1] });
  assert.equal(gates(panelId).at(-1).fn, 'denychannel');
});

test('forged or empty values and a wrong pending kind never throw and never change the draft', async () => {
  const { env, panelId } = await start();
  for (const action of ['prole', 'pperm', 'pchan', 'puser', 'rmgate', 'cond']) {
    for (const values of [undefined, [], ['1}{delete'], ['zzz']]) {
      const i = await press(env, panelId, action, { values });
      assert.ok(i.calls.length >= 1, `${action} answered`);
    }
  }
  await pend(env, panelId, 'requirerole');
  const forged = await press(env, panelId, 'prole', { values: ['1}{delete'] });
  assert.ok(forged.calls.length >= 1);
  const notPerm = await press(env, panelId, 'pperm', { values: ['BanMembers'] });
  assert.ok(notPerm.calls.length >= 1);
  assert.deepEqual(gates(panelId), []);
  for (const action of ['mcooldown', 'mperm']) {
    const click = await press(env, panelId, action);
    assert.equal(click.calls.length, 1);
    assert.equal(last(click)[0], 'reply');
  }
  const clickButton = await press(env, panelId, 'bperm');
  assert.ok(clickButton.calls.length >= 1);
  assert.deepEqual(gates(panelId), []);
});

test('rmgate lists the gates and removes exactly the chosen one', async () => {
  const { env, panelId } = await start();
  const empty = updated(await press(env, panelId, 'nav', { values: ['conditions'] }));
  assert.ok(!kinds(empty).includes('rmgate'));
  await submitModal(env, panelId, 'mcooldown', { seconds: '30' });
  await pend(env, panelId, 'requirerole');
  await press(env, panelId, 'prole', { values: [R1] });
  await pend(env, panelId, 'requireperm');
  await press(env, panelId, 'pperm', { values: ['BanMembers'] });
  const page = updated(await press(env, panelId, 'nav', { values: ['conditions'] }));
  const rm = flat(page.components).find((c) => c.custom_id.split(':')[2] === 'rmgate');
  assert.equal(rm.options.length, 3);
  assert.ok(page.components.length <= 5);
  const i = await press(env, panelId, 'rmgate', { values: ['1'] });
  assert.deepEqual(gates(panelId).map((g) => g.fn), ['cooldown', 'requireperm']);
  assert.ok(updated(i));
  const out = await press(env, panelId, 'rmgate', { values: ['9'] });
  assert.equal(gates(panelId).length, 2);
  assert.ok(out.calls.length >= 1);
});

test('Save after conditions stores a rule whose compiled gates match', async () => {
  const { env, panelId } = await start();
  await submitModal(env, panelId, 'mtrigger', { trigger: 'hi' });
  await submitModal(env, panelId, 'mtext', { text: 'yo' });
  await submitModal(env, panelId, 'mcooldown', { seconds: '30' });
  await pend(env, panelId, 'requirerole');
  await press(env, panelId, 'prole', { values: [R1, R2] });
  await pend(env, panelId, 'denyperm');
  await press(env, panelId, 'pperm', { values: ['BanMembers'] });
  await press(env, panelId, 'save');
  const [rule] = await listRules(db, G);
  assert.deepEqual(rule.compiled.gates, [
    { fn: 'cooldown', seconds: 30 },
    { fn: 'requirerole', roleIds: [R1, R2] },
    { fn: 'denyperm', perms: ['BanMembers'] },
  ]);
});

test('every conditions i18n key exists in en, fr and ar, with short labels', () => {
  const kindsList = ['cooldown', 'requirerole', 'denyrole', 'requireperm', 'denyperm', 'requirechannel', 'denychannel', 'requireuser'];
  const keys = [
    'page.conditions', 'noBrace', 'tooMany',
    ...kindsList.map((k) => `cond.kind.${k}`),
    'cond.ph.kind', 'cond.ph.role', 'cond.ph.perm', 'cond.ph.channel', 'cond.ph.user', 'cond.ph.remove',
    'cond.btn.cooldown', 'cond.btn.permOther', 'cond.modal.cooldown', 'cond.modal.perm', 'cond.input.seconds', 'cond.input.perm',
  ].map((k) => `autoresponder.builder.${k}`);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const key of ['cond.modal.cooldown', 'cond.modal.perm', 'cond.input.seconds', 'cond.input.perm', ...kindsList.map((k) => `cond.kind.${k}`)]) {
      assert.ok(t(lang, `autoresponder.builder.${key}`).length <= 45, `${lang} ${key}`);
    }
    for (const key of ['cond.btn.cooldown', 'cond.btn.permOther']) assert.ok(t(lang, `autoresponder.builder.${key}`).length <= 80);
  }
  assert.notEqual(t('fr', 'autoresponder.builder.noBrace'), t('en', 'autoresponder.builder.noBrace'));
});
