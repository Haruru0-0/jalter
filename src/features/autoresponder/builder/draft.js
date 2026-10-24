// Builder draft: the guided form's state, edited through immutable operations.
// Draft = { trigger, matchMode, text, dest: 'reply'|'dm'|'channel', channelId, embed, deleteTrigger,
//   deleteReplyAfter, silent, gates: Gate[], actions: Action[], mode: 'guided'|'script', scriptText,
//   random: { ranges: [{min,max}], choosers: [{kind:'choose',options}|{kind:'weighted',weights}], locked: string[][] },
//   argChecks: [{ n, type|null }] }  (role actions may carry target: number|null)

export function newDraft(matchMode = 'exact') {
  return {
    trigger: '',
    matchMode,
    text: '',
    dest: 'reply',
    channelId: null,
    embed: null,
    deleteTrigger: false,
    deleteReplyAfter: null,
    silent: false,
    gates: [],
    actions: [],
    random: { ranges: [], choosers: [], locked: [] },
    argChecks: [],
    mode: 'guided',
    scriptText: null,
  };
}

export const setTrigger = (d, trigger, matchMode = d.matchMode) => ({ ...d, trigger, matchMode });

export const patch = (d, partial) => ({ ...d, ...partial });

// A rule has at most one cooldown, so a new one replaces the old.
export function addGate(d, gate) {
  const kept = gate.fn === 'cooldown' ? d.gates.filter((g) => g.fn !== 'cooldown') : d.gates;
  return { ...d, gates: [...kept, gate] };
}

export const removeGate = (d, index) => ({ ...d, gates: d.gates.filter((_, i) => i !== index) });

export const addAction = (d, action) => ({ ...d, actions: [...d.actions, action] });

export const removeAction = (d, index) => ({ ...d, actions: d.actions.filter((_, i) => i !== index) });

export const toScriptMode = (d, scriptText) => ({ ...d, mode: 'script', scriptText });

export const addArgCheck = (d, check) => ({ ...d, argChecks: [...d.argChecks, check] });

export const removeArgCheck = (d, index) => ({ ...d, argChecks: d.argChecks.filter((_, i) => i !== index) });

export const setArgType = (d, n, type) => ({ ...d, argChecks: d.argChecks.map((c) => (c.n === n ? { ...c, type } : c)) });

const RANDOM_LISTS = { range: 'ranges', choose: 'choosers', weighted: 'choosers', locked: 'locked' };

/** Appends one random entry: a range, a chooser ({kind:'choose'|'weighted'}) or a locked list. */
export function addRandom(d, list, item) {
  const field = RANDOM_LISTS[list];
  return { ...d, random: { ...d.random, [field]: [...d.random[field], item] } };
}

/** Removes entry `index` of one list ('ranges' | 'choosers' | 'locked'). */
export const removeRandom = (d, field, index) => ({ ...d, random: { ...d.random, [field]: d.random[field].filter((_, i) => i !== index) } });
