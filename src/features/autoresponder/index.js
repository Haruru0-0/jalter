import { createAutoresponderCommand } from './commands.js';
import { pruneCooldowns } from './cooldown.js';

export const commands = [createAutoresponderCommand()];
export const housekeeping = [pruneCooldowns];
export { events } from './events.js';
