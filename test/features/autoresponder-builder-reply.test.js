import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { listRules } from '../../src/features/autoresponder/store.js';
import { clearCache } from '../../src/features/autoresponder/cache.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';
import { compileScript } from '../../src/features/autoresponder/script/compile.js';
import { createEmbed, deleteEmbed } from '../../src/features/embeds/store.js';
import { drafts } from '../../src/features/autoresponder/builder/drafts.js';
import { builderId, parseBuilderId, panelPayload } from '../../src/features/autoresponder/builder/panel.js';
import { newDraft, patch } from '../../src/features/autoresponder/builder/draft.js';
import { generateScript } from '../../src/features/autoresponder/builder/generate.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();

function setup() {
  const guild = { id: G, ownerId: 'owner', roles: { cache: new Map() }, channels: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } } };
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
const submitModal = (env, panelId, action, fields) => press(env, panelId, action, { fields });
const draftOf = (panelId) => drafts.get(panelId).draft;

async function start() {
  const env = setup();
  await on();
  const panelId = await open(env);
  await press(env, panelId, 'nav', { values: ['reply'] });
  return { env, panelId };
}
const refusedWith = (i, code) =>
  assert.ok(last(i)[1].content.includes(t('en', `autoresponder.error.${code}`, { detail: '' }).trim()), `${code}: ${last(i)[1]?.content}`);
const makeEmbeds = async (n) => { for (let k = 0; k < n; k++) await createEmbed(db, G, `e${String(k).padStart(2, '0')}`); };

test('the reply page has Embed and Delete-reply buttons, at most 5 rows and 5 buttons per row, in every language', () => {
  const userId = '9'.repeat(20);
  const panelId = 'z'.repeat(8);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const dest of ['reply', 'dm', 'channel']) {
      const payload = panelPayload(lang, { panelId, userId, page: 'reply', draft: { ...newDraft(), dest } });
      assert.ok(payload.components.length <= 5);
      for (const r of payload.components) assert.ok(r.toJSON().components.length <= 5);
      assert.ok(kinds(payload).includes('bembed') && kinds(payload).includes('bdelreply'));
    }
    const view = panelPayload(lang, { panelId, userId, page: 'embed', embedNames: Array.from({ length: 40 }, (_, k) => `e${k}`), draft: newDraft() });
    assert.ok(view.components.length <= 5);
    for (const c of flat(view.components)) {
      assert.ok(c.custom_id.length <= 100);
      assert.ok((c.options ?? []).length <= 25);
    }
  }
});

test('with 30 stored embeds the select has at most 25 options and a note line appears', async () => {
  const { env, panelId } = await start();
  await makeEmbeds(30);
  const view = updated(await press(env, panelId, 'bembed'));
  assert.equal(drafts.get(panelId).page, 'embed');
  assert.deepEqual(kinds(view), ['embed', 'bback']);
  const select = flat(view.components)[0];
  assert.equal(select.options.length, 25);
  assert.deepEqual(select.options.slice(0, 2).map((o) => o.value), ['none', 'plain']);
  assert.ok(view.content.includes(t('en', 'autoresponder.builder.embed.more', { shown: 23, total: 30 })));
});

test('with few embeds there is no note line', async () => {
  const { env, panelId } = await start();
  await makeEmbeds(2);
  const view = updated(await press(env, panelId, 'bembed'));
  assert.equal(flat(view.components)[0].options.length, 4);
  assert.ok(!view.content.includes(t('en', 'autoresponder.builder.embed.more', { shown: 2, total: 2 }).slice(0, 12)));
});

test('picking a named embed adds {embed:name}; Back returns to the reply page', async () => {
  const { env, panelId } = await start();
  await createEmbed(db, G, 'rules');
  await press(env, panelId, 'bembed');
  const i = await press(env, panelId, 'embed', { values: ['n0'] });
  assert.deepEqual(draftOf(panelId).embed, { kind: 'named', name: 'rules' });
  assert.ok(generateScript(draftOf(panelId)).includes('{embed:rules}'));
  assert.equal(drafts.get(panelId).page, 'reply');
  assert.ok(updated(i));
  await press(env, panelId, 'bembed');
  const back = await press(env, panelId, 'bback', { extra: 'reply' });
  assert.equal(drafts.get(panelId).page, 'reply');
  assert.ok(kinds(updated(back)).includes('bembed'));
});

test('an embed deleted between listing and picking is refused with EMBED_NOT_FOUND and reverted', async () => {
  const { env, panelId } = await start();
  await createEmbed(db, G, 'gone');
  await press(env, panelId, 'bembed');
  await deleteEmbed(db, G, 'gone');
  const i = await press(env, panelId, 'embed', { values: ['n0'] });
  assert.equal(draftOf(panelId).embed, null);
  assert.equal(updated(i), undefined);
  assert.equal(last(i)[0], 'followUp');
  refusedWith(i, 'EMBED_NOT_FOUND');
});

test('plain colour opens the colour modal; #ec948a is accepted, ec948a is refused, empty is a plain embed', async () => {
  const { env, panelId } = await start();
  await press(env, panelId, 'bembed');
  const [kind, modal] = last(await press(env, panelId, 'embed', { values: ['plain'] }));
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'mcolor');
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, 'color');
  assert.equal(input.required, false);
  assert.ok(modal.title.length <= 45 && input.label.length <= 45);
  await submitModal(env, panelId, 'mcolor', { color: '#ec948a' });
  assert.deepEqual(draftOf(panelId).embed, { kind: 'plain', color: '#ec948a' });
  assert.ok(generateScript(draftOf(panelId)).includes('{embed:#ec948a}'));
  const bad = await submitModal(env, panelId, 'mcolor', { color: 'ec948a' });
  refusedWith(bad, 'BAD_ARGUMENT');
  assert.deepEqual(draftOf(panelId).embed, { kind: 'plain', color: '#ec948a' });
  await submitModal(env, panelId, 'mcolor', { color: '' });
  assert.ok(generateScript(draftOf(panelId)).includes('{embed}'));
  const brace = await submitModal(env, panelId, 'mcolor', { color: '#a}' });
  assert.equal(last(brace)[1].content, t('en', 'autoresponder.builder.noBrace'));
});

test('a plain colour embed survives the generate, parse and compile round trip', async () => {
  const env = setup();
  const script = generateScript(patch(newDraft(), { text: 'hi', embed: { kind: 'plain', color: '#aabbcc' } }));
  const res = await compileScript(script, { db, guild: env.guild, writer: env.member });
  assert.ok(res.ok, JSON.stringify(res.errors));
  assert.deepEqual(res.compiled.flags.embed, { kind: 'plain', color: 0xaabbcc });
});

test('no embed clears it', async () => {
  const { env, panelId } = await start();
  await press(env, panelId, 'bembed');
  await submitModal(env, panelId, 'mcolor', { color: '#ec948a' });
  assert.ok(draftOf(panelId).embed);
  await press(env, panelId, 'bembed');
  const i = await press(env, panelId, 'embed', { values: ['none'] });
  assert.equal(draftOf(panelId).embed, null);
  assert.ok(updated(i));
});

test('forged embed values and calls never throw and never change the draft', async () => {
  const { env, panelId } = await start();
  await press(env, panelId, 'bembed');
  for (const values of [undefined, [], ['zzz'], ['n9'], ['n-1'], ['1}{delete']]) {
    assert.ok((await press(env, panelId, 'embed', { values })).calls.length >= 1);
  }
  assert.equal(draftOf(panelId).embed, null);
  for (const action of ['mcolor', 'mdelreply']) {
    const click = await press(env, panelId, action);
    assert.equal(click.calls.length, 1);
    assert.equal(last(click)[0], 'reply');
  }
  assert.ok((await press(env, panelId, 'bback', { extra: 'nowhere' })).calls.length >= 1);
});

test('delete-reply: 10 adds {delete_reply:10}, 0 and 301 are refused, empty clears', async () => {
  const { env, panelId } = await start();
  const [kind, modal] = last(await press(env, panelId, 'bdelreply'));
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'mdelreply');
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, 'seconds');
  assert.equal(input.required, false);
  assert.ok(modal.title.length <= 45 && input.label.length <= 45);
  await submitModal(env, panelId, 'mdelreply', { seconds: '10' });
  assert.ok(generateScript(draftOf(panelId)).includes('{delete_reply:10}'));
  for (const seconds of ['0', '301']) {
    const i = await submitModal(env, panelId, 'mdelreply', { seconds });
    refusedWith(i, 'DELETE_REPLY_RANGE');
    assert.ok(generateScript(draftOf(panelId)).includes('{delete_reply:10}'));
  }
  const brace = await submitModal(env, panelId, 'mdelreply', { seconds: '1}' });
  assert.equal(last(brace)[1].content, t('en', 'autoresponder.builder.noBrace'));
  await submitModal(env, panelId, 'mdelreply', { seconds: '' });
  assert.equal(draftOf(panelId).deleteReplyAfter, null);
  assert.ok(!generateScript(draftOf(panelId)).includes('delete_reply'));
});

test('Save stores the embed and deleteReplyAfter', async () => {
  const { env, panelId } = await start();
  await createEmbed(db, G, 'rules');
  await press(env, panelId, 'bembed');
  await press(env, panelId, 'embed', { values: ['n0'] });
  await submitModal(env, panelId, 'mdelreply', { seconds: '20' });
  await submitModal(env, panelId, 'mtrigger', { trigger: 'hi' });
  await submitModal(env, panelId, 'mtext', { text: 'yo' });
  await press(env, panelId, 'save');
  const [rule] = await listRules(db, G);
  assert.deepEqual(rule.compiled.flags.embed, { kind: 'named', name: 'rules' });
  assert.equal(rule.compiled.flags.deleteReplyAfter, 20);
});

test('every embed and delete-reply i18n key exists in en, fr and ar, with short labels', () => {
  const short = ['btn.embed', 'btn.delreply', 'btn.back', 'page.embed', 'modal.color', 'modal.delreply', 'input.color', 'input.delreply',
    'embed.none', 'embed.plain'];
  const keys = [...short, 'ph.embed', 'embed.more'].map((k) => `autoresponder.builder.${k}`);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const k of short) assert.ok(t(lang, `autoresponder.builder.${k}`).length <= 45, `${lang} ${k}`);
  }
});
