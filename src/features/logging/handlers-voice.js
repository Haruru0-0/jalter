import { Events } from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { sendLog, safe } from './send-log.js';
import { voiceTransition } from './format.js';

const onVoiceStateUpdate = safe('voiceStateUpdate', async (ctx, oldS, newS) => {
  const member = newS.member ?? oldS.member;
  if (member?.user?.bot) return;
  const event = voiceTransition(oldS.channelId, newS.channelId);
  if (!event) return;
  const guildId = newS.guild?.id ?? oldS.guild?.id;
  if (!guildId) return;
  const userId = member?.id ?? newS.id ?? oldS.id;
  const lang = await getLang(ctx.db, guildId);
  const titleKey = { voiceJoin: 'logging.voiceJoined', voiceMove: 'logging.voiceMoved', voiceLeave: 'logging.voiceLeft' }[event];
  const channels = event === 'voiceMove'
    ? `<#${oldS.channelId}> → <#${newS.channelId}>`
    : `<#${newS.channelId ?? oldS.channelId}>`;
  await sendLog(ctx, guildId, event, {
    title: t(lang, titleKey),
    description: `<@${userId}> ${channels}`,
  }, { sourceChannelId: newS.channelId ?? oldS.channelId });
});

export const events = [{ name: Events.VoiceStateUpdate, execute: onVoiceStateUpdate }];
