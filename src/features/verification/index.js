import { createVerificationCommand } from './commands.js';
import { jobs as rolloutJobs } from './rollout.js';
import { jobs as unverifiedJobs } from './unverified-jobs.js';

export const commands = [createVerificationCommand()];
export const jobs = { ...rolloutJobs, ...unverifiedJobs };
export { events } from './events.js';
