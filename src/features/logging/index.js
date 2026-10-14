import { commands } from './commands.js';
import { events as messageEvents } from './handlers-messages.js';
import { events as memberEvents } from './handlers-members.js';
import { events as serverEvents } from './handlers-server.js';

export { commands };
export const events = [...messageEvents, ...memberEvents, ...serverEvents];
