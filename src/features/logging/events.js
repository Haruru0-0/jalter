export const CATEGORIES = ['default', 'messages', 'members', 'join', 'server', 'voice', 'mod'];

export const EVENTS = {
  messageDelete: 'messages',
  messageEdit: 'messages',
  messagePurge: 'messages',
  invitePosted: 'messages',
  roleChange: 'members',
  avatarChange: 'members',
  nameChange: 'members',
  ban: 'members',
  unban: 'members',
  timeout: 'members',
  timeoutRemoved: 'members',
  memberJoin: 'join',
  memberLeave: 'join',
  channelCreate: 'server',
  channelUpdate: 'server',
  channelDelete: 'server',
  roleCreate: 'server',
  roleUpdate: 'server',
  roleDelete: 'server',
  emoji: 'server',
  guildUpdate: 'server',
  voiceJoin: 'voice',
  voiceMove: 'voice',
  voiceLeave: 'voice',
};

export const MESSAGE_EVENTS = ['messageDelete', 'messageEdit', 'messagePurge', 'invitePosted'];
