import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, readConfig, addToList, removeFromList, setSteps } from '../../src/features/automod/config.js';

test('defaults for empty and garbage input', () => {
  const base = readConfig({});
  for (const raw of [undefined, null, 'x', 5, [], true]) assert.deepEqual(readConfig(raw), base);
  assert.deepEqual(RULES, ['spam', 'invites', 'links', 'words']);
  assert.deepEqual(base.exemptRoles, []);
  assert.deepEqual(base.exemptChannels, []);
  assert.deepEqual(base.nickname, { enabled: false });
  for (const r of RULES) {
    assert.equal(base.rules[r].enabled, false);
    assert.equal(base.rules[r].delete, true);
    assert.equal(base.rules[r].windowSeconds, 600);
    assert.deepEqual(
      base.rules[r].steps,
      r === 'spam'
        ? [{ strikes: 3, action: 'warn', timeoutSeconds: null }, { strikes: 5, action: 'timeout', timeoutSeconds: 600 }]
        : [{ strikes: 3, action: 'warn', timeoutSeconds: null }],
    );
  }
  assert.deepEqual(base.rules.spam.burst, { enabled: true, messages: 5, seconds: 5 });
  assert.deepEqual(base.rules.spam.identical, { enabled: true, count: 4, seconds: 60 });
  assert.deepEqual(base.rules.spam.caps, { enabled: true, minLength: 20, percent: 70 });
  assert.deepEqual(base.rules.spam.emoji, { enabled: true, max: 10 });
  assert.deepEqual(base.rules.spam.mentions, { enabled: true, max: 5 });
  assert.deepEqual(base.rules.spam.attachments, { enabled: true, count: 5, seconds: 30 });
  assert.deepEqual(base.rules.spam.linkRate, { enabled: true, count: 5, seconds: 30 });
  assert.deepEqual(base.rules.words, { ...base.rules.words, custom: [], removedBuiltin: [], useBuiltin: true });
  // garbage nested values do not throw
  assert.doesNotThrow(() => readConfig({ rules: 'x', nickname: 5 }));
  assert.doesNotThrow(() => readConfig({ rules: { spam: null, words: 'x', links: [] } }));
  assert.deepEqual(readConfig({ rules: { spam: 5 } }), base);
});

test('invalid numbers fall back', () => {
  const c = readConfig({
    rules: {
      spam: { windowSeconds: 9, burst: { messages: 'x', seconds: -1 }, caps: { percent: 9 }, emoji: { max: 1.5 } },
      links: { windowSeconds: 86401 },
      words: { windowSeconds: NaN },
    },
  });
  assert.equal(c.rules.spam.windowSeconds, 600);
  assert.equal(c.rules.links.windowSeconds, 600);
  assert.equal(c.rules.words.windowSeconds, 600);
  assert.equal(c.rules.spam.burst.messages, 5);
  assert.equal(c.rules.spam.burst.seconds, 5);
  assert.equal(c.rules.spam.caps.percent, 70);
  assert.equal(c.rules.spam.emoji.max, 10);
  const ok = readConfig({ rules: { spam: { enabled: true, delete: false, windowSeconds: 10, caps: { percent: 100 } }, links: { windowSeconds: 86400 } } });
  assert.equal(ok.rules.spam.enabled, true);
  assert.equal(ok.rules.spam.delete, false);
  assert.equal(ok.rules.spam.windowSeconds, 10);
  assert.equal(ok.rules.spam.caps.percent, 100);
  assert.equal(ok.rules.links.windowSeconds, 86400);
  assert.equal(readConfig({ nickname: { enabled: true } }).nickname.enabled, true);
  assert.equal(readConfig({ nickname: { enabled: 'yes' } }).nickname.enabled, false);
});

test('lists are deduped and capped', () => {
  const roles = Array.from({ length: 15 }, (_, i) => `r${i}`);
  assert.deepEqual(readConfig({ exemptRoles: roles }).exemptRoles, roles.slice(0, 10));
  const chans = Array.from({ length: 30 }, (_, i) => `c${i}`);
  assert.deepEqual(readConfig({ exemptChannels: chans }).exemptChannels, chans.slice(0, 20));
  assert.deepEqual(readConfig({ exemptRoles: ['a', 'a', 5, '', 'b'] }).exemptRoles, ['a', 'b']);
  assert.deepEqual(readConfig({ exemptRoles: 'x' }).exemptRoles, []);
  const many = Array.from({ length: 150 }, (_, i) => `w${i}`);
  const c = readConfig({ rules: { words: { custom: many, removedBuiltin: ['x', 'x'] }, invites: { allow: many, block: ['a', 'a'] } } });
  assert.equal(c.rules.words.custom.length, 100);
  assert.deepEqual(c.rules.words.removedBuiltin, ['x']);
  assert.equal(c.rules.invites.allow.length, 100);
  assert.deepEqual(c.rules.invites.block, ['a']);
});

test('steps are sorted and validated', () => {
  const c = readConfig({
    rules: {
      spam: {
        steps: [
          { strikes: 5, action: 'timeout', timeoutSeconds: 3600 },
          { strikes: 2, action: 'warn' },
          { strikes: 2, action: 'timeout', timeoutSeconds: 60 },
          { strikes: 0, action: 'warn' },
          { strikes: 51, action: 'warn' },
          { strikes: 7, action: 'ban' },
          { strikes: 9, action: 'timeout' },
          { strikes: 11, action: 'timeout', timeoutSeconds: 10 },
          'junk',
        ],
      },
      links: { steps: [] },
      words: { steps: 'x' },
    },
  });
  assert.deepEqual(c.rules.spam.steps, [
    { strikes: 2, action: 'warn', timeoutSeconds: null },
    { strikes: 5, action: 'timeout', timeoutSeconds: 3600 },
    { strikes: 9, action: 'timeout', timeoutSeconds: 600 },
  ]);
  assert.deepEqual(c.rules.links.steps, [{ strikes: 3, action: 'warn', timeoutSeconds: null }]);
  assert.deepEqual(c.rules.words.steps, [{ strikes: 3, action: 'warn', timeoutSeconds: null }]);
  // warn steps never carry a timeout
  const w = readConfig({ rules: { spam: { steps: [{ strikes: 1, action: 'warn', timeoutSeconds: 300 }] } } });
  assert.equal(w.rules.spam.steps[0].timeoutSeconds, null);
});

test('invites default to blockAllExceptAllowed true and links to false', () => {
  const c = readConfig({});
  assert.equal(c.rules.invites.blockAllExceptAllowed, true);
  assert.equal(c.rules.links.blockAllExceptAllowed, false);
  assert.deepEqual(c.rules.invites.allow, []);
  assert.deepEqual(c.rules.links.block, []);
  const d = readConfig({ rules: { invites: { blockAllExceptAllowed: false }, links: { blockAllExceptAllowed: true } } });
  assert.equal(d.rules.invites.blockAllExceptAllowed, false);
  assert.equal(d.rules.links.blockAllExceptAllowed, true);
  assert.equal(readConfig({ rules: { invites: { blockAllExceptAllowed: 'no' } } }).rules.invites.blockAllExceptAllowed, true);
  assert.equal(readConfig({ rules: { words: { useBuiltin: false } } }).rules.words.useBuiltin, false);
});

test('addToList rejects duplicates and full lists', () => {
  const input = {};
  const r = addToList(input, 'exemptRoles', 'a');
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.exemptRoles, ['a']);
  assert.deepEqual(input, {});
  assert.deepEqual(addToList(r.config, 'exemptRoles', 'a'), { ok: false, reason: 'exists' });
  const full = Array.from({ length: 10 }, (_, i) => `r${i}`);
  assert.deepEqual(addToList({ exemptRoles: full }, 'exemptRoles', 'x'), { ok: false, reason: 'full' });
  const fullCh = Array.from({ length: 20 }, (_, i) => `c${i}`);
  assert.deepEqual(addToList({ exemptChannels: fullCh }, 'exemptChannels', 'x'), { ok: false, reason: 'full' });
  assert.equal(addToList({ exemptChannels: fullCh.slice(1) }, 'exemptChannels', 'x').ok, true);
  const w = addToList({}, 'words.custom', 'foo');
  assert.deepEqual(w.config.rules.words.custom, ['foo']);
  assert.deepEqual(addToList(w.config, 'invites.allow', 'abc').config.rules.invites.allow, ['abc']);
  assert.deepEqual(addToList({}, 'links.block', 'x.com').config.rules.links.block, ['x.com']);
  assert.deepEqual(addToList({}, 'words.removedBuiltin', 'z').config.rules.words.removedBuiltin, ['z']);
  const hundred = Array.from({ length: 100 }, (_, i) => `w${i}`);
  assert.deepEqual(addToList({ rules: { words: { custom: hundred } } }, 'words.custom', 'n'), { ok: false, reason: 'full' });
  assert.deepEqual(addToList({}, 'nope', 'a'), { ok: false, reason: 'invalid' });
  assert.deepEqual(addToList({}, 'exemptRoles', ''), { ok: false, reason: 'invalid' });
  assert.deepEqual(addToList({}, 'exemptRoles', 5), { ok: false, reason: 'invalid' });
});

test('removeFromList', () => {
  const input = { exemptRoles: ['a', 'b'] };
  const r = removeFromList(input, 'exemptRoles', 'a');
  assert.deepEqual(r.config.exemptRoles, ['b']);
  assert.deepEqual(input.exemptRoles, ['a', 'b']);
  assert.deepEqual(removeFromList(input, 'exemptRoles', 'zzz'), { ok: false, reason: 'missing' });
  const w = removeFromList({ rules: { links: { allow: ['x'] } } }, 'links.allow', 'x');
  assert.deepEqual(w.config.rules.links.allow, []);
  assert.deepEqual(removeFromList({}, 'bad.path', 'x'), { ok: false, reason: 'invalid' });
});

test('setSteps rejects empty, duplicate or out-of-range steps', () => {
  const r = setSteps({}, 'spam', [
    { strikes: 5, action: 'timeout', timeoutSeconds: 120 },
    { strikes: 2, action: 'warn', timeoutSeconds: null },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.config.rules.spam.steps, [
    { strikes: 2, action: 'warn', timeoutSeconds: null },
    { strikes: 5, action: 'timeout', timeoutSeconds: 120 },
  ]);
  assert.equal(setSteps({}, 'words', [{ strikes: 1, action: 'timeout' }]).config.rules.words.steps[0].timeoutSeconds, 600);
  const bad = (steps, rule = 'spam') => assert.deepEqual(setSteps({}, rule, steps), { ok: false, reason: 'invalid' });
  bad([]);
  bad('x');
  bad(null);
  bad([{ strikes: 2, action: 'warn' }, { strikes: 2, action: 'timeout' }]);
  bad([{ strikes: 0, action: 'warn' }]);
  bad([{ strikes: 51, action: 'warn' }]);
  bad([{ strikes: 1.5, action: 'warn' }]);
  bad([{ strikes: 1, action: 'ban' }]);
  bad([{ strikes: 1, action: 'timeout', timeoutSeconds: 59 }]);
  bad([{ strikes: 1, action: 'timeout', timeoutSeconds: 2_419_201 }]);
  bad(Array.from({ length: 9 }, (_, i) => ({ strikes: i + 1, action: 'warn' })));
  bad([{ strikes: 1, action: 'warn' }], 'nope');
  assert.equal(setSteps({}, 'spam', Array.from({ length: 8 }, (_, i) => ({ strikes: i + 1, action: 'warn' }))).ok, true);
});
