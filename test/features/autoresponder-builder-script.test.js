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
import { builderId, parseBuilderId, panelPayload } from '../../src/features/autoresponder/builder/panel.js';
import { newDraft, patch, toScriptMode } from '../../src/features/autoresponder/builder/draft.js';
import { generateScript } from '../../src/features/autoresponder/builder/generate.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();
const bt = (key, vars) => t('en', `autoresponder.builder.${key}`, vars);

function setup() {
  const guild = {
    id: G, name: 'Srv', ownerId: 'owner', memberCount: 5, createdTimestamp: 1_500_000_000_000, iconURL: () => 'i.png',
    roles: { cache: new Map() }, channels: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } },
  };
  const logChannel = { isTextBased: () => true, send: async () => ({ id: 'log1', channelId: 'logch' }) };
  const ctx = { db, client: { user: { id: 'bot' }, channels: { fetch: async () => logChannel } } };
  const user = { id: 'staff', username: 'Sam', globalName: null, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'a.png', tag: 'Sam#0' };
  const member = { id: 'staff', displayName: 'Sam', user, guild, permissions: { has: () => true }, roles: { highest: { position: 5 }, cache: new Map() } };
  const channel = { id: 'c1', name: 'general' };
  return { guild, ctx, member, user, channel };
}

function fake(env, extra = {}) {
  const calls = [];
  const i = {
    guildId: G, guild: env.guild, member: env.member, user: env.user, channel: env.channel, channelId: 'c1', calls,
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

async function press(env, panelId, action, { extra, ...rest } = {}) {
  const i = fake(env, { customId: builderId(action, 'staff', panelId, extra), ...rest });
  await command.components.handle(i, env.ctx);
  return i;
}
const submitModal = (env, panelId, action, fields) => press(env, panelId, action, { fields });
const draftOf = (panelId) => drafts.get(panelId).draft;

async function start(draft = {}) {
  const env = setup();
  await on();
  const panelId = await open(env);
  drafts.update(panelId, { draft: patch(newDraft(), { trigger: 'hello', matchMode: 'includes', text: 'hi', ...draft }), page: 'review' });
  return { env, panelId };
}
const SCRIPT = 'Welcome {user_name}\n{react:👍}';

async function scripted() {
  const { env, panelId } = await start();
  await submitModal(env, panelId, 'mscript', { script: SCRIPT });
  return { env, panelId };
}

test('Edit script text opens a modal prefilled with the generated script', async () => {
  const { env, panelId } = await start({ text: 'hi there' });
  const [kind, modal] = last(await press(env, panelId, 'bscript'));
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'mscript');
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, 'script');
  assert.equal(input.style, 2);
  assert.equal(input.max_length, 4000);
  assert.equal(input.value, generateScript(draftOf(panelId)));
  assert.ok(modal.title.length <= 45 && input.label.length <= 45);
});

test('a generated script over 4000 characters leaves the prefill empty and says so', async () => {
  const { env, panelId } = await start({ text: 'x'.repeat(4100) });
  const [kind, modal] = last(await press(env, panelId, 'bscript'));
  assert.equal(kind, 'showModal');
  const input = modal.components[0].components[0];
  assert.ok(!input.value);
  assert.equal(input.placeholder, bt('script.tooLong'));
  assert.ok(input.placeholder.length <= 100);
});

test('closing the modal without submitting changes nothing', async () => {
  const { env, panelId } = await start();
  const before = structuredClone(drafts.get(panelId));
  await press(env, panelId, 'bscript');
  const after = drafts.get(panelId);
  assert.deepEqual({ ...after, expiresAt: 0 }, { ...before, expiresAt: 0 });
  assert.equal(draftOf(panelId).mode, 'guided');
});

test('a valid edited script switches to script mode and Save stores exactly that text', async () => {
  const { env, panelId } = await scripted();
  assert.equal(draftOf(panelId).mode, 'script');
  assert.equal(draftOf(panelId).scriptText, SCRIPT);
  assert.equal(drafts.get(panelId).page, 'review');
  await press(env, panelId, 'save');
  const [rule] = await listRules(db, G);
  assert.equal(rule.script, SCRIPT);
  assert.equal(rule.trigger, 'hello');
  assert.deepEqual(rule.compiled.actions.map((a) => a.fn), ['react']);
});

test('an invalid script keeps guided mode and the draft unchanged and lists the errors', async () => {
  const { env, panelId } = await start();
  const i = await submitModal(env, panelId, 'mscript', { script: 'hi {embed:nope}' });
  assert.equal(draftOf(panelId).mode, 'guided');
  assert.equal(draftOf(panelId).scriptText, null);
  assert.equal(updated(i), undefined);
  assert.equal(last(i)[0], 'followUp');
  assert.ok(last(i)[1].content.includes(t('en', 'autoresponder.error.EMBED_NOT_FOUND', { detail: '' }).trim()));
});

test('4000 characters are accepted and 4001 are refused with SCRIPT_TOO_LONG', async () => {
  const { env, panelId } = await start();
  const long = await submitModal(env, panelId, 'mscript', { script: 'a'.repeat(4001) });
  assert.equal(draftOf(panelId).mode, 'guided');
  assert.ok(last(long)[1].content.includes('4000'), last(long)[1].content);
  const ok = await submitModal(env, panelId, 'mscript', { script: 'a'.repeat(4000) });
  assert.equal(draftOf(panelId).mode, 'script');
  const view = updated(ok);
  assert.ok(view.content.length <= 2000);
  assert.ok(view.content.includes(bt('sum.scriptClipped')));
});

test('in script mode the nav select is gone and the summary is the code block', async () => {
  const { env, panelId } = await scripted();
  const view = updated(await press(env, panelId, 'bback', { extra: 'review' }));
  assert.deepEqual(kinds(view), ['btry', 'bscript', 'bbasics', 'save', 'cancel']);
  assert.ok(view.content.includes('```\nWelcome {user_name}\n{react:👍}\n```'));
  assert.ok(view.content.includes('hello'));
  for (const lang of ['en', 'fr', 'ar']) {
    const entry = { panelId: 'z'.repeat(8), userId: '9'.repeat(20), page: 'review', draft: toScriptMode(newDraft(), SCRIPT) };
    for (const page of ['review', 'basics', 'reply', 'embed']) {
      const payload = panelPayload(lang, { ...entry, page });
      assert.ok(payload.components.length <= 5);
      assert.ok(payload.content.length <= 2000);
      assert.ok(!kinds(payload).includes('nav'), page);
      for (const r of payload.components) assert.ok(r.toJSON().components.length <= 5);
      for (const c of flat(payload.components)) assert.ok(c.custom_id.length <= 100);
    }
  }
});

test('Edit script text again is prefilled with the script text and keeps script mode', async () => {
  const { env, panelId } = await scripted();
  const [, modal] = last(await press(env, panelId, 'bscript'));
  assert.equal(modal.components[0].components[0].value, SCRIPT);
  await submitModal(env, panelId, 'mscript', { script: 'Bye\n{silent}' });
  assert.equal(draftOf(panelId).mode, 'script');
  assert.equal(draftOf(panelId).scriptText, 'Bye\n{silent}');
});

test('Try it works in script mode', async () => {
  const { env, panelId } = await scripted();
  const i = await submitModal(env, panelId, 'mtry', { sample: 'hello world' });
  assert.ok(last(i)[1].content.includes(bt('try.match')));
  assert.ok(last(i)[1].content.includes('Welcome Sam'));
});

test('the trigger and mode can still be changed through Basics in script mode', async () => {
  const { env, panelId } = await scripted();
  const basics = updated(await press(env, panelId, 'bbasics'));
  assert.equal(drafts.get(panelId).page, 'basics');
  assert.deepEqual(kinds(basics), ['trigger', 'mode', 'bback']);
  await submitModal(env, panelId, 'mtrigger', { trigger: 'bonjour' });
  await press(env, panelId, 'mode', { values: ['startswith'] });
  assert.equal(draftOf(panelId).trigger, 'bonjour');
  assert.equal(draftOf(panelId).matchMode, 'startswith');
  assert.equal(draftOf(panelId).mode, 'script');
  await press(env, panelId, 'save');
  const [rule] = await listRules(db, G);
  assert.equal(rule.trigger, 'bonjour');
  assert.equal(rule.matchMode, 'startswith');
  assert.equal(rule.script, SCRIPT);
});

test('there is no way back to guided mode: guided-only actions are ignored in script mode', async () => {
  const { env, panelId } = await scripted();
  const snapshot = JSON.stringify(draftOf(panelId));
  const attempts = [
    ['nav', { values: ['reply'] }], ['mtext', { fields: { text: 'x' } }], ['dest', { values: ['dm'] }], ['delete', {}],
    ['silent', {}], ['bembed', {}], ['embed', { values: ['none'] }], ['cond', { values: ['cooldown'] }], ['act', { values: ['setnick'] }],
    ['mnick', { fields: { nick: 'x' } }], ['bdelreply', {}], ['mdelreply', { fields: { seconds: '5' } }],
  ];
  for (const [action, rest] of attempts) {
    const i = await press(env, panelId, action, rest);
    assert.ok(i.calls.length >= 1, action);
    assert.equal(JSON.stringify(draftOf(panelId)), snapshot, action);
    assert.equal(drafts.get(panelId).page, 'review', action);
  }
});

test('Cancel in script mode drops the panel', async () => {
  const { env, panelId } = await scripted();
  await press(env, panelId, 'cancel');
  assert.equal(drafts.get(panelId), null);
});

test('forged calls never throw: mscript outside a modal, bback with a bad target', async () => {
  const { env, panelId } = await start();
  const click = await press(env, panelId, 'mscript');
  assert.equal(click.calls.length, 1);
  assert.equal(last(click)[1].content, bt('expired'));
  assert.equal(draftOf(panelId).mode, 'guided');
  assert.ok((await press(env, panelId, 'bback', { extra: '../x' })).calls.length >= 1);
});

test('every script-mode i18n key exists in en, fr and ar, with short labels', () => {
  const short = ['btn.script', 'modal.script', 'input.script'];
  const keys = [...short, 'script.tooLong', 'sum.scriptClipped'].map((k) => `autoresponder.builder.${k}`);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const k of short) assert.ok(t(lang, `autoresponder.builder.${k}`).length <= 45, `${lang} ${k}`);
    assert.ok(t(lang, 'autoresponder.builder.script.tooLong').length <= 100, lang);
  }
});
