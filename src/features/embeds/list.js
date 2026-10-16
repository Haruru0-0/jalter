import { EmbedBuilder } from 'discord.js';
import { capList } from '../../core/lists.js';
import { ephemeral } from '../../core/replies.js';
import { t } from '../../i18n/index.js';
import { CARD_COLOR } from './panel.js';

const MAX_DESCRIPTION = 3800;

/** The reply to `/embed list`: one card with the count, a numbered list of names and a hint. Ephemeral. */
export function listPayload(lang, names) {
  const card = new EmbedBuilder().setColor(CARD_COLOR);
  if (!names.length) {
    card.setTitle(t(lang, 'embeds.listTitleEmpty')).setDescription(t(lang, 'embeds.none'));
    return ephemeral({ embeds: [card] });
  }
  const lines = names.map((name, index) => `${index + 1}. \`${name}\``);
  const list = capList(lines, {
    max: MAX_DESCRIPTION, sep: '\n', more: (count) => t(lang, 'common.more', { count }),
  });
  card
    .setTitle(t(lang, 'embeds.listTitle', { count: names.length }))
    .setDescription(`${list}\n\n${t(lang, 'embeds.listHint')}`);
  return ephemeral({ embeds: [card] });
}
