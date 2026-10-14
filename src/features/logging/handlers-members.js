import { Events, AuditLogEvent } from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { sendLog, safe } from './send-log.js';
import { diffRoles, formatRoleChange, truncate, timeoutTransition, withExecutor } from './format.js';
import { findExecutor } from './audit.js';

const userLine = (user) => `<@${user.id}> (${user.username ?? '?'})`;

const onMemberAdd = safe('memberAdd', async (ctx, member) => {
  const lang = await getLang(ctx.db, member.guild.id);
  await sendLog(ctx, member.guild.id, 'memberJoin', {
    title: t(lang, 'logging.memberJoined'),
    description: userLine(member.user),
  });
});

const onMemberRemove = safe('memberRemove', async (ctx, member) => {
  // A partial member (left while uncached) normally still carries its user.
  if (!member.user) {
    console.warn(`Leave log skipped in ${member.guild.id}: member has no user data`);
    return;
  }
  const lang = await getLang(ctx.db, member.guild.id);
  await sendLog(ctx, member.guild.id, 'memberLeave', {
    title: t(lang, 'logging.memberLeft'),
    description: userLine(member.user),
  });
});

const onMemberUpdate = safe('memberUpdate', async (ctx, oldM, newM) => {
  if (oldM.partial) return;
  const lang = await getLang(ctx.db, newM.guild.id);
  if (oldM.nickname !== newM.nickname) {
    await sendLog(ctx, newM.guild.id, 'nameChange', {
      title: t(lang, 'logging.nicknameChanged'),
      description: userLine(newM.user),
      fields: [
        { name: t(lang, 'logging.before'), value: truncate(oldM.nickname) },
        { name: t(lang, 'logging.after'), value: truncate(newM.nickname) },
      ],
    });
  }
  if (oldM.avatar !== newM.avatar) {
    await sendLog(ctx, newM.guild.id, 'avatarChange', {
      title: t(lang, 'logging.avatarChanged'),
      description: userLine(newM.user),
    });
  }
  const transition = timeoutTransition(oldM.communicationDisabledUntilTimestamp, newM.communicationDisabledUntilTimestamp);
  if (transition) {
    const executor = await findExecutor(newM.guild, AuditLogEvent.MemberUpdate, newM.user.id);
    const embed = transition === 'timeout'
      ? {
        title: t(lang, 'logging.memberTimedOut'),
        description: userLine(newM.user),
        fields: [{ name: t(lang, 'logging.timeoutUntil'), value: `<t:${Math.floor(newM.communicationDisabledUntilTimestamp / 1000)}:F>` }],
      }
      : { title: t(lang, 'logging.timeoutRemoved'), description: userLine(newM.user) };
    await sendLog(ctx, newM.guild.id, transition, withExecutor(embed, executor, lang));
  }
  const diff = diffRoles([...oldM.roles.cache.keys()], [...newM.roles.cache.keys()]);
  if (diff.added.length || diff.removed.length) {
    await sendLog(ctx, newM.guild.id, 'roleChange', formatRoleChange(newM.user.id, diff, lang));
  }
});

async function onBan(ctx, ban, event, auditType, titleKey) {
  const full = ban.partial ? await ban.fetch() : ban;
  const lang = await getLang(ctx.db, ban.guild.id);
  const executor = await findExecutor(ban.guild, auditType, full.user.id);
  await sendLog(ctx, ban.guild.id, event,
    withExecutor({ title: t(lang, titleKey), description: userLine(full.user) }, executor, lang));
}

const onBanAdd = safe('banAdd', (ctx, ban) => onBan(ctx, ban, 'ban', AuditLogEvent.MemberBanAdd, 'logging.memberBanned'));
const onBanRemove = safe('banRemove', (ctx, ban) => onBan(ctx, ban, 'unban', AuditLogEvent.MemberBanRemove, 'logging.memberUnbanned'));

const onUserUpdate = safe('userUpdate', async (ctx, oldUser, newUser) => {
  if (oldUser.partial) return;
  const avatarChanged = oldUser.avatar !== newUser.avatar;
  const nameChanged = oldUser.username !== newUser.username;
  if (!avatarChanged && !nameChanged) return;
  for (const guild of ctx.client.guilds.cache.values()) {
    if (!guild.members.cache.has(newUser.id)) continue;
    const lang = await getLang(ctx.db, guild.id);
    if (avatarChanged) {
      await sendLog(ctx, guild.id, 'avatarChange', { title: t(lang, 'logging.avatarChanged'), description: userLine(newUser) });
    }
    if (nameChanged) {
      await sendLog(ctx, guild.id, 'nameChange', {
        title: t(lang, 'logging.usernameChanged'),
        description: userLine(newUser),
        fields: [
          { name: t(lang, 'logging.before'), value: truncate(oldUser.username) },
          { name: t(lang, 'logging.after'), value: truncate(newUser.username) },
        ],
      });
    }
  }
});

export const events = [
  { name: Events.GuildBanAdd, execute: onBanAdd },
  { name: Events.GuildBanRemove, execute: onBanRemove },
  { name: Events.UserUpdate, execute: onUserUpdate },
  { name: Events.GuildMemberAdd, execute: onMemberAdd },
  { name: Events.GuildMemberRemove, execute: onMemberRemove },
  { name: Events.GuildMemberUpdate, execute: onMemberUpdate },
];
