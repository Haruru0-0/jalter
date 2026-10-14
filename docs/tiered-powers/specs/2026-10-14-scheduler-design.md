# Shared scheduler: design

Step 0 of the feature roadmap (`2026-10-14-feature-roadmap.md`). Status: built (branch `scheduler`; code in `src/core/scheduler.js`).

## Intent and why

Several planned features need to do something at a future time: temp ban and timed mute (unban or un-timeout later), reminders, birthdays, stats channels, the end of an anti-raid lockdown, ticket auto-close. Today only auto role's timed roles can do this, with a private timer in `src/features/autorole/assign.js` and its own table (`pending_roles`). The owner wants one shared scheduler those features plug into, so each feature adds a job type instead of its own timer and table.

The owner's words: the scheduler should "do stuff in the features we decided". It is infrastructure for the roadmap, not a user-facing feature. It has no slash commands.

## Goals

- One database table of jobs, one timer, one place that runs them.
- A job survives a restart. If the bot was offline when a job came due, it runs when the bot is back.
- A crash while running a job does not lose it: the job is tried again after restart (decided by the owner: retry, even if that means a rare double action).
- A failed job is retried a few times, then dropped with a warning in the log.
- A feature can cancel jobs it scheduled (for example a ban lifted early).
- Auto role's timed roles move onto it, so the bot has one timer, not two. Existing waiting members must not lose their pending role: migrate the rows.
- Everything is testable without Discord: due-time logic takes a `now` value like the current code does.

## Non-goals

- Recurring jobs and cron expressions. A feature that repeats (birthdays, stats channels) schedules its own next job when its handler runs.
- Precision finer than the tick (about 30 seconds). Jobs run on the first tick after they are due.
- A user interface, commands or a dashboard for jobs.
- Running on more than one bot process. The claim step should be safe if it ever happens, but it is not a goal.

## Anti-goals (a failure even if it technically works)

- A job silently lost on crash or restart (the failure of today's delete-then-run).
- A job that runs forever in a retry loop and floods the log or the Discord API.
- Auto role's timed roles breaking or granting roles twice during the move.
- One slow or throwing job blocking the others.

## Design (decided with the owner; the rest is the builder's)

**Table `scheduled_jobs`** (new migration): `id` bigserial primary key; `guild_id` text; `type` text (for example `autorole.grant`, later `mod.unban`, `remind`); `key` text, optional, unique together with guild and type so scheduling the same thing twice replaces it (this is how `queueRole` behaves today); `payload` jsonb (what the handler needs); `due_at` timestamptz; `attempts` integer; plus a claim marker so a running job is not picked up twice. Index on due time.

**Running a job (at least once):** every tick, claim due jobs in a batch (`FOR UPDATE SKIP LOCKED`), mark them claimed for a few minutes, run the handler, then delete the row on success. If the bot crashes mid-job, the claim expires and the job runs again. On a thrown error: increase `attempts`, push `due_at` out with a growing delay, and after 5 attempts delete the job and log a warning. Handlers must therefore be safe to run twice (for example "unban if banned").

**API for features** (module `src/core/scheduler.js`, builder chooses exact names): register a handler for a job type; schedule a job (guild, type, optional key, payload, due time); cancel by guild and type and key, or by a payload field (auto role needs "cancel every pending job for this role"); start the ticker from `index.js` once the client is ready, where `startTicker` is called today. Handlers receive the shared context (`db`, `client`) and the job. How features register their handlers (for example a `jobs` export collected by `src/core/loader.js` next to `commands` and `events`) is the builder's call; it should follow how the loader collects the others.

**Rules carried over from the autorole ticker:** do nothing until the client is ready; a handler for a deleted guild, member or role is skipped quietly, not retried; a feature that is switched off in a server skips its jobs for that server (the handler checks, as autorole does).

**Auto role move:** a migration copies waiting `pending_roles` rows into `scheduled_jobs` (type `autorole.grant`, key from user and role, payload with user and role) and drops `pending_roles`. The grant logic moves into a handler with the same checks it has now. `queueRole` and `cancelRole` callers (`assign.js`, `index.js`) switch to the scheduler API. The `remembered_roles` table and its purge are unrelated and stay where they are. Update `resetDb` in `src/db/index.js` and the existing autorole tests to match.

## Constraints

- Node 22, ESM, Postgres, `node --test` with a real test database (`npm test`, tests hit the DB through `test/helpers/db.js`).
- Follow the code's existing style: small modules, the `now` parameter for time, `console.warn` for failures that must not crash the bot, no new dependencies.
- No user-facing text is added, so no i18n changes. If a handler needs text later, that feature adds it.
- Existing behavior of `/autorole timed add|remove` and the 30-second cadence must not change.
- Update `docs/memory/` notes (architecture, roadmap, decisions) and the roadmap spec status when it ships.

## Left to the builder

Exact table columns and names, the claim and backoff numbers (a few minutes of claim, delays like 1, 5 and 15 minutes), how handlers register, file layout, and test structure. If the job `key` needs a different shape than described, that is fine as long as "schedule the same thing twice replaces it" still holds.

## Calls I made after the builder check (not discussed with the owner; change any you disagree with)

- **Handler contract:** a handler that returns normally means "done", and the job is deleted. This includes "nothing to do" cases (feature switched off, guild or member or role gone). A handler that throws means "try again later". So auto role's handler must catch permanent Discord errors (missing permission, role above the bot, unknown member or role) and return after a log line, because retrying them cannot help. Only transient failures (network, Discord 5xx, rate limit) should throw.
- **No handler registered for a job type:** the job is left alone (not claimed, no attempt counted) and a warning is logged once per type per process. It runs once a handler registers. This also keeps migrated `autorole.grant` rows safe on first boot.
- **Housekeeping that is not a job** (the `remembered_roles` purge that today rides on auto role's ticker): the scheduler lets a feature register a function that runs once per tick. Auto role registers its purge there. This keeps one timer without adding a recurring-job feature.
- **Cancel by payload:** one generic call that matches jobs of a guild and type whose payload contains the given fields (equality only). Auto role cancels with its role id.
- **Cancelling a job that is running right now** does not stop it. The handler's own switched-off and config checks are the protection, as they are today.
- **Where handlers register** (a `jobs` export collected by the loader, or direct registration) stays the builder's call.
