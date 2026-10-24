// Builder draft: the guided form's state, edited through immutable operations.
// Draft = { trigger, matchMode, text, dest: 'reply'|'dm'|'channel', channelId, embed, deleteTrigger,
//   deleteReplyAfter, silent, gates: Gate[], actions: Action[], mode: 'guided'|'script', scriptText }

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
