import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createRule, getRule } from '../../src/features/autoresponder/store.js';
import { clearCache } from '../../src/features/autoresponder/cache.js';
import { compileScript, COMPILE_ERROR_CODES } from '../../src/features/autoresponder/script/compile.js';
import { drawRandom } from '../../src/features/autoresponder/script/random.js';
import { ESCAPED_BRACKET } from '../../src/features/autoresponder/script/parse.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';

const G = '100000000000000000';
const id = (n) => `2${String(n).padStart(17, '0')}`;
const BOT_ID = id(900);

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => { await resetDb(db); clearCache(); });
after(async () => { await db.end(); });

const perm = (...names) => ({ has: (p) => names.includes(p) });
function role(n, name, position, extra = {}) {
  return { id: id(n), name, position, managed: false, permissions: perm(), ...extra };
}
const roles = [
  role(1, 'Mods', 5), role(2, 'Red', 2), role(5, 'Staff', 3, { permissions: perm('Administrator') }),
  role(6, 'High', 20), role(7, 'Mid', 8), role(8, 'Blue', 1),
];
const asMap = (list) => new Map(list.map((x) => [x.id, x]));
const makeGuild = () => ({
  id: G,
  ownerId: id(700),
  roles: { cache: asMap(roles) },
  channels: { cache: asMap([{ id: id(50), name: 'chat' }]) },
  emojis: { cache: new Map() },
  members: { me: { id: BOT_ID, roles: { highest: { position: 10 } } } },
});
const writerOf = (position) => ({ id: id(701), roles: { highest: { position } } });
const env = (over = {}) => ({ guild: makeGuild(), writer: writerOf(15), ...over });
const comp = (src, over) => compileScript(src, { db, ...env(over) });
const codes = (r) => r.errors.map((e) => e.code);
const GATED = '{requirearg:1|user}{requirerole:Mods}';

test('a script with no stage 2 feature has the version 2 shape with empty stage 2 fields', async () => {
  const r = await comp('hi {user} {addrole:Red}');
  assert.equal(r.ok, true);
  assert.equal(r.compiled.version, 2);
  assert.deepEqual(r.compiled.random, { ranges: [], choosers: [], locked: [] });
  assert.deepEqual(r.compiled.argChecks, []);
  assert.deepEqual(r.compiled.actions, [{ fn: 'addrole', roleId: id(2), raw: 'Red', target: null }]);
  assert.deepEqual(r.warnings, []);
});

test('[range] and [choice] without their function are literal text, same as stage 1 template', async () => {
  const r = await comp('roll [range] and [choice] and [lockedchoice2] and [Note]');
  assert.deepEqual(r.compiled.template, [{ t: 'text', v: 'roll [range] and [choice] and [lockedchoice2] and [Note]' }]);
});

test('rand tokens are live regardless of script order', async () => {
  const a = await comp('[range] [choice] [lockedchoice]{range:1-6}{choose:a|b}{lockedchoose:x|y}');
  assert.deepEqual(a.compiled.template.filter((p) => p.t !== 'text'), [
    { t: 'rand', kind: 'range', n: 1 }, { t: 'rand', kind: 'choice', n: 1 }, { t: 'rand', kind: 'lockedchoice', n: 1 },
  ]);
  const b = await comp('{range:1-6}{choose:a|b}{lockedchoose:x|y}[range] [choice] [lockedchoice]');
  assert.deepEqual(b.compiled.template.filter((p) => p.t !== 'text'), a.compiled.template.filter((p) => p.t !== 'text'));
});

test('a rand token numbered past the defined count stays literal', async () => {
  const r = await comp('{range:1-6}[range] [range2] [choice2]');
  assert.deepEqual(r.compiled.template, [
    { t: 'rand', kind: 'range', n: 1 }, { t: 'text', v: ' [range2] [choice2]' },
  ]);
});

test('arg tokens are always live', async () => {
  const r = await comp('a [$1] b [$2+] c [$3-5]');
  assert.deepEqual(r.compiled.template, [
    { t: 'text', v: 'a ' }, { t: 'arg', from: 1, to: 1 }, { t: 'text', v: ' b ' },
    { t: 'arg', from: 2, to: 'end' }, { t: 'text', v: ' c ' }, { t: 'arg', from: 3, to: 5 },
  ]);
});

test('range: valid, negative, inverted, too big, not numbers', async () => {
  const ok = await comp('{range:1-6}');
  assert.deepEqual(ok.compiled.random.ranges, [{ min: 1, max: 6 }]);
  assert.deepEqual((await comp('{range:-5-10}')).compiled.random.ranges, [{ min: -5, max: 10 }]);
  for (const bad of ['5-1', '1-2000000000', 'a', '1', '']) {
    const r = await comp(`{range:${bad}}`);
    assert.equal(r.ok, false, bad);
    assert.ok(codes(r).includes('RANGE_INVALID') || codes(r).includes('MISSING_ARGUMENT'), bad);
  }
  assert.deepEqual(codes(await comp('{range:5-1}')), ['RANGE_INVALID']);
});

test('at most four ranges, four choosers, four lockedchooses', async () => {
  const four = '{range:1-2}{range:1-2}{range:1-2}{range:1-2}';
  assert.equal((await comp(four)).ok, true);
  assert.deepEqual(codes(await comp(`${four}{range:1-2}`)), ['TOO_MANY_RANDOM']);
  const c4 = '{choose:a}{choose:a}{weightedchoose:1%}{choose:a}';
  assert.equal((await comp(c4)).ok, true);
  assert.deepEqual(codes(await comp(`${c4}{choose:a}`)), ['TOO_MANY_RANDOM']);
  const l4 = '{lockedchoose:a}'.repeat(4);
  assert.equal((await comp(c4 + l4)).ok, true);
  assert.ok(codes(await comp(c4 + l4 + '{lockedchoose:a}')).includes('TOO_MANY_RANDOM'));
});

test('choose and weightedchoose', async () => {
  const c = await comp('{choose:a|b|c}');
  assert.deepEqual(c.compiled.random.choosers, [{ kind: 'choose', options: ['a', 'b', 'c'] }]);
  const w = await comp('{weightedchoose:60%|30%|10%}');
  assert.deepEqual(w.compiled.random.choosers, [{ kind: 'weighted', weights: [60, 30, 10] }]);
  assert.deepEqual((await comp('{weightedchoose:12.5%|87.5%}')).compiled.random.choosers[0].weights, [12.5, 87.5]);
  assert.deepEqual(codes(await comp('{weightedchoose:0%|0%}')), ['WEIGHT_INVALID']);
  assert.deepEqual(codes(await comp('{weightedchoose:x%}')), ['WEIGHT_INVALID']);
  assert.deepEqual(codes(await comp('{weightedchoose:50|50}')), ['WEIGHT_INVALID', 'WEIGHT_INVALID']);
  assert.equal((await comp(`{weightedchoose:${'1%|'.repeat(24)}1%}`)).ok, true);
  assert.deepEqual(codes(await comp(`{choose:${'a|'.repeat(25)}a}`)), ['TOO_MANY_ARGUMENTS']);
});

test('the compiled random spec is what drawRandom consumes', async () => {
  const r = await comp('{range:3-3}{choose:a|b}{lockedchoose:x|y}');
  const d = drawRandom(r.compiled.random, () => 0);
  assert.deepEqual(d.range, [3]);
  assert.deepEqual(d.choice, ['a']);
  assert.deepEqual(d.lockedchoice, ['x']);
});

test('lockedchoose pairs by order; mismatches and orphans are errors', async () => {
  const r = await comp('{choose:a|b}{weightedchoose:1%|2%|3%}{lockedchoose:x|y}{lockedchoose:p|q|r}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.random.locked, [['x', 'y'], ['p', 'q', 'r']]);
  assert.deepEqual(codes(await comp('{choose:a|b}{lockedchoose:x|y|z}')), ['CHOICE_COUNT_MISMATCH']);
  assert.deepEqual(codes(await comp('{lockedchoose:x|y}')), ['CHOICE_NOT_CHOSEN_YET']);
  // order independent: lockedchoose before its chooser
  assert.equal((await comp('{lockedchoose:x|y}{choose:a|b}')).ok, true);
  assert.deepEqual(codes(await comp('{choose:a|b}{lockedchoose:x|y}{lockedchoose:x|y}')), ['CHOICE_NOT_CHOSEN_YET']);
});

test('requirearg: forms and errors', async () => {
  assert.deepEqual((await comp('{requirearg:1}')).compiled.argChecks, [{ n: 1, type: null }]);
  assert.deepEqual((await comp('{requirearg:2|user}{requirearg:3|number}')).compiled.argChecks, [
    { n: 2, type: 'user' }, { n: 3, type: 'number' },
  ]);
  for (const type of ['channel', 'color', 'role']) assert.equal((await comp(`{requirearg:1|${type}}`)).ok, true);
  assert.deepEqual(codes(await comp('{requirearg:0}')), ['ARG_INDEX_INVALID']);
  assert.deepEqual(codes(await comp('{requirearg:21}')), ['ARG_INDEX_INVALID']);
  assert.deepEqual(codes(await comp('{requirearg:x}')), ['ARG_INDEX_INVALID']);
  assert.deepEqual(codes(await comp('{requirearg:1|banana}')), ['ARG_TYPE_INVALID']);
  assert.deepEqual(codes(await comp('{requirearg:1}{requirearg:1|user}')), ['DUPLICATE_FUNCTION']);
  assert.equal((await comp('{requirearg:1}{requirearg:2}')).ok, true);
});

test('match mode: requirearg refused without words, [$N] warns, no mode means no complaint', async () => {
  for (const matchMode of ['exact', 'endswith', 'regex']) {
    assert.deepEqual(codes(await comp('{requirearg:1}', { matchMode })), ['NO_ARGUMENTS_IN_MODE'], matchMode);
    const w = await comp('hi [$1]', { matchMode });
    assert.equal(w.ok, true);
    assert.deepEqual(w.warnings, [{ code: 'ARGS_EMPTY_IN_MODE', pos: 3 }]);
  }
  for (const matchMode of ['startswith', 'includes']) {
    const r = await comp('hi [$1]{requirearg:1}', { matchMode });
    assert.equal(r.ok, true);
    assert.deepEqual(r.warnings, []);
  }
  const none = await comp('hi [$1]{requirearg:1}');
  assert.equal(none.ok, true);
  assert.deepEqual(none.warnings, []);
  const nick = await comp('{setnick:[$1]}', { matchMode: 'exact' });
  assert.deepEqual(nick.warnings.map((x) => x.code), ['ARGS_EMPTY_IN_MODE']);
});

test('role target: accepted with user check and gate', async () => {
  const r = await comp(`{addrole:Red|[$1]}${GATED}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.compiled.actions, [{ fn: 'addrole', roleId: id(2), raw: 'Red', target: 1 }]);
  const p = await comp('{removerole:Red|[$2]}{requirearg:2|user}{requireperm:ManageRoles}');
  assert.deepEqual(p.compiled.actions[0].target, 2);
  // order independent
  assert.equal((await comp(`${GATED}{addrole:Red|[$1]}`)).ok, true);
});

test('role target: gate, user check and form are enforced', async () => {
  assert.deepEqual(codes(await comp('{addrole:Red|[$1]}{requirearg:1|user}')), ['TARGET_NEEDS_GATE']);
  assert.deepEqual(codes(await comp('{addrole:Red|[$1]}{requirerole:Mods}')), ['TARGET_NOT_CHECKED_USER']);
  assert.deepEqual(codes(await comp('{addrole:Red|[$1]}{requirearg:1}{requirerole:Mods}')), ['TARGET_NOT_CHECKED_USER']);
  assert.deepEqual(codes(await comp(`{addrole:Red|@sam}${GATED}`)), ['TARGET_NOT_CHECKED_USER']);
  assert.deepEqual(codes(await comp(`{addrole:Red|${id(5)}}${GATED}`)), ['TARGET_NOT_CHECKED_USER']);
  assert.deepEqual(codes(await comp(`{addrole:Red|[$2]}${GATED}`)), ['TARGET_NOT_CHECKED_USER']);
  assert.deepEqual(codes(await comp(`{addrole:Red|[$1+]}${GATED}`)), ['TARGET_NOT_CHECKED_USER']);
  assert.deepEqual(codes(await comp(`{addrole:Red|\\[$1]}${GATED}`)), ['TARGET_NOT_CHECKED_USER']);
});

test('role target: role checks still apply and the action counts', async () => {
  assert.deepEqual(codes(await comp(`{addrole:Staff|[$1]}${GATED}`)), ['ROLE_DANGEROUS']);
  assert.deepEqual(codes(await comp(`{addrole:High|[$1]}${GATED}`)), ['ROLE_ABOVE_BOT']);
  assert.deepEqual(codes(await comp(`{addrole:Mid|[$1]}${GATED}`, { writer: writerOf(8) })), ['ROLE_ABOVE_YOU']);
  const four = `{addrole:Red|[$1]}{addrole:Red|[$1]}{removerole:Blue|[$1]}{addrole:Blue|[$1]}${GATED}`;
  assert.ok(codes(await comp(four)).includes('TOO_MANY_ROLE_ACTIONS'));
  assert.ok(codes(await comp(`{addrole:Red|[$1]}{addrole:Red|[$1]}{setnick:a}{setnick:b}${GATED}`)).includes('TOO_MANY_ROLE_ACTIONS'));
});

test('setnick with [$1] compiles; an escaped bracket stays literal and is marked', async () => {
  const r = await comp('{setnick:Hi [$1]}');
  assert.deepEqual(r.compiled.actions, [{ fn: 'setnick', text: 'Hi [$1]' }]);
  const e = await comp('{setnick:Hi \\[$1]}');
  assert.equal(e.compiled.actions[0].text, `Hi ${ESCAPED_BRACKET}$1]`);
});

test('the escaped-bracket sentinel never reaches a resolved argument', async () => {
  const r = await comp('{addrole:\\[$1]}');
  assert.deepEqual(codes(r), ['ROLE_NOT_FOUND']);
  assert.ok(!r.errors[0].detail.includes(ESCAPED_BRACKET));
  assert.equal(r.errors[0].detail, '[$1]');
});

test('compiled output survives JSON round trip', async () => {
  const r = await comp(`{range:1-6}{choose:a|b}{lockedchoose:x|y}{addrole:Red|[$1]}${GATED}[range] [$1+] [choice]`);
  assert.equal(r.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.compiled)), r.compiled);
});

test('every new code has en, fr and ar text and is listed', () => {
  const news = ['RANGE_INVALID', 'WEIGHT_INVALID', 'TOO_MANY_RANDOM', 'CHOICE_COUNT_MISMATCH', 'CHOICE_NOT_CHOSEN_YET',
    'ARG_INDEX_INVALID', 'ARG_TYPE_INVALID', 'NO_ARGUMENTS_IN_MODE', 'TARGET_NOT_CHECKED_USER', 'TARGET_NEEDS_GATE'];
  for (const c of [...news, 'TARGET_NOT_ALLOWED_YET']) assert.ok(COMPILE_ERROR_CODES.includes(c), c);
  for (const lang of ['en', 'fr', 'ar']) {
    for (const c of news) assert.notEqual(t(lang, `autoresponder.error.${c}`), `autoresponder.error.${c}`, `${lang} ${c}`);
    assert.notEqual(t(lang, 'autoresponder.warning.ARGS_EMPTY_IN_MODE'), 'autoresponder.warning.ARGS_EMPTY_IN_MODE');
  }
});

// --- commands wiring ---

const command = createAutoresponderCommand();
function cenv() {
  const guild = makeGuild();
  const logChannel = { isTextBased: () => true, send: async () => ({ id: 'log1', channelId: 'logch' }) };
  const ctx = { db, client: { user: { id: BOT_ID }, channels: { fetch: async () => logChannel } } };
  const member = { id: 'staff', permissions: { has: () => true }, roles: { highest: { position: 15 }, cache: new Map() }, guild };
  return { guild, ctx, member };
}
function interaction(e, over) {
  const replies = [];
  return { guildId: G, guild: e.guild, member: e.member, user: { id: 'staff' }, replies, inGuild: () => true, reply: async (p) => { replies.push(typeof p === 'string' ? { content: p } : p); }, ...over };
}
const runSlash = async (e, sub, opts) => {
  const i = interaction(e, { isModalSubmit: () => false, options: { getSubcommand: () => sub, getString: (n) => opts[n] ?? null, getInteger: (n) => opts[n] ?? null } });
  await command.execute(i, e.ctx);
  return i;
};
const runModal = async (e, customId, fields) => {
  const i = interaction(e, { customId, isModalSubmit: () => true, fields: { getTextInputValue: (n) => fields[n] } });
  await command.components.handle(i, e.ctx);
  return i;
};
const on = () => setFeature(db, G, 'autoresponder', { enabled: true });
const last = (i) => i.replies.at(-1).content;

test('editmatchmode refuses a mode that would invalidate the script and leaves the rule alone', async () => {
  const e = cenv();
  await on();
  const stored = { version: 1, template: [], gates: [], actions: [], flags: {} };
  const withArg = await createRule(db, { guildId: G, trigger: '!say', matchMode: 'startswith', script: 'hi {requirearg:1}', compiled: stored, createdBy: 'u' });
  const refused = await runSlash(e, 'editmatchmode', { id: withArg.id, match: 'exact' });
  assert.ok(last(refused).includes(t('en', 'autoresponder.error.NO_ARGUMENTS_IN_MODE', { detail: '' }).trim()));
  assert.equal((await getRule(db, G, withArg.id)).matchMode, 'startswith');
  const plain = await createRule(db, { guildId: G, trigger: '!hi', matchMode: 'startswith', script: 'hello', compiled: stored, createdBy: 'u' });
  const ok = await runSlash(e, 'editmatchmode', { id: plain.id, match: 'exact' });
  assert.equal(last(ok), t('en', 'autoresponder.matchChanged', { id: plain.id, mode: 'exact' }));
  assert.equal((await getRule(db, G, plain.id)).matchMode, 'exact');
});

test('add and edit pass the match mode and show the warning after the success text', async () => {
  const e = cenv();
  await on();
  const refused = await runModal(e, 'autoresponder:m:add:exact', { trigger: '!x', script: '{requirearg:1}' });
  assert.ok(last(refused).includes(t('en', 'autoresponder.error.NO_ARGUMENTS_IN_MODE', { detail: '' }).trim()));
  const warned = await runModal(e, 'autoresponder:m:add:exact', { trigger: '!x', script: 'hi [$1]' });
  assert.ok(last(warned).startsWith(t('en', 'autoresponder.created', { id: 1 })));
  assert.ok(last(warned).endsWith(t('en', 'autoresponder.warning.ARGS_EMPTY_IN_MODE')));
  const clean = await runModal(e, 'autoresponder:m:add:exact', { trigger: '!y', script: 'hi' });
  assert.equal(last(clean), t('en', 'autoresponder.created', { id: 2 }));
  const edited = await runModal(e, 'autoresponder:m:edit:2', { trigger: '!y', script: 'hi [$2]' });
  assert.ok(last(edited).startsWith(t('en', 'autoresponder.updated', { id: 2 })));
  assert.ok(last(edited).endsWith(t('en', 'autoresponder.warning.ARGS_EMPTY_IN_MODE')));
});
