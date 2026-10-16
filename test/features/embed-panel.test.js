import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { panelModal, editsFromModal, panelPayload, createPayload, handlePanel } from '../../src/features/embeds/panel.js';
import { createEmbed, getEmbed, saveEmbed, deleteEmbed } from '../../src/features/embeds/store.js';
import { LANGS, t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const PARTS = ['text', 'look', 'author', 'images', 'field'];

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
  const spec = { title: 'T', description: 'D', footer: 'F', color: '#000000', timestamp: true,
    author: { text: 'A', icon: '{user_avatar}' }, thumbnail: '{server_icon}', image: { type: 'stored', name: 'logo' } };
  const values = (part) => panelModal('en', part, 'x', spec).toJSON().components.map((r) => r.components[0].value);
  assert.deepEqual(values('text'), ['T', 'D', 'F']);
  assert.deepEqual(values('look'), ['#000000', 'yes']);
  assert.deepEqual(values('author'), ['A', '{user_avatar}']);
  assert.deepEqual(values('images'), ['{server_icon}', 'logo']);
  const look = (lang, s) => panelModal(lang, 'look', 'x', s).toJSON().components[1].components[0].value;
  assert.equal(look('fr', { timestamp: true }), 'oui');
  assert.equal(look('en', {}), 'no');
});

test('only the field name and value are required', () => {
  const required = (part) => panelModal('en', part, 'x', {}).toJSON().components
    .filter((r) => r.components[0].required).map((r) => r.components[0].custom_id);
  assert.deepEqual(required('field'), ['name', 'value']);
  for (const part of ['text', 'look', 'author', 'images']) assert.deepEqual(required(part), []);
});

test('editsFromModal maps each form to edits', () => {
  const get = (map) => (id) => map[id];
  assert.deepEqual(editsFromModal('text', get({ title: 'T', description: '', footer: 'F' })),
    [['title', 'T'], ['description', ''], ['footer', 'F']]);
  assert.deepEqual(editsFromModal('look', get({ color: '#fff000', timestamp: 'Oui' })),
    [['color', '#fff000'], ['timestamp', true]]);
  assert.deepEqual(editsFromModal('look', get({ color: '', timestamp: '' })), [['color', ''], ['timestamp', false]]);
  assert.deepEqual(editsFromModal('author', get({ text: 'A', icon: '' })), [['author', { text: 'A', icon: '' }]]);
  assert.deepEqual(editsFromModal('images', get({ thumbnail: 't', image: 'i' })), [['thumbnail', 't'], ['image', 'i']]);
  assert.deepEqual(editsFromModal('field', get({ name: 'n', value: 'v', inline: 'yes' })),
    [['field', { name: 'n', value: 'v', inline: true }]]);
});

// ---- handler tests against the test database ----

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE embeds'); });
after(async () => { await db.end(); });

const ctx = () => ({ db, client: {} });

function fake({ customId, kind = 'button', fields = {}, fromMessage = true }) {
  const calls = { reply: [], update: [], showModal: [], deferReply: [], editReply: [] };
  return {
    calls,
    customId,
    guildId: 'g1',
    channelId: 'c1',
    inGuild: () => true,
    isButton: () => kind === 'button',
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

test('the panel shows the rendered preview and two rows of buttons', async () => {
  const payload = await panelPayload(ctx(), fake({}), 'en', 'rules', { title: 'Hi {user_name}' });
  assert.equal(payload.embeds[0].title, 'Hi Sam');
  assert.match(payload.embeds.at(-1).data.description, /rules/);
  assert.equal(payload.content, undefined);
  const ids = payload.components.map((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.deepEqual(ids, [
    ['embeds:b:text:rules', 'embeds:b:look:rules', 'embeds:b:author:rules', 'embeds:b:images:rules', 'embeds:b:field:rules'],
    ['embeds:b:clear:rules', 'embeds:b:show:rules'],
  ]);
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
  const i = fake({ customId: 'embeds:m:look:rules', kind: 'modal', fields: { color: 'red', timestamp: 'yes' } });
  await handlePanel(i, ctx());
  assert.equal(i.calls.reply[0].content, `• ${t('en', 'embeds.err.badColor')}`);
  assert.ok(i.calls.reply[0].flags);
  assert.equal(i.calls.update.length, 0);
  assert.deepEqual(await getEmbed(db, 'g1', 'rules'), { title: 'T' });
});

test('blanking the last part saves an empty embed and shows the empty panel', async () => {
  await createEmbed(db, 'g1', 'rules');
  await saveEmbed(db, 'g1', 'rules', { title: 'T' });
  const i = fake({ customId: 'embeds:m:text:RULES', kind: 'modal', fields: { title: ' ', description: '', footer: '' } });
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
  const i = fake({ customId: 'embeds:b:text:rules' });
  await handlePanel(i, ctx());
  const json = i.calls.showModal[0].toJSON();
  assert.equal(json.custom_id, 'embeds:m:text:rules');
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
    fake({ customId: 'embeds:b:look:rules' }),
    fake({ customId: 'embeds:m:text:rules', kind: 'modal', fields: { title: 'T' } }),
  ]) {
    await handlePanel(i, ctx());
    assert.equal(i.calls.reply[0].content, t('en', 'embeds.notFound', { name: 'rules' }));
    assert.equal(i.calls.showModal.length + i.calls.update.length, 0);
  }
  assert.equal(await getEmbed(db, 'g1', 'rules'), null);
});

test('a member who cannot manage the bot is refused before anything happens', async () => {
  await createEmbed(db, 'g1', 'rules');
  const i = fake({ customId: 'embeds:b:text:rules' });
  i.member.permissions.has = () => false;
  await handlePanel(i, ctx());
  assert.equal(i.calls.reply[0].content, t('en', 'common.notAllowed'));
  assert.equal(i.calls.showModal.length, 0);
});
