import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { testDb } from '../helpers/db.js';
import { resetDb } from '../../src/db/index.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { createRule, updateRule, deleteRule } from '../../src/features/autoresponder/store.js';
import { createButton, deleteButton, createMessageRecord, getMessageRecord } from '../../src/features/autoresponder/buttons/store.js';
import { createPressThrottle } from '../../src/features/autoresponder/buttons/model.js';
import { executePlan, RUN_ERROR_CODES } from '../../src/features/autoresponder/execute.js';
import { handlePress } from '../../src/features/autoresponder/buttons/press.js';
import { evaluate } from '../../src/features/autoresponder/script/evaluate.js';
import { prepareRun } from '../../src/features/autoresponder/script/run.js';
import { compileScript } from '../../src/features/autoresponder/script/compile.js';
import { describeRun } from '../../src/features/autoresponder/dryrun.js';
import { createAutoresponderCommand } from '../../src/features/autoresponder/commands.js';
import en from '../../src/i18n/en.json' with { type: 'json' };
import fr from '../../src/i18n/fr.json' with { type: 'json' };
import ar from '../../src/i18n/ar.json' with { type: 'json' };

let db;
before(async () => { db = await testDb(); });
after(async () => { await db.end(); });
beforeEach(async () => {
  await resetDb(db);
  await setFeature(db, 'g1', 'autoresponder', { enabled: true });
});

const DAY = 86_400_000;
const U1 = '111111111111111111';
const U2 = '222222222222222222';
const flags = (over = {}) => ({ silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null, ...over });
const comp = (over = {}) => ({
  version: 2, template: [{ t: 'text', v: 'ok' }], gates: [], actions: [], random: { ranges: [], choosers: [], locked: [] }, argChecks: [], ...over, flags: flags(over.flags),
});
const press = (key, vars) => t('en', `autoresponder.press.${key}`, vars);

// ---------- sending ----------

function sendWorld({ sendToChannel } = {}) {
  const log = { edits: [], replies: [], sends: [] };
  const mkSent = (id, channelId) => ({
    id, channelId, channel: { id: channelId },
    edit: async (p) => { log.edits.push({ id, p }); return null; },
    react: async () => {}, delete: async () => {},
  });
  const channel = { id: 'c1', send: async (p) => { log.sends.push(p); return mkSent('S-chan', 'c1'); } };
  const message = {
    id: 'm1', channel, channelId: 'c1',
    guild: { id: 'g1', roles: { cache: new Map() }, channels: { cache: new Map(sendToChannel ? [[sendToChannel.id, sendToChannel]] : []) } },
    reply: async (p) => { log.replies.push(p); return mkSent('S1', 'c1'); },
  };
  const member = { id: 'u1', roles: { cache: new Map() } };
  return { log, message, member, mkSent };
}
const sendPlan = (over = {}) => ({
  status: 'run', cooldown: null, text: 'pick', flags: flags(), actions: [],
  v2: true, words: { rest: () => 'a  b c', list: ['a', 'b', 'c'] }, draws: { range: [4], choice: ['x'], lockedchoice: [], picked: [0] }, ...over,
});
const baseButton = { guildId: 'g1', name: 'rules', label: 'Rules', emoji: null, style: 'blue', script: 'x', compiled: comp(), createdBy: 'u1' };

async function sendRule() {
  return createRule(db, { guildId: 'g1', trigger: 'hello', matchMode: 'includes', script: 'x', compiled: comp(), createdBy: 'u1' });
}

test('a reply with a stored button is sent, then edited with the real custom id and a record is stored', async () => {
  await createButton(db, baseButton);
  const rule = await sendRule();
  const w = sendWorld();
  const now = 1_800_000_000_000;
  const res = await executePlan({ db }, {
    rule, message: w.message, member: w.member, lang: 'en', vars: {},
    plan: sendPlan({ buttons: [{ kind: 'stored', name: 'rules' }] }),
  }, { now: () => now });
  assert.deepEqual(res.errors, []);
  assert.equal(res.sent.id, 'S1');
  assert.equal(w.log.edits.length, 1);
  const row = w.log.edits[0].p.components[0].toJSON();
  const b = row.components[0];
  assert.equal(b.custom_id, 'autoresponder:p:S1:0');
  assert.equal(b.label, 'Rules');
  assert.equal(b.style, 1);
  assert.equal(Boolean(b.disabled), false);
  const rec = await getMessageRecord(db, 'S1', now);
  assert.equal(rec.invokerId, 'u1');
  assert.equal(rec.channelId, 'c1');
  assert.equal(rec.ruleId, rule.id);
  assert.equal(rec.words, 'a  b c');
  assert.deepEqual(rec.draws, { range: [4], choice: ['x'], lockedchoice: [], picked: [0] });
  assert.deepEqual(rec.buttons, [{ kind: 'stored', name: 'rules' }]);
  assert.equal(rec.expiresAt, now + 14 * DAY);
});

test('invokerId overrides the member as the stored invoker; buttonState overrides words and draws', async () => {
  await createButton(db, baseButton);
  const rule = await sendRule();
  const w = sendWorld();
  await executePlan({ db }, {
    rule, message: w.message, member: w.member, lang: 'en', vars: {}, invokerId: 'presser',
    buttonState: { words: 'old words', draws: { choice: ['k'] } },
    plan: sendPlan({ buttons: [{ kind: 'stored', name: 'rules' }] }),
  }, {});
  const rec = await getMessageRecord(db, 'S1');
  assert.equal(rec.invokerId, 'presser');
  assert.equal(rec.words, 'old words');
  assert.deepEqual(rec.draws, { choice: ['k'] });
});

test('with {sendto} the record stores the channel of the sent message', async () => {
  await createButton(db, baseButton);
  const rule = await sendRule();
  const target = { id: 'c9', send: null, isTextBased: () => true, permissionsFor: () => null };
  const w = sendWorld({ sendToChannel: target });
  target.send = async () => w.mkSent('S9', 'c9');
  const res = await executePlan({ db }, {
    rule, message: w.message, member: w.member, lang: 'en', vars: {},
    plan: sendPlan({ flags: flags({ sendTo: 'c9' }), buttons: [{ kind: 'stored', name: 'rules' }] }),
  }, {});
  assert.equal(res.sent.id, 'S9');
  assert.equal((await getMessageRecord(db, 'S9')).channelId, 'c9');
});

test('a link button has the url and no custom id; a missing stored button is skipped with BUTTON_MISSING', async () => {
  await createButton(db, baseButton);
  const rule = await sendRule();
  const w = sendWorld();
  const res = await executePlan({ db }, {
    rule, message: w.message, member: w.member, lang: 'en', vars: {},
    plan: sendPlan({ buttons: [{ kind: 'stored', name: 'gone' }, { kind: 'link', label: 'Docs', url: 'https://example.com/', emoji: null }, { kind: 'stored', name: 'rules' }] }),
  }, {});
  assert.deepEqual(res.errors, [{ code: 'BUTTON_MISSING', action: 'addbutton', detail: 'gone' }]);
  const comps = w.log.edits[0].p.components[0].toJSON().components;
  assert.equal(comps.length, 2);
  assert.equal(comps[0].url, 'https://example.com/');
  assert.equal(comps[0].custom_id, undefined);
  assert.equal(comps[1].custom_id, 'autoresponder:p:S1:1');
  const rec = await getMessageRecord(db, 'S1');
  assert.deepEqual(rec.buttons.map((x) => x.kind), ['link', 'stored']);
});

test('a rule without buttons makes no database call and no extra Discord call', async () => {
  let queries = 0;
  const spy = { query: async (...a) => { queries += 1; return db.query(...a); }, connect: async () => { queries += 1; return db.connect(); } };
  const w = sendWorld();
  const res = await executePlan({ db: spy }, { rule: { id: 1 }, message: w.message, member: w.member, lang: 'en', vars: {}, plan: sendPlan() }, {});
  assert.equal(queries, 0);
  assert.equal(w.log.edits.length, 0);
  assert.equal(res.sent.id, 'S1');
  assert.deepEqual(res.errors, []);
});

test('BUTTON_MISSING is a run code with text in every language', () => {
  assert.ok(RUN_ERROR_CODES.includes('BUTTON_MISSING'));
  for (const lang of [en, fr, ar]) assert.ok(lang['autoresponder.run.BUTTON_MISSING']);
});

// ---------- the press ----------

function pressWorld({ memberRoles = [], userId = 'p1', known = [U1] } = {}) {
  const calls = { follow: [], edits: [], roles: [], replies: [], sends: [], deferred: 0, order: [], deletes: 0, reacts: [] };
  const roleCache = new Map([['R1', { id: 'R1' }]]);
  const guild = {
    id: 'g1', name: 'G', ownerId: 'own', memberCount: 3, createdTimestamp: 1, iconURL: () => null,
    roles: { cache: roleCache }, channels: { cache: new Map() }, emojis: { cache: new Map() },
    members: { me: { id: 'bot' }, fetch: async (id) => { if (known.includes(id) || id === userId) return { id, displayName: `n${id}` }; throw new Error('unknown'); } },
  };
  const sentOf = (id) => ({ id, channelId: 'c1', channel: { id: 'c1' }, edit: async () => null, react: async (e) => { calls.reacts.push(['reply', e]); }, delete: async () => {} });
  const channel = { id: 'c1', name: 'general', send: async (p) => { calls.sends.push(p); calls.order.push('send'); return sentOf('S-send'); } };
  const message = {
    id: '1001', guild, channel, channelId: 'c1', url: 'https://discord.com/channels/g1/c1/1001',
    reply: async (p) => { calls.replies.push(p); calls.order.push('reply'); return sentOf(`S-${calls.replies.length}`); },
    delete: async () => { calls.deletes += 1; },
    react: async (e) => { calls.reacts.push(['msg', e]); },
  };
  const member = {
    id: userId, roles: { cache: new Map(memberRoles.map((r) => [r, { id: r }])), add: async (...a) => { calls.roles.push(a); }, remove: async () => {} },
    permissions: { has: () => false }, displayName: 'Presser', manageable: true,
  };
  const user = { id: userId, username: 'presser', globalName: null, createdTimestamp: 1, tag: 'presser', displayAvatarURL: () => 'a.png', bot: false };
  const deps = { throttle: createPressThrottle(0), botCanGive: () => true, isDangerousRole: () => false, rng: () => 0.5 };
  const interact = async (customId, over = {}) => {
    const i = {
      customId, guildId: 'g1', guild, channel, channelId: 'c1', member, user, message,
      inGuild: () => true, isButton: () => true,
      deferUpdate: async () => { calls.deferred += 1; calls.order.push('defer'); },
      followUp: async (p) => { calls.follow.push(p); calls.order.push('follow'); },
      editReply: async (p) => { calls.edits.push(p); },
      ...over,
    };
    await handlePress(i, { db, client: { user: { id: 'bot' } } }, { ...deps, ...(over.deps ?? {}) });
    return i;
  };
  return { calls, guild, member, message, channel, deps, interact };
}

// A rule, its button(s) and a stored message record. `btn` is merged into the button row.
async function seed({ rule = {}, buttons = [{}], record = {}, entries } = {}) {
  const r = await createRule(db, { guildId: 'g1', trigger: 'hello', matchMode: 'includes', script: 'x', compiled: comp(), createdBy: 'u1', ...rule });
  const names = [];
  for (let i = 0; i < buttons.length; i++) {
    const name = `b${i}`;
    names.push(name);
    await createButton(db, { ...baseButton, name, label: `B${i}`, compiled: comp(), ...buttons[i] });
  }
  await createMessageRecord(db, {
    messageId: '1001', channelId: 'c1', guildId: 'g1', ruleId: r.id, invokerId: 'inv', words: '', draws: {},
    buttons: entries ?? names.map((name) => ({ kind: 'stored', name })), expiresAt: Date.now() + DAY, ...record,
  });
  return r;
}

const id = (n) => `autoresponder:p:1001:${n}`;
const noEffects = (w) => {
  assert.deepEqual(w.calls.roles, []);
  assert.deepEqual(w.calls.replies, []);
  assert.deepEqual(w.calls.sends, []);
};
const flagsOf = (p) => p.flags;

test('a normal member presses: deferUpdate first, the script runs as the presser, the reply is public to the button message', async () => {
  await seed({ buttons: [{ compiled: comp({ template: [{ t: 'text', v: 'hi ' }, { t: 'ph', name: 'user' }], actions: [{ fn: 'addrole', roleId: 'R1', raw: 'R1' }] }) }] });
  const w = pressWorld();
  await w.interact(id(0));
  assert.equal(w.calls.order[0], 'defer');
  assert.deepEqual(w.calls.roles[0], ['R1', 'Autoresponder']);
  assert.equal(w.calls.replies.length, 1);
  assert.equal(w.calls.replies[0].content, 'hi <@p1>');
  assert.deepEqual(w.calls.replies[0].allowedMentions.parse, []);
  assert.deepEqual(w.calls.replies[0].allowedMentions.users, ['p1']);
  assert.deepEqual(w.calls.follow, []);
});

for (const [name, setup] of [
  ['an expired record', async () => seed({ record: { expiresAt: Date.now() - 1000 } })],
  ['a deleted rule', async () => { const r = await seed(); await deleteRule(db, 'g1', r.id); }],
  ['a disabled rule', async () => { const r = await seed(); await updateRule(db, 'g1', r.id, { enabled: false }); }],
  ['a removed stored button', async () => { await seed(); await deleteButton(db, 'g1', 'b0'); }],
  ['the feature off', async () => { await seed(); await setFeature(db, 'g1', 'autoresponder', { enabled: false }); }],
  ['an out-of-range index', async () => { await seed(); }],
  ['a link entry index', async () => seed({ entries: [{ kind: 'link', label: 'L', url: 'https://e.com/', emoji: null }] })],
  ['a record of another server', async () => seed({ record: { guildId: 'g2' } })],
]) {
  test(`${name} answers expired and nothing else happens`, async () => {
    await setup();
    const w = pressWorld();
    await w.interact(id(name === 'an out-of-range index' ? 7 : 0), { deps: {} });
    assert.equal(w.calls.deferred, 1);
    assert.equal(w.calls.follow.length, 1);
    assert.equal(w.calls.follow[0].content, press('expired'));
    assert.equal(flagsOf(w.calls.follow[0]), MessageFlags.Ephemeral);
    noEffects(w);
    assert.deepEqual(w.calls.edits, []);
    const rec = await getMessageRecord(db, '1001');
    if (rec) { assert.equal(rec.locked, false); assert.deepEqual(rec.pressed, []); }
  });
}

test('invoker_only: another member gets the invoker notice, the invoker runs it', async () => {
  await seed({ buttons: [{ invokerOnly: true }] });
  const other = pressWorld({ userId: 'p2' });
  await other.interact(id(0));
  assert.equal(other.calls.follow[0].content, press('invoker'));
  noEffects(other);
  const inv = pressWorld({ userId: 'inv' });
  await inv.interact(id(0));
  assert.equal(inv.calls.replies.length, 1);
  assert.deepEqual(inv.calls.follow, []);
});

test('limited: the second press is refused with pressed and the button is disabled in the edit; link buttons stay enabled', async () => {
  await seed({
    buttons: [{ limitations: 'limited' }, {}],
    entries: [{ kind: 'stored', name: 'b0' }, { kind: 'link', label: 'L', url: 'https://e.com/', emoji: null }, { kind: 'stored', name: 'b1' }],
  });
  const w = pressWorld();
  await w.interact(id(0));
  assert.equal(w.calls.replies.length, 1);
  assert.equal(w.calls.edits.length, 1);
  const comps = w.calls.edits[0].components[0].toJSON().components;
  assert.equal(comps[0].disabled, true);
  assert.equal(comps[1].disabled, undefined);
  assert.equal(comps[1].url, 'https://e.com/');
  assert.equal(Boolean(comps[2].disabled), false);
  await w.interact(id(0));
  assert.equal(w.calls.replies.length, 1);
  assert.equal(w.calls.follow.at(-1).content, press('pressed'));
});

test('strict: after one press every other press (any button, any member) is refused with locked and the buttons render disabled', async () => {
  await seed({ buttons: [{ limitations: 'strict' }, { limitations: 'none' }, { limitations: 'limited' }] });
  const w = pressWorld();
  await w.interact(id(0));
  assert.equal(w.calls.replies.length, 1);
  const comps = w.calls.edits[0].components[0].toJSON().components;
  assert.deepEqual(comps.map((c) => c.disabled), [true, true, true]);
  const other = pressWorld({ userId: 'p2' });
  for (const n of [0, 1, 2]) await other.interact(id(n));
  assert.deepEqual(other.calls.follow.map((f) => f.content), [press('locked'), press('locked'), press('locked')]);
  noEffects(other);
  await w.interact(id(1));
  assert.equal(w.calls.follow.at(-1).content, press('locked'));
  assert.equal(w.calls.replies.length, 1);
});

test('two simultaneous presses on a limited button run the script once', async () => {
  await seed({ buttons: [{ limitations: 'limited' }] });
  const a = pressWorld({ userId: 'p1' });
  const b = pressWorld({ userId: 'p2' });
  await Promise.all([a.interact(id(0)), b.interact(id(0))]);
  assert.equal(a.calls.replies.length + b.calls.replies.length, 1);
  assert.equal(a.calls.follow.length + b.calls.follow.length, 1);
});

test('a none button presses freely, but the same presser twice within 3 seconds gets slow', async () => {
  await seed();
  const w = pressWorld();
  const throttle = createPressThrottle(3000);
  let clock = 1_000_000;
  const deps = { throttle, now: () => clock };
  await w.interact(id(0), { deps });
  clock += 1000;
  await w.interact(id(0), { deps });
  assert.equal(w.calls.replies.length, 1);
  assert.equal(w.calls.follow[0].content, press('slow'));
  clock += 3000;
  await w.interact(id(0), { deps });
  assert.equal(w.calls.replies.length, 2);
});

test('a {cooldown} in the button script is per presser per button', async () => {
  await seed({ buttons: [{ compiled: comp({ gates: [{ fn: 'cooldown', seconds: 30 }] }) }] });
  const w = pressWorld();
  await w.interact(id(0));
  await w.interact(id(0));
  assert.equal(w.calls.replies.length, 1);
  assert.equal(w.calls.follow[0].content, press('cooldown', { seconds: '30' }));
  const other = pressWorld({ userId: 'p2' });
  await other.interact(id(0));
  assert.equal(other.calls.replies.length, 1);
});

test('a failing {requirerole} gives the gate notice and no reply', async () => {
  await seed({ buttons: [{ compiled: comp({ gates: [{ fn: 'requirerole', roleIds: ['R9'] }] }) }] });
  const w = pressWorld();
  await w.interact(id(0));
  assert.equal(w.calls.follow[0].content, press('gate'));
  noEffects(w);
  const ok = pressWorld({ memberRoles: ['R9'] });
  await ok.interact(id(0));
  assert.equal(ok.calls.replies.length, 1);
});

const argButton = (over = {}) => ({
  compiled: comp({ template: [{ t: 'text', v: 'hug ' }, { t: 'arg', from: 1, to: 1 }], argChecks: [{ n: 1, type: 'user' }], ...over }),
});

test('restored words are re-checked: a stored user who is known works, one who left gets the arg notice', async () => {
  await seed({ buttons: [argButton()], record: { words: U1 } });
  const ok = pressWorld({ known: [U1] });
  await ok.interact(id(0));
  assert.equal(ok.calls.replies[0].content, `hug <@${U1}>`);
  assert.deepEqual(ok.calls.replies[0].allowedMentions.users, [U1]);
  const gone = pressWorld({ known: [] });
  await gone.interact(id(0));
  assert.equal(gone.calls.follow[0].content, press('arg', { n: '1', type: t('en', 'autoresponder.argtype.user') }));
  assert.equal(gone.calls.replies.length, 0);
});

test('stored words typed as @everyone or a role mention never ping', async () => {
  const plain = { compiled: comp({ template: [{ t: 'arg', from: 1, to: 'end' }], argChecks: [{ n: 1, type: null }] }) };
  await seed({ buttons: [plain], record: { words: '@everyone <@&333333333333333333> <@222222222222222222>' } });
  const w = pressWorld();
  await w.interact(id(0));
  const p = w.calls.replies[0];
  assert.match(p.content, /@everyone/);
  assert.deepEqual(p.allowedMentions.parse, []);
  assert.deepEqual(p.allowedMentions.users, []);
});

test('[choice] resolves from the stored draws unless the button defines its own choose', async () => {
  const tpl = [{ t: 'rand', kind: 'choice', n: 1 }];
  await seed({
    buttons: [{ compiled: comp({ template: tpl }) }, { compiled: comp({ template: tpl, random: { ranges: [], choosers: [{ kind: 'choose', options: ['own'] }], locked: [] } }) }],
    record: { draws: { choice: ['stored'], range: [], lockedchoice: [] } },
  });
  const w = pressWorld();
  await w.interact(id(0));
  assert.equal(w.calls.replies[0].content, 'stored');
  await w.interact(id(1));
  assert.equal(w.calls.replies[1].content, 'own');
});

test('a chained {addbutton} posts a new reply and a new record with the presser as invoker and the words and draws copied', async () => {
  await seed({
    buttons: [{ compiled: comp({ template: [{ t: 'text', v: 'next' }], buttons: [{ kind: 'stored', name: 'b1' }] }) }, {}],
    record: { words: 'w1  w2', draws: { choice: ['c'], range: [], lockedchoice: [] } },
  });
  const w = pressWorld({ userId: 'p7' });
  const sentEdits = [];
  w.message.reply = async (p) => {
    w.calls.replies.push(p);
    return { id: 'S2', channelId: 'c1', channel: { id: 'c1' }, edit: async (e) => { sentEdits.push(e); }, react: async () => {}, delete: async () => {} };
  };
  await w.interact(id(0));
  assert.equal(sentEdits.length, 1);
  assert.equal(sentEdits[0].components[0].toJSON().components[0].custom_id, 'autoresponder:p:S2:0');
  const rec = await getMessageRecord(db, 'S2');
  assert.equal(rec.invokerId, 'p7');
  assert.equal(rec.words, 'w1  w2');
  assert.deepEqual(rec.draws, { choice: ['c'], range: [], lockedchoice: [] });
  assert.equal(rec.ruleId, (await getMessageRecord(db, '1001')).ruleId);
});

test('{delete} deletes the button message, {react} reacts on it', async () => {
  await seed({ buttons: [{ compiled: comp({ flags: { delete: true } }) }, { compiled: comp({ actions: [{ fn: 'react', emoji: 'x' }] }) }] });
  const w = pressWorld();
  await w.interact(id(0));
  assert.equal(w.calls.deletes, 1);
  assert.equal(w.calls.sends.length, 1);
  await w.interact(id(1));
  assert.deepEqual(w.calls.reacts, [['msg', 'x']]);
});

test('the reply falls back to a channel send when the button message is gone', async () => {
  await seed();
  const w = pressWorld();
  w.message.reply = async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); };
  await w.interact(id(0));
  assert.equal(w.calls.sends.length, 1);
  assert.equal(w.calls.sends[0].content, 'ok');
  assert.deepEqual(w.calls.sends[0].allowedMentions.parse, []);
});

test('the handler never throws: a failing database gives the generic ephemeral error', async () => {
  const w = pressWorld();
  const bad = { query: async () => { throw new Error('db down'); }, connect: async () => { throw new Error('db down'); } };
  const i = {
    customId: id(0), guildId: 'g1', guild: w.guild, channel: w.channel, channelId: 'c1', member: w.member, user: { id: 'p1' }, message: w.message,
    inGuild: () => true, isButton: () => true,
    deferUpdate: async () => {}, followUp: async (p) => { w.calls.follow.push(p); }, editReply: async () => {},
  };
  await handlePress(i, { db: bad, client: {} }, w.deps);
  assert.equal(w.calls.follow.length, 1);
  assert.equal(w.calls.follow[0].content, t('en', 'autoresponder.press.error'));
});

test('commands.js routes kind p to the press handler before any manager check', async () => {
  await seed();
  const w = pressWorld();
  const cmd = createAutoresponderCommand();
  const i = {
    customId: id(0), guildId: 'g1', guild: w.guild, channel: w.channel, channelId: 'c1', member: w.member, user: { id: 'p1', username: 'p', createdTimestamp: 1, displayAvatarURL: () => 'a' }, message: w.message,
    inGuild: () => true, isButton: () => true,
    deferUpdate: async () => {}, followUp: async (p) => { w.calls.follow.push(p); }, editReply: async () => {},
  };
  await cmd.components.handle(i, { db, client: { user: { id: 'bot' } } });
  assert.equal(w.calls.replies.length, 1);
  assert.deepEqual(w.calls.follow, []);
});

// ---------- evaluate / dry run / i18n ----------

test('evaluate copies compiled.buttons to plan.buttons; absent means none', () => {
  const member = { id: 'u', roles: { cache: new Map() }, permissions: { has: () => false } };
  const withB = evaluate(comp({ buttons: [{ kind: 'stored', name: 'a' }] }), { member, channelId: 'c', vars: {} });
  assert.deepEqual(withB.buttons, [{ kind: 'stored', name: 'a' }]);
  assert.equal(evaluate(comp(), { member, channelId: 'c', vars: {} }).buttons?.length ?? 0, 0);
});

const dryArgs = () => {
  const user = { id: 's', username: 'S', globalName: null, createdTimestamp: 1, displayAvatarURL: () => 'a', tag: 'S' };
  const guild = { id: 'g1', name: 'G', ownerId: 'o', memberCount: 1, createdTimestamp: 1, iconURL: () => 'i', roles: { cache: new Map() } };
  const member = { id: 's', displayName: 'S', user, guild, permissions: { has: () => true }, roles: { cache: new Map() } };
  return { text: 'hello', member, guild, channel: { id: 'c1' }, channelId: 'c1', author: user };
};

test('describeRun prints a buttons line only when the reply carries buttons', () => {
  const none = describeRun('en', { compiled: comp(), ...dryArgs() });
  assert.ok(!none.some((l) => l.startsWith(t('en', 'autoresponder.test.buttons', { detail: '' }).trim().slice(0, 8))));
  const lines = describeRun('en', {
    compiled: comp({ buttons: [{ kind: 'stored', name: 'rules' }, { kind: 'link', label: 'Docs', url: 'https://e.com/', emoji: null }] }),
    ...dryArgs(),
    buttonInfo: { rules: { label: 'Rules', style: 'red', invokerOnly: true, limitations: 'strict' } },
  });
  const line = lines.find((l) => l.includes('Rules'));
  assert.ok(line);
  for (const bit of ['red', 'invoker_only', 'strict', 'https://e.com/']) assert.ok(line.includes(bit), bit);
});

test('all new keys exist in en, fr and ar', () => {
  const keys = ['expired', 'invoker', 'pressed', 'locked', 'slow', 'gate', 'arg', 'cooldown', 'error'].map((k) => `autoresponder.press.${k}`);
  keys.push('autoresponder.run.BUTTON_MISSING', 'autoresponder.test.buttons');
  for (const lang of [en, fr, ar]) for (const k of keys) assert.ok(lang[k], k);
});

// ---------- fix round 1: gates are answered before anything is claimed ----------

const gated = (limitations) => ({ limitations, compiled: comp({ gates: [{ fn: 'requirerole', roleIds: ['R9'] }] }) });

for (const limitations of ['limited', 'strict']) {
  test(`${limitations}: a failed gate claims nothing and leaves the buttons alone; a member with the role then presses`, async () => {
    await seed({ buttons: [gated(limitations), {}] });
    const without = pressWorld({ userId: 'p2' });
    await without.interact(id(0));
    assert.equal(without.calls.follow[0].content, press('gate'));
    assert.deepEqual(without.calls.edits, []);
    noEffects(without);
    const rec = await getMessageRecord(db, '1001');
    assert.equal(rec.locked, false);
    assert.deepEqual(rec.pressed, []);
    const withRole = pressWorld({ memberRoles: ['R9'] });
    await withRole.interact(id(0));
    assert.equal(withRole.calls.replies.length, 1);
    assert.equal(withRole.calls.edits.length, 1);
  });
}

test('a failed requirearg (stored user left) claims nothing', async () => {
  await seed({ buttons: [{ ...argButton(), limitations: 'strict' }], record: { words: U1 } });
  const gone = pressWorld({ known: [] });
  await gone.interact(id(0));
  assert.equal(gone.calls.follow[0].content, press('arg', { n: '1', type: t('en', 'autoresponder.argtype.user') }));
  assert.deepEqual(gone.calls.edits, []);
  assert.equal((await getMessageRecord(db, '1001')).locked, false);
  const ok = pressWorld({ known: [U1] });
  await ok.interact(id(0));
  assert.equal(ok.calls.replies.length, 1);
});

test('a successful press still claims exactly once under Promise.all', async () => {
  await seed({ buttons: [{ limitations: 'strict' }] });
  const ws = ['p1', 'p2', 'p3'].map((u) => pressWorld({ userId: u }));
  await Promise.all(ws.map((w) => w.interact(id(0))));
  assert.equal(ws.reduce((n, w) => n + w.calls.replies.length, 0), 1);
  assert.equal(ws.reduce((n, w) => n + w.calls.follow.length, 0), 2);
});

test('a press whose message or channel does not match the record answers expired', async () => {
  await seed();
  const w = pressWorld();
  await w.interact(id(0), { message: { ...w.message, id: '999' } });
  await w.interact(id(0), { channelId: 'other' });
  assert.deepEqual(w.calls.follow.map((f) => f.content), [press('expired'), press('expired')]);
  noEffects(w);
});

test('a non-invoker pressing an invoker_only button twice is throttled; the invoker is unaffected', async () => {
  await seed({ buttons: [{ invokerOnly: true }] });
  const throttle = createPressThrottle(3000);
  const deps = { throttle, now: () => 5000 };
  const other = pressWorld({ userId: 'p2' });
  await other.interact(id(0), { deps });
  await other.interact(id(0), { deps });
  assert.deepEqual(other.calls.follow.map((f) => f.content), [press('invoker'), press('slow')]);
  const inv = pressWorld({ userId: 'inv' });
  await inv.interact(id(0), { deps });
  assert.equal(inv.calls.replies.length, 1);
});

// ---------- stage 3 follow-up: stored words, allowedMentions on component edits ----------

test('end to end: a rule that reads no words but carries a button stores the words, and the button uses them on press', async () => {
  const world = pressWorld({ known: [U1] });
  const cg = { ...world.guild, roles: { cache: new Map() }, channels: { cache: new Map() } };
  const btn = await compileScript('hug [$1]{requirearg:1|user}', { db, guild: cg, writer: { id: 'w' }, buttonScript: true });
  assert.equal(btn.ok, true);
  await createButton(db, { ...baseButton, name: 'answer', label: 'Answer', compiled: btn.compiled });
  const ruleComp = await compileScript('Noted {addbutton:answer}', { db, guild: cg, writer: { id: 'w' }, matchMode: 'startswith' });
  assert.equal(ruleComp.ok, true);
  const rule = await createRule(db, { guildId: 'g1', trigger: '!ask', matchMode: 'startswith', script: 'x', compiled: ruleComp.compiled, createdBy: 'u1' });
  const text = `!ask ${U1}  please`;
  const prepared = await prepareRun({ compiled: rule.compiled, rule, text, guild: world.guild, rng: () => 0.5 });
  assert.equal(prepared.words.rest(1), `${U1}  please`);
  const plan = evaluate(rule.compiled, { member: world.member, channelId: 'c1', vars: {}, ...prepared });
  const edits = [];
  const msg = {
    id: 'trig', guild: world.guild, channel: world.channel, channelId: 'c1',
    reply: async () => ({ id: '1001', channelId: 'c1', channel: { id: 'c1' }, edit: async (e) => { edits.push(e); }, react: async () => {}, delete: async () => {} }),
  };
  const res = await executePlan({ db }, { rule, message: msg, member: world.member, plan, lang: 'en', vars: {} }, {});
  assert.deepEqual(res.errors, []);
  const rec = await getMessageRecord(db, '1001');
  assert.equal(rec.words, `${U1}  please`);
  await world.interact(id(0));
  assert.deepEqual(world.calls.follow, []);
  assert.equal(world.calls.replies[0].content, `hug <@${U1}>`);
});

test('prepareRun: a rule with no words and no buttons still takes the fast path', async () => {
  const cg = { id: 'g1', roles: { cache: new Map() }, channels: { cache: new Map() } };
  const plain = (await compileScript('Noted {user}', { db, guild: cg, writer: { id: 'w' }, matchMode: 'startswith' })).compiled;
  const throwing = () => { throw new Error('rng used'); };
  const noGuild = { members: { fetch: async () => { throw new Error('guild used'); } } };
  const p = await prepareRun({ compiled: plain, rule: { trigger: '!ask', matchMode: 'startswith' }, text: '!ask a b', guild: noGuild, rng: throwing });
  assert.deepEqual(p.words.list, []);
  assert.equal(p.words.rest(1), '');
});

test('the edit that adds the buttons and the re-render of disabled buttons both pass allowedMentions parse []', async () => {
  await createButton(db, baseButton);
  const rule = await sendRule();
  const w = sendWorld();
  await executePlan({ db }, { rule, message: w.message, member: w.member, lang: 'en', vars: {}, plan: sendPlan({ buttons: [{ kind: 'stored', name: 'rules' }] }) }, {});
  assert.deepEqual(w.log.edits[0].p.allowedMentions, { parse: [] });
  await resetDb(db);
  await setFeature(db, 'g1', 'autoresponder', { enabled: true });
  await seed({ buttons: [{ limitations: 'limited' }] });
  const p = pressWorld();
  await p.interact(id(0));
  assert.equal(p.calls.edits.length, 1);
  assert.deepEqual(p.calls.edits[0].allowedMentions, { parse: [] });
});
