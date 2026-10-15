import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { warningCommands } from '../../src/features/moderation/commands-warnings.js';
import { createCase, getCase, setCaseLog, listWarnings } from '../../src/features/moderation/store.js';
import { setFeature } from '../../src/db/settings.js';
import { t } from '../../src/i18n/index.js';
import { testDb } from '../helpers/db.js';

const byName = (n) => warningCommands.find((c) => c.data.name === n);

// ---- structure ----

test('the module exposes /warnings and /reason', () => {
  assert.deepEqual(warningCommands.map((c) => c.data.name), ['warnings', 'reason']);
});

test('/warnings subcommands and option order', () => {
  const subs = byName('warnings').data.toJSON().options;
  assert.deepEqual(subs.map((s) => s.name), ['list', 'edit', 'delete', 'clear', 'top']);
  const shape = (n) => subs.find((s) => s.name === n).options?.map((o) => [o.name, !!o.required]) ?? [];
  assert.deepEqual(shape('list'), [['user', false]]);
  assert.deepEqual(shape('edit'), [['id', true], ['reason', true]]);
  assert.deepEqual(shape('delete'), [['id', true]]);
  assert.deepEqual(shape('clear'), [['user', true]]);
  assert.deepEqual(shape('top'), []);
});

test('/reason options', () => {
  const opts = byName('reason').data.toJSON().options;
  assert.deepEqual(opts.map((o) => [o.name, !!o.required]), [['case', true], ['reason', true]]);
  assert.equal(opts[1].max_length, 400);
});

test('descriptions are 1-100 chars, required first, no default permissions', () => {
  const checkOpts = (label, options) => {
    let optional = false;
    for (const o of options ?? []) {
      assert.ok(o.description.length >= 1 && o.description.length <= 100, `${label} ${o.name}`);
      if (o.type === 1) checkOpts(`${label} ${o.name}`, o.options);
      else {
        assert.ok(!(optional && o.required), `${label} ${o.name} order`);
        if (!o.required) optional = true;
      }
    }
  };
  for (const c of warningCommands) {
    const j = c.data.toJSON();
    assert.equal(j.default_member_permissions ?? null, null);
    assert.ok(j.description.length >= 1 && j.description.length <= 100);
    checkOpts(j.name, j.options);
  }
});

// ---- execute ----

let db;
before(async () => { db = await testDb(); });
beforeEach(async () => {
  await db.query('TRUNCATE guild_settings, scheduled_jobs, mod_cases, mod_counters');
  await setFeature(db, 'g1', 'moderation', { enabled: true, config: {} });
});
after(async () => { await db.end(); });

function fake({ sub, opts = {}, perms = ['ModerateMembers'], callerId = 'mod', roles = [], channels } = {}) {
  const calls = { replies: [] };
  const values = { user: null, id: null, case: null, reason: null, ...opts };
  const interaction = {
    guildId: 'g1', guild: { id: 'g1' },
    member: {
      id: callerId,
      permissions: { has: (p) => perms.includes(p) },
      roles: { cache: { has: (r) => roles.includes(r) } },
    },
    user: { id: callerId },
    inGuild: () => true,
    options: {
      getSubcommand: () => sub,
      getUser: (n) => (values[n] ? { id: values[n] } : null),
      getString: (n) => values[n] ?? null,
      getInteger: (n) => values[n] ?? null,
    },
    deferReply: async () => {},
    reply: async (p) => { calls.replies.push(p); },
    editReply: async (p) => { calls.replies.push(p); },
  };
  const ctx = { db, client: { channels: { fetch: channels ?? (async () => null) } } };
  return { interaction, ctx, calls };
}
const run = (name, f) => byName(name).execute(f.interaction, f.ctx);
const last = (f) => f.calls.replies.at(-1).content;
const isEphemeral = (f) => f.calls.replies.every((r) => r.flags !== undefined);
const warn = (targetId, reason = 'r') =>
  createCase(db, { guildId: 'g1', type: 'warn', targetId, moderatorId: 'mod', reason });

test('a member lists their own warnings', async () => {
  await warn('u1', 'spam');
  const f = fake({ sub: 'list', perms: [], callerId: 'u1' });
  await run('warnings', f);
  assert.ok(last(f).includes('spam'));
  assert.ok(last(f).includes('#1'));
  assert.ok(isEphemeral(f));
});

test('listing your own id explicitly also works, another user is refused', async () => {
  await warn('u1', 'spam');
  const own = fake({ sub: 'list', opts: { user: 'u1' }, perms: [], callerId: 'u1' });
  await run('warnings', own);
  assert.ok(last(own).includes('spam'));
  const other = fake({ sub: 'list', opts: { user: 'u1' }, perms: [], callerId: 'u2' });
  await run('warnings', other);
  assert.equal(last(other), t('en', 'moderation.err.not_allowed'));
});

test('a moderator lists another user and an empty list says so', async () => {
  await warn('u1', 'spam');
  const f = fake({ sub: 'list', opts: { user: 'u1' } });
  await run('warnings', f);
  assert.ok(last(f).includes('spam'));
  const g = fake({ sub: 'list', opts: { user: 'nobody' } });
  await run('warnings', g);
  assert.equal(last(g), t('en', 'moderation.warnings.none', { user: 'nobody' }));
});

test('the list is capped at 25 lines with a tail', async () => {
  for (let i = 0; i < 27; i++) await warn('u1', `reason${String(i).padStart(2, '0')}`);
  const f = fake({ sub: 'list', opts: { user: 'u1' } });
  await run('warnings', f);
  assert.ok(last(f).includes(t('en', 'moderation.warnings.more', { count: 2 })));
  assert.ok(last(f).includes('reason24'));
  assert.ok(!last(f).includes('reason25'));
});

test('edit, delete, clear and top need permission', async () => {
  await warn('u1');
  for (const [sub, opts] of [['edit', { id: 1, reason: 'x' }], ['delete', { id: 1 }], ['clear', { user: 'u1' }], ['top', {}]]) {
    const f = fake({ sub, opts, perms: [] });
    await run('warnings', f);
    assert.equal(last(f), t('en', 'moderation.err.not_allowed'), sub);
  }
  assert.equal((await listWarnings(db, 'g1', 'u1')).length, 1);
});

test('edit changes the reason without creating a case; unknown id is refused', async () => {
  await warn('u1', 'old');
  const f = fake({ sub: 'edit', opts: { id: 1, reason: 'new' } });
  await run('warnings', f);
  assert.equal((await getCase(db, 'g1', 1)).reason, 'new');
  assert.equal(await getCase(db, 'g1', 2), null);
  assert.ok(isEphemeral(f));
  const g = fake({ sub: 'edit', opts: { id: 9, reason: 'new' } });
  await run('warnings', g);
  assert.equal(last(g), t('en', 'moderation.err.no_such_warning'));
});

test('delete deactivates; deleting twice replies no-such-warning', async () => {
  await warn('u1');
  const f = fake({ sub: 'delete', opts: { id: 1 } });
  await run('warnings', f);
  assert.equal((await listWarnings(db, 'g1', 'u1')).length, 0);
  assert.equal(last(f), t('en', 'moderation.warnings.deleted', { number: 1 }));
  const g = fake({ sub: 'delete', opts: { id: 1 } });
  await run('warnings', g);
  assert.equal(last(g), t('en', 'moderation.err.no_such_warning'));
});

test('clear reports the count', async () => {
  await warn('u1'); await warn('u1'); await warn('u2');
  const f = fake({ sub: 'clear', opts: { user: 'u1' } });
  await run('warnings', f);
  assert.equal(last(f), t('en', 'moderation.warnings.cleared', { count: 2, user: 'u1' }));
  assert.equal((await listWarnings(db, 'g1', 'u2')).length, 1);
});

test('top lists counts, most first', async () => {
  await warn('u1'); await warn('u2'); await warn('u2');
  const f = fake({ sub: 'top' });
  await run('warnings', f);
  const text = last(f);
  assert.ok(text.indexOf('u2') < text.indexOf('u1'));
  await db.query('TRUNCATE mod_cases');
  const empty = fake({ sub: 'top' });
  await run('warnings', empty);
  assert.equal(last(empty), t('en', 'moderation.warnings.top_none'));
});

test('feature off gives the standard off message', async () => {
  await setFeature(db, 'g1', 'moderation', { enabled: false });
  const f = fake({ sub: 'top' });
  await run('warnings', f);
  assert.match(last(f), /This feature is off/);
  const g = fake({ opts: { case: 1, reason: 'x' } });
  await run('reason', g);
  assert.match(last(g), /This feature is off/);
});

// ---- /reason ----

test('/reason updates the case and edits the stored log message', async () => {
  await warn('u1', 'old');
  await setCaseLog(db, 'g1', 1, { channelId: 'c1', messageId: 'm1' });
  const edits = [];
  const channels = async (id) => ({
    messages: { fetch: async (mid) => ({ edit: async (p) => { edits.push([id, mid, p]); } }) },
  });
  const f = fake({ opts: { case: 1, reason: 'better' }, channels });
  await run('reason', f);
  assert.equal((await getCase(db, 'g1', 1)).reason, 'better');
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].slice(0, 2), ['c1', 'm1']);
  assert.equal(edits[0][2].embeds[0].fields.at(-1).value, 'better');
  assert.equal(last(f), t('en', 'moderation.reason.done', { number: 1 }));
  assert.ok(isEphemeral(f));
});

test('/reason still succeeds when the channel or message fetch throws', async () => {
  await warn('u1', 'old');
  await setCaseLog(db, 'g1', 1, { channelId: 'c1', messageId: 'm1' });
  const f = fake({ opts: { case: 1, reason: 'a' }, channels: async () => { throw new Error('gone'); } });
  await run('reason', f);
  assert.equal((await getCase(db, 'g1', 1)).reason, 'a');
  const channels = async () => ({ messages: { fetch: async () => { throw new Error('gone'); } } });
  const g = fake({ opts: { case: 1, reason: 'b' }, channels });
  await run('reason', g);
  assert.equal((await getCase(db, 'g1', 1)).reason, 'b');
  const h = fake({
    opts: { case: 1, reason: 'c' },
    channels: async () => ({ messages: { fetch: async () => ({ edit: async () => { throw new Error('x'); } }) } }),
  });
  await run('reason', h);
  assert.equal((await getCase(db, 'g1', 1)).reason, 'c');
});

test('/reason refuses an empty reason, an unknown case, and a member without permission', async () => {
  await warn('u1', 'old');
  const empty = fake({ opts: { case: 1, reason: '   ' } });
  await run('reason', empty);
  assert.equal(last(empty), t('en', 'moderation.err.reason_required'));
  assert.equal((await getCase(db, 'g1', 1)).reason, 'old');
  const unknown = fake({ opts: { case: 9, reason: 'x' } });
  await run('reason', unknown);
  assert.equal(last(unknown), t('en', 'moderation.err.no_such_case'));
  const denied = fake({ opts: { case: 1, reason: 'x' }, perms: [] });
  await run('reason', denied);
  assert.equal(last(denied), t('en', 'moderation.err.not_allowed'));
});
