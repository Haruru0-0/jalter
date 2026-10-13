import {
  SlashCommandBuilder, ChannelType, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
} from 'discord.js';
import { guard } from '../../core/guard.js';
import { ephemeral } from '../../core/replies.js';
import { extractEmbedRefs } from '../../core/placeholders.js';
import { parseImageInput } from '../media/images.js';
import { getEmbed, normalizeEmbedName } from '../embeds/store.js';
import { t } from '../../i18n/index.js';
import { KINDS, DM_KINDS, DEFAULT_MESSAGE } from './kinds.js';
import { setChannel, applyMessage, setCard, setBackground, setDm, getKindConfig } from './config.js';
import { handleMember, events } from './send.js';

const DESCRIBE = {
  greet: 'Message for new members',
  leave: 'Message for members who leave',
  boost: 'Message for server boosts',
};

const onOff = (o) =>
  o.setName('state').setDescription('On or off')
    .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }).setRequired(true);

const data = new SlashCommandBuilder().setName('set').setDescription('Set up greet, leave and boost messages');
for (const kind of KINDS) {
  data.addSubcommandGroup((g) => {
    g.setName(kind).setDescription(DESCRIBE[kind])
      .addSubcommand((s) =>
        s.setName('channel').setDescription('Choose the channel and turn the message on')
          .addChannelOption((o) =>
            o.setName('channel').setDescription('Where to post')
              .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true)))
      .addSubcommand((s) =>
        s.setName('message').setDescription('Set the message text, or none to turn it off')
          .addStringOption((o) =>
            o.setName('message').setDescription('Message text; leave empty to open a form').setMaxLength(2000)))
      .addSubcommand((s) =>
        s.setName('card').setDescription('Attach a welcome card image').addStringOption(onOff))
      .addSubcommand((s) =>
        s.setName('background').setDescription('Set the card background')
          .addStringOption((o) =>
            o.setName('source').setDescription('Image link or stored image name').setMaxLength(512))
          .addBooleanOption((o) => o.setName('clear').setDescription('Remove the background instead')));
    if (DM_KINDS.includes(kind)) {
      g.addSubcommand((s) =>
        s.setName('dm').setDescription('Also send the member a direct message').addStringOption(onOff));
    }
    return g;
  });
}

const testData = new SlashCommandBuilder().setName('test').setDescription('Send a test message using your account');
for (const kind of KINDS) {
  testData.addSubcommand((s) => s.setName(kind).setDescription(`Test the ${kind} message`));
}

/** The multi-line form for editing a message. */
export function messageModal(lang, kind, current) {
  const input = new TextInputBuilder()
    .setCustomId('text').setLabel(t(lang, 'greet.messageLabel').slice(0, 45))
    .setStyle(TextInputStyle.Paragraph).setMaxLength(2000).setRequired(true)
    .setValue((current ?? DEFAULT_MESSAGE[kind]).slice(0, 2000));
  return new ModalBuilder()
    .setCustomId(`set:msg:${kind}`)
    .setTitle(t(lang, 'greet.modalTitle').slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(input));
}

const SAVE_REPLY = {
  disabled: 'greet.messageDisabled',
  saved: 'greet.messageSaved',
  'saved-needs-channel': 'greet.messageNeedsChannel',
};

// Saves the text and builds the reply, noting a missing {embed:name}.
async function saveMessage(ctx, lang, guildId, kind, text) {
  const result = await applyMessage(ctx.db, guildId, kind, text);
  let reply = t(lang, SAVE_REPLY[result], { kind: t(lang, `greet.kind.${kind}`), command: `/set ${kind} channel` });
  if (result !== 'disabled') {
    for (const raw of extractEmbedRefs(text).names) {
      const name = normalizeEmbedName(raw);
      if (!name || !(await getEmbed(ctx.db, guildId, name))) {
        reply += `\n${t(lang, 'greet.embedMissing', { name: name ?? raw })}`;
      }
    }
  }
  return reply;
}

const TEST_REPLY = {
  sent: 'greet.testSent',
  off: 'greet.testOff',
  'no-channel': 'greet.testNoChannel',
  'send-failed': 'greet.testFailed',
};

async function execute(interaction, ctx) {
  const kind = interaction.options.getSubcommandGroup(true);
  const sub = interaction.options.getSubcommand();
  const lang = await guard(interaction, ctx, kind, { requireEnabled: false });
  if (!lang) return;
  const guildId = interaction.guildId;
  const label = t(lang, `greet.kind.${kind}`);

  if (sub === 'channel') {
    const channel = interaction.options.getChannel('channel', true);
    await setChannel(ctx.db, guildId, kind, channel.id);
    return interaction.reply(ephemeral(t(lang, 'greet.channelSet', { kind: label, channel: `<#${channel.id}>` })));
  }

  if (sub === 'message') {
    const text = interaction.options.getString('message');
    if (text == null || !text.trim()) {
      const { config } = await getKindConfig(ctx.db, guildId, kind);
      return interaction.showModal(messageModal(lang, kind, config.message));
    }
    return interaction.reply(ephemeral(await saveMessage(ctx, lang, guildId, kind, text)));
  }

  if (sub === 'card' || sub === 'dm') {
    const on = interaction.options.getString('state', true) === 'on';
    await (sub === 'card' ? setCard : setDm)(ctx.db, guildId, kind, on);
    return interaction.reply(ephemeral(t(lang, `greet.${sub}${on ? 'On' : 'Off'}`, { kind: label })));
  }

  if (sub === 'background') {
    if (interaction.options.getBoolean('clear')) {
      await setBackground(ctx.db, guildId, kind, null);
      return interaction.reply(ephemeral(t(lang, 'greet.backgroundCleared', { kind: label })));
    }
    const source = interaction.options.getString('source')?.trim();
    if (!source) return interaction.reply(ephemeral(t(lang, 'greet.backgroundNeeded')));
    const ref = parseImageInput(source);
    if (ref.type === 'stored') {
      const { rowCount } = await ctx.db.query(
        'SELECT 1 FROM media_items WHERE guild_id = $1 AND name = $2', [guildId, ref.name]);
      if (!rowCount) return interaction.reply(ephemeral(t(lang, 'media.unknown', { name: ref.name })));
    }
    await setBackground(ctx.db, guildId, kind, source);
    return interaction.reply(ephemeral(t(lang, 'greet.backgroundSaved', { kind: label })));
  }
}

async function executeTest(interaction, ctx) {
  const kind = interaction.options.getSubcommand();
  const lang = await guard(interaction, ctx, kind, { requireEnabled: false });
  if (!lang) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const status = await handleMember(ctx, interaction.member, kind);
  return interaction.editReply(
    t(lang, TEST_REPLY[status], { kind: t(lang, `greet.kind.${kind}`), command: `/set ${kind} channel` }));
}

async function handle(interaction, ctx) {
  const [, action, kind] = interaction.customId.split(':');
  if (action !== 'msg' || !interaction.isModalSubmit() || !KINDS.includes(kind)) return;
  const lang = await guard(interaction, ctx, kind, { requireEnabled: false });
  if (!lang) return;
  const text = interaction.fields.getTextInputValue('text');
  await interaction.reply(ephemeral(await saveMessage(ctx, lang, interaction.guildId, kind, text)));
}

export const commands = [
  { data, execute, components: { prefix: 'set', handle } },
  { data: testData, execute: executeTest },
];
export { events };
