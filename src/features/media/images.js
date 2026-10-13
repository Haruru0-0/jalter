export function parseImageInput(input) {
  const value = (input ?? '').trim();
  if (!value) throw new Error('invalid-image');
  return /^https?:\/\//i.test(value)
    ? { type: 'url', url: value }
    : { type: 'stored', name: value };
}

export async function resolveImage(db, client, guildId, ref) {
  if (ref.type === 'url') return ref.url;
  const { rows } = await db.query(
    'SELECT channel_id, message_id, attachment_index FROM media_items WHERE guild_id = $1 AND name = $2',
    [guildId, ref.name],
  );
  if (!rows[0]) throw new Error('image-not-found');
  try {
    const channel = await client.channels.fetch(rows[0].channel_id);
    const message = await channel.messages.fetch(rows[0].message_id);
    const attachment = [...message.attachments.values()][rows[0].attachment_index];
    if (!attachment) throw new Error('missing attachment');
    return attachment.url;
  } catch {
    throw new Error('image-not-found');
  }
}
