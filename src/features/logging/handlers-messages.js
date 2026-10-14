import { Events } from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { sendLog, safe } from './send-log.js';
import { formatMessageEdit, formatMessageDelete } from './format.js';

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
  await sendLog(ctx, message.guildId, 'messageDelete', formatMessageDelete(message, lang), {
    sourceChannelId: message.channelId,
    ignore: { channelId: message.channelId, userId: message.author?.id, content: message.content },
  });
});

export const events = [
  { name: Events.MessageUpdate, execute: onMessageUpdate },
  { name: Events.MessageDelete, execute: onMessageDelete },
];
