# Architecture

Discord bot: discord.js 14, Node 22+, ESM, Postgres in Docker. Entry `src/index.js`; slash commands registered by `src/deploy-commands.js`.

## Layout
- `src/features/<name>/index.js` - one folder per feature; each is listed in `src/modules.js` (the loader's module list).
- `src/core/` - shared helpers: `guard.js`, `registry.js`, `toggle.js`, `permissions.js`, `replies.js`, `placeholders.js`, `mentions.js`, `send.js`, `lists.js`, `members.js`, `loader.js`.
- `src/db/` - `index.js` (pool, `resetDb()` for tests), `settings.js`, `migrations/` (001_init, 002_named_embeds, 003_autorole_tables).
- `src/i18n/` - `en.json`, `fr.json`, `ar.json`, and `index.js` with `t(lang, key, vars)` and `getLang`.

## Key pieces
- **Registry** (`core/registry.js`): `FEATURES` lists every feature with phase, command and enable command. Optional fields: `commands` (several top-level commands, e.g. `set` + `test`), `byKey` (a shared command like `/set` whose subcommands are split per feature key), `alwaysOn`. Phase 2-5 entries are "coming soon" stubs with `command: null`. `alwaysOn` features skip the enabled check.
- **Guard** (`core/guard.js`): `guard(interaction, ctx, key, {requireManager, requireEnabled})` checks guild-only, manager permission, and enabled state, replies ephemerally on failure, and returns the guild language on success. Almost every command handler starts with it.
- **Settings** (`db/settings.js`): `guild_settings(guild_id, feature, enabled, config jsonb)`. `getFeature` returns `{enabled:false, config:{}}` when no row; `setFeature` upserts and merges config.
- **Toggle** (`core/toggle.js`): shared `enable`/`disable` subcommands.
- **Context** (`src/index.js`): `ctx = { db, client, commands }`; `ctx.commands` is the loaded command map, used by `/help` to read command definitions.
- **Help** (`features/help/index.js`): `buildHelp`, `commandPaths`, `findFeature` walk command JSON to list subcommand paths.

## Graph hot spots
Most-connected nodes in the Graphify map: `t`, `guard()`, `ephemeral()`, `setFeature()`, `getFeature()`, `getLang()`, `sendLog()`. Changes there ripple widely.

See [[gotchas]] for rules, [[features-built]] for behaviour.
