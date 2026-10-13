import { SlashCommandBuilder } from 'discord.js';
import { guard } from '../../core/guard.js';
import { handleToggle, toggleSubcommands } from '../../core/toggle.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { buildUserInfo, buildServerInfo } from './build.js';

const userOption = (o) => o.setName('user').setDescription('Member (defaults to you)');

const infoToggle = toggleSubcommands(new SlashCommandBuilder().setName('info').setDescription('Turn the info commands on or off'));
const userinfo = new SlashCommandBuilder().setName('userinfo').setDescription('About a member').addUserOption(userOption);
const avatar = new SlashCommandBuilder().setName('avatar').setDescription('Show an avatar').addUserOption(userOption);
const banner = new SlashCommandBuilder().setName('banner').setDescription('Show a banner').addUserOption(userOption);
const serverinfo = new SlashCommandBuilder().setName('serverinfo').setDescription('About this server');

const open = (interaction, ctx) => guard(interaction, ctx, 'info', { requireManager: false });

export const commands = [
  { data: infoToggle, execute: (i, ctx) => handleToggle(i, ctx, 'info') },
  {
    data: userinfo,
    async execute(i, ctx) {
      const lang = await open(i, ctx);
      if (!lang) return;
      const user = i.options.getUser('user') ?? i.user;
      const member = await i.guild.members.fetch(user.id).catch(() => null);
      if (!member) return i.reply(ephemeral(t(lang, 'info.notMember')));
      await i.reply({ embeds: [buildUserInfo(member, lang)] });
    },
  },
  {
    data: avatar,
    async execute(i, ctx) {
      const lang = await open(i, ctx);
      if (!lang) return;
      const user = i.options.getUser('user') ?? i.user;
      await i.reply({ embeds: [{ title: user.username, image: { url: user.displayAvatarURL({ size: 1024 }) } }] });
    },
  },
  {
    data: banner,
    async execute(i, ctx) {
      const lang = await open(i, ctx);
      if (!lang) return;
      const cached = i.options.getUser('user') ?? i.user;
      const user = await cached.fetch(true).catch(() => cached);
      const url = user.bannerURL({ size: 1024 });
      if (!url) return i.reply(ephemeral(t(lang, 'info.noBanner')));
      await i.reply({ embeds: [{ title: user.username, image: { url } }] });
    },
  },
  {
    data: serverinfo,
    async execute(i, ctx) {
      const lang = await open(i, ctx);
      if (!lang) return;
      await i.reply({ embeds: [buildServerInfo(i.guild, lang)] });
    },
  },
];
export const events = [];
