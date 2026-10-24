import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { executePlan, scheduleDelete, sendGateNotice, RUN_ERROR_CODES } from '../../src/features/autoresponder/execute.js';
import { createThrottle } from '../../src/features/autoresponder/throttle.js';
import { logAutoresponder, logRunError } from '../../src/features/autoresponder/log.js';

const flags = (over = {}) => ({ silent: false, dm: false, delete: false, embed: null, sendTo: null, deleteReplyAfter: null, ...over });
const plan = (over = {}) => ({ status: 'run', cooldown: null, text: 'hello', flags: flags(), actions: [], ...over });

function setup({ roles = {}, memberRoles = [], manageable = true, botCan = () => true, dangerous = () => false, dmError = null, sendToChannel, embeds = {}, buildError = false } = {}) {
  const calls = [];
  const sent = { react: [] };
  const roleCache = new Map(Object.entries(roles).map(([id, r]) => [id, { id, ...r }]));
  const memberRoleCache = new Map(memberRoles.map((id) => [id, { id }]));
  const channel = {
    id: 'c1',
    send: async (p) => { calls.push('send'); sent.channel = p; return { id: 'm-sent', react: async (e) => { calls.push('reactreply'); sent.react.push(e); }, delete: async () => {} }; },
  };
  const member = {
    id: 'u1',
    manageable,
    roles: {
      cache: memberRoleCache,
      add: async (...a) => { calls.push('role'); sent.add = a; },
      remove: async (...a) => { calls.push('role'); sent.remove = a; },
    },
    setNickname: async (n) => { calls.push('nick'); sent.nick = n; },
    send: async (p) => {
      if (dmError) throw Object.assign(new Error('closed'), { code: dmError });
      calls.push('dm'); sent.dm = p;
      return { id: 'm-dm', react: async (e) => { calls.push('reactreply'); sent.react.push(e); } };
    },
  };
  const message = {
    id: 'm1',
    channel,
    guild: { id: 'g1', roles: { cache: roleCache }, channels: { cache: new Map(sendToChannel ? [[sendToChannel.id, sendToChannel.channel]] : []) } },
    delete: async () => { calls.push('delete'); },
    react: async (e) => { calls.push('react'); sent.triggerReact = e; },
    reply: async (p) => {
      calls.push('reply'); sent.reply = p;
      return { id: 'm-reply', react: async (e) => { calls.push('reactreply'); sent.react.push(e); }, delete: async () => {} };
    },
  };
  const deps = {
    botCanGive: botCan,
    isDangerousRole: dangerous,
    getEmbed: async (_db, _g, name) => embeds[name] ?? null,
    buildEmbedPayload: async (_c, _g, spec) => { if (buildError) throw new Error('bad'); return { embeds: [{ title: spec.title }] }; },
    trySend: async (ch, p) => { try { return await ch.send(p); } catch { return null; } },
    setTimeout: (fn, ms) => { calls.push(`timer:${ms}`); sent.timerFn = fn; return { unref() {} }; },
  };
  const run = (p, extra = {}) => executePlan({ db: {} }, { rule: { id: 'r1' }, message, member, plan: p, lang: 'en', vars: { user: 'Bob' }, ...extra }, deps);
  return { calls, sent, run, message, member, deps };
}

test('actions run in the fixed order', async () => {
  const s = setup({ roles: { r1: {} } });
  const res = await s.run(plan({
    flags: flags({ delete: true, deleteReplyAfter: 5 }),
    actions: [
      { fn: 'reactreply', emoji: 'b' }, { fn: 'react', emoji: 'a' }, { fn: 'setnick', text: 'Nick' }, { fn: 'addrole', roleId: 'r1', raw: 'r1' },
    ],
  }));
  assert.deepEqual(res.errors, []);
  assert.deepEqual(s.calls, ['delete', 'role', 'nick', 'send', 'reactreply', 'timer:5000']);
});

test('react on the trigger runs before the message is sent', async () => {
  const s = setup();
  await s.run(plan({ actions: [{ fn: 'react', emoji: 'a' }] }));
  assert.deepEqual(s.calls, ['react', 'reply']);
});

test('addrole uses roles.add with a single id', async () => {
  const s = setup({ roles: { r1: {} } });
  await s.run(plan({ actions: [{ fn: 'addrole', roleId: 'r1', raw: 'r1' }] }));
  assert.equal(s.sent.add[0], 'r1');
  assert.equal(typeof s.sent.add[0], 'string');
});

test('role deleted since save -> ROLE_MISSING and other actions still run', async () => {
  const s = setup();
  const res = await s.run(plan({ actions: [{ fn: 'addrole', roleId: 'gone', raw: 'x' }, { fn: 'react', emoji: 'a' }] }));
  assert.equal(res.errors[0].code, 'ROLE_MISSING');
  assert.ok(s.calls.includes('react'));
  assert.ok(s.calls.includes('reply'));
  assert.ok(!s.calls.includes('role'));
});

test('dangerous role -> ROLE_UNSAFE and no add', async () => {
  const s = setup({ roles: { r1: {} }, dangerous: () => true });
  const res = await s.run(plan({ actions: [{ fn: 'addrole', roleId: 'r1', raw: 'r1' }] }));
  assert.equal(res.errors[0].code, 'ROLE_UNSAFE');
  assert.ok(!s.calls.includes('role'));
});

test('role the bot cannot give -> ROLE_UNSAFE', async () => {
  const s = setup({ roles: { r1: {} }, botCan: () => false });
  const res = await s.run(plan({ actions: [{ fn: 'addrole', roleId: 'r1', raw: 'r1' }] }));
  assert.equal(res.errors[0].code, 'ROLE_UNSAFE');
  assert.ok(!s.calls.includes('role'));
});

test('a role add the API refuses -> ROLE_FAILED with the error code, other actions still run', async () => {
  const s = setup({ roles: { r1: {} } });
  s.member.roles.add = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
  const res = await s.run(plan({ actions: [{ fn: 'addrole', roleId: 'r1', raw: 'r1' }, { fn: 'react', emoji: 'a' }] }));
  assert.deepEqual(res.errors, [{ code: 'ROLE_FAILED', action: 'addrole', detail: 'r1 (50013)' }]);
  assert.ok(s.calls.includes('react'));
  assert.ok(s.calls.includes('reply'));
});

test('a role remove the API refuses -> ROLE_FAILED, not ROLE_UNSAFE', async () => {
  const s = setup({ roles: { r1: {} }, memberRoles: ['r1'] });
  s.member.roles.remove = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
  const res = await s.run(plan({ actions: [{ fn: 'removerole', roleId: 'r1', raw: 'r1' }] }));
  assert.deepEqual(res.errors, [{ code: 'ROLE_FAILED', action: 'removerole', detail: 'r1 (50013)' }]);
  assert.ok(RUN_ERROR_CODES.includes('ROLE_FAILED'));
});

test('removerole of a role the member lacks is not an error', async () => {
  const s = setup({ roles: { r1: {} }, memberRoles: [] });
  const res = await s.run(plan({ actions: [{ fn: 'removerole', roleId: 'r1', raw: 'r1' }] }));
  assert.deepEqual(res.errors, []);
});

test('removerole removes a held role with a single id', async () => {
  const s = setup({ roles: { r1: {} }, memberRoles: ['r1'] });
  const res = await s.run(plan({ actions: [{ fn: 'removerole', roleId: 'r1', raw: 'r1' }] }));
  assert.deepEqual(res.errors, []);
  assert.equal(s.sent.remove[0], 'r1');
});

test('setnick renders placeholders', async () => {
  const s = setup();
  await s.run(plan({ actions: [{ fn: 'setnick', text: 'Hi {user}' }] }));
  assert.equal(s.sent.nick, 'Hi Bob');
});

test('setnick on an unmanageable member -> CANNOT_MANAGE_NICK', async () => {
  const s = setup({ manageable: false });
  const res = await s.run(plan({ actions: [{ fn: 'setnick', text: 'x' }] }));
  assert.equal(res.errors[0].code, 'CANNOT_MANAGE_NICK');
  assert.ok(!s.calls.includes('nick'));
});

test('rendered nickname over 32 characters -> NICK_TOO_LONG, not truncated', async () => {
  const s = setup();
  const res = await s.run(plan({ actions: [{ fn: 'setnick', text: '{user}' }] }), { vars: { user: 'x'.repeat(40) } });
  assert.equal(res.errors[0].code, 'NICK_TOO_LONG');
  assert.ok(!s.calls.includes('nick'));
});

test('DM closed -> CANNOT_DM and the other steps still happened', async () => {
  const s = setup({ roles: { r1: {} }, dmError: 50007 });
  const res = await s.run(plan({ flags: flags({ dm: true }), actions: [{ fn: 'addrole', roleId: 'r1', raw: 'r1' }, { fn: 'react', emoji: 'a' }] }));
  assert.equal(res.errors.length, 1);
  assert.equal(res.errors[0].code, 'CANNOT_DM');
  assert.ok(s.calls.includes('role'));
  assert.ok(s.calls.includes('react'));
});

test('DM goes to the member', async () => {
  const s = setup();
  await s.run(plan({ flags: flags({ dm: true }) }));
  assert.equal(s.sent.dm.content, 'hello');
  assert.ok(!s.calls.includes('reply'));
});

test('sendto channel the bot cannot send in -> CANNOT_SEND', async () => {
  const channel = { id: 'c2', isTextBased: () => true, permissionsFor: () => ({ has: () => false }), send: async () => { throw new Error('no'); } };
  const s = setup({ sendToChannel: { id: 'c2', channel } });
  const res = await s.run(plan({ flags: flags({ sendTo: 'c2' }) }));
  assert.equal(res.errors[0].code, 'CANNOT_SEND');
});

test('sendto an unknown channel -> CANNOT_SEND', async () => {
  const s = setup();
  const res = await s.run(plan({ flags: flags({ sendTo: 'nope' }) }));
  assert.equal(res.errors[0].code, 'CANNOT_SEND');
});

test('sendto a sendable channel sends there', async () => {
  const sentTo = [];
  const channel = { id: 'c2', isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: async (p) => { sentTo.push(p); return { id: 'x', react: async () => {} }; } };
  const s = setup({ sendToChannel: { id: 'c2', channel } });
  const res = await s.run(plan({ flags: flags({ sendTo: 'c2' }) }));
  assert.deepEqual(res.errors, []);
  assert.equal(sentTo[0].content, 'hello');
  assert.ok(!s.calls.includes('reply'));
});

test('in-place reply does not ping the replied user', async () => {
  const s = setup();
  await s.run(plan());
  assert.equal(s.sent.reply.failIfNotExists, false);
  assert.equal(s.sent.reply.allowedMentions.repliedUser, false);
  assert.deepEqual(s.sent.reply.allowedMentions.parse, []);
});

test('falls back to a channel send when {delete} removed the trigger', async () => {
  const s = setup();
  await s.run(plan({ flags: flags({ delete: true }) }));
  assert.ok(s.calls.includes('send'));
  assert.ok(!s.calls.includes('reply'));
});

test('everyone, here and role mentions are never allowed; only the allowed users of the plan are', async () => {
  const s = setup();
  // <@789> came from a member-controlled placeholder: it is in the text but not in allowedUsers.
  await s.run(plan({ text: '@everyone @here <@&555> <@123> <@!456> <@789>', allowedUsers: ['123', '456'] }));
  const am = s.sent.reply.allowedMentions;
  assert.deepEqual(am.parse, []);
  assert.deepEqual(am.users, ['123', '456']);
  assert.equal(am.roles, undefined);
  assert.equal(am.everyone, undefined);
  assert.equal(am.repliedUser, false);
});

test('a mention found only in the rendered text pings nobody', async () => {
  const sentTo = [];
  const channel = { id: 'c2', isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: async (p) => { sentTo.push(p); return { id: 'x', react: async () => {} }; } };
  const s = setup({ sendToChannel: { id: 'c2', channel } });
  await s.run(plan({ text: '<@123> look', allowedUsers: [], flags: flags({ sendTo: 'c2' }) }));
  assert.deepEqual(sentTo[0].allowedMentions, { parse: [], users: [], repliedUser: false });
});

test('rendered text over 2000 characters -> RENDERED_TOO_LONG and nothing sent', async () => {
  const s = setup();
  const res = await s.run(plan({ text: 'x'.repeat(2001), actions: [{ fn: 'reactreply', emoji: 'a' }] }));
  assert.equal(res.errors[0].code, 'RENDERED_TOO_LONG');
  assert.ok(!s.calls.includes('reply') && !s.calls.includes('send') && !s.calls.includes('reactreply'));
});

test('named embed missing at run time -> EMBED_FAILED while the text still sends', async () => {
  const s = setup();
  const res = await s.run(plan({ flags: flags({ embed: { kind: 'named', name: 'gone' } }) }));
  assert.equal(res.errors[0].code, 'EMBED_FAILED');
  assert.equal(s.sent.reply.content, 'hello');
});

test('named embed that fails to build -> EMBED_FAILED while the text still sends', async () => {
  const s = setup({ embeds: { e: { title: 'T' } }, buildError: true });
  const res = await s.run(plan({ flags: flags({ embed: { kind: 'named', name: 'e' } }) }));
  assert.equal(res.errors[0].code, 'EMBED_FAILED');
  assert.equal(s.sent.reply.content, 'hello');
});

test('named embed is sent with the text', async () => {
  const s = setup({ embeds: { e: { title: 'T' } } });
  const res = await s.run(plan({ flags: flags({ embed: { kind: 'named', name: 'e' } }) }));
  assert.deepEqual(res.errors, []);
  assert.equal(s.sent.reply.embeds[0].title, 'T');
  assert.equal(s.sent.reply.content, 'hello');
});

test('plain embed puts the text in the description with its color', async () => {
  const s = setup();
  await s.run(plan({ flags: flags({ embed: { kind: 'plain', color: 255 } }) }));
  assert.equal(s.sent.reply.embeds[0].description, 'hello');
  assert.equal(s.sent.reply.embeds[0].color, 255);
  assert.equal(s.sent.reply.content, undefined);
});

test('delete_reply schedules a delete with the injected timer', async () => {
  const s = setup();
  await s.run(plan({ flags: flags({ deleteReplyAfter: 7 }) }));
  assert.ok(s.calls.includes('timer:7000'));
});

test('scheduleDelete deletes best effort and unrefs the timer', async () => {
  let unrefed = false;
  let fn;
  let deleted = 0;
  scheduleDelete({ delete: async () => { deleted++; throw new Error('gone'); } }, 3, {
    setTimeout: (f, ms) => { fn = f; assert.equal(ms, 3000); return { unref() { unrefed = true; } }; },
  });
  await fn();
  assert.equal(deleted, 1);
  assert.ok(unrefed);
});

test('sendGateNotice replies without pings and deletes after 8 seconds', async () => {
  const s = setup();
  await sendGateNotice({}, s.message, 'en', { kind: 'cooldown', seconds: 30 }, { setTimeout: s.deps.setTimeout });
  assert.match(s.sent.reply.content, /30/);
  assert.deepEqual(s.sent.reply.allowedMentions, { parse: [], repliedUser: false });
  assert.equal(s.sent.reply.failIfNotExists, false);
  assert.ok(s.calls.includes('timer:8000'));
});

test('sendGateNotice never throws', async () => {
  await sendGateNotice({}, { reply: async () => { throw new Error('x'); } }, 'en', { kind: 'role' });
});

test('every run error code has a translation in all languages', () => {
  for (const lang of ['en', 'fr', 'ar']) {
    const j = JSON.parse(readFileSync(new URL(`../../src/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const code of RUN_ERROR_CODES) assert.ok(j[`autoresponder.run.${code}`], `${lang} ${code}`);
    for (const k of ['notice.cooldown', 'notice.role', 'log.title', 'log.moderator', 'log.rule', 'log.error']) {
      assert.ok(j[`autoresponder.${k}`], `${lang} ${k}`);
    }
  }
});

test('createThrottle allows once per window and again after it', () => {
  let t = 1000;
  const th = createThrottle(100, () => t);
  assert.equal(th.allow('a'), true);
  assert.equal(th.allow('a'), false);
  assert.equal(th.allow('b'), true);
  t += 100;
  assert.equal(th.allow('a'), true);
});

test('createThrottle is bounded to 5000 keys, oldest evicted', () => {
  const th = createThrottle(1e9, () => 1);
  for (let i = 0; i < 5001; i++) th.allow(`k${i}`);
  assert.equal(th.allow('k0'), true); // evicted
  assert.equal(th.allow('k5000'), false); // still held
});

test('logRunError writes one line per rule per window', async () => {
  const lines = [];
  const deps = { throttle: createThrottle(3600000, () => 5), sendLog: async (...a) => { lines.push(a); } };
  const errors = [{ code: 'ROLE_MISSING', action: 'addrole' }];
  await logRunError({}, { id: 'g1' }, 'en', { ruleId: 1, errors }, deps);
  await logRunError({}, { id: 'g1' }, 'en', { ruleId: 1, errors }, deps);
  assert.equal(lines.length, 1);
  await logRunError({}, { id: 'g1' }, 'en', { ruleId: 2, errors }, deps);
  assert.equal(lines.length, 2);
  assert.equal(lines[0][2], 'modAction');
});

test('logAutoresponder writes a line and never throws', async () => {
  const lines = [];
  await logAutoresponder({}, { id: 'g1' }, 'en', { action: 'add', actorId: '9', ruleId: 3 }, { sendLog: async (...a) => { lines.push(a); } });
  assert.equal(lines.length, 1);
  await logAutoresponder({}, { id: 'g1' }, 'en', { action: 'add', actorId: '9', ruleId: 3 }, { sendLog: async () => { throw new Error('boom'); } });
});
