import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { panelModal, editsFromModal, panelPayload, createPayload, handlePanel } from '../../src/features/embeds/panel.js';
import { createEmbed, getEmbed, saveEmbed, deleteEmbed } from '../../src/features/embeds/store.js';
import { LANGS, t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const PARTS = ['basic', 'author', 'footer', 'images', 'field'];

test('every modal is valid in every language and uses the documented custom id', () => {
  for (const lang of LANGS) {
    for (const part of PARTS) {
      const json = panelModal(lang, part, 'rules', {}).toJSON();   // toJSON validates label and title lengths
      assert.equal(json.custom_id, `embeds:m:${part}:rules`);
      assert.ok(json.components.length >= 2 && json.components.length <= 5);
    }
  }
});

test('every modal title and label is at most 45 characters in every language', () => {
  for (const lang of LANGS) {
    for (const part of PARTS) {
      const json = panelModal(lang, part, 'abcdefghijklmnop', {}).toJSON();
      assert.ok(json.title.length <= 45, `${lang} ${part} title`);
      for (const row of json.components) assert.ok(row.components[0].label.length <= 45, `${lang} ${part} label`);
    }
  }
});

test('modals are prefilled from the saved embed', () => {
  const spec = { title: 'T', description: 'D', footer: 'F', footerIcon: 'https://a.test/f.png', color: '#000000',
    timestamp: true, author: { text: 'A', icon: '{user_avatar}' }, thumbnail: '{server_icon}',
    image: { type: 'stored', name: 'logo' } };
  const values = (part, lang = 'en') => panelModal(lang, part, 'x', spec).toJSON().components
    .map((r) => r.components[0].value);
  assert.deepEqual(values('basic'), ['T', 'D', '#000000']);
  assert.deepEqual(values('author'), ['A', '{user_avatar}']);
  assert.deepEqual(values('footer'), ['F', 'https://a.test/f.png', 'yes']);
  assert.deepEqual(values('images'), ['logo', '{server_icon}']);
  const stamp = (lang, s2) => panelModal(lang, 'footer', 'x', s2).toJSON().components[2].components[0].value;
  assert.equal(stamp('fr', { timestamp: true }), 'oui');
  assert.equal(stamp('en', {}), 'no');
});

test('only the field name and value are required', () => {
  const required = (part) => panelModal('en', part, 'x', {}).toJSON().components
    .filter((r) => r.components[0].required).map((r) => r.components[0].custom_id);
  assert.deepEqual(required('field'), ['name', 'value']);
  for (const part of ['basic', 'author', 'footer', 'images']) assert.deepEqual(required(part), []);
});

test('editsFromModal maps each form to edits', () => {
  const get = (map) => (id) => map[id];
  assert.deepEqual(editsFromModal('basic', get({ title: 'T', description: '', color: '#fff000' })),
    [['title', 'T'], ['description', ''], ['color', '#fff000']]);
  assert.deepEqual(editsFromModal('author', get({ text: 'A', icon: '' })), [['author', { text: 'A', icon: '' }]]);
  assert.deepEqual(editsFromModal('footer', get({ text: 'F', icon: 'i', timestamp: 'Oui' })),
    [['footer', { text: 'F', icon: 'i' }], ['timestamp', true]]);
  assert.deepEqual(editsFromModal('footer', get({ text: '', icon: '', timestamp: '' })),
    [['footer', { text: '', icon: '' }], ['timestamp', false]]);
  assert.deepEqual(editsFromModal('images', get({ thumbnail: 't', image: 'i' })), [['image', 'i'], ['thumbnail', 't']]);
  assert.deepEqual(editsFromModal('field', get({ name: 'n', value: 'v', inline: 'yes' })),
    [['field', { name: 'n', value: 'v', inline: true }]]);
});

// ---- handler tests against the test database ----

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE embeds'); });
after(async () => { await db.end(); });

const ctx = () => ({ db, client: {} });

function fake({ customId, kind = 'button', fields = {}, fromMessage = true, values = [] }) {
  const calls = { reply: [], update: [], showModal: [], deferReply: [], editReply: [] };
  return {
    calls,
    customId,
    guildId: 'g1',
    channelId: 'c1',
    inGuild: () => true,
    isButton: () => kind === 'button',
    isStringSelectMenu: () => kind === 'select',
    values,
    isModalSubmit: () => kind === 'modal',
    isFromMessage: () => fromMessage,
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    user: { id: 'u1', username: 'sam', displayAvatarURL: () => 'https://a.test/u.png' },
    member: {
      displayName: 'Sam',
      guild: { id: 'g1' },
      permissions: { has: () => true },
      roles: { cache: { has: () => false } },
    },
    guild: { name: 'Home', memberCount: 3, ownerId: 'o1', createdTimestamp: 0, iconURL: () => null },
    reply: async (p) => { calls.reply.push(p); },
    update: async (p) => { calls.update.push(p); },
    showModal: async (m) => { calls.showModal.push(m); },
    deferReply: async (p) => { calls.deferReply.push(p); },
    editReply: async (p) => { calls.editReply.push(p); },
  };
}

test('the create reply is public, explains how to use the embed and still has the panel', async () => {
  for (const lang of LANGS) {
    const payload = await createPayload(ctx(), fake({}), lang, 'rules', {});
    assert.equal(payload.flags, undefined, `${lang} must not be ephemeral`);
    assert.ok(payload.content.includes('{embed:rules}'), `${lang} guide names the tag`);
    const card = payload.embeds.at(-1);
    assert.ok(card.data.description.includes(t(lang, 'embeds.panelHint', { name: 'rules' })), `${lang} keeps the hint in the card`);
    assert.equal(payload.components.length, 2);
  }
});

test('the create reply stays under the message length limit with the longest name', async () => {
  const payload = await createPayload(ctx(), fake({}), 'ar', 'a'.repeat(16), { title: 'T' });
  assert.ok(payload.content.length < 2000);
  assert.ok(payload.embeds.at(-1).data.description.length < 4096);
});

test('the panel shows the preview, a part menu and a plain clear button', async () => {
  const payload = await panelPayload(ctx(), fake({}), 'en', 'rules', { title: 'Hi {user_name}' });
  assert.equal(payload.embeds[0].title, 'Hi Sam');
  assert.match(payload.embeds.at(-1).data.description, /rules/);
  assert.equal(payload.content, undefined);
  const rows = payload.components.map((r) => r.toJSON().components);
  assert.equal(rows.length, 2);
  const [menu] = rows[0];
  assert.equal(menu.custom_id, 'embeds:s:menu:rules');
  assert.deepEqual(menu.options.map((o) => o.value), ['basic', 'author', 'footer', 'images', 'field']);
  assert.ok(menu.options.every((o) => o.label.length <= 100 && o.description.length <= 100));
  assert.deepEqual(rows[1].map((c) => c.custom_id), ['embeds:b:clear:rules']);
  assert.notEqual(rows[1][0].style, 4, 'clear fields is not the red danger style');
});

test('the menu texts fit Discord limits in every language', async () => {
  for (const lang of LANGS) {
    const payload = await panelPayload(ctx(), fake({}), lang, 'rules', {});
    const menu = payload.components[0].toJSON().components[0];
    assert.ok(menu.placeholder.length <= 150, `${lang} placeholder`);
    for (const o of menu.options) {
      assert.ok(o.label.length <= 100 && o.description.length <= 100, `${lang} ${o.value}`);
    }
  }
});

test('choosing a part in the menu opens its form prefilled', async () => {
  await createEmbed(db, 'g1', 'rules');
  await saveEmbed(db, 'g1', 'rules', { title: 'T', footer: 'F', footerIcon: 'https://a.test/f.png' });
  for (const part of ['basic', 'author', 'footer', 'images', 'field']) {
    const i = fake({ customId: 'embeds:s:menu:rules', kind: 'select', values: [part] });
    await handlePanel(i, ctx());
    assert.equal(i.calls.showModal.length, 1, part);
    assert.equal(i.calls.showModal[0].toJSON().custom_id, `embeds:m:${part}:rules`);
  }
  const i = fake({ customId: 'embeds:s:menu:rules', kind: 'select', values: ['footer'] });
  await handlePanel(i, ctx());
  const values = i.calls.showModal[0].toJSON().components.map((r) => r.components[0].value);
  assert.deepEqual(values.slice(0, 2), ['F', 'https://a.test/f.png']);
});

test('a menu choice that is not a form does nothing, and a deleted embed replies not found', async () => {
  await createEmbed(db, 'g1', 'rules');
  const junk = fake({ customId: 'embeds:s:menu:rules', kind: 'select', values: ['nope'] });
  await handlePanel(junk, ctx());
  assert.equal(junk.calls.showModal.length + junk.calls.reply.length + junk.calls.update.length, 0);
  await deleteEmbed(db, 'g1', 'rules');
  const gone = fake({ customId: 'embeds:s:menu:rules', kind: 'select', values: ['basic'] });
  await handlePanel(gone, ctx());
  assert.equal(gone.calls.reply[0].content, t('en', 'embeds.notFound', { name: 'rules' }));
});

test('an empty embed shows the empty text instead of a preview', async () => {
  const payload = await panelPayload(ctx(), fake({}), 'en', 'rules', {});
  assert.equal(payload.embeds.length, 1, "only the status card, no preview");
  assert.ok(payload.embeds.at(-1).data.description.includes(t('en', 'embeds.panelEmpty')));
  assert.equal(payload.embeds.length, 1);
});

test('a missing stored image shows the image message instead of a preview', async () => {
  const payload = await panelPayload(ctx(), fake({}), 'en', 'rules', { title: 'T', image: 'nope' });
  assert.equal(payload.embeds.length, 1, "only the status card, no preview");
  assert.ok(payload.embeds.at(-1).data.description.includes(t('en', 'embeds.imageMissing')));
});

test('a form with an invalid color saves nothing and replies the error', async () => {
  await createEmbed(db, 'g1', 'rules');
  await saveEmbed(db, 'g1', 'rules', { title: 'T' });
  const i = fake({ customId: 'embeds:m:basic:rules', kind: 'modal', fields: { title: '', description: '', color: 'red' } });
  await handlePanel(i, ctx());
  assert.equal(i.calls.reply[0].content, `• ${t('en', 'embeds.err.badColor')}`);
  assert.ok(i.calls.reply[0].flags);
  assert.equal(i.calls.update.length, 0);
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), { title: 'T' });
});

test('blanking the last part saves an empty embed and shows the empty panel', async () => {
  await createEmbed(db, 'g1', 'rules');
  await saveEmbed(db, 'g1', 'rules', { title: 'T' });
  const i = fake({ customId: 'embeds:m:basic:RULES', kind: 'modal', fields: { title: ' ', description: '', color: '' } });
  await handlePanel(i, ctx());
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), {});
  assert.equal(i.calls.update.length, 1);
  assert.equal(i.calls.update[0].embeds.length, 1);
  assert.ok(i.calls.update[0].embeds.at(-1).data.description.includes(t('en', 'embeds.panelEmpty')));
});

test('a form not opened from the panel message replies with a new ephemeral panel', async () => {
  await createEmbed(db, 'g1', 'rules');
  const i = fake({ customId: 'embeds:m:field:rules', kind: 'modal', fromMessage: false,
    fields: { name: 'n', value: 'v', inline: 'non' } });
  await handlePanel(i, ctx());
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), { fields: [{ name: 'n', value: 'v', inline: false }] });
  assert.equal(i.calls.reply.length, 1);
  assert.ok(i.calls.reply[0].flags);
  assert.equal(i.calls.reply[0].embeds[0].fields[0].name, 'n');
});

test('a part button opens its form prefilled', async () => {
  await createEmbed(db, 'g1', 'rules');
  await saveEmbed(db, 'g1', 'rules', { title: 'T' });
  const i = fake({ customId: 'embeds:b:basic:rules' });
  await handlePanel(i, ctx());
  const json = i.calls.showModal[0].toJSON();
  assert.equal(json.custom_id, 'embeds:m:basic:rules');
  assert.equal(json.components[0].components[0].value, 'T');
});

test('clear fields removes the fields and updates the panel', async () => {
  await createEmbed(db, 'g1', 'rules');
  await saveEmbed(db, 'g1', 'rules', { title: 'T', fields: [{ name: 'n', value: 'v', inline: false }] });
  const i = fake({ customId: 'embeds:b:clear:rules' });
  await handlePanel(i, ctx());
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), { title: 'T' });
  assert.equal(i.calls.update[0].embeds[0].title, 'T');
});

test('show here refuses an empty embed', async () => {
  await createEmbed(db, 'g1', 'rules');
  const i = fake({ customId: 'embeds:b:show:rules' });
  await handlePanel(i, ctx());
  assert.equal(i.calls.reply[0].content, `• ${t('en', 'embeds.err.empty')}`);
});

test('an embed deleted since the panel opened replies not found', async () => {
  await createEmbed(db, 'g1', 'rules');
  await deleteEmbed(db, 'g1', 'rules');
  for (const i of [
    fake({ customId: 'embeds:b:footer:rules' }),
    fake({ customId: 'embeds:m:basic:rules', kind: 'modal', fields: { title: 'T' } }),
  ]) {
    await handlePanel(i, ctx());
    assert.equal(i.calls.reply[0].content, t('en', 'embeds.notFound', { name: 'rules' }));
    assert.equal(i.calls.showModal.length + i.calls.update.length, 0);
  }
  assert.equal(await getEmbed(db, 'g1', 'rules'), null);
});

test('a member who cannot manage the bot is refused before anything happens', async () => {
  await createEmbed(db, 'g1', 'rules');
  const i = fake({ customId: 'embeds:b:basic:rules' });
  i.member.permissions.has = () => false;
  await handlePanel(i, ctx());
  assert.equal(i.calls.reply[0].content, t('en', 'common.notAllowed'));
  assert.equal(i.calls.showModal.length, 0);
});

test('the footer form saves text, icon and timestamp together', async () => {
  await createEmbed(db, 'g1', 'rules');
  const i = fake({ customId: 'embeds:m:footer:rules', kind: 'modal',
    fields: { text: 'hello', icon: 'https://a.test/f.png', timestamp: 'yes' } });
  await handlePanel(i, ctx());
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'),
    { footer: 'hello', footerIcon: 'https://a.test/f.png', timestamp: true });
  assert.equal(i.calls.update.length, 1);
});

test('the footer form refuses an icon without text', async () => {
  await createEmbed(db, 'g1', 'rules');
  const i = fake({ customId: 'embeds:m:footer:rules', kind: 'modal',
    fields: { text: '', icon: 'https://a.test/f.png', timestamp: '' } });
  await handlePanel(i, ctx());
  assert.equal(i.calls.reply[0].content, `• ${t('en', 'embeds.err.footerNeedsText')}`);
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), {});
});

test('buttons on panels posted before the regroup still open the basic form', async () => {
  await createEmbed(db, 'g1', 'rules');
  for (const old of ['text', 'look']) {
    const i = fake({ customId: `embeds:b:${old}:rules` });
    await handlePanel(i, ctx());
    assert.equal(i.calls.showModal[0].toJSON().custom_id, 'embeds:m:basic:rules');
  }
});
