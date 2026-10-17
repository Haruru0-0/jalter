// Auto-mod message events: one shared engine and one prune sweep per process.
import { Events } from 'discord.js';
import { safe } from '../logging/send-log.js';
import { createEngine } from './pipeline.js';
import { createNativeHandler } from './native.js';

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
export function createEvents(engine, native = createNativeHandler({ strikes: engine.strikes })) {
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

  const onMemberAdd = safe('automodMemberAdd', async (ctx, member) => {
    await engine.checkMember(ctx, member);
  });

  const onMemberUpdate = safe('automodMemberUpdate', async (ctx, oldMember, newMember) => {
    // A partial old member has no known nickname: check anyway.
    if (!oldMember?.partial && oldMember?.nickname === newMember?.nickname) return;
    await engine.checkMember(ctx, newMember);
  });

  // Discord's own AutoMod fired. Needs the AutoModerationExecution intent.
  const onNativeExecution = safe('automodNativeExecution', async (ctx, execution) => {
    startAutomodSweep(engine);
    await native.handle(ctx, execution);
  });

  return [
    { name: Events.MessageCreate, execute: onCreate },
    { name: Events.MessageUpdate, execute: onUpdate },
    { name: Events.GuildMemberAdd, execute: onMemberAdd },
    { name: Events.GuildMemberUpdate, execute: onMemberUpdate },
    { name: Events.AutoModerationActionExecution, execute: onNativeExecution },
  ];
}

const engine = createEngine();

export const events = createEvents(engine);
