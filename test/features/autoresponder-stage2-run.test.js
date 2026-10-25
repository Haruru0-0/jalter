import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { createRule } from '../../src/features/autoresponder/store.js';
import { clearCache } from '../../src/features/autoresponder/cache.js';
import { createEvents } from '../../src/features/autoresponder/events.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';
import { evaluate } from '../../src/features/autoresponder/script/evaluate.js';
import { prepareRun } from '../../src/features/autoresponder/script/run.js';
import { ESCAPED_BRACKET } from '../../src/features/autoresponder/script/parse.js';
import { compileScript } from '../../src/features/autoresponder/script/compile.js';
import { executePlan, sendGateNotice, RUN_ERROR_CODES } from '../../src/features/autoresponder/execute.js';
import { describeRun, describeRunFor } from '../../src/features/autoresponder/dryrun.js';
import { createThrottle } from '../../src/features/autoresponder/throttle.js';
import { t } from '../../src/i18n/index.js';
import en from '../../src/i18n/en.json' with { type: 'json' };
import fr from '../../src/i18n/fr.json' with { type: 'json' };
import ar from '../../src/i18n/ar.json' with { type: 'json' };

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => { await resetDb(db); clearCache(); });

const U1 = '111111111111111111';
const U2 = '222222222222222222';
const flags = (over = {}) => ({ silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null, ...over });
const comp = (over = {}) => ({
  version: 2, template: [{ t: 'text', v: 'hi' }], gates: [], actions: [], random: { ranges: [], choosers: [], locked: [] }, argChecks: [], ...over, flags: flags(over.flags),
});
const rule = (over = {}) => ({ trigger: '!hug', matchMode: 'startswith', ...over });
const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const member = (id = 'a1') => ({ id, roles: { cache: new Map() }, permissions: { has: () => false } });
const guildWith = (ids = [U1]) => ({ members: { fetch: async (id) => { if (!ids.includes(id)) throw new Error('unknown'); return { id }; } } });

// ---- prepareRun ----
test('prepareRun: words for startswith and includes, none for exact', async () => {
  const c = comp({ template: [{ t: 'arg', from: 1, to: 'end' }] });
  const sw = await prepareRun({ compiled: c, rule: rule(), text: '!hug  one two', guild: guildWith() });
  assert.deepEqual(sw.words.list, ['one', 'two']);
  const inc = await prepareRun({ compiled: c, rule: rule({ matchMode: 'includes' }), text: 'oh !hug a b', guild: guildWith() });
  assert.deepEqual(inc.words.list, ['a', 'b']);
  const ex = await prepareRun({ compiled: c, rule: rule({ matchMode: 'exact' }), text: '!hug', guild: guildWith() });
  assert.deepEqual(ex.words.list, []);
});

test('prepareRun: seeded rng draws deterministically, sentinel maps back to a bracket', async () => {
  const c = comp({ random: { ranges: [{ min: 1, max: 6 }], choosers: [{ kind: 'choose', options: [`a${ESCAPED_BRACKET}x]`, 'b'] }], locked: [['p', `q${ESCAPED_BRACKET}`]] } });
  const a = await prepareRun({ compiled: c, rule: rule(), text: '!hug', guild: guildWith(), rng: seq(0.99, 0.0) });
  assert.deepEqual(a.draws.range, [6]);
  assert.deepEqual(a.draws.choice, ['a[x]']);
  assert.deepEqual(a.draws.lockedchoice, ['p']);
  const b = await prepareRun({ compiled: c, rule: rule(), text: '!hug', guild: guildWith(), rng: seq(0.0, 0.99) });
  assert.deepEqual(b.draws.choice, ['b']);
  assert.deepEqual(b.draws.lockedchoice, ['q[']);
});

test('prepareRun: version 1 is a no-op; argResults cover every check', async () => {
  const v1 = { version: 1, template: [], gates: [], actions: [], flags: flags() };
  const r = await prepareRun({ compiled: v1, rule: rule(), text: '!hug 5', guild: guildWith() });
  assert.deepEqual(r.words.list, []);
  assert.deepEqual(r.draws, { range: [], choice: [], lockedchoice: [], picked: [] });
  assert.deepEqual(r.argResults, {});
  const c = comp({ argChecks: [{ n: 1, type: 'user' }, { n: 2, type: 'number' }, { n: 3, type: null }] });
  const p = await prepareRun({ compiled: c, rule: rule(), text: `!hug <@${U1}> abc`, guild: guildWith() });
  assert.deepEqual(p.argResults[1], { ok: true, id: U1, name: '' });
  assert.equal(p.argResults[2].ok, false);
  assert.equal(p.argResults[3].ok, false);
});

// ---- evaluate: rendering ----
const evalWith = async (c, text, over = {}) => {
  const prepared = await prepareRun({ compiled: c, rule: rule(), text, guild: guildWith(), rng: over.rng });
  return evaluate(c, { member: member(), channelId: 'c1', vars: {}, ...prepared });
};

test('evaluate renders words and random values; missing ones render empty', async () => {
  const c = comp({
    template: [
      { t: 'arg', from: 1, to: 1 }, { t: 'text', v: '|' }, { t: 'arg', from: 2, to: 'end' }, { t: 'text', v: '|' }, { t: 'arg', from: 1, to: 2 }, { t: 'text', v: '|' },
      { t: 'rand', kind: 'range', n: 1 }, { t: 'text', v: '|' }, { t: 'rand', kind: 'choice', n: 1 }, { t: 'text', v: '|' }, { t: 'rand', kind: 'lockedchoice', n: 1 }, { t: 'text', v: '|' }, { t: 'arg', from: 9, to: 9 },
    ],
    random: { ranges: [{ min: 1, max: 6 }], choosers: [{ kind: 'choose', options: ['red', 'blue'] }], locked: [['R', 'B']] },
  });
  const p = await evalWith(c, '!hug a b  c', { rng: seq(0.99, 0.99) });
  assert.equal(p.text, 'a|b  c|a b|6|blue|B|');
});

test('the same drawn value appears in the text and in the nickname', async () => {
  const c = comp({
    template: [{ t: 'rand', kind: 'range', n: 1 }],
    actions: [{ fn: 'setnick', text: `Lvl [range] [$1] ${ESCAPED_BRACKET}x]` }],
    random: { ranges: [{ min: 1, max: 100 }], choosers: [], locked: [] },
  });
  const plan = await evalWith(c, '!hug Bob', { rng: () => 0.5 });
  let applied;
  const m = { id: 'a1', manageable: true, roles: { cache: new Map() }, setNickname: async (n) => { applied = n; } };
  const guild = { id: 'g', roles: { cache: new Map() } };
  const res = await executePlan({ db: {} }, { rule: {}, message: { guild, delete: async () => {}, reply: async () => ({}) }, member: m, plan, lang: 'en', vars: {} }, {});
  assert.equal(plan.text, '51');
  assert.equal(applied, 'Lvl 51 Bob [x]');
  assert.deepEqual(res.errors, []);
});

test('a nickname over 32 characters after rendering is NICK_TOO_LONG, never cut', async () => {
  const c = comp({ actions: [{ fn: 'setnick', text: '[$1]' }] });
  const plan = await evalWith(c, `!hug ${'x'.repeat(40)}`);
  let applied = null;
  const m = { id: 'a1', manageable: true, roles: { cache: new Map() }, setNickname: async (n) => { applied = n; } };
  const res = await executePlan({ db: {} }, { rule: {}, message: { guild: { id: 'g', roles: { cache: new Map() } }, reply: async () => ({}) }, member: m, plan, lang: 'en', vars: {} }, {});
  assert.equal(applied, null);
  assert.equal(res.errors[0].code, 'NICK_TOO_LONG');
});

test('a member word that looks like a token or placeholder is not rendered a second time', async () => {
  const c = comp({ actions: [{ fn: 'setnick', text: '[$1]' }] });
  const plan = await evalWith(c, '!hug {user}');
  let applied;
  const m = { id: 'a1', manageable: true, roles: { cache: new Map() }, setNickname: async (n) => { applied = n; } };
  await executePlan({ db: {} }, { rule: {}, message: { guild: { id: 'g', roles: { cache: new Map() } }, reply: async () => ({}) }, member: m, plan, lang: 'en', vars: { user: 'SECRET' } }, {});
  assert.equal(applied, '{user}');
});

test('version 1 without the new fields behaves as before (no words, no draws)', () => {
  const v1 = { version: 1, template: [{ t: 'text', v: 'x [$1] [range]' }], gates: [], actions: [], flags: flags() };
  const p = evaluate(v1, { member: member(), channelId: 'c1', vars: {} });
  assert.equal(p.text, 'x [$1] [range]');
  assert.equal('words' in p, false);
});

// ---- evaluate: requirearg ----
test('requirearg: missing word, non-member user and bad number skip with the arg gate', async () => {
  const miss = await evalWith(comp({ argChecks: [{ n: 1, type: null }] }), '!hug');
  assert.deepEqual(miss, { status: 'skip', gate: 'arg', notice: true, arg: { n: 1, type: null } });
  const user = await evalWith(comp({ argChecks: [{ n: 1, type: 'user' }] }), `!hug <@${U2}>`);
  assert.deepEqual(user, { status: 'skip', gate: 'arg', notice: true, arg: { n: 1, type: 'user' } });
  const num = await evalWith(comp({ argChecks: [{ n: 2, type: 'number' }] }), '!hug x abc');
  assert.deepEqual(num.arg, { n: 2, type: 'number' });
  const ok = await evalWith(comp({ argChecks: [{ n: 2, type: 'number' }] }), '!hug x 12');
  assert.equal(ok.status, 'run');
});

test('requirearg with {silent} skips without a notice; a failing role gate wins over it', async () => {
  const silent = await evalWith(comp({ argChecks: [{ n: 1, type: null }], flags: { silent: true } }), '!hug');
  assert.equal(silent.notice, false);
  const both = comp({ argChecks: [{ n: 1, type: null }], gates: [{ fn: 'requirerole', roleIds: ['r9'] }] });
  assert.equal((await evalWith(both, '!hug')).gate, 'role');
});

// ---- evaluate: allowedUsers ----
test('allowedUsers: only the user word checked as user, never other mentions in [$n]', async () => {
  const tpl = [{ t: 'arg', from: 1, to: 'end' }];
  const checked = comp({ template: tpl, argChecks: [{ n: 1, type: 'user' }] });
  const p = await evalWith(checked, `!hug <@${U1}> @everyone <@&333333333333333333> <@${U2}>`);
  assert.equal(p.status, 'run');
  assert.deepEqual(p.allowedUsers, [U1]);
  for (const word of ['@everyone', '<@&333333333333333333>', `<@${U2}>`, '@here']) {
    const unchecked = comp({ template: [{ t: 'arg', from: 1, to: 1 }] });
    const q = await evalWith(unchecked, `!hug ${word}`);
    assert.deepEqual(q.allowedUsers, [], word);
    assert.equal(q.text, word);
  }
  const second = comp({ template: [{ t: 'arg', from: 2, to: 2 }], argChecks: [{ n: 1, type: 'user' }] });
  const r = await evalWith(second, `!hug <@${U1}> <@${U2}>`);
  assert.deepEqual(r.allowedUsers, []);
});

test('plan actions carry targetId from the checked word', async () => {
  const c = comp({ argChecks: [{ n: 1, type: 'user' }], actions: [{ fn: 'addrole', roleId: 'r1', raw: 'Red', target: 1 }, { fn: 'addrole', roleId: 'r2', raw: 'Blue', target: null }] });
  const p = await evalWith(c, `!hug <@${U1}>`);
  assert.equal(p.actions[0].targetId, U1);
  assert.equal('targetId' in p.actions[1], false);
});

// ---- executor: targets ----
function targetEnv({ targets = {}, ownerId = 'owner', roles = { r1: {} }, dangerous = () => false, canGive = () => true } = {}) {
  const log = [];
  const members = new Map(Object.entries(targets).map(([id, o]) => [id, {
    id, manageable: true, roles: { cache: new Map(), highest: { comparePositionTo: () => -1 }, add: async (...a) => { log.push(['add', id, ...a]); }, remove: async (...a) => { log.push(['remove', id, ...a]); } }, ...o,
  }]));
  const author = { id: 'a1', manageable: true, roles: { cache: new Map(), add: async () => log.push(['author-add']), remove: async () => log.push(['author-remove']) }, setNickname: async (n) => { log.push(['nick', n]); } };
  const guild = {
    id: 'g', ownerId, roles: { cache: new Map(Object.entries(roles).map(([id, r]) => [id, { id, ...r }])) },
    members: { me: { id: 'bot', roles: { highest: {} } }, fetch: async (id) => { const m = members.get(id); if (!m) throw new Error('gone'); return m; } },
  };
  const message = { guild, react: async () => { log.push(['react']); }, reply: async (p) => { log.push(['reply', p.content]); return null; } };
  const run = (actions, extra = {}) => executePlan({ db: {} }, {
    rule: {}, message, member: author, lang: 'en', vars: {},
    plan: { status: 'run', cooldown: null, text: 'done', flags: flags(), allowedUsers: [], actions, ...extra },
  }, { botCanGive: canGive, isDangerousRole: dangerous });
  return { run, log, members };
}

test('a role action with a target gives the role to the target, with a single-role call, not the author', async () => {
  const e = targetEnv({ targets: { [U1]: {} } });
  const res = await e.run([{ fn: 'addrole', roleId: 'r1', target: 1, targetId: U1 }]);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(e.log.filter((l) => l[0] !== 'reply'), [['add', U1, 'r1', 'Autoresponder']]);
});

test('removerole with a target removes from the target', async () => {
  const e = targetEnv({ targets: { [U1]: {} } });
  e.members.get(U1).roles.cache.set('r1', { id: 'r1' });
  await e.run([{ fn: 'removerole', roleId: 'r1', target: 1, targetId: U1 }]);
  assert.deepEqual(e.log.filter((l) => l[0] === 'remove' || l[0] === 'author-remove'), [['remove', U1, 'r1', 'Autoresponder']]);
});

test('a target who left gives TARGET_MISSING and the other actions still run', async () => {
  const e = targetEnv();
  const res = await e.run([{ fn: 'addrole', roleId: 'r1', target: 1, targetId: U1 }, { fn: 'setnick', text: 'Nick' }]);
  assert.deepEqual(res.errors.map((x) => x.code), ['TARGET_MISSING']);
  assert.ok(e.log.some((l) => l[0] === 'nick'));
  assert.ok(e.log.some((l) => l[0] === 'reply'));
  assert.equal(e.log.some((l) => l[0] === 'author-add'), false);
});

test('a target with no resolved id is TARGET_MISSING (never falls back to the author)', async () => {
  const e = targetEnv();
  const res = await e.run([{ fn: 'addrole', roleId: 'r1', target: 1 }]);
  assert.deepEqual(res.errors.map((x) => x.code), ['TARGET_MISSING']);
  assert.equal(e.log.some((l) => l[0] === 'author-add'), false);
});

test('a target the bot cannot manage, above the bot, or the owner gives TARGET_UNSAFE', async () => {
  const e1 = targetEnv({ targets: { [U1]: { manageable: false } } });
  assert.deepEqual((await e1.run([{ fn: 'addrole', roleId: 'r1', target: 1, targetId: U1 }])).errors.map((x) => x.code), ['TARGET_UNSAFE']);
  const e2 = targetEnv({ targets: { [U1]: { roles: { cache: new Map(), highest: { comparePositionTo: () => 1 }, add: async () => { throw new Error('must not'); } } } } });
  assert.deepEqual((await e2.run([{ fn: 'addrole', roleId: 'r1', target: 1, targetId: U1 }])).errors.map((x) => x.code), ['TARGET_UNSAFE']);
  const e3 = targetEnv({ targets: { [U1]: {} }, ownerId: U1 });
  assert.deepEqual((await e3.run([{ fn: 'addrole', roleId: 'r1', target: 1, targetId: U1 }])).errors.map((x) => x.code), ['TARGET_UNSAFE']);
  for (const e of [e1, e3]) assert.equal(e.log.some((l) => l[0] === 'add'), false);
});

test('the role is re-checked for a targeted action: ROLE_UNSAFE and ROLE_MISSING, rest still runs', async () => {
  const e = targetEnv({ targets: { [U1]: {} }, dangerous: () => true });
  const res = await e.run([{ fn: 'addrole', roleId: 'r1', target: 1, targetId: U1 }, { fn: 'addrole', roleId: 'gone', target: 1, targetId: U1 }, { fn: 'setnick', text: 'N' }]);
  assert.deepEqual(res.errors.map((x) => x.code), ['ROLE_UNSAFE', 'ROLE_MISSING']);
  assert.equal(e.log.some((l) => l[0] === 'add'), false);
  assert.ok(e.log.some((l) => l[0] === 'nick'));
});

test('a targeted removerole re-checks the role: dangerous or not givable -> ROLE_UNSAFE, the rest still runs', async () => {
  for (const opts of [{ dangerous: () => true }, { canGive: () => false }]) {
    const e = targetEnv({ targets: { [U1]: {} }, ...opts });
    e.members.get(U1).roles.cache.set('r1', { id: 'r1' });
    const res = await e.run([{ fn: 'removerole', roleId: 'r1', target: 1, targetId: U1 }, { fn: 'setnick', text: 'N' }]);
    assert.deepEqual(res.errors, [{ code: 'ROLE_UNSAFE', action: 'removerole', detail: 'r1' }]);
    assert.equal(e.log.some((l) => l[0] === 'remove' || l[0] === 'author-remove'), false);
    assert.ok(e.log.some((l) => l[0] === 'nick'));
    assert.ok(e.log.some((l) => l[0] === 'reply'));
  }
});

test('a targeted removerole: a missing target is TARGET_MISSING, an unsafe one TARGET_UNSAFE, never the author', async () => {
  const missing = targetEnv();
  assert.deepEqual((await missing.run([{ fn: 'removerole', roleId: 'r1', target: 1, targetId: U1 }])).errors.map((x) => x.code), ['TARGET_MISSING']);
  assert.deepEqual((await missing.run([{ fn: 'removerole', roleId: 'r1', target: 1 }])).errors.map((x) => x.code), ['TARGET_MISSING']);
  const held = () => { const c = new Map([['r1', { id: 'r1' }]]); return c; };
  const cases = [
    targetEnv({ targets: { [U1]: {} }, ownerId: U1 }),
    targetEnv({ targets: { [U1]: { manageable: false } } }),
    targetEnv({ targets: { [U1]: { roles: { cache: held(), highest: { comparePositionTo: () => 1 }, remove: async () => { throw new Error('must not'); } } } } }),
    targetEnv({ targets: { bot: {} } }),
  ];
  for (const [k, e] of cases.entries()) {
    const id = k === 3 ? 'bot' : U1;
    const m = e.members.get(id);
    if (!m.roles.cache.has('r1')) m.roles.cache.set('r1', { id: 'r1' });
    const res = await e.run([{ fn: 'removerole', roleId: 'r1', target: 1, targetId: id }]);
    assert.deepEqual(res.errors.map((x) => x.code), ['TARGET_UNSAFE'], `case ${k}`);
    assert.equal(e.log.some((l) => l[0] === 'remove' || l[0] === 'author-remove'), false, `case ${k}`);
  }
  for (const e of [missing, ...cases]) assert.equal(e.log.some((l) => l[0] === 'author-remove'), false);
});

// ---- choice options render the member's words ----
const compileFor = (src, matchMode = 'startswith') => compileScript(src, { db, guild: { id: 'g', roles: { cache: new Map() }, channels: { cache: new Map() } }, writer: {}, matchMode });
const runSrc = async (src, text, rng = () => 0, guild = guildWith()) => {
  const r = await compileFor(src);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const prepared = await prepareRun({ compiled: r.compiled, rule: rule(), text, guild, rng });
  return { plan: evaluate(r.compiled, { member: member(), channelId: 'c1', vars: {}, ...prepared }), prepared };
};

test('[$N] inside a choose option is rendered with the member words', async () => {
  const a = await runSrc('{choose:Hi [$1]!|Hey [$1]!}[choice]', '!hug Sam', () => 0);
  assert.equal(a.plan.text, 'Hi Sam!');
  const b = await runSrc('{choose:Hi [$1]!|Hey [$1]!}[choice]', '!hug Sam', () => 0.99);
  assert.equal(b.plan.text, 'Hey Sam!');
  assert.deepEqual(b.prepared.draws.choice, ['Hey Sam!']);
});

test('[$N+], [$N-M] and a missing word in options; the escaped bracket stays literal', async () => {
  assert.equal((await runSrc('{choose:say [$1+]}[choice]', '!hug a  b c')).plan.text, 'say a  b c');
  assert.equal((await runSrc('{choose:[$2-3]}[choice]', '!hug a b c d')).plan.text, 'b c');
  assert.equal((await runSrc('{choose:x[$4]y}[choice]', '!hug a')).plan.text, 'xy');
  assert.equal((await runSrc('{choose:lit \\[$1]}[choice]', '!hug Sam')).plan.text, 'lit [$1]');
});

test('lockedchoose values render [$N]; weightedchoose positions stay numbers', async () => {
  const r = await runSrc('{weightedchoose:1%|1%}{lockedchoose:to [$1]|for [$1]}[choice] [lockedchoice]', '!hug Ann', () => 0);
  assert.equal(r.plan.text, '1 to Ann');
  assert.deepEqual(r.prepared.draws.choice, [1]);
});

test('a member word in an option is not rendered a second time and options never add pings', async () => {
  const twice = await runSrc('{choose:[$1]}[choice] {user}', '!hug [$2] {user} x');
  assert.equal(twice.plan.text, '[$2]');
  const pings = await runSrc(`{requirearg:1|user}{choose:hi [$1] <@${U2}>}[choice]`, `!hug <@${U1}>`);
  assert.equal(pings.plan.text, `hi <@${U1}> <@${U2}>`);
  assert.deepEqual(pings.plan.allowedUsers, []);
});

// ---- a word checked as a user renders as a mention ----
test('a bare id checked as a user renders as <@id> and pings; unchecked or other types stay as typed', async () => {
  const checked = await runSrc('{requirearg:1|user}hugs [$1]', `!hug ${U1}`);
  assert.equal(checked.plan.text, `hugs <@${U1}>`);
  assert.deepEqual(checked.plan.allowedUsers, [U1]);
  const rest = await runSrc('{requirearg:1|user}hugs [$1+]', `!hug ${U1}  twice`);
  assert.equal(rest.plan.text, `hugs <@${U1}>  twice`);
  const mention = await runSrc('{requirearg:1|user}hugs [$1]', `!hug <@!${U1}>`);
  assert.equal(mention.plan.text, `hugs <@${U1}>`);
  const unchecked = await runSrc('hugs [$1]', `!hug ${U1}`);
  assert.equal(unchecked.plan.text, `hugs ${U1}`);
  assert.deepEqual(unchecked.plan.allowedUsers, []);
  const number = await runSrc('{requirearg:1|number}n [$1]', `!hug ${U1}`);
  assert.equal(number.plan.text, `n ${U1}`);
  assert.deepEqual(number.plan.allowedUsers, []);
  const second = await runSrc('{requirearg:1|user}[$2]', `!hug ${U1} ${U1}`);
  assert.equal(second.plan.text, U1);
  assert.deepEqual(second.plan.allowedUsers, []);
});

// ---- the fast path ----
test('prepareRun fast path: a version 2 rule with no stage 2 feature reads no words and draws nothing', async () => {
  const throwing = () => { throw new Error('rng used'); };
  const noGuild = { members: { fetch: async () => { throw new Error('guild used'); } } };
  const plain = (await compileFor('hi {user} {setnick:Bob}')).compiled;
  const p = await prepareRun({ compiled: plain, rule: rule(), text: '!hug a b', guild: noGuild, rng: throwing });
  assert.deepEqual(p.words.list, []);
  assert.deepEqual(p.draws, { range: [], choice: [], lockedchoice: [], picked: [] });
  assert.deepEqual(p.argResults, {});
});

test('prepareRun slow path: an arg part, an arg token in a nickname, a random or an arg check computes words', async () => {
  for (const src of ['say [$1]', '{setnick:[$2]}', '{range:1-2}[range]', '{requirearg:1}']) {
    const c = (await compileFor(src)).compiled;
    const p = await prepareRun({ compiled: c, rule: rule(), text: '!hug a b', guild: guildWith(), rng: () => 0 });
    assert.deepEqual(p.words.list, ['a', 'b'], src);
  }
});

// ---- events: a failed requirearg does not burn the cooldown ----
test('events: a failed requirearg never claims the cooldown', async () => {
  await enable();
  await createRule(db, {
    guildId: 'g1', trigger: '!hug', matchMode: 'startswith', script: 'x', createdBy: 'u1',
    compiled: comp({ template: [{ t: 'arg', from: 1, to: 1 }], argChecks: [{ n: 1, type: 'user' }], gates: [{ fn: 'cooldown', seconds: 60 }] }),
  });
  const claims = [];
  const exec = [];
  const [event] = createEvents({
    executePlan: async (ctx, args) => { exec.push(args); return { errors: [] }; },
    sendGateNotice: async () => {},
    logRunError: async () => {},
    claimCooldown: async (...a) => { claims.push(a); return { ok: true }; },
    noticeThrottle: createThrottle(30_000),
  });
  const ctx = { db, client: { user: { id: 'bot' } } };
  await event.execute(ctx, fakeMessage('!hug nobody'));
  await event.execute(ctx, fakeMessage('!hug'));
  assert.equal(claims.length, 0);
  assert.equal(exec.length, 0);
  await event.execute(ctx, fakeMessage(`!hug <@${U1}>`));
  assert.equal(claims.length, 1);
  assert.equal(exec.length, 1);
});

// ---- i18n ----
test('new keys exist in en, fr and ar, and the new run codes are listed', () => {
  const keys = ['autoresponder.notice.arg', 'autoresponder.test.draws', 'autoresponder.test.pings', 'autoresponder.run.TARGET_MISSING', 'autoresponder.run.TARGET_UNSAFE'];
  for (const k of keys) for (const d of [en, fr, ar]) assert.ok(d[k], k);
  for (const d of [en, fr, ar]) {
    assert.ok(d['autoresponder.notice.arg'].includes('{n}') && d['autoresponder.notice.arg'].includes('{type}'));
    assert.ok(d['autoresponder.test.draws'].includes('{detail}') && d['autoresponder.test.pings'].includes('{detail}'));
  }
  assert.ok(RUN_ERROR_CODES.includes('TARGET_MISSING') && RUN_ERROR_CODES.includes('TARGET_UNSAFE'));
  for (const code of RUN_ERROR_CODES) for (const d of [en, fr, ar]) assert.ok(d[`autoresponder.run.${code}`], code);
});

test('sendGateNotice for arg names the word and the expected type', async () => {
  const sent = [];
  await sendGateNotice({}, { reply: async (p) => { sent.push(p.content); return null; } }, 'en', { kind: 'arg', n: 2, type: 'number' });
  assert.equal(sent[0], t('en', 'autoresponder.notice.arg', { n: '2', type: t('en', 'autoresponder.argtype.number') }));
  assert.ok(sent[0].includes('2'));
});

// ---- events end to end ----
const enable = () => setFeature(db, 'g1', 'autoresponder', { enabled: true });
function fakeMessage(content, over = {}) {
  const m = { id: 'u2', roles: { cache: new Map() }, permissions: { has: () => false } };
  const guild = { id: 'g1', name: 'G', members: { fetch: async (id) => { if (id === U1 || id === 'u2') return { id }; throw new Error('no'); } }, memberCount: 3, iconURL: () => null };
  return {
    id: 'msg', content, channelId: 'c1', guild, guildId: 'g1', member: m, webhookId: null, system: false,
    author: { id: 'u2', bot: false, username: 'bob', createdTimestamp: 1, displayAvatarURL: () => 'http://a', tag: 'bob' },
    ...over,
  };
}
function harness(rng) {
  const calls = { exec: [], notice: [] };
  const [event] = createEvents({
    rng,
    executePlan: async (ctx, args) => { calls.exec.push(args); return { errors: [] }; },
    sendGateNotice: async (ctx, msg, lang, info) => { calls.notice.push(info); },
    logRunError: async () => {},
    noticeThrottle: createThrottle(30_000),
  });
  return { calls, run: (msg) => event.execute({ db, client: { user: { id: 'bot' } } }, msg) };
}

test('events: !hug <@id> replies with the mention and pings only that user; bare !hug sends one notice', async () => {
  await enable();
  await createRule(db, {
    guildId: 'g1', trigger: '!hug', matchMode: 'startswith', script: 'x', createdBy: 'u1',
    compiled: comp({ template: [{ t: 'text', v: 'hugs ' }, { t: 'arg', from: 1, to: 1 }], argChecks: [{ n: 1, type: 'user' }] }),
  });
  const h = harness();
  await h.run(fakeMessage(`!hug <@${U1}> and @everyone`));
  assert.equal(h.calls.exec.length, 1);
  assert.equal(h.calls.exec[0].plan.text, `hugs <@${U1}>`);
  assert.deepEqual(h.calls.exec[0].plan.allowedUsers, [U1]);
  await h.run(fakeMessage('!hug'));
  await h.run(fakeMessage('!hug'));
  assert.equal(h.calls.exec.length, 1);
  assert.deepEqual(h.calls.notice, [{ kind: 'arg', n: 1, type: 'user' }]);
});

test('events: !roll with {range} replies with a number inside the range', async () => {
  await enable();
  await createRule(db, {
    guildId: 'g1', trigger: '!roll', matchMode: 'startswith', script: 'x', createdBy: 'u1',
    compiled: comp({ template: [{ t: 'rand', kind: 'range', n: 1 }], random: { ranges: [{ min: 1, max: 6 }], choosers: [], locked: [] } }),
  });
  const h = harness();
  for (let i = 0; i < 20; i++) await h.run(fakeMessage('!roll'));
  assert.equal(h.calls.exec.length, 20);
  for (const a of h.calls.exec) {
    const n = Number(a.plan.text);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 6, a.plan.text);
  }
});

// ---- dry run ----
function readOnlyEnv() {
  const boom = (name) => () => { throw new Error(`side effect: ${name}`); };
  const queries = [];
  const spy = { query: (sql, ...rest) => { queries.push(String(sql)); return db.query(sql, ...rest); } };
  const user = { id: 'staff', username: 'Sam', globalName: null, createdTimestamp: 1_600_000_000_000, displayAvatarURL: () => 'a.png', tag: 'Sam#0' };
  const guild = {
    id: 'g1', name: 'Srv', ownerId: 'owner', memberCount: 5, createdTimestamp: 1_500_000_000_000, iconURL: () => 'i.png',
    channels: { cache: new Map() }, roles: { cache: new Map() },
    members: { me: { id: 'bot' }, fetch: async (id) => { if (id === U1) return { id }; throw new Error('unknown'); } },
  };
  const m = { id: 'staff', displayName: 'Sam', user, guild, permissions: { has: () => true }, roles: { cache: new Map(), add: boom('add'), remove: boom('remove') }, send: boom('send'), setNickname: boom('nick') };
  const replies = [];
  const interaction = {
    guildId: 'g1', channelId: 'c1', guild, member: m, user, channel: { id: 'c1', name: 'g', send: boom('send') }, replies, inGuild: () => true,
    options: { getSubcommand: () => 'test', getString: () => interaction.msg, getInteger: () => null },
    reply: async (p) => { replies.push(p); },
  };
  return { interaction, queries, ctx: { db: spy, client: { user: { id: 'bot' }, channels: { fetch: boom('fetch') } } } };
}

test('/autoresponder test shows drawn values and pings, with only SELECTs and no Discord writes', async () => {
  await enable();
  await createRule(db, {
    guildId: 'g1', trigger: '!hug', matchMode: 'startswith', script: 'x', createdBy: 'u1',
    compiled: comp({
      template: [{ t: 'arg', from: 1, to: 1 }, { t: 'text', v: ' rolled ' }, { t: 'rand', kind: 'range', n: 1 }],
      argChecks: [{ n: 1, type: 'user' }], random: { ranges: [{ min: 1, max: 6 }], choosers: [], locked: [] },
    }),
  });
  const e = readOnlyEnv();
  e.interaction.msg = `!hug <@${U1}>`;
  await createAutoresponderCommand().execute(e.interaction, e.ctx);
  const out = e.interaction.replies.at(-1).content;
  assert.match(out, /Random values drawn: \[range\]: [1-6]/);
  assert.match(out, new RegExp(`Would ping: <@${U1}>`));
  assert.match(out, /requirearg 1: pass/);
  assert.ok(e.queries.every((q) => /^\s*select/i.test(q)), e.queries.join('\n'));
  e.interaction.msg = '!hug';
  await createAutoresponderCommand().execute(e.interaction, e.ctx);
  assert.match(e.interaction.replies.at(-1).content, /requirearg 1: fail/);
});

test('describeRunFor uses the same preparation, and v1 output has no draws or pings lines', async () => {
  const e = readOnlyEnv();
  const v1 = { version: 1, template: [{ t: 'text', v: 'plain' }], gates: [], actions: [], flags: flags() };
  const args = { compiled: v1, text: 'hello', member: e.interaction.member, guild: e.interaction.guild, channel: e.interaction.channel, channelId: 'c1', author: e.interaction.user };
  const lines = await describeRunFor('en', args, { rule: rule({ trigger: 'hello' }) });
  assert.deepEqual(lines, describeRun('en', args));
  assert.equal(lines.some((l) => /Random values|Would ping/.test(l)), false);
});

// ---- nickname words ----
const NU = '123456789012345678';
const names = { [NU]: 'Sam' };
const nickGuild = (map = names) => ({ id: 'g', roles: { cache: new Map() }, members: { fetch: async (id) => { if (!(id in map)) throw new Error('unknown'); return { id, displayName: map[id] }; } } });
const nickRun = async (src, text, map = names, vars = {}) => {
  const { compiled } = await compileFor(src);
  const g = nickGuild(map);
  const prepared = await prepareRun({ compiled, rule: rule({ trigger: '!fan' }), text, guild: g });
  const plan = evaluate(compiled, { member: member(), channelId: 'c1', vars, ...prepared });
  let applied = null;
  const m = { id: 'a1', manageable: true, roles: { cache: new Map() }, setNickname: async (n) => { applied = n; } };
  const replies = [];
  const res = await executePlan({ db: {} }, { rule: {}, message: { guild: g, reply: async (o) => { replies.push(o); return {}; } }, member: m, plan, lang: 'en', vars }, {});
  return { prepared, plan, res, replies, applied: () => applied, compiled, g };
};

test('prepareRun: nickWords hold the display name of a checked user word, words keep the mention', async () => {
  const c = comp({ argChecks: [{ n: 1, type: 'user' }], actions: [{ fn: 'setnick', text: '[$1]' }] });
  const p = await prepareRun({ compiled: c, rule: rule(), text: `!hug ${NU} extra`, guild: nickGuild() });
  assert.equal(p.nickWords.list[0], 'Sam');
  assert.equal(p.words.list[0], `<@${NU}>`);
  assert.deepEqual(p.nickWords.list, ['Sam', 'extra']);
});

test('prepareRun: nickWords equal words for unchecked, number-checked and requirearg-free rules', async () => {
  for (const c of [
    comp({ actions: [{ fn: 'setnick', text: '[$1]' }] }),
    comp({ argChecks: [{ n: 1, type: 'number' }], actions: [{ fn: 'setnick', text: '[$1]' }] }),
    comp({ template: [{ t: 'text', v: 'x' }] }),
  ]) {
    const p = await prepareRun({ compiled: c, rule: rule(), text: '!hug 42', guild: nickGuild() });
    assert.equal(p.nickWords, p.words);
  }
});

test('nickname uses the display name; reply text and allowedUsers keep the mention', async () => {
  const r = await nickRun('{requirearg:1|user}{setnick:[$1] fan club}{user} hugs [$1]', `!fan ${NU}`);
  assert.equal(r.applied(), 'Sam fan club');
  assert.match(r.plan.text, new RegExp(`<@${NU}>`));
  assert.deepEqual(r.plan.allowedUsers, ['a1', NU]); // the sender (via {user}) and the checked user, as before
  assert.deepEqual(r.res.errors, []);
});

test('a display name with spaces keeps later word indexes and rest()', async () => {
  const r = await nickRun('{requirearg:1|user}{setnick:[$2]/[$2+]/[$1+]}', `!fan ${NU} tail end`, { [NU]: 'Sam Smith' });
  assert.equal(r.applied(), 'tail/tail end/Sam Smith tail end');
});

test('a display name is inserted literally in one pass', async () => {
  for (const name of ['[$2]', '<@999>', '{user}', '[range]', `a${ESCAPED_BRACKET}b`]) {
    const r = await nickRun('{requirearg:1|user}{setnick:[$1]}', `!fan ${NU} second`, { [NU]: name }, { user: 'SECRET' });
    assert.equal(r.applied(), name.replaceAll(ESCAPED_BRACKET, ''), name);
  }
});

test('a 40-character display name is NICK_TOO_LONG; an empty name falls back to the typed word', async () => {
  const long = await nickRun('{requirearg:1|user}{setnick:[$1]}', `!fan ${NU}`, { [NU]: 'x'.repeat(40) });
  assert.equal(long.applied(), null);
  assert.equal(long.res.errors[0].code, 'NICK_TOO_LONG');
  const empty = await nickRun('{requirearg:1|user}{setnick:[$1]}', `!fan ${NU}`, { [NU]: '' });
  assert.equal(empty.applied(), NU);
});

test('describeRunFor prints the nickname executePlan would set', async () => {
  const { compiled, g, applied } = await nickRun('{requirearg:1|user}{setnick:[$1] fan club}', `!fan ${NU}`);
  const e = readOnlyEnv();
  const args = { compiled, text: `!fan ${NU}`, member: e.interaction.member, guild: Object.assign(e.interaction.guild, { members: nickGuild().members }), channel: e.interaction.channel, channelId: 'c1', author: e.interaction.user };
  const lines = await describeRunFor('en', args, { rule: rule({ trigger: '!fan' }) });
  assert.equal(applied(), 'Sam fan club');
  assert.ok(lines.some((l) => l.includes('Sam fan club')), lines.join('\n'));
  assert.ok(!lines.some((l) => l.includes(`<@${NU}> fan club`)), lines.join('\n'));
  assert.ok(g);
});
