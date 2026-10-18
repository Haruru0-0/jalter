# Roadmap

Full detail: `docs/tiered-powers/specs/2026-10-14-feature-roadmap.md`. Original design: `docs/tiered-powers/specs/2026-10-13-discord-bot-design.md`. Plans in `docs/tiered-powers/plans/`.

## Build order
1. **Step 0 shared pieces**: generic scheduler (done, see below), mod-case store (done, see Moderation below), extra intents (GuildModeration and GuildVoiceStates are already added by logging; GuildMessageReactions is still to come) and invite permissions - add each only when its first feature ships.
2. **Phase 2 Moderation**, strict order: mod cases + warn/kick/ban/timeout and timed actions (both built and merged into `autorole-upgrade`, see below) -> channel tools (purge, slowmode, lock; built on `phase-2`, see Done) -> auto-mod (built on `phase-2`) -> verification (built on `phase-2`, manual testing pending) -> anti-raid (next).
3. **Phase 3 Automation**, any order: autoresponder, reaction roles, quote.
4. **Phase 4 Community**: scheduler group (reminders, birthdays, stats channels); event group (AFK, leveling, starboard); staff group (tickets, confessions). Extend `/userinfo` last (needs levels, warnings, birthdays).
5. **Phase 5**: backup/restore, translate (needs an API key in `.env`), gif reactions (added 2026-10-17; scope to decide: reaction-GIF commands like /hug vs. reacting to messages with GIFs; a GIF provider API such as Tenor or Giphy needs a key in `.env`).

## Done
- **Logging Carl-parity** (plan: `docs/tiered-powers/plans/2026-10-14-logging-carl-parity.md`): built and merged into `autorole-upgrade` (not yet deployed: run `npm run deploy` to register the new subcommands). See [[features-built]]. Modlog and cases are deliberately left for Phase 2 (mod-case store), which can log to the existing `mod` category.
- **Shared scheduler (Step 0)**: built and merged into `autorole-upgrade` (pushed to origin; migration 005 runs on the next bot start) (spec: `docs/tiered-powers/specs/2026-10-14-scheduler-design.md`, plan: `docs/tiered-powers/plans/`). `scheduled_jobs` table, one 30 s ticker, at-least-once with retries; auto role's timed roles run on it and migration 005 moved waiting `pending_roles` rows over. See [[architecture]]. Moderation timed actions (temp ban, timed mute) are the next consumer.
- **Auto-created channels**: built on `phase-2` (commits 379837b, c86a290, 1d4335a; pushed to origin, not merged back into `autorole-upgrade`). Logging and greet/leave/boost create their channel when none was chosen; see [[gotchas]] and [[features-built]]. Active development branch is now `phase-2`.
- **Channel tools (Phase 2 step 3)**: built on `phase-2` (not yet merged into `autorole-upgrade`; run `npm run deploy` to register `/purge`, `/slowmode`, `/lock`, `/unlock`). Spec `docs/tiered-powers/specs/2026-10-15-channel-tools-design.md`. Inside moderation; no cases, one mod log line each. See [[features-built]], [[architecture]], [[decisions]], [[gotchas]]. Manual testing on a real server is pending (checklist section 11).

## In progress
- **Moderation (Phase 2 steps 1 and 2)**: All 10 plan tasks are built, reviewed and merged into `autorole-upgrade` (pushed to origin). Spec `docs/tiered-powers/specs/2026-10-14-moderation-design.md`, plan `docs/tiered-powers/plans/2026-10-14-moderation.md`. What exists: `/warn`, `/timeout`, `/untimeout`, `/mute`, `/unmute`, `/kick`, `/ban`, `/unban`, `/warnings`, `/reason` and `/moderation` settings, numbered cases, mod log through the hidden `modAction` event, timed bans and mutes on the scheduler, mute role restored on rejoin. See [[features-built]], [[architecture]], [[decisions]], [[gotchas]]. Deployed to the dev guild on 2026-10-15 (26 commands registered, migration 006 ran on bot start); manual testing on a real server is still pending (see `docs/testing-checklist.md`).

- **Auto-mod (Phase 2 step 4)**: spec `docs/tiered-powers/specs/2026-10-16-automod-design.md`. Phase 1 core (plan `docs/tiered-powers/plans/2026-10-16-automod-phase1-core.md`, 13 tasks) is built on `phase-2`, not merged into `autorole-upgrade`: detectors, strikes with tiered escalation, pipeline, nickname check, `/automod` commands, history table. Run `npm run deploy` to register `/automod`. Manual testing is pending (checklist section 12). Phase 2 advanced (regex patterns, honeypot, account-age conditions, timed role, native AutoMod trigger; plan `docs/tiered-powers/plans/2026-10-16-automod-phase2-advanced.md`, 8 tasks) is built on `phase-2`, not merged into `autorole-upgrade`. Run `npm run deploy` to register the new subcommands (`patterns`, `age`, `role`, `honeypot`, `native`). Manual testing is pending (checklist section 12). Next in the moderation order: anti-raid (verification is built, see below). See [[features-built]], [[gotchas]].

- **Verification (Phase 2 step 5)**: built on `phase-2` (not merged into `autorole-upgrade`; run `npm run deploy` to register `/verification`; migration 008 runs on the next start). Manual testing pending: follow section 13 of `docs/testing-checklist.md`. Spec `docs/tiered-powers/specs/2026-10-17-verification-design.md`, plan `docs/tiered-powers/plans/2026-10-17-verification.md` (button mode, then image captcha, always English). Verified role gate; public channels (read-only for unverified, for Discord Onboarding) and skipped channels; existing members and bots grandfathered before channels are hidden; undo record. See [[features-built]], [[decisions]], [[gotchas]].

## Planned, not built
- Everything in the build order above except logging, the scheduler, moderation (cases, timed actions, channel tools), auto-mod and verification.

## Dependencies worth remembering
- Verification must exist before anti-raid (lockdown raises verification).
- Anti-raid also needs the scheduler and logging alerts.
- Leveling before the `/userinfo` update.
