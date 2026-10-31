import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createButton, getButton, listButtons, MAX_BUTTONS } from '../../src/features/autoresponder/buttons/store.js';
import { clearCache } from '../../src/features/autoresponder/cache.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();

function setup({ staff = true } = {}) {
  const guild = { id: G, ownerId: 'owner', roles: { cache: new Map() }, channels: { cache: new Map() }, emojis: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } } };
  const logged = [];
  const logChannel = { isTextBased: () => true, send: async (payload) => { logged.push(payload); return { id: 'log1', channelId: 'logch' }; } };
  const ctx = { db, client: { user: { id: 'bot' }, channels: { fetch: async () => logChannel } } };
  const member = { id: 'staff', permissions: { has: () => staff }, roles: { highest: { position: 5 }, cache: new Map() }, guild };
  return { guild, ctx, member, logged };
}

function slash(env, group, sub, opts = {}) {
  const replies = [];
  const i = {
    guildId: G, guild: env.guild, member: env.member, user: { id: 'staff' }, replies, modals: [],
    inGuild: () => true,
    isModalSubmit: () => false,
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => sub,
      getString: (n) => opts[n] ?? null,
      getInteger: (n) => opts[n] ?? null,
      getBoolean: (n) => opts[n] ?? null,
    },
    reply: async (p) => { replies.push(typeof p === 'string' ? { content: p } : p); },
    showModal: async (m) => { i.modals.push(m.toJSON()); },
  };
  return i;
}

function submit(env, customId, fields) {
  const replies = [];
  return {
    guildId: G, guild: env.guild, member: env.member, user: { id: 'staff' }, replies, customId,
    inGuild: () => true,
    isModalSubmit: () => true,
    fields: { getTextInputValue: (n) => fields[n] ?? '' },
    reply: async (p) => { replies.push(typeof p === 'string' ? { content: p } : p); },
  };
}

const run = (env, sub, opts, group = 'button') => { const i = slash(env, group, sub, opts); return command.execute(i, env.ctx).then(() => i); };
const send = (env, customId, fields) => { const i = submit(env, customId, fields); return command.components.handle(i, env.ctx).then(() => i); };
const on = async () => {
  await setFeature(db, G, 'logging', { enabled: true, config: { channels: { default: 'logch' } } });
  await setFeature(db, G, 'autoresponder', { enabled: true });
};
const text = (i) => i.replies.at(-1).content;
const inputs = (modal) => modal.components.map((row) => row.components[0]);
const stored = { guildId: G, label: 'L', style: 'grey', script: 'hi', compiled: { version: 1, template: [], gates: [], actions: [], flags: {} }, createdBy: 'u1' };
const nameInvalid = t('en', 'autoresponder.error.BUTTON_NAME_INVALID', { detail: '' }).trim();

test('the slash data has a button group with add, edit, remove and list, and the old subcommands stay', () => {
  const json = command.data.toJSON();
  const group = json.options.find((o) => o.name === 'button');
  assert.deepEqual(group.options.map((o) => o.name), ['add', 'edit', 'remove', 'list']);
  const add = group.options[0];
  assert.deepEqual(add.options.map((o) => o.name), ['name', 'style', 'invoker_only', 'limitations']);
  assert.equal(add.options[0].required, true);
  assert.deepEqual(add.options[1].choices.map((c) => c.value), ['blue', 'green', 'grey', 'red']);
  assert.deepEqual(add.options[3].choices.map((c) => c.value), ['none', 'limited', 'strict']);
  for (const name of ['enable', 'disable', 'add', 'edit', 'editmatchmode', 'toggle', 'remove', 'list', 'show', 'test', 'builder']) {
    assert.ok(json.options.some((o) => o.name === name), name);
  }
});

test('button add opens the modal with the documented id and three inputs', async () => {
  const env = setup();
  await on();
  const i = await run(env, 'add', { name: 'rules', style: 'green', invoker_only: true, limitations: 'strict' });
  assert.equal(i.modals.length, 1);
  const m = i.modals[0];
  assert.equal(m.custom_id, 'autoresponder:m:btnadd:rules:green:1s');
  assert.ok(m.title.length <= 45);
  const [label, emoji, script] = inputs(m);
  assert.deepEqual([label.custom_id, emoji.custom_id, script.custom_id], ['label', 'emoji', 'script']);
  assert.equal(label.max_length, 80);
  assert.equal(emoji.required, false);
  assert.equal(script.max_length, 4000);
  assert.equal(script.style, 2);
  const defaults = await run(env, 'add', { name: 'plain' });
  assert.equal(defaults.modals[0].custom_id, 'autoresponder:m:btnadd:plain:blue:0n');
});

test('the longest modal id stays within 100 characters', async () => {
  const env = setup();
  await on();
  const name = 'a'.repeat(16);
  const i = await run(env, 'add', { name, style: 'green', invoker_only: true, limitations: 'limited' });
  assert.ok(i.modals[0].custom_id.length <= 100);
  await createButton(db, { ...stored, name });
  const e = await run(env, 'edit', { name, style: 'green', invoker_only: true, limitations: 'strict' });
  assert.ok(e.modals[0].custom_id.length <= 100);
});

test('an invalid name is refused before any modal', async () => {
  const env = setup();
  await on();
  for (const name of ['Bad Name', 'a:b', 'x'.repeat(17), '']) {
    const i = await run(env, 'add', { name });
    assert.equal(i.modals.length, 0, name);
    assert.ok(text(i).includes(nameInvalid), name);
  }
});

test('submitting a valid button stores it compiled with its flags, logs once and replies with the name', async () => {
  const env = setup();
  await on();
  const i = await send(env, 'autoresponder:m:btnadd:rules:green:1s', { label: 'Rules', emoji: '', script: 'Be kind {cooldown:5}' });
  assert.equal(text(i), t('en', 'autoresponder.button.created', { name: 'rules' }));
  assert.equal(i.replies.at(-1).flags, MessageFlags.Ephemeral);
  const b = await getButton(db, G, 'rules');
  assert.equal(b.label, 'Rules');
  assert.equal(b.style, 'green');
  assert.equal(b.invokerOnly, true);
  assert.equal(b.limitations, 'strict');
  assert.equal(b.emoji, null);
  assert.equal(b.createdBy, 'staff');
  assert.ok(b.compiled.version);
  assert.equal(b.script, 'Be kind {cooldown:5}');
  assert.equal(env.logged.length, 1);
  assert.ok(JSON.stringify(env.logged[0]).includes(t('en', 'autoresponder.action.btnadd')));
});

test('a unicode emoji is stored; a bad one is refused and nothing is stored', async () => {
  const env = setup();
  await on();
  await send(env, 'autoresponder:m:btnadd:ok:blue:0n', { label: 'Ok', emoji: '\u{1F44D}', script: 'hi' });
  assert.equal((await getButton(db, G, 'ok')).emoji, '\u{1F44D}');
  const bad = await send(env, 'autoresponder:m:btnadd:bad:blue:0n', { label: 'Bad', emoji: 'notanemoji', script: 'hi' });
  assert.ok(text(bad).startsWith(t('en', 'autoresponder.errors.head')));
  assert.equal(await getButton(db, G, 'bad'), null);
});

test('a script with errors stores nothing, lists the localized errors and writes no log line', async () => {
  const env = setup();
  await on();
  const i = await send(env, 'autoresponder:m:btnadd:oops:blue:0n', { label: 'Oops', script: 'hi {nosuchfunction} {addbutton:missing}' });
  assert.ok(text(i).startsWith(t('en', 'autoresponder.errors.head')));
  assert.ok(text(i).includes('At character'));
  assert.equal(await getButton(db, G, 'oops'), null);
  assert.equal(env.logged.length, 0);
});

test('a button script compiles as a button script', async () => {
  const env = setup();
  await on();
  const i = await send(env, 'autoresponder:m:btnadd:dice:blue:0n', { label: 'Dice', script: 'You rolled [range] {range:1-6}' });
  assert.equal(text(i), t('en', 'autoresponder.button.created', { name: 'dice' }));
});

test('an invalid name, style, limitation or label in a forged id or field is refused on submit', async () => {
  const env = setup();
  await on();
  const cases = [
    ['autoresponder:m:btnadd:Bad:blue:0n', { label: 'x', script: 'hi' }, nameInvalid],
    ['autoresponder:m:btnadd:a:purple:0n', { label: 'x', script: 'hi' }, t('en', 'autoresponder.button.BUTTON_STYLE_INVALID')],
    ['autoresponder:m:btnadd:a:blue:0x', { label: 'x', script: 'hi' }, t('en', 'autoresponder.button.BUTTON_LIMITATION_INVALID')],
    ['autoresponder:m:btnadd:a:blue', { label: 'x', script: 'hi' }, t('en', 'autoresponder.button.BUTTON_LIMITATION_INVALID')],
    ['autoresponder:m:btnadd:a:blue:0n', { label: '   ', script: 'hi' }, t('en', 'autoresponder.button.BUTTON_LABEL_INVALID')],
    ['autoresponder:m:btnadd:a:blue:0n', { label: 'x'.repeat(81), script: 'hi' }, t('en', 'autoresponder.button.BUTTON_LABEL_INVALID')],
  ];
  for (const [id, fields, expected] of cases) {
    const i = await send(env, id, fields);
    assert.ok(text(i).includes(expected), `${id}: ${text(i)}`);
  }
  assert.deepEqual(await listButtons(db, G), []);
  assert.equal(env.logged.length, 0);
});

test('a duplicate name replies exists and the 51st button replies full', async () => {
  const env = setup();
  await on();
  await createButton(db, { ...stored, name: 'dup' });
  const dup = await send(env, 'autoresponder:m:btnadd:dup:blue:0n', { label: 'x', script: 'hi' });
  assert.equal(text(dup), t('en', 'autoresponder.button.exists', { name: 'dup' }));
  assert.equal((await getButton(db, G, 'dup')).label, 'L');
  for (let k = 0; k < MAX_BUTTONS - 1; k++) await createButton(db, { ...stored, name: `b${k}` });
  assert.equal((await listButtons(db, G)).length, MAX_BUTTONS);
  const full = await send(env, 'autoresponder:m:btnadd:extra:blue:0n', { label: 'x', script: 'hi' });
  assert.equal(text(full), t('en', 'autoresponder.button.full'));
  assert.equal(await getButton(db, G, 'extra'), null);
  assert.equal(env.logged.length, 0);
});

test('button edit prefills label, emoji and script, keeps the name and updates the button', async () => {
  const env = setup();
  await on();
  await createButton(db, { ...stored, name: 'rules', label: 'Old', emoji: '\u{1F44D}', script: 'old script', style: 'red', invokerOnly: true, limitations: 'limited' });
  const open = await run(env, 'edit', { name: 'rules' });
  const m = open.modals[0];
  assert.equal(m.custom_id, 'autoresponder:m:btnedit:rules:red:1l');
  const [label, emoji, script] = inputs(m);
  assert.deepEqual([label.value, emoji.value, script.value], ['Old', '\u{1F44D}', 'old script']);
  const changed = await run(env, 'edit', { name: 'rules', style: 'green', invoker_only: false, limitations: 'none' });
  assert.equal(changed.modals[0].custom_id, 'autoresponder:m:btnedit:rules:green:0n');
  const i = await send(env, changed.modals[0].custom_id, { label: 'New', emoji: '', script: 'new script' });
  assert.equal(text(i), t('en', 'autoresponder.button.updated', { name: 'rules' }));
  const b = await getButton(db, G, 'rules');
  assert.deepEqual([b.label, b.emoji, b.script, b.style, b.invokerOnly, b.limitations], ['New', null, 'new script', 'green', false, 'none']);
  assert.equal(env.logged.length, 1);
  assert.ok(JSON.stringify(env.logged[0]).includes(t('en', 'autoresponder.action.btnedit')));
  assert.equal((await listButtons(db, G)).length, 1);
});

test('editing a missing button replies gone, at the command and at the submit', async () => {
  const env = setup();
  await on();
  const open = await run(env, 'edit', { name: 'nope' });
  assert.equal(open.modals.length, 0);
  assert.equal(text(open), t('en', 'autoresponder.button.gone', { name: 'nope' }));
  const i = await send(env, 'autoresponder:m:btnedit:nope:blue:0n', { label: 'x', script: 'hi' });
  assert.equal(text(i), t('en', 'autoresponder.button.gone', { name: 'nope' }));
  assert.deepEqual(await listButtons(db, G), []);
});

test('an edit whose script has errors changes nothing', async () => {
  const env = setup();
  await on();
  await createButton(db, { ...stored, name: 'keep' });
  const i = await send(env, 'autoresponder:m:btnedit:keep:blue:0n', { label: 'New', script: '{nosuchfunction}' });
  assert.ok(text(i).startsWith(t('en', 'autoresponder.errors.head')));
  assert.equal((await getButton(db, G, 'keep')).label, 'L');
  assert.equal(env.logged.length, 0);
});

test('button remove deletes, logs once and replies; a missing name replies gone', async () => {
  const env = setup();
  await on();
  await createButton(db, { ...stored, name: 'bye' });
  const i = await run(env, 'remove', { name: 'bye' });
  assert.equal(text(i), t('en', 'autoresponder.button.removed', { name: 'bye' }));
  assert.equal(await getButton(db, G, 'bye'), null);
  assert.equal(env.logged.length, 1);
  assert.ok(JSON.stringify(env.logged[0]).includes(t('en', 'autoresponder.action.btnremove')));
  const again = await run(env, 'remove', { name: 'bye' });
  assert.equal(text(again), t('en', 'autoresponder.button.gone', { name: 'bye' }));
  assert.equal(env.logged.length, 1);
});

test('button list shows names, labels, styles and settings, and stays under 2000 characters with many buttons', async () => {
  const env = setup();
  await on();
  assert.equal(text(await run(env, 'list')), t('en', 'autoresponder.button.list.none'));
  await createButton(db, { ...stored, name: 'one', label: 'First', style: 'red', limitations: 'strict', invokerOnly: true });
  const one = text(await run(env, 'list'));
  for (const part of ['one', 'First', 'red', 'strict']) assert.ok(one.includes(part), part);
  for (let k = 0; k < 49; k++) await createButton(db, { ...stored, name: `n${String(k).padStart(2, '0')}`, label: 'l'.repeat(80) });
  const many = await run(env, 'list');
  assert.ok(text(many).length <= 2000);
  assert.equal(many.replies.at(-1).flags, MessageFlags.Ephemeral);
});

test('every button reply is ephemeral', async () => {
  const env = setup();
  await on();
  await createButton(db, { ...stored, name: 'e1' });
  for (const [sub, opts] of [['list', {}], ['remove', { name: 'zzz' }], ['edit', { name: 'zzz' }], ['add', { name: 'BAD' }]]) {
    const i = await run(env, sub, opts);
    assert.equal(i.replies.at(-1).flags, MessageFlags.Ephemeral, sub);
  }
});

test('non-managers and a disabled feature are refused for the button group and its modals', async () => {
  const env = setup();
  const offText = t('en', 'common.featureOff', { command: '/autoresponder enable' });
  for (const sub of ['add', 'edit', 'remove', 'list']) {
    const i = await run(env, sub, { name: 'x' });
    assert.equal(text(i), offText, sub);
    assert.equal(i.modals.length, 0);
  }
  assert.equal(text(await send(env, 'autoresponder:m:btnadd:x:blue:0n', { label: 'x', script: 'hi' })), offText);
  await on();
  const member = setup({ staff: false });
  for (const sub of ['add', 'edit', 'remove', 'list']) {
    const i = await run(member, sub, { name: 'x' });
    assert.equal(text(i), t('en', 'common.notAllowed'), sub);
    assert.equal(i.modals.length, 0);
  }
  const forged = await send(member, 'autoresponder:m:btnadd:x:blue:0n', { label: 'x', script: 'hi' });
  assert.equal(text(forged), t('en', 'common.notAllowed'));
  assert.deepEqual(await listButtons(db, G), []);
});

test('the existing subcommands still work next to the group (list and add)', async () => {
  const env = setup();
  await on();
  assert.equal(text(await run(env, 'list', {}, null)), t('en', 'autoresponder.list.none'));
  const add = await run(env, 'add', { match: 'includes' }, null);
  assert.equal(add.modals[0].custom_id, 'autoresponder:m:add:includes');
});

test('every button text exists in en, fr and ar, within modal limits', () => {
  const keys = [
    ...['BUTTON_LABEL_INVALID', 'BUTTON_STYLE_INVALID', 'BUTTON_LIMITATION_INVALID', 'created', 'updated', 'removed', 'gone', 'exists',
      'full', 'list.none', 'list.line', 'modal.title.add', 'modal.title.edit', 'modal.label', 'modal.emoji', 'modal.script']
      .map((k) => `autoresponder.button.${k}`),
    ...['btnadd', 'btnedit', 'btnremove'].map((k) => `autoresponder.action.${k}`),
  ];
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const k of ['modal.title.add', 'modal.title.edit', 'modal.label', 'modal.emoji', 'modal.script']) {
      assert.ok(t(lang, `autoresponder.button.${k}`).length <= 45, `${lang} ${k}`);
    }
  }
});
