import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { listRules } from '../../src/features/autoresponder/store.js';
import { createButton, deleteButton } from '../../src/features/autoresponder/buttons/store.js';
import { clearCache } from '../../src/features/autoresponder/cache.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';
import { compileScript } from '../../src/features/autoresponder/script/compile.js';
import { drafts } from '../../src/features/autoresponder/builder/drafts.js';
import { builderId, parseBuilderId, panelPayload, PAGES } from '../../src/features/autoresponder/builder/panel.js';
import { newDraft, patch, addButton } from '../../src/features/autoresponder/builder/draft.js';
import { generateScript } from '../../src/features/autoresponder/builder/generate.js';
import { summaryLines } from '../../src/features/autoresponder/builder/summary.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();
const compiledStub = { version: 1, template: [], gates: [], actions: [], flags: {} };

function setup() {
  const guild = { id: G, name: 'Srv', memberCount: 5, createdTimestamp: 1_500_000_000_000, iconURL: () => 'i.png', ownerId: 'owner', roles: { cache: new Map() }, channels: { cache: new Map() }, emojis: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } } };
  const logChannel = { isTextBased: () => true, send: async () => ({ id: 'log1', channelId: 'logch' }) };
  const ctx = { db, client: { user: { id: 'bot' }, channels: { fetch: async () => logChannel } } };
  const member = { id: 'staff', displayName: 'Sam', user: { id: 'staff', username: 'Sam', displayAvatarURL: () => 'a.png' }, permissions: { has: () => true }, roles: { highest: { position: 5 }, cache: new Map() }, guild };
  return { guild, ctx, member };
}

function fake(env, extra = {}) {
  const calls = [];
  const i = {
    guildId: G, guild: env.guild, member: env.member, user: { id: extra.userId ?? 'staff', username: 'Sam', globalName: null, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'a.png', tag: 'Sam#0' },
    channel: { id: 'c1', name: 'general', isTextBased: () => true }, channelId: 'c1', calls,
    deferred: false, replied: false,
    inGuild: () => true,
    isModalSubmit: () => Boolean(extra.fields),
    isFromMessage: () => true,
    values: extra.values,
    customId: extra.customId,
    options: { getSubcommand: () => extra.sub, getSubcommandGroup: () => null, getString: () => null, getInteger: () => null },
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
async function press(env, panelId, action, { extra, userId = 'staff', openerId = userId, ...rest } = {}) {
  const i = fake(env, { customId: builderId(action, openerId, panelId, extra), userId, ...rest });
  await command.components.handle(i, env.ctx);
  return i;
}
const submitModal = (env, panelId, action, fields) => press(env, panelId, action, { fields });
const draftOf = (panelId) => drafts.get(panelId).draft;
const refusedText = (i) => (i.calls.find((c) => c[0] === 'followUp' || c[0] === 'reply')?.[1]?.content ?? '');
const errorText = (code, detail) => t('en', `autoresponder.error.${code}`, { detail: detail === undefined ? '' : `"${detail}"` }).trim();

async function start({ withText = true, buttons = [] } = {}) {
  const env = setup();
  await on();
  for (const name of buttons) await createButton(db, { guildId: G, name, label: name, style: 'grey', script: 'hi', compiled: compiledStub, createdBy: 'u1' });
  const panelId = await open(env);
  if (withText) await submitModal(env, panelId, 'mtext', { text: 'hello there' });
  await press(env, panelId, 'nav', { values: ['buttons'] });
  return { env, panelId };
}

const userId = '9'.repeat(20);
const panelIdLong = 'z'.repeat(8);

test('PAGES puts buttons after random and before review', () => {
  assert.deepEqual(PAGES, ['basics', 'reply', 'conditions', 'actions', 'random', 'buttons', 'review']);
});

test('the draft starts with no buttons and the script emits them after the other calls', () => {
  assert.deepEqual(newDraft().buttons, []);
  assert.equal(generateScript(newDraft()), '');
  let d = patch(newDraft(), { text: 'hi', silent: true });
  d = addButton(d, { kind: 'stored', name: 'rules' });
  d = addButton(d, { kind: 'link', label: 'Docs', url: 'https://example.com/a', emoji: null });
  d = addButton(d, { kind: 'link', label: 'Go', url: 'https://example.com/b', emoji: '\u{1F44D}' });
  assert.equal(generateScript(d), 'hi\n{silent}\n{addbutton:rules}\n{addlinkbutton:Docs|https://example.com/a}\n{addlinkbutton:Go|https://example.com/b|\u{1F44D}}');
});

test('link arguments go through escapeArg', () => {
  const d = addButton(patch(newDraft(), { text: 'hi' }), { kind: 'link', label: 'a\\b', url: 'https://e.com', emoji: null });
  assert.ok(generateScript(d).includes('{addlinkbutton:a\\\\b|https://e.com}'));
});

test('summaryLines shows stored and link buttons', () => {
  let d = addButton(patch(newDraft(), { text: 'hi' }), { kind: 'stored', name: 'rules' });
  d = addButton(d, { kind: 'link', label: 'Docs', url: 'https://example.com/a', emoji: null });
  const lines = summaryLines('en', d);
  assert.ok(lines.includes(t('en', 'autoresponder.builder.sum.addbutton', { value: 'rules' })));
  assert.ok(lines.some((l) => l.includes('Docs') && l.includes('https://example.com/a')));
});

test('the Buttons page stays within 5 rows, 25 options and 100 character ids in every state and language', () => {
  const stored = Array.from({ length: 60 }, (_, k) => `b${String(k).padStart(2, '0')}`);
  const full = {
    ...newDraft(), text: 'hi',
    buttons: [
      ...Array.from({ length: 12 }, (_, k) => ({ kind: 'stored', name: `s${k}` })),
      ...Array.from({ length: 13 }, (_, k) => ({ kind: 'link', label: 'L'.repeat(80), url: `https://example.com/${'p'.repeat(400)}${k}`, emoji: '\u{1F44D}' })),
    ],
  };
  const cases = [[undefined, newDraft()], [[], newDraft()], [stored, newDraft()], [stored, full], [stored.slice(0, 3), full]];
  for (const lang of ['en', 'fr', 'ar']) {
    for (const [buttonNames, draft] of cases) {
      const payload = panelPayload(lang, { panelId: panelIdLong, userId, page: 'buttons', buttonNames, draft });
      assert.ok(payload.components.length <= 5, `${lang} rows`);
      assert.ok(payload.content.length <= 2000);
      assert.deepEqual(payload.allowedMentions, { parse: [] });
      for (const c of flat(payload.components)) {
        assert.ok(c.custom_id.length <= 100, c.custom_id);
        assert.ok((c.options ?? []).length <= 25, `${lang} options`);
        for (const o of c.options ?? []) assert.ok(o.label.length <= 100 && o.label.length >= 1);
      }
    }
  }
});

test('opening the Buttons page lists the stored names; more than 24 are cut with a note', async () => {
  const names = Array.from({ length: 30 }, (_, k) => `b${String(k).padStart(2, '0')}`);
  const { env, panelId } = await start({ buttons: names });
  const view = updated(await press(env, panelId, 'nav', { values: ['buttons'] }));
  assert.deepEqual(kinds(view), ['nav', 'pbtn', 'blink']);
  const select = flat(view.components).find((c) => c.custom_id.split(':')[2] === 'pbtn');
  assert.equal(select.options.length, 24);
  assert.deepEqual(select.options.slice(0, 2).map((o) => o.label), ['b00', 'b01']);
  assert.ok(view.content.includes(t('en', 'autoresponder.builder.buttons.more', { shown: 24, total: 30 })));
});

test('with no stored buttons the page shows a note and only the link button control', async () => {
  const { env, panelId } = await start();
  const view = updated(await press(env, panelId, 'nav', { values: ['buttons'] }));
  assert.deepEqual(kinds(view), ['nav', 'blink']);
  assert.ok(view.content.includes(t('en', 'autoresponder.builder.buttons.none')));
});

test('picking a stored button adds {addbutton:name} and the generated script compiles', async () => {
  const { env, panelId } = await start({ buttons: ['rules', 'faq'] });
  const i = await press(env, panelId, 'pbtn', { values: ['n1'] });
  assert.deepEqual(draftOf(panelId).buttons, [{ kind: 'stored', name: 'rules' }]);
  assert.ok(kinds(updated(i)).includes('rmbtn'));
  const script = generateScript(draftOf(panelId));
  assert.ok(script.includes('{addbutton:rules}'));
  const res = await compileScript(script, { db, guild: env.guild, writer: env.member, matchMode: 'exact' });
  assert.equal(res.ok, true);
  assert.deepEqual(res.compiled.buttons, [{ kind: 'stored', name: 'rules' }]);
});

test('a button removed between listing and picking is refused with BUTTON_NOT_FOUND and reverted', async () => {
  const { env, panelId } = await start({ buttons: ['rules'] });
  await deleteButton(db, G, 'rules');
  const i = await press(env, panelId, 'pbtn', { values: ['n0'] });
  assert.deepEqual(draftOf(panelId).buttons, []);
  assert.ok(refusedText(i).includes(errorText('BUTTON_NOT_FOUND', 'rules')), refusedText(i));
});

test('adding a link button through the modal stores it and the script compiles', async () => {
  const { env, panelId } = await start();
  const [kind, modal] = last(await press(env, panelId, 'blink'));
  assert.equal(kind, 'showModal');
  assert.deepEqual(modal.components.map((r) => r.components[0].custom_id), ['label', 'url', 'emoji']);
  assert.deepEqual(modal.components.map((r) => r.components[0].required), [true, true, false]);
  assert.ok(modal.title.length <= 45);
  const i = await submitModal(env, panelId, 'mlink', { label: 'Docs', url: 'https://example.com/a', emoji: '\u{1F44D}' });
  assert.deepEqual(draftOf(panelId).buttons, [{ kind: 'link', label: 'Docs', url: 'https://example.com/a', emoji: '\u{1F44D}' }]);
  assert.ok(updated(i));
  const res = await compileScript(generateScript(draftOf(panelId)), { db, guild: env.guild, writer: env.member, matchMode: 'exact' });
  assert.equal(res.ok, true);
  assert.equal(res.compiled.buttons[0].url, 'https://example.com/a');
});

test('a bad URL is refused with LINK_URL_INVALID; a bad emoji with INVALID_EMOJI', async () => {
  const { env, panelId } = await start();
  const bad = await submitModal(env, panelId, 'mlink', { label: 'Docs', url: 'not a url', emoji: '' });
  assert.deepEqual(draftOf(panelId).buttons, []);
  assert.ok(refusedText(bad).includes(errorText('LINK_URL_INVALID', 'not a url')), refusedText(bad));
  const ftp = await submitModal(env, panelId, 'mlink', { label: 'Docs', url: 'ftp://example.com', emoji: '' });
  assert.ok(refusedText(ftp).includes(t('en', 'autoresponder.builder.refused')));
  const emoji = await submitModal(env, panelId, 'mlink', { label: 'Docs', url: 'https://example.com', emoji: 'zzz' });
  assert.deepEqual(draftOf(panelId).buttons, []);
  assert.ok(refusedText(emoji).includes(t('en', 'autoresponder.builder.refused')));
});

test('} and | in the label, URL or emoji are refused before the compile, and a blank label too', async () => {
  const { env, panelId } = await start();
  for (const fields of [
    { label: 'a}b', url: 'https://e.com', emoji: '' },
    { label: 'ab', url: 'https://e.com/}', emoji: '' },
    { label: 'ab', url: 'https://e.com', emoji: '}' },
  ]) {
    const i = await submitModal(env, panelId, 'mlink', fields);
    assert.equal(last(i)[1].content, t('en', 'autoresponder.builder.noBrace'));
  }
  for (const fields of [
    { label: 'a|b', url: 'https://e.com', emoji: '' },
    { label: 'ab', url: 'https://e.com/?a=1|2', emoji: '' },
    { label: 'ab', url: 'https://e.com', emoji: 'x|y' },
  ]) {
    const i = await submitModal(env, panelId, 'mlink', fields);
    assert.equal(last(i)[1].content, t('en', 'autoresponder.builder.noPipe'));
  }
  const blank = await submitModal(env, panelId, 'mlink', { label: '   ', url: 'https://e.com', emoji: '' });
  assert.ok(last(blank)[1].content.includes(t('en', 'autoresponder.builder.refused')));
  assert.deepEqual(draftOf(panelId).buttons, []);
});

test('the 26th button is refused with TOO_MANY_BUTTONS', async () => {
  const { env, panelId } = await start();
  for (let k = 0; k < 25; k++) {
    await submitModal(env, panelId, 'mlink', { label: `L${k}`, url: `https://example.com/${k}`, emoji: '' });
  }
  assert.equal(draftOf(panelId).buttons.length, 25);
  const i = await submitModal(env, panelId, 'mlink', { label: 'one more', url: 'https://example.com/x', emoji: '' });
  assert.equal(draftOf(panelId).buttons.length, 25);
  assert.ok(refusedText(i).includes(errorText('TOO_MANY_BUTTONS')), refusedText(i));
  const view = panelPayload('en', drafts.get(panelId));
  assert.ok(view.content.length <= 2000);
  assert.ok(flat(view.components).every((c) => (c.options ?? []).length <= 25));
});

test('a {dm} destination with a button surfaces BUTTONS_NEED_CHANNEL and is reverted', async () => {
  const { env, panelId } = await start();
  await submitModal(env, panelId, 'mlink', { label: 'Docs', url: 'https://example.com', emoji: '' });
  await press(env, panelId, 'nav', { values: ['reply'] });
  const i = await press(env, panelId, 'dest', { values: ['dm'] });
  assert.equal(draftOf(panelId).dest, 'reply');
  assert.ok(refusedText(i).includes(errorText('BUTTONS_NEED_CHANNEL')), refusedText(i));
});

test('a button with no reply text is refused by the compile, and Save reports BUTTONS_NEED_TEXT', async () => {
  const { env, panelId } = await start({ withText: false });
  const i = await submitModal(env, panelId, 'mlink', { label: 'Docs', url: 'https://example.com', emoji: '' });
  assert.deepEqual(draftOf(panelId).buttons, []);
  assert.ok(refusedText(i).includes(errorText('BUTTONS_NEED_TEXT')), refusedText(i));
  // A draft that got there another way is still caught when it is saved.
  drafts.update(panelId, { draft: { ...patch(draftOf(panelId), { trigger: 'hi' }), buttons: [{ kind: 'link', label: 'Docs', url: 'https://example.com', emoji: null }] } });
  const save = await press(env, panelId, 'save');
  const message = save.calls.find((c) => c[0] === 'followUp')[1].content;
  assert.ok(message.includes(errorText('BUTTONS_NEED_TEXT')), message);
  assert.deepEqual(await listRules(db, G), []);
});

test('the remove select drops a button and the script compiles again', async () => {
  const { env, panelId } = await start({ buttons: ['rules'] });
  await press(env, panelId, 'pbtn', { values: ['n0'] });
  await submitModal(env, panelId, 'mlink', { label: 'Docs', url: 'https://example.com', emoji: '' });
  assert.equal(draftOf(panelId).buttons.length, 2);
  const view = panelPayload('en', drafts.get(panelId));
  const rm = flat(view.components).find((c) => c.custom_id.split(':')[2] === 'rmbtn');
  assert.deepEqual(rm.options.map((o) => o.value), ['0', '1']);
  const i = await press(env, panelId, 'rmbtn', { values: ['0'] });
  assert.deepEqual(draftOf(panelId).buttons.map((b) => b.kind), ['link']);
  assert.ok(updated(i));
  assert.ok(!generateScript(draftOf(panelId)).includes('addbutton:rules'));
});

test('Save stores compiled.buttons matching the draft', async () => {
  const { env, panelId } = await start({ buttons: ['rules'] });
  await press(env, panelId, 'pbtn', { values: ['n0'] });
  await submitModal(env, panelId, 'mlink', { label: 'Docs', url: 'https://example.com/a', emoji: '' });
  await submitModal(env, panelId, 'mtrigger', { trigger: 'hello' });
  const save = await press(env, panelId, 'save');
  assert.ok(save.calls.some((c) => c[0] === 'editReply'));
  const [rule] = await listRules(db, G);
  assert.deepEqual(rule.compiled.buttons, [
    { kind: 'stored', name: 'rules' },
    { kind: 'link', label: 'Docs', url: 'https://example.com/a', emoji: null },
  ]);
  assert.ok(rule.script.includes('{addbutton:rules}') && rule.script.includes('{addlinkbutton:Docs|https://example.com/a}'));
});

test('the new actions sit behind the router: other members, non-managers and forged values are all handled', async () => {
  const { env, panelId } = await start({ buttons: ['rules'] });
  for (const [action, rest] of [['pbtn', { values: ['n0'] }], ['blink', {}], ['mlink', { fields: { label: 'x', url: 'https://e.com', emoji: '' } }], ['rmbtn', { values: ['0'] }]]) {
    const stranger = await press(env, panelId, action, { userId: 'other', openerId: 'staff', ...rest });
    assert.equal(last(stranger)[1].content, t('en', 'autoresponder.builder.notYours'), action);
  }
  assert.deepEqual(draftOf(panelId).buttons, []);
  const member = setup();
  member.member.permissions.has = () => false;
  const refused = await press(member, panelId, 'pbtn', { values: ['n0'] });
  assert.equal(last(refused)[1].content, t('en', 'common.notAllowed'));
  assert.deepEqual(draftOf(panelId).buttons, []);
});

test('forged values never throw and never change the draft', async () => {
  const { env, panelId } = await start({ buttons: ['rules'] });
  for (const values of [undefined, [], ['x'], ['n99'], ['n-1'], ['n0 '], ['__proto__'], ['n24'], ['0']]) {
    const i = await press(env, panelId, 'pbtn', { values });
    assert.equal(last(i)[0], 'update', JSON.stringify(values));
  }
  for (const values of [undefined, [], ['x'], ['5'], ['-1'], ['0']]) {
    const i = await press(env, panelId, 'rmbtn', { values });
    assert.equal(last(i)[0], 'update', JSON.stringify(values));
  }
  assert.deepEqual(draftOf(panelId).buttons, []);
  // A modal-only action reached as a button press is answered, not executed.
  const forged = await press(env, panelId, 'mlink');
  assert.equal(last(forged)[1].content, t('en', 'autoresponder.builder.expired'));
  assert.deepEqual(draftOf(panelId).buttons, []);
  // Off the Buttons page the controls do nothing.
  await press(env, panelId, 'nav', { values: ['reply'] });
  const off = await press(env, panelId, 'pbtn', { values: ['n0'] });
  assert.equal(last(off)[0], 'update');
  assert.deepEqual(draftOf(panelId).buttons, []);
  const offLink = await press(env, panelId, 'blink');
  assert.equal(last(offLink)[0], 'update');
});

test('Try it lists the buttons of the draft', async () => {
  const { env, panelId } = await start({ buttons: ['rules'] });
  await press(env, panelId, 'pbtn', { values: ['n0'] });
  await submitModal(env, panelId, 'mtrigger', { trigger: 'hello' });
  const i = await submitModal(env, panelId, 'mtry', { sample: 'hello' });
  const message = last(i)[1].content;
  assert.ok(message.includes('rules'), message);
});

test('every builder button text exists in en, fr and ar, with short labels', () => {
  const keys = ['page.buttons', 'ph.buttons', 'ph.rmbutton', 'btn.addlink', 'buttons.more', 'buttons.none', 'modal.link', 'input.linklabel',
    'input.linkurl', 'input.linkemoji', 'sum.addbutton', 'sum.addlinkbutton'].map((k) => `autoresponder.builder.${k}`);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const k of ['modal.link', 'input.linklabel', 'input.linkurl', 'input.linkemoji', 'btn.addlink', 'page.buttons']) {
      assert.ok(t(lang, `autoresponder.builder.${k}`).length <= 45, `${lang} ${k}`);
    }
  }
});
