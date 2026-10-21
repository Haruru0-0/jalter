import { jobs as settingsJobs } from './commands-settings.js';
import { createReactionRolesCommand } from './commands.js';

export const commands = [createReactionRolesCommand()];

export const jobs = { ...settingsJobs };
