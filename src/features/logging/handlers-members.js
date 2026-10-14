import { Events } from 'discord.js';
import { getLang, t } from '../../i18n/index.js';
import { sendLog, safe } from './send-log.js';
import { diffRoles, formatRoleChange, truncate } from './format.js';

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
  const diff = diffRoles([...oldM.roles.cache.keys()], [...newM.roles.cache.keys()]);
  if (diff.added.length || diff.removed.length) {
    await sendLog(ctx, newM.guild.id, 'roleChange', formatRoleChange(newM.user.id, diff, lang));
  }
});

export const events = [
  { name: Events.GuildMemberAdd, execute: onMemberAdd },
  { name: Events.GuildMemberRemove, execute: onMemberRemove },
  { name: Events.GuildMemberUpdate, execute: onMemberUpdate },
];
