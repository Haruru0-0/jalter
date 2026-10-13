export async function trySend(channel, payload) {
  try {
    return await channel.send(payload);
  } catch (err) {
    console.warn(`Could not send message: ${err.code ?? ''} ${err.message}`);
    return null;
  }
}

export async function fetchSendable(client, channelId) {
  if (!channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    return channel?.isTextBased() ? channel : null;
  } catch {
    return null;
  }
}
