// Auto-mod message events: one shared engine and one prune sweep per process.
import { Events } from 'discord.js';
import { safe } from '../logging/send-log.js';
import { createEngine } from './pipeline.js';

const SWEEP_MS = 60_000;

let sweep = null;

/** Starts the prune timer once (unref'd, so it never keeps the process alive). Returns the handle. */
export function startAutomodSweep(engine) {
  if (!sweep) {
    sweep = setInterval(() => {
      try {
        engine.prune(Date.now());
      } catch (err) {
        console.warn(`Auto-mod prune failed: ${err?.message ?? err}`);
      }
    }, SWEEP_MS);
    sweep.unref?.();
  }
  return sweep;
}

export function stopAutomodSweep() {
  if (sweep) clearInterval(sweep);
  sweep = null;
}

/** Builds the event list around an engine (tests pass a fake one). */
export function createEvents(engine) {
  const onCreate = safe('automodMessageCreate', async (ctx, message) => {
    startAutomodSweep(engine);
    await engine.handleMessage(ctx, message, { edited: false });
  });

  const onUpdate = safe('automodMessageUpdate', async (ctx, oldMessage, newMessage) => {
    startAutomodSweep(engine);
    let message = newMessage;
    if (message?.partial) {
      try {
        message = await message.fetch();
      } catch {
        return;
      }
    }
    if (!message?.guildId || message.author?.bot) return;
    await engine.handleMessage(ctx, message, { edited: true, oldContent: oldMessage?.content ?? undefined });
  });

  return [
    { name: Events.MessageCreate, execute: onCreate },
    { name: Events.MessageUpdate, execute: onUpdate },
  ];
}

const engine = createEngine();

export const events = createEvents(engine);
