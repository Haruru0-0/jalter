import { Events, AuditLogEvent } from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { sendLog, safe } from './send-log.js';
import { findExecutor } from './audit.js';
import {
  formatMessageEdit, formatMessageDelete, formatPurge, formatInvite,
} from './format.js';

export const INVITE_RE = /(discord\.gg|discord(?:app)?\.com\/invite)\/\S+/i;

const onMessageUpdate = safe('messageUpdate', async (ctx, oldM, newM) => {
  if (!newM.guildId || newM.author?.bot) return;
  const known = oldM.content !== null && oldM.content !== undefined
    && newM.content !== null && newM.content !== undefined;
  if (known && oldM.content === newM.content) return;
  const lang = await getLang(ctx.db, newM.guildId);
  await sendLog(ctx, newM.guildId, 'messageEdit', formatMessageEdit(oldM, newM, lang), {
    sourceChannelId: newM.channelId,
    ignore: { channelId: newM.channelId, userId: newM.author?.id, content: oldM.content ?? newM.content },
  });
});

const onMessageDelete = safe('messageDelete', async (ctx, message) => {
  if (!message.guildId || message.author?.bot) return;
  const lang = await getLang(ctx.db, message.guildId);
  const authorId = message.author?.id;
  await sendLog(ctx, message.guildId, 'messageDelete', formatMessageDelete(message, lang), {
    executor: authorId ? () => findExecutor(message.guild, AuditLogEvent.MessageDelete, authorId) : null,
    sourceChannelId: message.channelId,
    ignore: { channelId: message.channelId, userId: message.author?.id, content: message.content },
  });
});

const onMessageBulkDelete = safe('messageDeleteBulk', async (ctx, messages, channel) => {
  if (!channel?.guildId) return;
  const lang = await getLang(ctx.db, channel.guildId);
  await sendLog(ctx, channel.guildId, 'messagePurge', formatPurge(messages.size, channel.id, lang), {
    sourceChannelId: channel.id,
    ignore: { channelId: channel.id },
  });
});

const onMessageCreate = safe('messageCreate', async (ctx, message) => {
  if (!message.guildId || message.author?.bot) return;
  if (!message.content || !INVITE_RE.test(message.content)) return;
  const lang = await getLang(ctx.db, message.guildId);
  await sendLog(ctx, message.guildId, 'invitePosted', formatInvite(message, lang), {
    sourceChannelId: message.channelId,
    ignore: { channelId: message.channelId, userId: message.author?.id, content: message.content },
  });
});

export const events = [
  { name: Events.MessageUpdate, execute: onMessageUpdate },
  { name: Events.MessageDelete, execute: onMessageDelete },
  { name: Events.MessageBulkDelete, execute: onMessageBulkDelete },
  { name: Events.MessageCreate, execute: onMessageCreate },
];
