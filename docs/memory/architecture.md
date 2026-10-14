# Architecture

Discord bot: discord.js 14, Node 22+, ESM, Postgres in Docker. Entry `src/index.js`; slash commands registered by `src/deploy-commands.js`.

## Layout
- `src/features/<name>/index.js` - one folder per feature; each is listed in `src/modules.js` (the loader's module list).
- `src/core/` - shared helpers: `guard.js`, `registry.js`, `toggle.js`, `permissions.js`, `replies.js`, `placeholders.js`, `mentions.js`, `send.js`, `lists.js`, `members.js`, `loader.js`, `scheduler.js`.
- `src/db/` - `index.js` (pool, `resetDb()` for tests), `settings.js`, `migrations/` (001_init, 002_named_embeds, 003_autorole_tables, 004_scheduled_jobs, 005_autorole_to_scheduler).
- `src/i18n/` - `en.json`, `fr.json`, `ar.json`, and `index.js` with `t(lang, key, vars)` and `getLang`.

## Key pieces
- **Registry** (`core/registry.js`): `FEATURES` lists every feature with phase, command and enable command. Optional fields: `commands` (several top-level commands, e.g. `set` + `test`), `byKey` (a shared command like `/set` whose subcommands are split per feature key), `alwaysOn`. Phase 2-5 entries are "coming soon" stubs with `command: null`. `alwaysOn` features skip the enabled check.
- **Guard** (`core/guard.js`): `guard(interaction, ctx, key, {requireManager, requireEnabled})` checks guild-only, manager permission, and enabled state, replies ephemerally on failure, and returns the guild language on success. Almost every command handler starts with it.
- **Settings** (`db/settings.js`): `guild_settings(guild_id, feature, enabled, config jsonb)`. `getFeature` returns `{enabled:false, config:{}}` when no row; `setFeature` upserts and merges config.
- **Toggle** (`core/toggle.js`): shared `enable`/`disable` subcommands.
- **Scheduler** (`core/scheduler.js`, table `scheduled_jobs`: id, guild_id, type, key, payload jsonb, due_at, attempts, claimed_until; unique on guild_id+type+key): one shared, restart-safe job runner. Helpers `scheduleJob` (same guild+type+key updates the row, resets attempts; this needs a non-null key, since NULL keys never conflict and always insert a new row), `cancelJobs` (by guild, type, optional key, optional payload containment; with no key it matches any key), `claimDue`, `completeJob`, `failJob`. `startScheduler(ctx, registry)` ticks every 30 000 ms (timer is unref'd, a tick never overlaps the previous one) and `index.js` starts it inside the `ClientReady` handler, so nothing runs before the client is ready. Each tick runs every feature's `housekeeping` functions, then claims due jobs of registered types and runs their handlers. A feature adds job types by exporting `jobs` (`{ 'type': async (ctx, job) => ... }`) and per-tick functions by exporting `housekeeping` (`async (ctx, { now }) => ...`); `collectModules` in `loader.js` gathers both and throws on a duplicate job type. Handler contract and retry rules: see [[decisions]] and [[gotchas]]. Auto role is the first user: job type `autorole.grant`, handler `grantTimedRole`, housekeeping `purgeRememberedRoles` (sticky-role memory cleanup).
- **Context** (`src/index.js`): `ctx = { db, client, commands }`; `ctx.commands` is the loaded command map, used by `/help` to read command definitions.
- **Help** (`features/help/index.js`): `buildHelp`, `commandPaths`, `findFeature` walk command JSON to list subcommand paths.

## Graph hot spots
Most-connected nodes in the Graphify map: `t`, `guard()`, `ephemeral()`, `setFeature()`, `getFeature()`, `getLang()`, `sendLog()`. Changes there ripple widely.

See [[gotchas]] for rules, [[features-built]] for behaviour.
