# Gotchas

- `stickyroles` is still a "coming soon" stub in `core/registry.js`, but `/autorole reassign` and `/autorole blacklist` already do it. Remove the stub or point it at `/autorole`.
- The bot's highest role must sit above any role it gives, or Discord refuses (autorole).
- Privileged intents needed: Server Members and Message Content. Guilds, Guild Messages, Guild Expressions, Guild Moderation and Guild Voice States are not privileged.
- Invite permissions: View Channels, Send Messages, Read Message History, Embed Links, Attach Files, Manage Roles. Update the README invite list as phases add Kick, Ban, Moderate Members, Manage Messages/Channels/Nicknames.
- `DEV_GUILD_ID` set means commands register to that one server only and update instantly; unset means global (slow to propagate).
- Setting a feature's config merges into existing jsonb (`setFeature`), it does not replace it.
- `graphify-out/` can be stale; compare its commit with `git rev-parse HEAD`.
- Logging config shape (in the `logging` feature row): `channels{category:id}`, `disabledEvents[]` (everything is on once a channel resolves), `ignore{channels[],members[],prefixes[]}`. `setFeature` shallow-merges top-level keys, so always write the whole nested object (`channels`, `ignore`), never a partial one.
- Logging channel lookup: `channels[category]`, else for the `join` category `channels.members` (old join/leave logs keep working), else `channels.default`, else nothing.
- Logging ignore lists only affect message events (delete, edit, purge, invite posted). Events inside a log channel are never logged (loop guard).
- Logging "By" needs View Audit Log; it is optional and the invite list does not require it. `/logging setup` needs Manage Channels and is not idempotent: a second run adds a new "Logs" category.
- Logging "By" lookups are lazy: handlers pass `opts.executor` (an async function) to `sendLog`, which calls it only after the enabled, event, ignore, channel and loop-guard checks pass. Timeout attribution filters audit entries on the `communication_disabled_until` change; ban handlers use `ban.user` without fetching (gateway bans are always partial). Channel create/delete/update do not use the loop guard, so changes to log channels are themselves logged.
- Modlog and cases are deferred to Phase 2; the `mod` logging category is selectable but unused. See [[roadmap]].
- Setup and testing docs: `docs/discord-bot-setup.md` (developer portal, intents, invite, `.env`, troubleshooting) and `docs/testing-checklist.md` (tick-box manual test per feature). When a feature or invite permission changes, update both and the README manual check. `/help` needs no edit for new subcommands: it reads the command definitions.
- Repo hosting: `origin` is the private GitHub repo `Haruru0-0/jalter` (branches `autorole-upgrade`, `phase-1`). Commits use the global git identity (Haru); no Co-Authored-By trailers. History was rewritten once on 2026-10-14 before the first stable push; local tags `backup-before-rewrite-*` hold the old history and can be deleted.
- Scheduler handlers must be idempotent (at-least-once: a crash or expired claim can run a job twice) and must return, not throw, on permanent Discord errors (HTTP 4xx other than 429, unknown member or role, missing permission); throwing means retry, and after 5 attempts the job is dropped. A feature adds a job type by exporting `jobs` from its module; `collectModules` throws on duplicate types. A job type nobody registered just sits in `scheduled_jobs` (see [[architecture]], [[decisions]]).
- Timed roles no longer have a `pending_roles` table: they are `scheduled_jobs` rows of type `autorole.grant` with key `userId:roleId` and payload `{userId, roleId}`.
- Moderation plan note: `/logging event` already has 25 choices (the Discord limit), so the mod log must use a hidden `modAction` event outside `EVENTS` (planned in `docs/tiered-powers/plans/2026-10-14-moderation.md`, Task 3).
