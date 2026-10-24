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
import { newDraft, patch } from '../../src/features/autoresponder/builder/draft.js';
import { generateScript } from '../../src/features/autoresponder/builder/generate.js';
import { summaryLines } from '../../src/features/autoresponder/builder/summary.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();
const R1 = '111111111111111111';
const R2 = '222222222222222222';

function setup({ manager = true } = {}) {
  const roles = new Map();
  const addRole = (id, name, position = 1) =>
    roles.set(id, { id, name, position, managed: false, permissions: { has: () => false } });
  addRole(R1, 'one'); addRole(R2, 'two');
  const guild = { id: G, name: 'Srv', memberCount: 5, createdTimestamp: 1_500_000_000_000, iconURL: () => 'i.png', ownerId: 'owner', roles: { cache: roles }, channels: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } } };
  const logChannel = { isTextBased: () => true, send: async () => ({ id: 'log1', channelId: 'logch' }) };
  const ctx = { db, client: { user: { id: 'bot' }, channels: { fetch: async () => logChannel } } };
  const member = { id: 'staff', permissions: { has: () => manager }, roles: { highest: { position: 5 }, cache: new Map() }, guild, displayName: 'Sam', user: { id: 'staff', username: 'Sam', globalName: null, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'a.png', tag: 'Sam#0' } };
  return { guild, ctx, member };
}

function fake(env, extra = {}) {
  const calls = [];
  const i = {
    guildId: G, guild: env.guild, member: env.member, user: { id: extra.userId ?? 'staff', username: 'Sam', globalName: null, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'a.png', tag: 'Sam#0' }, calls,
    deferred: false, replied: false,
    channel: null, channelId: 'c1',
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
const updated = (i) => i.calls.find((x) => x[0] === 'update')?.[1];

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
const submit = (env, panelId, action, fields) => press(env, panelId, action, { fields });
const rnd = (panelId) => drafts.get(panelId).draft.random;
const script = (panelId) => generateScript(drafts.get(panelId).draft);
const err = (code) => t('en', `autoresponder.error.${code}`, { detail: '' }).split('{')[0].trim().slice(0, 25);
const said = (i, text) => assert.ok(last(i)[1].content.includes(text), `${text} <- ${last(i)[1]?.content}`);

async function start(mode = 'startswith') {
  const env = setup();
  await on();
  const panelId = await open(env);
  drafts.update(panelId, { draft: patch(newDraft(), { trigger: 'hi', matchMode: mode, text: 'yo' }) });
  return { env, panelId };
}

test('PAGES has random after actions and before review', () => {
  assert.deepEqual(PAGES, ['basics', 'reply', 'conditions', 'actions', 'random', 'review']);
});

test('the new pages and views stay within 5 rows, 25 options and 100 character ids in every language', () => {
  const userId = '9'.repeat(20);
  const panelId = 'z'.repeat(8);
  const full = {
    ...newDraft(),
    random: {
      ranges: [{ min: 1, max: 6 }, { min: 1, max: 2 }, { min: 3, max: 4 }, { min: 5, max: 6 }],
      choosers: [{ kind: 'choose', options: ['a', 'b'] }, { kind: 'weighted', weights: [60, 40] }],
      locked: [['x', 'y']],
    },
    argChecks: Array.from({ length: 20 }, (_, k) => ({ n: k + 1, type: k % 2 ? 'user' : null })),
    gates: Array.from({ length: 10 }, () => ({ fn: 'cooldown', seconds: 5 })),
    actions: [{ fn: 'addrole', id: R1, target: 1 }],
  };
  const cases = [
    ['random', null, newDraft()], ['random', null, full],
    ['conditions', 'requirearg', newDraft()], ['conditions', 'requirearg', full],
    ['conditions', 'argtype:1', full], ['conditions', 'argtype:2', full], ['conditions', null, full],
    ['actions', 'addrole', full], ['actions', 'removerole', { ...full, argChecks: [{ n: 1, type: 'user' }] }],
    ['actions', 'addrole', newDraft()],
  ];
  for (const lang of ['en', 'fr', 'ar']) {
    for (const [page, pending, draft] of cases) {
      const payload = panelPayload(lang, { panelId, userId, page, pending, target: 1, draft });
      assert.ok(payload.components.length <= 5, `${lang} ${page} ${pending} rows`);
      assert.ok(payload.content.length <= 2000);
      for (const c of flat(payload.components)) {
        assert.ok(c.custom_id.length <= 100);
        assert.ok((c.options ?? []).length <= 25, `${lang} ${page} options`);
        for (const o of c.options ?? []) assert.ok(o.label.length <= 100);
      }
    }
  }
});

test('the Random page lists the kinds and a remove select only when something exists', async () => {
  const { env, panelId } = await start();
  const page = updated(await press(env, panelId, 'nav', { values: ['random'] }));
  assert.deepEqual(kinds(page), ['nav', 'rnd']);
  assert.deepEqual(flat(page.components)[1].options.map((o) => o.value), ['range', 'choose', 'weightedchoose', 'lockedchoose']);
  await submit(env, panelId, 'mrange', { min: '1', max: '6' });
  const after2 = updated(await press(env, panelId, 'nav', { values: ['random'] }));
  assert.deepEqual(kinds(after2), ['nav', 'rnd', 'rmrnd']);
});

test('picking a kind opens its modal; forged kinds are answered without throwing', async () => {
  const { env, panelId } = await start();
  const expect = { range: 'mrange', choose: 'mchoose', weightedchoose: 'mweighted', lockedchoose: 'mlocked' };
  for (const [kind, modal] of Object.entries(expect)) {
    const [type, m] = last(await press(env, panelId, 'rnd', { values: [kind] }));
    assert.equal(type, 'showModal');
    assert.equal(parseBuilderId(m.custom_id).action, modal);
    assert.ok(m.title.length <= 45);
    for (const row of m.components) for (const c of row.components) assert.ok(c.label.length <= 45);
  }
  for (const values of [undefined, [], ['hax'], ['}{delete']]) {
    const i = await press(env, panelId, 'rnd', { values });
    assert.equal(i.calls.length, 1);
    assert.equal(last(i)[0], 'update');
  }
});

test('mrange adds {range:1-6}; a bad range reverts with RANGE_INVALID; a fifth is refused with TOO_MANY_RANDOM', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mrange', { min: '1', max: '6' });
  assert.deepEqual(rnd(panelId).ranges, [{ min: 1, max: 6 }]);
  assert.ok(script(panelId).includes('{range:1-6}'));
  for (const [min, max] of [['6', '1'], ['a', '3'], ['1', '2000000000'], ['1.5', '3'], ['', '3']]) {
    const i = await submit(env, panelId, 'mrange', { min, max });
    assert.equal(rnd(panelId).ranges.length, 1, `${min}-${max}`);
    said(i, err('RANGE_INVALID'));
  }
  await submit(env, panelId, 'mrange', { min: '-5', max: '5' });
  await submit(env, panelId, 'mrange', { min: '1', max: '2' });
  await submit(env, panelId, 'mrange', { min: '3', max: '4' });
  assert.equal(rnd(panelId).ranges.length, 4);
  const fifth = await submit(env, panelId, 'mrange', { min: '7', max: '8' });
  assert.equal(rnd(panelId).ranges.length, 4);
  said(fifth, err('TOO_MANY_RANDOM'));
  const braces = await submit(env, panelId, 'mrange', { min: '1}', max: '2' });
  said(braces, t('en', 'autoresponder.builder.noBrace'));
});

test('mchoose adds one option per line; braces and pipes are refused; empty reverts', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mchoose', { options: 'red\n  green  \n\nblue' });
  assert.deepEqual(rnd(panelId).choosers, [{ kind: 'choose', options: ['red', 'green', 'blue'] }]);
  assert.ok(script(panelId).includes('{choose:red|green|blue}'));
  said(await submit(env, panelId, 'mchoose', { options: 'a\nb}' }), t('en', 'autoresponder.builder.noBrace'));
  said(await submit(env, panelId, 'mchoose', { options: 'a|b\nc' }), t('en', 'autoresponder.builder.noPipeList'));
  await submit(env, panelId, 'mchoose', { options: '  \n ' });
  assert.equal(rnd(panelId).choosers.length, 1);
});

test('mweighted adds percentages; a bad weight reverts with WEIGHT_INVALID', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mweighted', { weights: '60%\n40%' });
  assert.ok(script(panelId).includes('{weightedchoose:60%|40%}'));
  assert.equal(rnd(panelId).choosers[0].kind, 'weighted');
  const bad = await submit(env, panelId, 'mweighted', { weights: 'lots\n40%' });
  assert.equal(rnd(panelId).choosers.length, 1);
  said(bad, err('WEIGHT_INVALID'));
  const zero = await submit(env, panelId, 'mweighted', { weights: '0%\n0%' });
  assert.equal(rnd(panelId).choosers.length, 1);
  said(zero, err('WEIGHT_INVALID'));
  said(await submit(env, panelId, 'mweighted', { weights: '50%\n50%}' }), t('en', 'autoresponder.builder.noBrace'));
});

test('mlocked must come after its chooser and match its option count', async () => {
  const { env, panelId } = await start();
  const early = await submit(env, panelId, 'mlocked', { values: 'x\ny' });
  assert.deepEqual(rnd(panelId).locked, []);
  said(early, err('CHOICE_NOT_CHOSEN_YET'));
  await submit(env, panelId, 'mchoose', { options: 'a\nb\nc' });
  const wrong = await submit(env, panelId, 'mlocked', { values: 'x\ny' });
  assert.deepEqual(rnd(panelId).locked, []);
  said(wrong, err('CHOICE_COUNT_MISMATCH'));
  await submit(env, panelId, 'mlocked', { values: 'x\ny\nz' });
  assert.deepEqual(rnd(panelId).locked, [['x', 'y', 'z']]);
  assert.ok(script(panelId).includes('{lockedchoose:x|y|z}'));
});

test('rmrnd removes exactly the chosen entry and ignores forged values', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mrange', { min: '1', max: '6' });
  await submit(env, panelId, 'mrange', { min: '2', max: '3' });
  await submit(env, panelId, 'mchoose', { options: 'a\nb' });
  const page = updated(await press(env, panelId, 'nav', { values: ['random'] }));
  const rm = flat(page.components).find((c) => c.custom_id.split(':')[2] === 'rmrnd');
  assert.equal(rm.options.length, 3);
  await press(env, panelId, 'rmrnd', { values: ['r0'] });
  assert.deepEqual(rnd(panelId).ranges, [{ min: 2, max: 3 }]);
  assert.equal(rnd(panelId).choosers.length, 1);
  for (const values of [undefined, [], ['r9'], ['x1'], ['c-1'], ['}'], ['r0}']]) {
    const i = await press(env, panelId, 'rmrnd', { values });
    assert.equal(i.calls.length, 1);
  }
  assert.equal(rnd(panelId).ranges.length, 1);
  await press(env, panelId, 'rmrnd', { values: ['c0'] });
  assert.deepEqual(rnd(panelId).choosers, []);
});

test('the Random page names the tokens to type, numbered when there are several', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mrange', { min: '1', max: '6' });
  await submit(env, panelId, 'mrange', { min: '1', max: '2' });
  await submit(env, panelId, 'mchoose', { options: 'a\nb' });
  await submit(env, panelId, 'mlocked', { values: 'x\ny' });
  const page = updated(await press(env, panelId, 'nav', { values: ['random'] }));
  for (const token of ['[range]', '[range2]', '[choice]', '[lockedchoice]']) assert.ok(page.content.includes(token), token);
  assert.ok(!page.content.includes('[choice2]'));
});

test('summaryLines show random values, argument checks and role targets', () => {
  const d = patch(newDraft(), {
    random: { ranges: [{ min: 1, max: 6 }], choosers: [{ kind: 'choose', options: ['a', 'b'] }, { kind: 'weighted', weights: [60, 40] }], locked: [['x', 'y']] },
    argChecks: [{ n: 1, type: 'user' }, { n: 2, type: null }],
    actions: [{ fn: 'addrole', id: R1, target: 1 }],
  });
  for (const lang of ['en', 'fr', 'ar']) {
    const text = summaryLines(lang, d).join('\n');
    assert.ok(text.includes('a, b') && text.includes('60') && text.includes('x, y'), lang);
    assert.ok(text.includes('[$1]'));
    assert.ok(!text.includes('autoresponder.builder'), `${lang} has an unresolved key`);
  }
});

test('generateScript emits the new calls after the existing ones, escaped', () => {
  const d = patch(newDraft(), {
    text: 'hi', gates: [{ fn: 'requirerole', ids: [R2] }], silent: true,
    random: { ranges: [{ min: 1, max: 6 }], choosers: [{ kind: 'choose', options: ['a|b', 'c\\d'] }, { kind: 'weighted', weights: [60, 40] }], locked: [['x', 'y']] },
    argChecks: [{ n: 1, type: 'user' }, { n: 2, type: null }],
    actions: [{ fn: 'addrole', id: R1, target: 1 }, { fn: 'removerole', id: R1, target: null }],
  });
  assert.deepEqual(generateScript(d).split('\n'), [
    'hi', `{requirerole:<@&${R2}>}`, `{addrole:<@&${R1}>|[$1]}`, `{removerole:<@&${R1}>}`, '{silent}',
    '{range:1-6}', '{choose:a\\|b|c\\\\d}', '{weightedchoose:60%|40%}', '{lockedchoose:x|y}',
    '{requirearg:1|user}', '{requirearg:2}',
  ]);
});

// ---- argument checks ----

test('the Conditions page offers requirearg: N modal, then a type select', async () => {
  const { env, panelId } = await start();
  await press(env, panelId, 'nav', { values: ['conditions'] });
  const page = updated(await press(env, panelId, 'cond', { values: ['requirearg'] }));
  assert.deepEqual(kinds(page), ['nav', 'cond', 'bargn']);
  const [type, modal] = last(await press(env, panelId, 'bargn'));
  assert.equal(type, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'margn');
  const added = await submit(env, panelId, 'margn', { n: '1' });
  assert.deepEqual(drafts.get(panelId).draft.argChecks, [{ n: 1, type: null }]);
  const view = updated(added);
  assert.deepEqual(kinds(view), ['nav', 'cond', 'parg', 'rmgate']);
  assert.deepEqual(flat(view.components)[2].options.map((o) => o.value), ['any', 'user', 'channel', 'color', 'role', 'number']);
  await press(env, panelId, 'parg', { values: ['user'] });
  assert.deepEqual(drafts.get(panelId).draft.argChecks, [{ n: 1, type: 'user' }]);
  assert.ok(script(panelId).includes('{requirearg:1|user}'));
});

test('a bad N or type reverts; forged type values are answered', async () => {
  const { env, panelId } = await start();
  await press(env, panelId, 'cond', { values: ['requirearg'] });
  for (const n of ['0', '21', 'abc', '', '1}']) {
    const i = await submit(env, panelId, 'margn', { n });
    assert.deepEqual(drafts.get(panelId).draft.argChecks, [], n);
    assert.ok(['reply', 'followUp'].includes(last(i)[0]));
  }
  await submit(env, panelId, 'margn', { n: '2' });
  const dup = await submit(env, panelId, 'margn', { n: '2' });
  assert.equal(drafts.get(panelId).draft.argChecks.length, 1);
  said(dup, err('DUPLICATE_FUNCTION'));
  for (const values of [undefined, [], ['hax'], ['user}'], ['Number']]) {
    const i = await press(env, panelId, 'parg', { values });
    assert.equal(i.calls.length, 1);
  }
  assert.deepEqual(drafts.get(panelId).draft.argChecks, [{ n: 2, type: null }]);
  await press(env, panelId, 'parg', { values: ['number'] });
  assert.equal(drafts.get(panelId).draft.argChecks[0].type, 'number');
  await press(env, panelId, 'parg', { values: ['any'] });
  assert.equal(drafts.get(panelId).draft.argChecks[0].type, null);
});

test('rmgate also removes an argument check', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mcooldown', { seconds: '30' });
  await press(env, panelId, 'cond', { values: ['requirearg'] });
  await submit(env, panelId, 'margn', { n: '1' });
  const page = updated(await press(env, panelId, 'nav', { values: ['conditions'] }));
  const rm = flat(page.components).find((c) => c.custom_id.split(':')[2] === 'rmgate');
  assert.equal(rm.options.length, 2);
  await press(env, panelId, 'rmgate', { values: ['a5'] });
  assert.equal(drafts.get(panelId).draft.argChecks.length, 1);
  await press(env, panelId, 'rmgate', { values: ['a0'] });
  assert.deepEqual(drafts.get(panelId).draft.argChecks, []);
  assert.equal(drafts.get(panelId).draft.gates.length, 1);
});

test('in an exact draft requirearg is refused with NO_ARGUMENTS_IN_MODE', async () => {
  const { env, panelId } = await start('exact');
  await press(env, panelId, 'cond', { values: ['requirearg'] });
  const i = await submit(env, panelId, 'margn', { n: '1' });
  assert.deepEqual(drafts.get(panelId).draft.argChecks, []);
  said(i, err('NO_ARGUMENTS_IN_MODE'));
});

test('switching to an exact match mode is refused while an argument check exists', async () => {
  const { env, panelId } = await start();
  await press(env, panelId, 'cond', { values: ['requirearg'] });
  await submit(env, panelId, 'margn', { n: '1' });
  await press(env, panelId, 'mode', { values: ['exact'] });
  assert.equal(drafts.get(panelId).draft.matchMode, 'startswith');
});

// ---- role targets ----

async function withGateAndArg(env, panelId) {
  await press(env, panelId, 'cond', { values: ['requirerole'] });
  await press(env, panelId, 'prole', { values: [R2] });
  await press(env, panelId, 'cond', { values: ['requirearg'] });
  await submit(env, panelId, 'margn', { n: '1' });
  await press(env, panelId, 'parg', { values: ['user'] });
}

test('the role view offers a target select: none, or the N of a user argument check', async () => {
  const { env, panelId } = await start();
  const noArg = updated(await press(env, panelId, 'act', { values: ['addrole'] }));
  assert.ok(!kinds(noArg).includes('tgt'));
  await withGateAndArg(env, panelId);
  await press(env, panelId, 'cond', { values: ['requirearg'] });
  await submit(env, panelId, 'margn', { n: '2' }); // an "any word" check is not a target
  await press(env, panelId, 'nav', { values: ['actions'] });
  const view = updated(await press(env, panelId, 'act', { values: ['addrole'] }));
  assert.deepEqual(kinds(view), ['nav', 'act', 'prole', 'tgt']);
  assert.deepEqual(flat(view.components)[3].options.map((o) => o.value), ['none', '1']);
  assert.ok(view.components.length <= 5);
});

test('a target without a gate is refused with TARGET_NEEDS_GATE; with a gate it saves target 1 and {addrole:<@&id>|[$1]}', async () => {
  const { env, panelId } = await start();
  await press(env, panelId, 'cond', { values: ['requirearg'] });
  await submit(env, panelId, 'margn', { n: '1' });
  await press(env, panelId, 'parg', { values: ['user'] });
  await press(env, panelId, 'act', { values: ['addrole'] });
  await press(env, panelId, 'tgt', { values: ['1'] });
  const refused = await press(env, panelId, 'prole', { values: [R1] });
  assert.deepEqual(drafts.get(panelId).draft.actions, []);
  said(refused, err('TARGET_NEEDS_GATE'));
  await press(env, panelId, 'cond', { values: ['requirerole'] });
  await press(env, panelId, 'prole', { values: [R2] });
  await press(env, panelId, 'act', { values: ['addrole'] });
  await press(env, panelId, 'tgt', { values: ['1'] });
  await press(env, panelId, 'prole', { values: [R1] });
  assert.deepEqual(drafts.get(panelId).draft.actions, [{ fn: 'addrole', id: R1, target: 1 }]);
  assert.ok(script(panelId).includes(`{addrole:<@&${R1}>|[$1]}`));
  // the target resets after use
  await press(env, panelId, 'act', { values: ['removerole'] });
  await press(env, panelId, 'prole', { values: [R1] });
  assert.ok(!drafts.get(panelId).draft.actions[1].target);
});

test('a forged target never reaches the script', async () => {
  const { env, panelId } = await start();
  await withGateAndArg(env, panelId);
  await press(env, panelId, 'act', { values: ['addrole'] });
  for (const values of [undefined, [], ['2'], ['7'], ['1}'], ['[$1]'], ['-1']]) {
    const i = await press(env, panelId, 'tgt', { values });
    assert.equal(i.calls.length, 1);
  }
  await press(env, panelId, 'prole', { values: [R1] });
  assert.ok(!drafts.get(panelId).draft.actions[0].target);
  assert.ok(!script(panelId).includes('[$'));
  const noPending = await press(env, panelId, 'tgt', { values: ['1'] });
  assert.equal(noPending.calls.length, 1);
});

// ---- save, try it, router ----

test('Save in a startswith draft stores a version 2 rule with its text, random spec and argChecks', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mtext', { text: 'Hello [$1] you rolled [range] and got [choice]' });
  await submit(env, panelId, 'mrange', { min: '1', max: '6' });
  await submit(env, panelId, 'mchoose', { options: 'a\nb' });
  await press(env, panelId, 'cond', { values: ['requirearg'] });
  await submit(env, panelId, 'margn', { n: '1' });
  await press(env, panelId, 'parg', { values: ['user'] });
  await press(env, panelId, 'save');
  const [rule] = await listRules(db, G);
  assert.equal(rule.compiled.version, 2);
  assert.deepEqual(rule.compiled.random.ranges, [{ min: 1, max: 6 }]);
  assert.deepEqual(rule.compiled.random.choosers, [{ kind: 'choose', options: ['a', 'b'] }]);
  assert.deepEqual(rule.compiled.argChecks, [{ n: 1, type: 'user' }]);
  assert.ok(rule.compiled.template.some((x) => x.t === 'arg'));
  assert.ok(rule.compiled.template.some((x) => x.t === 'rand' && x.kind === 'range'));
  assert.equal(rule.matchMode, 'startswith');
});

test('Save in an exact draft that holds a requirearg is refused with NO_ARGUMENTS_IN_MODE', async () => {
  const { env, panelId } = await start('exact');
  drafts.update(panelId, { draft: patch(drafts.get(panelId).draft, { argChecks: [{ n: 1, type: null }] }) });
  const i = await press(env, panelId, 'save');
  assert.deepEqual(await listRules(db, G), []);
  assert.ok(i.calls.some((c) => c[0] === 'followUp' && c[1].content.includes(err('NO_ARGUMENTS_IN_MODE'))));
  assert.ok(drafts.get(panelId), 'the panel stays so the member can fix it');
});

test('Try it shows the drawn values', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mtext', { text: 'You rolled [range] of [choice]' });
  await submit(env, panelId, 'mrange', { min: '7', max: '7' });
  await submit(env, panelId, 'mchoose', { options: 'solo' });
  const i = await submit(env, panelId, 'mtry', { sample: 'hi there' });
  said(i, 'You rolled 7 of solo');
});

test('Try it compiles with the draft match mode: requirearg in an exact draft reports the error', async () => {
  const { env, panelId } = await start('exact');
  drafts.update(panelId, { draft: patch(drafts.get(panelId).draft, { argChecks: [{ n: 1, type: null }] }) });
  const i = await submit(env, panelId, 'mtry', { sample: 'hi' });
  said(i, err('NO_ARGUMENTS_IN_MODE'));
});

test('every new action sits behind the router: other user, non-manager, expired panel', async () => {
  const { env, panelId } = await start();
  const snapshot = JSON.stringify(drafts.get(panelId).draft);
  const actions = ['rnd', 'mrange', 'mchoose', 'mweighted', 'mlocked', 'rmrnd', 'bargn', 'margn', 'parg', 'tgt'];
  const fields = { min: '1', max: '2', options: 'a', weights: '1%', values: 'a', n: '1' };
  for (const action of actions) {
    const other = await press(env, panelId, action, { userId: 'intruder', values: ['range'], fields });
    assert.equal(other.calls.length, 1, `${action} other user`);
    assert.equal(last(other)[0], 'reply');
    const gone = await press(env, 'nopanel0', action, { values: ['range'] });
    assert.equal(gone.calls.length, 1, `${action} expired`);
  }
  const weak = setup({ manager: false });
  for (const action of actions) {
    const i = await press(weak, panelId, action, { values: ['range'], fields });
    assert.equal(i.calls.length, 1, `${action} non-manager`);
  }
  assert.equal(JSON.stringify(drafts.get(panelId).draft), snapshot);
});

test('modal-only actions pressed as plain components are answered and change nothing', async () => {
  const { env, panelId } = await start();
  for (const action of ['mrange', 'mchoose', 'mweighted', 'mlocked', 'margn']) {
    const i = await press(env, panelId, action, { values: ['x'] });
    assert.equal(i.calls.length, 1, action);
    assert.equal(last(i)[0], 'reply');
  }
  assert.deepEqual(rnd(panelId), { ranges: [], choosers: [], locked: [] });
  assert.deepEqual(drafts.get(panelId).draft.argChecks, []);
});

test('script mode ignores the new guided controls', async () => {
  const { env, panelId } = await start();
  await submit(env, panelId, 'mscript', { script: 'hello' });
  for (const action of ['rnd', 'rmrnd', 'parg', 'tgt', 'bargn']) {
    const i = await press(env, panelId, action, { values: ['range'] });
    assert.equal(i.calls.length, 1, action);
  }
});

test('every new i18n key exists in en, fr and ar, with short labels', () => {
  const rndKinds = ['range', 'choose', 'weightedchoose', 'lockedchoose'];
  const types = ['any', 'user', 'channel', 'color', 'role', 'number'];
  const keys = [
    'page.random', 'random.ph.kind', 'random.ph.remove', 'random.note', 'random.note.none',
    ...rndKinds.map((k) => `random.kind.${k}`),
    'random.modal.range', 'random.modal.choose', 'random.modal.weighted', 'random.modal.locked',
    'random.input.min', 'random.input.max', 'random.input.options', 'random.input.weights', 'random.input.values',
    'sum.range', 'sum.choose', 'sum.weighted', 'sum.locked', 'sum.requirearg', 'sum.requirearg.any',
    'cond.kind.requirearg', 'cond.btn.argn', 'cond.modal.argn', 'cond.input.argn', 'cond.ph.argtype',
    ...types.map((k) => `cond.argtype.${k}`),
    'act.ph.target', 'act.target.none', 'act.target.n',
  ].map((k) => `autoresponder.builder.${k}`);
  const short = ['random.modal.range', 'random.modal.choose', 'random.modal.weighted', 'random.modal.locked',
    'random.input.min', 'random.input.max', 'random.input.options', 'random.input.weights', 'random.input.values',
    'cond.modal.argn', 'cond.input.argn', 'cond.kind.requirearg', ...rndKinds.map((k) => `random.kind.${k}`),
    ...types.map((k) => `cond.argtype.${k}`)];
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const key of short) assert.ok(t(lang, `autoresponder.builder.${key}`).length <= 45, `${lang} ${key}`);
  }
  assert.notEqual(t('fr', 'autoresponder.builder.page.random'), t('en', 'autoresponder.builder.page.random'));
});

test('a pipe in an option, weight or locked value gets the list message; the permission modal keeps its own', async () => {
  const { env, panelId } = await start();
  const list = t('en', 'autoresponder.builder.noPipeList');
  said(await submit(env, panelId, 'mchoose', { options: 'a|b' }), list);
  said(await submit(env, panelId, 'mweighted', { weights: '50%|50%' }), list);
  await submit(env, panelId, 'mchoose', { options: 'a\nb' });
  said(await submit(env, panelId, 'mlocked', { values: 'x|y\nz' }), list);
  await press(env, panelId, 'cond', { values: ['requireperm'] });
  const perm = await submit(env, panelId, 'mperm', { perm: 'A|B' });
  assert.equal(last(perm)[1].content, t('en', 'autoresponder.builder.noPipe'));
  assert.notEqual(list, t('en', 'autoresponder.builder.noPipe'));
  for (const lang of ['en', 'fr', 'ar']) {
    assert.notEqual(t(lang, 'autoresponder.builder.noPipeList'), 'autoresponder.builder.noPipeList');
    assert.notEqual(t(lang, 'autoresponder.builder.noPipeList'), t(lang, 'autoresponder.builder.noPipe'));
  }
  assert.notEqual(t('fr', 'autoresponder.builder.noPipeList'), list);
  assert.notEqual(t('ar', 'autoresponder.builder.noPipeList'), list);
});
