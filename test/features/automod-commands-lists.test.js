import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../../src/features/automod/index.js';
import { readConfig, MAX_LIST } from '../../src/features/automod/config.js';
import { addHistory } from '../../src/features/automod/history.js';
import { getFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const cmd = commands[0];
const json = cmd.data.toJSON();

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await db.query('TRUNCATE guild_settings, scheduled_jobs, automod_history'); });
after(async () => { await db.end(); });

function fake(group, sub, { strings = {}, roles = {}, channels = {}, users = {} } = {}) {
  const calls = { reply: [] };
  return {
    calls,
    guildId: 'g1',
    inGuild: () => true,
    member: { permissions: { has: () => true }, guild: { id: 'g1' }, roles: { cache: { has: () => false } } },
    guild: { id: 'g1' },
    options: {
      getSubcommand: () => sub,
      getSubcommandGroup: () => group,
      getString: (n) => strings[n] ?? null,
      getRole: (n) => roles[n] ?? null,
      getChannel: (n) => channels[n] ?? null,
      getUser: (n) => users[n] ?? null,
    },
    deferred: false,
    replied: false,
    reply: async (p) => { calls.reply.push(p); },
    editReply: async (p) => { calls.reply.push(p); },
  };
}
const run = (i) => cmd.execute(i, { db });
const text = (i) => i.calls.reply.at(-1).content;
const saved = async () => readConfig((await getFeature(db, 'g1', 'automod')).config);
const letters = (n) => `${String.fromCharCode(97 + (n % 26))}${String.fromCharCode(97 + Math.floor(n / 26))}`;

test('structure: groups and subcommands exist and descriptions fit', () => {
  const names = json.options.map((o) => o.name);
  for (const n of ['exempt', 'words', 'domains', 'mode', 'history']) assert.ok(names.includes(n), n);
  const sub = (g) => json.options.find((o) => o.name === g).options.map((o) => o.name);
  assert.deepEqual(sub('exempt'), ['add-role', 'remove-role', 'add-channel', 'remove-channel']);
  assert.deepEqual(sub('words'), ['add', 'remove', 'builtin-remove', 'builtin-restore', 'builtin', 'list']);
  const walk = (o) => {
    assert.ok(o.description.length >= 1 && o.description.length <= 100, o.name);
    for (const c of o.options ?? []) walk(c);
  };
  walk(json);
});

test('exempt add-role stores the role, refuses @everyone, and remove-role removes it', async () => {
  const i = fake('exempt', 'add-role', { roles: { role: { id: 'r1' } } });
  await run(i);
  assert.deepEqual((await saved()).exemptRoles, ['r1']);
  assert.equal(i.calls.reply[0].allowedMentions.parse.length, 0);
  const dup = fake('exempt', 'add-role', { roles: { role: { id: 'r1' } } });
  await run(dup);
  assert.equal(text(dup), t('en', 'automod.lists.exists'));
  const ev = fake('exempt', 'add-role', { roles: { role: { id: 'g1' } } });
  await run(ev);
  assert.equal(text(ev), t('en', 'automod.lists.everyone'));
  assert.deepEqual((await saved()).exemptRoles, ['r1']);
  await run(fake('exempt', 'remove-role', { roles: { role: { id: 'r1' } } }));
  assert.deepEqual((await saved()).exemptRoles, []);
  const miss = fake('exempt', 'remove-role', { roles: { role: { id: 'r1' } } });
  await run(miss);
  assert.equal(text(miss), t('en', 'automod.lists.missing'));
});

test('exempt channels add and remove; the list is capped with a clear message', async () => {
  await run(fake('exempt', 'add-channel', { channels: { channel: { id: 'c1' } } }));
  assert.deepEqual((await saved()).exemptChannels, ['c1']);
  for (let n = 2; n <= 20; n += 1) await run(fake('exempt', 'add-channel', { channels: { channel: { id: `c${n}` } } }));
  const full = fake('exempt', 'add-channel', { channels: { channel: { id: 'c21' } } });
  await run(full);
  assert.equal(text(full), t('en', 'automod.lists.full'));
  assert.equal((await saved()).exemptChannels.length, 20);
  await run(fake('exempt', 'remove-channel', { channels: { channel: { id: 'c1' } } }));
  assert.equal((await saved()).exemptChannels.includes('c1'), false);
});

test('words add normalises and stores; rejects short, long, empty and duplicate; remove works', async () => {
  await run(fake('words', 'add', { strings: { word: '  B4D   Wooord  ' } }));
  assert.deepEqual((await saved()).rules.words.custom, ['bad woord']);
  const dup = fake('words', 'add', { strings: { word: 'bad woord' } });
  await run(dup);
  assert.equal(text(dup), t('en', 'automod.lists.exists'));
  for (const bad of ['a', '   ', '', 'ab'.repeat(51)]) {
    const i = fake('words', 'add', { strings: { word: bad } });
    await run(i);
    assert.equal(text(i), t('en', 'automod.lists.bad_word'), JSON.stringify(bad));
  }
  assert.equal((await saved()).rules.words.custom.length, 1);
  await run(fake('words', 'remove', { strings: { word: 'BAD woord' } }));
  assert.deepEqual((await saved()).rules.words.custom, []);
  const miss = fake('words', 'remove', { strings: { word: 'nothing' } });
  await run(miss);
  assert.equal(text(miss), t('en', 'automod.lists.missing'));
});

test('words add stops at the cap', async () => {
  for (let n = 0; n < MAX_LIST; n += 1) await run(fake('words', 'add', { strings: { word: `word${letters(n)}x` } }));
  assert.equal((await saved()).rules.words.custom.length, MAX_LIST);
  const i = fake('words', 'add', { strings: { word: 'onemoreword' } });
  await run(i);
  assert.equal(text(i), t('en', 'automod.lists.full'));
});

test('builtin-remove hides a builtin word, builtin-restore brings it back, others are refused', async () => {
  await run(fake('words', 'builtin-remove', { strings: { word: 'Damn' } }));
  assert.deepEqual((await saved()).rules.words.removedBuiltin, ['damn']);
  const again = fake('words', 'builtin-remove', { strings: { word: 'damn' } });
  await run(again);
  assert.equal(text(again), t('en', 'automod.lists.exists'));
  const nb = fake('words', 'builtin-remove', { strings: { word: 'notaswearword' } });
  await run(nb);
  assert.equal(text(nb), t('en', 'automod.lists.not_builtin'));
  assert.deepEqual((await saved()).rules.words.removedBuiltin, ['damn']);
  await run(fake('words', 'builtin-restore', { strings: { word: 'damn' } }));
  assert.deepEqual((await saved()).rules.words.removedBuiltin, []);
  const miss = fake('words', 'builtin-restore', { strings: { word: 'damn' } });
  await run(miss);
  assert.equal(text(miss), t('en', 'automod.lists.missing'));
});

test('builtin <state> toggles useBuiltin', async () => {
  await run(fake('words', 'builtin', { strings: { state: 'off' } }));
  assert.equal((await saved()).rules.words.useBuiltin, false);
  await run(fake('words', 'builtin', { strings: { state: 'on' } }));
  assert.equal((await saved()).rules.words.useBuiltin, true);
});

test('words list shows custom words, removed builtins and counts, not the builtin list', async () => {
  await run(fake('words', 'add', { strings: { word: 'qwcustom' } }));
  await run(fake('words', 'builtin-remove', { strings: { word: 'crap' } }));
  const i = fake('words', 'list');
  await run(i);
  const out = text(i);
  assert.ok(out.includes('qwcustom'));
  assert.ok(out.includes('crap'));
  assert.ok(!out.includes('bastard'));
  assert.equal(i.calls.reply[0].allowedMentions.parse.length, 0);
});

test('words list is capped with an "and N more" suffix', async () => {
  for (let n = 0; n < 60; n += 1) await run(fake('words', 'add', { strings: { word: `longword${letters(n)}k` } }));
  const i = fake('words', 'list');
  await run(i);
  assert.match(text(i), /and \d+ more/);
  assert.ok(text(i).length < 1500);
});

test('domains rejects a bad domain and a non-numeric server id, and stores valid values', async () => {
  const d = (type, list, action, value) => fake(null, 'domains', { strings: { type, list, action, value } });
  const badDomains = ['https://example.com', 'example.com/path', 'nodot', 'bad domain.com', '-a.com', 'a-.com', 'exa_mple.com',
    `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`, 'user@example.com', 'example.c', ''];
  for (const bad of badDomains) {
    const i = d('links', 'allow', 'add', bad);
    await run(i);
    assert.equal(text(i), t('en', 'automod.lists.bad_domain'), JSON.stringify(bad));
  }
  for (const bad of ['abc', '1234', '123456789012345678901', '12345678901234567x']) {
    const i = d('invites', 'allow', 'add', bad);
    await run(i);
    assert.equal(text(i), t('en', 'automod.lists.bad_server'), bad);
  }
  assert.deepEqual((await saved()).rules.links.allow, []);
  await run(d('links', 'allow', 'add', 'Example.COM'));
  await run(d('links', 'block', 'add', 'evil.example.org'));
  await run(d('invites', 'allow', 'add', '12345678901234567'));
  await run(d('invites', 'block', 'add', '12345678901234567890'));
  const c = await saved();
  assert.deepEqual(c.rules.links.allow, ['example.com']);
  assert.deepEqual(c.rules.links.block, ['evil.example.org']);
  assert.deepEqual(c.rules.invites.allow, ['12345678901234567']);
  assert.deepEqual(c.rules.invites.block, ['12345678901234567890']);
  const dup = d('links', 'allow', 'add', 'example.com');
  await run(dup);
  assert.equal(text(dup), t('en', 'automod.lists.exists'));
  await run(d('links', 'allow', 'remove', 'example.com'));
  assert.deepEqual((await saved()).rules.links.allow, []);
  const miss = d('links', 'allow', 'remove', 'example.com');
  await run(miss);
  assert.equal(text(miss), t('en', 'automod.lists.missing'));
});

test('domains lists are capped at 100', async () => {
  for (let n = 0; n < MAX_LIST; n += 1) {
    await run(fake(null, 'domains', { strings: { type: 'links', list: 'block', action: 'add', value: `site${n}.com` } }));
  }
  const i = fake(null, 'domains', { strings: { type: 'links', list: 'block', action: 'add', value: 'extra.com' } });
  await run(i);
  assert.equal(text(i), t('en', 'automod.lists.full'));
});

test('mode toggles blockAllExceptAllowed', async () => {
  await run(fake(null, 'mode', { strings: { type: 'links', state: 'on' } }));
  assert.equal((await saved()).rules.links.blockAllExceptAllowed, true);
  await run(fake(null, 'mode', { strings: { type: 'invites', state: 'off' } }));
  const c = await saved();
  assert.equal(c.rules.invites.blockAllExceptAllowed, false);
  assert.equal(c.rules.links.blockAllExceptAllowed, true);
});

test('history lists newest first, filters by user, and works while the feature is off', async () => {
  await addHistory(db, { guildId: 'g1', userId: '111', rules: ['spam'], messageId: 'm1', actions: ['delete'], caseNumber: 4 });
  await addHistory(db, { guildId: 'g1', userId: '222', rules: ['words', 'links'], messageId: 'm2', actions: ['delete', 'warn'], caseNumber: null });
  await addHistory(db, { guildId: 'g2', userId: '111', rules: ['invites'], messageId: 'm3', actions: [], caseNumber: 9 });
  const all = fake(null, 'history');
  await run(all);
  const out = text(all);
  assert.ok(out.indexOf('222') < out.indexOf('111'));
  assert.ok(out.includes(t('en', 'automod.rule.words')));
  assert.match(out, /<t:\d+:R>/);
  assert.ok(out.includes('#4'));
  assert.ok(!out.includes(t('en', 'automod.rule.invites')));
  assert.equal(all.calls.reply[0].allowedMentions.parse.length, 0);
  const one = fake(null, 'history', { users: { user: { id: '111' } } });
  await run(one);
  assert.ok(text(one).includes('111') && !text(one).includes('222'));
  const none = fake(null, 'history', { users: { user: { id: '999' } } });
  await run(none);
  assert.equal(text(none), t('en', 'automod.history.empty'));
});

test('history shows at most 10 entries', async () => {
  for (let n = 0; n < 14; n += 1) await addHistory(db, { guildId: 'g1', userId: '111', rules: ['spam'], messageId: `m${n}`, actions: ['delete'], caseNumber: n + 100 });
  const i = fake(null, 'history');
  await run(i);
  assert.equal((text(i).match(/<t:\d+:R>/g) ?? []).length, 10);
  assert.ok(text(i).length < 2000);
});

test('non-managers are refused for the new subcommands', async () => {
  const i = fake('words', 'add', { strings: { word: 'hello' } });
  i.member.permissions.has = () => false;
  await run(i);
  assert.equal(text(i), t('en', 'common.notAllowed'));
  const h = fake(null, 'history');
  h.member.permissions.has = () => false;
  await run(h);
  assert.equal(text(h), t('en', 'common.notAllowed'));
});
