import { createAutomodCommand } from './commands.js';
import { extendWithLists, listHandlers, listGroupHandlers } from './commands-lists.js';

export const commands = [createAutomodCommand({
  extend: extendWithLists,
  handlers: listHandlers,
  groupHandlers: listGroupHandlers,
})];
export { events } from './events.js';
