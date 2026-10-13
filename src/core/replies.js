import { MessageFlags } from 'discord.js';

export function ephemeral(content) {
  const body = typeof content === 'string' ? { content } : content;
  return { ...body, flags: MessageFlags.Ephemeral };
}
