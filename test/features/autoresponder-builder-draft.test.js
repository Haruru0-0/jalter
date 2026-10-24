import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newDraft, setTrigger, patch, addGate, removeGate, addAction, removeAction, toScriptMode,
} from '../../src/features/autoresponder/builder/draft.js';
import { generateScript } from '../../src/features/autoresponder/builder/generate.js';
import { parseScript } from '../../src/features/autoresponder/script/parse.js';

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); }
  return o;
};
const gen = (over) => generateScript({ ...newDraft(), text: 'hi', ...over });

test('newDraft defaults', () => {
  assert.deepEqual(newDraft(), {
    trigger: '', matchMode: 'exact', text: '', dest: 'reply', channelId: null, embed: null,
    deleteTrigger: false, deleteReplyAfter: null, silent: false, gates: [], actions: [], random: { ranges: [], choosers: [], locked: [] }, argChecks: [], mode: 'guided', scriptText: null,
  });
  assert.equal(newDraft('contains').matchMode, 'contains');
});

test('ops return new drafts and leave the input unchanged', () => {
  const d = deepFreeze(newDraft());
  const outs = [
    setTrigger(d, 'x', 'contains'), patch(d, { text: 'a' }), addGate(d, { fn: 'cooldown', seconds: 5 }),
    addAction(d, { fn: 'react', emoji: 'x' }), toScriptMode(d, 'hello'),
  ];
  for (const o of outs) assert.notEqual(o, d);
  assert.equal(outs[0].trigger, 'x');
  assert.equal(outs[0].matchMode, 'contains');
  assert.equal(setTrigger(d, 'y').matchMode, 'exact');
  assert.equal(outs[1].text, 'a');
  assert.equal(outs[4].mode, 'script');
  assert.equal(outs[4].scriptText, 'hello');
  const g = deepFreeze(addGate(d, { fn: 'denyperm', perms: ['Administrator'] }));
  assert.equal(removeGate(g, 0).gates.length, 0);
  assert.equal(g.gates.length, 1);
  const a = deepFreeze(addAction(d, { fn: 'react', emoji: 'x' }));
  assert.equal(removeAction(a, 0).actions.length, 0);
  assert.equal(a.actions.length, 1);
  assert.equal(d.gates.length, 0);
});

test('a second cooldown replaces the first', () => {
  let d = addGate(newDraft(), { fn: 'cooldown', seconds: 5 });
  d = addGate(d, { fn: 'denyperm', perms: ['Administrator'] });
  d = addGate(d, { fn: 'cooldown', seconds: 9 });
  assert.equal(d.gates.filter((g) => g.fn === 'cooldown').length, 1);
  assert.equal(d.gates.find((g) => g.fn === 'cooldown').seconds, 9);
  assert.equal(d.gates.length, 2);
});

test('text only', () => assert.equal(gen({}), 'hi'));
test('cooldown', () => assert.equal(gen({ gates: [{ fn: 'cooldown', seconds: 30 }] }), 'hi\n{cooldown:30}'));
test('requirerole with two ids', () =>
  assert.equal(gen({ gates: [{ fn: 'requirerole', ids: ['1', '2'] }] }), 'hi\n{requirerole:<@&1>|<@&2>}'));
test('denyperm', () =>
  assert.equal(gen({ gates: [{ fn: 'denyperm', perms: ['BanMembers', 'KickMembers'] }] }), 'hi\n{denyperm:BanMembers|KickMembers}'));
test('requireuser and channel gates', () => {
  assert.equal(gen({ gates: [{ fn: 'requireuser', ids: ['5'] }] }), 'hi\n{requireuser:<@5>}');
  assert.equal(gen({ gates: [{ fn: 'denychannel', ids: ['7', '8'] }] }), 'hi\n{denychannel:<#7>|<#8>}');
});
test('addrole and removerole', () =>
  assert.equal(gen({ actions: [{ fn: 'addrole', id: '3' }, { fn: 'removerole', id: '4' }] }), 'hi\n{addrole:<@&3>}\n{removerole:<@&4>}'));
test('setnick escapes', () => assert.equal(gen({ actions: [{ fn: 'setnick', text: 'a|b\\c' }] }), 'hi\n{setnick:a\\|b\\\\c}'));
test('react and reactreply', () =>
  assert.equal(gen({ actions: [{ fn: 'react', emoji: '👍' }, { fn: 'reactreply', emoji: 'a|b' }] }), 'hi\n{react:👍}\n{reactreply:a\\|b}'));
test('embed forms', () => {
  assert.equal(gen({ embed: { kind: 'plain', color: null } }), 'hi\n{embed}');
  assert.equal(gen({ embed: { kind: 'plain', color: '#aabbcc' } }), 'hi\n{embed:#aabbcc}');
  assert.equal(gen({ embed: { kind: 'named', name: 'welcome' } }), 'hi\n{embed:welcome}');
});
test('destinations', () => {
  assert.equal(gen({ dest: 'dm' }), 'hi\n{dm}');
  assert.equal(gen({ dest: 'channel', channelId: '9' }), 'hi\n{sendto:<#9>}');
  assert.equal(gen({ dest: 'reply' }), 'hi');
});
test('flags', () => {
  assert.equal(gen({ deleteTrigger: true }), 'hi\n{delete}');
  assert.equal(gen({ deleteReplyAfter: 10 }), 'hi\n{delete_reply:10}');
  assert.equal(gen({ silent: true }), 'hi\n{silent}');
});
test('documented order', () => {
  const s = gen({
    gates: [{ fn: 'cooldown', seconds: 3 }, { fn: 'requireuser', ids: ['1'] }],
    actions: [{ fn: 'react', emoji: 'x' }, { fn: 'addrole', id: '2' }],
    embed: { kind: 'plain', color: null }, dest: 'dm', deleteTrigger: true, deleteReplyAfter: 4, silent: true,
  });
  assert.equal(s, 'hi\n{cooldown:3}\n{requireuser:<@1>}\n{react:x}\n{addrole:<@&2>}\n{embed}\n{dm}\n{delete}\n{delete_reply:4}\n{silent}');
});
test('script mode returns scriptText untouched', () => {
  const d = toScriptMode({ ...newDraft(), text: 'ignored' }, '  raw {x}\n');
  assert.equal(generateScript(d), '  raw {x}\n');
});
test('round trip through parseScript', () => {
  const d = {
    ...newDraft(), text: 'hello',
    gates: [
      { fn: 'cooldown', seconds: 30 }, { fn: 'requirerole', ids: ['1', '2'] }, { fn: 'denyrole', ids: ['3'] },
      { fn: 'requireperm', perms: ['ManageMessages'] }, { fn: 'denyperm', perms: ['Administrator'] },
      { fn: 'requirechannel', ids: ['4'] }, { fn: 'denychannel', ids: ['5'] }, { fn: 'requireuser', ids: ['6'] },
    ],
    actions: [
      { fn: 'addrole', id: '7' }, { fn: 'removerole', id: '8' }, { fn: 'setnick', text: 'a|b' },
      { fn: 'react', emoji: 'x' }, { fn: 'reactreply', emoji: 'y' },
    ],
    embed: { kind: 'named', name: 'e' }, dest: 'channel', channelId: '9', deleteTrigger: true, deleteReplyAfter: 5, silent: true,
  };
  const r = parseScript(generateScript(d));
  assert.equal(r.ok, true);
  assert.deepEqual(r.nodes.filter((n) => n.t === 'call').map((n) => n.name), [
    'cooldown', 'requirerole', 'denyrole', 'requireperm', 'denyperm', 'requirechannel', 'denychannel', 'requireuser',
    'addrole', 'removerole', 'setnick', 'react', 'reactreply', 'embed', 'sendto', 'delete', 'delete_reply', 'silent',
  ]);
  assert.deepEqual(r.nodes.find((n) => n.name === 'setnick').args, ['a|b']);
});
test('reply text is verbatim', () => {
  const text = 'hi {user} [x] \\ back\nline two';
  assert.equal(gen({ text }), text);
  assert.equal(gen({ text, silent: true }), `${text}\n{silent}`);
});
