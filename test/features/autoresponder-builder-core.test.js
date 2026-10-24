import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createRule, getRule, listRules, MAX_RULES } from '../../src/features/autoresponder/store.js';
import { getRules, clearCache } from '../../src/features/autoresponder/cache.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';
import { drafts } from '../../src/features/autoresponder/builder/drafts.js';
import { builderId, parseBuilderId, PAGES, panelPayload } from '../../src/features/autoresponder/builder/panel.js';
import { summaryLines } from '../../src/features/autoresponder/builder/summary.js';
import { newDraft } from '../../src/features/autoresponder/builder/draft.js';
import { generateScript } from '../../src/features/autoresponder/builder/generate.js';

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const G = 'g1';
const command = createAutoresponderCommand();
const compiled = { version: 1, template: [{ t: 'text', v: 'hi' }], gates: [], actions: [], flags: { silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null } };
const base = { guildId: G, trigger: 'hello', matchMode: 'exact', script: 'hi', compiled, createdBy: 'u1' };
const CHAN = '777777777777777777';

function setup({ staff = true } = {}) {
  const guild = { id: G, ownerId: 'owner', roles: { cache: new Map() }, channels: { cache: new Map() }, members: { me: { id: 'bot', roles: { highest: { position: 10 } } } } };
  const logged = [];
  const logChannel = { isTextBased: () => true, send: async (payload) => { logged.push(payload); return { id: 'log1', channelId: 'logch' }; } };
  const ctx = { db, client: { user: { id: 'bot' }, channels: { fetch: async () => logChannel } } };
  const member = { id: 'staff', permissions: { has: () => staff }, roles: { highest: { position: 5 }, cache: new Map() }, guild };
  return { guild, ctx, member, logged };
}

// A fake interaction that records every response method used.
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
const slashRun = async (env, sub, extra) => { const i = fake(env, { sub, ...extra }); await command.execute(i, env.ctx); return i; };
const last = (i) => i.calls.at(-1);
const flat = (components) => components.flatMap((r) => r.toJSON().components);
const kinds = (payload) => flat(payload.components).map((c) => c.custom_id.split(':')[2]);

async function open(env) {
  const i = await slashRun(env, 'builder');
  const [, payload] = last(i);
  const panelId = parseBuilderId(flat(payload.components)[0].custom_id).panelId;
  return { i, payload, panelId };
}

async function press(env, panelId, action, { extra, userId = 'staff', as = userId, ...rest } = {}) {
  const customId = builderId(action, userId, panelId, extra);
  const i = fake(env, { customId, userId: as, ...rest });
  await command.components.handle(i, env.ctx);
  return i;
}
const submitModal = (env, panelId, action, fields, opts) => press(env, panelId, action, { fields, ...opts });
const updated = (i) => { const c = i.calls.find((x) => x[0] === 'update'); return c?.[1]; };
const refusal = (key) => ['reply', { content: t('en', key), flags: MessageFlags.Ephemeral }];

// ---- ids and panel shape ----

test('builderId and parseBuilderId round trip, and reject foreign ids', () => {
  const id = builderId('mode', '123', 'abcd1234');
  assert.equal(id, 'autoresponder:b:mode:123:abcd1234');
  assert.deepEqual(parseBuilderId(id), { action: 'mode', userId: '123', panelId: 'abcd1234', extra: undefined });
  assert.equal(parseBuilderId(builderId('x', '1', 'p', 'e')).extra, 'e');
  assert.equal(parseBuilderId('autoresponder:m:add:exact'), null);
  assert.equal(parseBuilderId('reactionroles:b:a:1:2'), null);
  assert.equal(parseBuilderId('autoresponder:b:a'), null);
});

test('PAGES has review last', () => {
  assert.deepEqual(PAGES, ['basics', 'reply', 'conditions', 'actions', 'review']);
});

test('every component and modal id of every page stays within 100 characters, in every language', () => {
  const userId = '9'.repeat(20);
  const panelId = 'z'.repeat(8);
  const longest = builderId('trigger', userId, panelId);
  assert.ok(longest.length <= 100);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const page of PAGES) {
      for (const dest of ['reply', 'dm', 'channel']) {
        const entry = { panelId, userId, page, pending: null, draft: { ...newDraft(), dest, channelId: CHAN, trigger: 'x', text: 'y' } };
        const payload = panelPayload(lang, entry);
        assert.ok(payload.content.length <= 2000);
        assert.deepEqual(payload.allowedMentions, { parse: [] });
        assert.ok(payload.components.length <= 5);
        for (const c of flat(payload.components)) assert.ok(c.custom_id.length <= 100, `${page} ${c.custom_id}`);
      }
    }
  }
});

test('the panel opens ephemeral with the page select first, and no mentions parse', async () => {
  const env = setup();
  await on();
  const { i, payload } = await open(env);
  assert.equal(last(i)[1].flags, MessageFlags.Ephemeral);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.components.length >= 2, true);
  const first = flat(payload.components)[0];
  assert.equal(first.custom_id.split(':')[2], 'nav');
  assert.deepEqual(first.options.map((o) => o.value), PAGES);
  for (const c of flat(payload.components)) assert.ok(c.custom_id.length <= 100);
  assert.deepEqual(kinds(payload), ['nav', 'trigger', 'mode']);
});

test('builder is refused for a non-manager and when the feature is off', async () => {
  const env = setup();
  const openBefore = drafts.size();
  const off = await slashRun(env, 'builder');
  assert.deepEqual(last(off), ['reply', { content: t('en', 'common.featureOff', { command: '/autoresponder enable' }), flags: MessageFlags.Ephemeral }]);
  await on();
  const nope = await slashRun(setup({ staff: false }), 'builder');
  assert.equal(last(nope)[1].content, t('en', 'common.notAllowed'));
  assert.equal(drafts.size(), openBefore);
});

test('existing subcommands still work after the change: list and add', async () => {
  const env = setup();
  await on();
  assert.equal(last(await slashRun(env, 'list'))[1].content, t('en', 'autoresponder.list.none'));
  const add = await slashRun(env, 'add');
  assert.equal(last(add)[0], 'showModal');
  assert.equal(last(add)[1].custom_id, 'autoresponder:m:add:exact');
});

// ---- security of the router ----

test('another member is refused with notYours and nothing changes', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  const before = drafts.get(panelId).draft;
  const i = await press(env, panelId, 'silent', { as: 'intruder' });
  assert.deepEqual(last(i), refusal('autoresponder.builder.notYours'));
  assert.equal(drafts.get(panelId).draft, before);
});

test('a member without manager rights who copies the id is refused', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  const plain = setup({ staff: false });
  const i = await press(plain, panelId, 'silent');
  assert.equal(last(i)[1].content, t('en', 'common.notAllowed'));
  assert.equal(drafts.get(panelId).draft.silent, false);
  const m = await submitModal(plain, panelId, 'mtrigger', { trigger: 'hack' });
  assert.equal(last(m)[1].content, t('en', 'common.notAllowed'));
  assert.equal(drafts.get(panelId).draft.trigger, '');
});

test('the guard also runs on clicks when the feature was switched off meanwhile', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  await setFeature(db, G, 'autoresponder', { enabled: false });
  const i = await press(env, panelId, 'silent');
  assert.equal(last(i)[1].content, t('en', 'common.featureOff', { command: '/autoresponder enable' }));
  assert.equal(drafts.get(panelId).draft.silent, false);
});

test('an unknown, dropped or replaced panel replies expired and does not throw', async () => {
  const env = setup();
  await on();
  const unknown = await press(env, 'nope1234', 'silent');
  assert.deepEqual(last(unknown), refusal('autoresponder.builder.expired'));
  const first = await open(env);
  drafts.drop(first.panelId);
  assert.deepEqual(last(await press(env, first.panelId, 'nav', { values: ['reply'] })), refusal('autoresponder.builder.expired'));
  const a = await open(env);
  const b = await open(env);
  assert.notEqual(a.panelId, b.panelId);
  assert.deepEqual(last(await press(env, a.panelId, 'silent')), refusal('autoresponder.builder.expired'));
  assert.deepEqual(last(await submitModal(env, a.panelId, 'mtext', { text: 'x' })), refusal('autoresponder.builder.expired'));
  assert.equal(updated(await press(env, b.panelId, 'silent')) !== undefined, true);
});

test('an unparseable builder id is ignored', async () => {
  const env = setup();
  await on();
  const i = fake(env, { customId: 'autoresponder:b:silent' });
  await command.components.handle(i, env.ctx);
  assert.equal(i.calls.length, 0);
});

// ---- navigation and controls ----

test('nav switches pages and the reply page shows its controls', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  const reply = updated(await press(env, panelId, 'nav', { values: ['reply'] }));
  assert.deepEqual(kinds(reply), ['nav', 'text', 'delete', 'silent', 'bembed', 'bdelreply', 'dest']);
  const review = updated(await press(env, panelId, 'nav', { values: ['review'] }));
  assert.deepEqual(kinds(review), ['nav', 'btry', 'bscript', 'save', 'cancel']);
  const bogus = updated(await press(env, panelId, 'nav', { values: ['hax'] }));
  assert.equal(bogus, undefined);
  assert.equal(drafts.get(panelId).page, 'review');
});

test('the trigger button opens a prefilled modal; the submit stores the trigger and re-renders', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  const click = await press(env, panelId, 'trigger');
  const [kind, modal] = last(click);
  assert.equal(kind, 'showModal');
  assert.equal(parseBuilderId(modal.custom_id).action, 'mtrigger');
  assert.ok(modal.title.length <= 45);
  const input = modal.components[0].components[0];
  assert.equal(input.custom_id, 'trigger');
  assert.equal(input.max_length, 100);
  assert.ok(input.label.length <= 45);
  const done = await submitModal(env, panelId, 'mtrigger', { trigger: 'Hello there' });
  assert.equal(drafts.get(panelId).draft.trigger, 'Hello there');
  assert.ok(updated(done).content.includes('Hello there'));
});

test('an empty trigger or a bad regex is refused with badTrigger and the draft is unchanged', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  const empty = await submitModal(env, panelId, 'mtrigger', { trigger: '   ' });
  assert.deepEqual(last(empty), refusal('autoresponder.badTrigger.EMPTY_TRIGGER'));
  await press(env, panelId, 'mode', { values: ['regex'] });
  assert.equal(drafts.get(panelId).draft.matchMode, 'regex');
  const bad = await submitModal(env, panelId, 'mtrigger', { trigger: '(' });
  assert.deepEqual(last(bad), refusal('autoresponder.badTrigger.BAD_REGEX'));
  assert.equal(drafts.get(panelId).draft.trigger, '');
});

test('mode, destination and the channel select update the draft and re-render', async () => {
  const env = setup();
  await on();
  env.guild.channels.cache.set(CHAN, { id: CHAN, name: 'general' });
  const { panelId } = await open(env);
  const m = await press(env, panelId, 'mode', { values: ['includes'] });
  assert.equal(drafts.get(panelId).draft.matchMode, 'includes');
  assert.ok(updated(m));
  await press(env, panelId, 'nav', { values: ['reply'] });
  const d = await press(env, panelId, 'dest', { values: ['channel'] });
  assert.equal(drafts.get(panelId).draft.dest, 'channel');
  assert.deepEqual(kinds(updated(d)), ['nav', 'text', 'delete', 'silent', 'bembed', 'bdelreply', 'dest', 'channel']);
  const c = await press(env, panelId, 'channel', { values: [CHAN] });
  assert.equal(drafts.get(panelId).draft.channelId, CHAN);
  assert.ok(updated(c).content.includes(`<#${CHAN}>`));
  const back = await press(env, panelId, 'dest', { values: ['dm'] });
  assert.deepEqual(kinds(updated(back)), ['nav', 'text', 'delete', 'silent', 'bembed', 'bdelreply', 'dest']);
  const bogus = await press(env, panelId, 'dest', { values: ['hax'] });
  assert.equal(updated(bogus), undefined);
  assert.equal(drafts.get(panelId).draft.dest, 'dm');
});

test('changing the mode to regex with a stored bad trigger is refused', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  await submitModal(env, panelId, 'mtrigger', { trigger: '(' });
  const i = await press(env, panelId, 'mode', { values: ['regex'] });
  assert.equal(drafts.get(panelId).draft.matchMode, 'exact');
  assert.equal(last(i)[1].content, t('en', 'autoresponder.badTrigger.BAD_REGEX'));
});

test('delete and silent toggle and show in the summary', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  await press(env, panelId, 'delete');
  await press(env, panelId, 'silent');
  assert.equal(drafts.get(panelId).draft.deleteTrigger, true);
  assert.equal(drafts.get(panelId).draft.silent, true);
  const off = await press(env, panelId, 'silent');
  assert.equal(drafts.get(panelId).draft.silent, false);
  assert.ok(updated(off).content.includes(t('en', 'autoresponder.builder.sum.delete')));
});

test('a change that breaks the compile is reverted, and the follow-up lists the error with its position', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  await submitModal(env, panelId, 'mtext', { text: 'fine' });
  assert.equal(drafts.get(panelId).draft.text, 'fine');
  const bad = await submitModal(env, panelId, 'mtext', { text: 'a {nope}' });
  assert.equal(drafts.get(panelId).draft.text, 'fine');
  assert.equal(updated(bad), undefined);
  const [kind, payload] = last(bad);
  assert.equal(kind, 'followUp');
  assert.equal(payload.flags, MessageFlags.Ephemeral);
  assert.ok(payload.content.includes(t('en', 'autoresponder.error.UNKNOWN_FUNCTION', { detail: '"nope"' })));
  assert.ok(payload.content.includes('At character 3:'));
  assert.ok(bad.calls.some((c) => c[0] === 'deferUpdate'));
});

// ---- save ----

async function ready(env, trigger = 'hi bot', text = 'hello there') {
  const { panelId } = await open(env);
  await submitModal(env, panelId, 'mtrigger', { trigger });
  await submitModal(env, panelId, 'mtext', { text });
  return panelId;
}

test('save stores one rule with the generated script, invalidates the cache, logs once and replies with the id', async () => {
  const env = setup();
  await on();
  const panelId = await ready(env);
  await press(env, panelId, 'delete');
  assert.deepEqual(await getRules(db, G), []);
  const i = await press(env, panelId, 'save');
  const rules = await listRules(db, G);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].trigger, 'hi bot');
  assert.equal(rules[0].matchMode, 'exact');
  assert.equal(rules[0].script, generateScript({ ...newDraft(), trigger: 'hi bot', text: 'hello there', deleteTrigger: true }));
  assert.equal(rules[0].script, 'hello there\n{delete}');
  assert.ok(rules[0].compiled.version);
  assert.equal(rules[0].createdBy, 'staff');
  assert.equal((await getRules(db, G)).length, 1);
  assert.equal(env.logged.length, 1);
  const [kind, payload] = last(i);
  assert.equal(kind, 'editReply');
  assert.equal(payload.content, t('en', 'autoresponder.builder.saved', { id: rules[0].id }));
  assert.deepEqual(payload.components, []);
  assert.equal(drafts.get(panelId), null);
  assert.deepEqual(last(await press(env, panelId, 'save')), refusal('autoresponder.builder.expired'));
});

test('a saved builder rule appears in list and show, and edit opens it with the script prefilled', async () => {
  const env = setup();
  await on();
  const panelId = await ready(env);
  await press(env, panelId, 'save');
  const [rule] = await listRules(db, G);
  assert.ok(last(await slashRun(env, 'list'))[1].content.includes('hi bot'));
  const sh = fake(env, { sub: 'show' });
  sh.options = { getSubcommand: () => 'show', getInteger: () => rule.id, getString: () => null };
  await command.execute(sh, env.ctx);
  assert.ok(last(sh)[1].content.includes('hello there'));
  const e = fake(env, { sub: 'edit' });
  e.options = { getSubcommand: () => 'edit', getInteger: () => rule.id, getString: () => null };
  await command.execute(e, env.ctx);
  const modal = last(e)[1];
  assert.equal(modal.custom_id, `autoresponder:m:edit:${rule.id}`);
  assert.equal(modal.components[1].components[0].value, 'hello there');
});

test('save with an invalid reply text stores nothing, logs nothing, keeps the entry and lists the errors', async () => {
  const env = setup();
  await on();
  const panelId = await ready(env);
  // Bypass the per-change compile to simulate a draft that went bad (for example a role removed meanwhile).
  drafts.update(panelId, { draft: { ...drafts.get(panelId).draft, text: 'x {nope}' } });
  const i = await press(env, panelId, 'save');
  assert.equal((await listRules(db, G)).length, 0);
  assert.equal(env.logged.length, 0);
  assert.ok(drafts.get(panelId));
  assert.equal(drafts.get(panelId).saving, false);
  const [kind, payload] = last(i);
  assert.equal(kind, 'followUp');
  assert.ok(payload.content.includes('At character 3:'));
  assert.ok(payload.content.includes('nope'));
});

test('save with an empty trigger replies badTrigger and keeps the entry', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  const i = await press(env, panelId, 'save');
  assert.equal(last(i)[0], 'followUp');
  assert.equal(last(i)[1].content, t('en', 'autoresponder.badTrigger.EMPTY_TRIGGER'));
  assert.ok(drafts.get(panelId));
  assert.equal(drafts.get(panelId).saving, false);
  assert.equal((await listRules(db, G)).length, 0);
});

test('the 101st rule replies full and stores nothing', async () => {
  const env = setup();
  await on();
  for (let k = 0; k < MAX_RULES; k += 1) await createRule(db, { ...base, trigger: `t${k}` });
  const panelId = await ready(env);
  const i = await press(env, panelId, 'save');
  assert.equal(last(i)[1].content, t('en', 'autoresponder.full'));
  assert.equal((await listRules(db, G)).length, MAX_RULES);
  assert.equal(env.logged.length, 0);
  assert.ok(drafts.get(panelId));
});

test('two simultaneous Save presses create exactly one rule', async () => {
  const env = setup();
  await on();
  const panelId = await ready(env);
  const [a, b] = await Promise.all([press(env, panelId, 'save'), press(env, panelId, 'save')]);
  assert.equal((await listRules(db, G)).length, 1);
  assert.equal(env.logged.length, 1);
  const outcomes = [last(a), last(b)].map(([k]) => k).sort();
  assert.deepEqual(outcomes, ['editReply', 'reply']);
});

test('cancel drops the entry and a later click gets expired', async () => {
  const env = setup();
  await on();
  const { panelId } = await open(env);
  const c = await press(env, panelId, 'cancel');
  assert.deepEqual(updated(c), { content: t('en', 'autoresponder.builder.cancelled'), components: [] });
  assert.equal(drafts.get(panelId), null);
  assert.deepEqual(last(await press(env, panelId, 'silent')), refusal('autoresponder.builder.expired'));
});

// ---- summary and texts ----

test('summaryLines shows the trigger, reply settings and the delete-with-react note', () => {
  const d = {
    ...newDraft('includes'), trigger: 'hi', text: 'yo', deleteTrigger: true,
    gates: [{ fn: 'cooldown', seconds: 30 }, { fn: 'requirerole', ids: ['1', '2'] }, { fn: 'denyperm', perms: ['BanMembers'] }],
    actions: [{ fn: 'react', emoji: '👍' }, { fn: 'addrole', id: '5' }],
  };
  const lines = summaryLines('en', d);
  assert.ok(lines[0].includes('hi') && lines[0].includes('includes'));
  assert.ok(lines.some((l) => l.includes('30')));
  assert.ok(lines.some((l) => l.includes('<@&1>') && l.includes('<@&2>')));
  assert.ok(lines.some((l) => l.includes(t('en', 'autoresponder.builder.sum.note.deleteReact'))));
  const plain = summaryLines('en', { ...newDraft(), trigger: 'a' });
  assert.ok(!plain.some((l) => l.includes(t('en', 'autoresponder.builder.sum.note.deleteReact'))));
});

test('every builder text exists in en, fr and ar, with short labels', () => {
  const keys = [
    'head', 'notYours', 'expired', 'cancelled', 'saved', 'logDetail', 'refused', 'notSet', 'modal.trigger', 'modal.text',
    'input.trigger', 'input.text', 'ph.nav', 'ph.mode', 'ph.dest', 'ph.channel',
    'btn.trigger', 'btn.text', 'btn.delete', 'btn.silent', 'btn.save', 'btn.cancel',
    ...PAGES.map((p) => `page.${p}`),
    ...['exact', 'startswith', 'endswith', 'includes', 'regex'].map((m) => `mode.${m}`),
    ...['reply', 'dm', 'channel'].map((d) => `dest.${d}`),
    'sum.trigger', 'sum.text', 'sum.dest.reply', 'sum.dest.dm', 'sum.dest.channel', 'sum.embed', 'sum.delete', 'sum.delete_reply',
    'sum.silent', 'sum.script', 'sum.note.deleteReact',
    ...['cooldown', 'requirerole', 'denyrole', 'requireperm', 'denyperm', 'requirechannel', 'denychannel', 'requireuser',
      'addrole', 'removerole', 'setnick', 'react', 'reactreply'].map((f) => `sum.${f}`),
  ].map((k) => `autoresponder.builder.${k}`);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const key of keys) assert.notEqual(t(lang, key), key, `${lang} ${key}`);
    for (const key of ['modal.trigger', 'modal.text', 'input.trigger', 'input.text']) {
      assert.ok(t(lang, `autoresponder.builder.${key}`).length <= 45, `${lang} ${key}`);
    }
  }
});
