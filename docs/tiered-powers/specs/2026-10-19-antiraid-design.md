# Anti-raid (Phase 2, step 6): design

Status: design, not built. Roadmap: `2026-10-14-feature-roadmap.md`, Phase 2 step 6 (after verification, which is built on `phase-2`). Items marked **(call)** are choices the designer made without the owner saying so; the owner should check them while reading.

## Intent and why

When a server is raided, dozens of throwaway accounts join within a minute or two. By the time a moderator notices, the damage is done. The owner wants the bot to notice a burst of joins by itself, tell the moderators, stop new people from joining through invites for a while, and remove the brand-new accounts that came in with the burst, then return to normal on its own or when a moderator says so.

The owner described the raid they worry about as **mass joins**: many accounts join at once, often brand-new ones.

## Goals

- A per-server **join-rate detector**: when a number of **human** members join within a time window, a **lockdown** starts. Defaults **(call)**: **10 joins within 60 seconds**.
- When a lockdown starts, automatically, in this order of importance:
  1. **Alert the moderators**: a message in the mod-log channel with the numbers (joins counted, window, how many accounts were removed, when the lockdown ends), and a **ping to one role** the admin picks. If none is picked, the bot manager role (set with `/panel manager-role`) is pinged **(call)**.
  2. **Pause invites** with Discord's own invite pause (`invitesDisabledUntil`) until the lockdown ends.
  3. **Kick the young accounts in the burst**: every human who joined inside the detection window **and** whose Discord account is younger than a set age (default **7 days**, **(call)**). Each is a real moderation kick case with the reason "anti-raid lockdown", created through the moderation engine with the bot as the moderator.
- While a lockdown is on, a human who joins with a young account is kicked straight away **(call)**; an older account is left alone and is not counted.
- A lockdown **ends** after a set time (default **30 minutes**, **(call)**) **or** when a moderator ends it with a command, whichever comes first. Ending removes the invite pause (only the one the lockdown made, see below) and writes a mod-log line. The end timer survives a bot restart.
- Admin commands under `/antiraid`: `enable`, `disable`, `config` (joins, window, account age, duration, ping role), `status`, and a manual `start` and `end` **(call: `start` was not asked for)**. All replies are private; all setup commands need Manage Server or the bot manager role, like the rest of the bot.
- The feature is **off by default**.
- All user-facing text in English, French and Arabic.

## Non-goals

- Raising or changing the verification mode (the owner did not choose it; verification is not touched).
- Locking channels, or hiding the server (no server-wide channel lock).
- Pausing DMs, or acting on any join outside a lockdown (a normal join is never touched).
- Detecting message spam or mention floods (auto-mod's job).
- Persisting the join counter across a restart: it lives in memory and starts empty after a restart.
- Banning, timing out or any action other than kick.
- Per-role or per-invite exceptions.

## Anti-goals (a failure even if it technically works)

- Kicking a real, older member, a staff member, a bot or the server owner. Only young accounts that joined in the burst are kicked, and the owner, people at or above the bot's highest role, and people with the bot manager role (`canManage`) are never kicked.
- A lockdown that never ends, or an invite pause that is never lifted: ending must always unpause what the lockdown paused, even after a restart, and `disable` while locked ends the lockdown first **(call)**.
- Undoing an invite pause an administrator set on purpose: if invites were already paused when the lockdown started, the bot leaves that pause alone and does not lift it at the end.
- A second lockdown starting while one is on, or one starting again the moment the first ends from the same burst (the counter is cleared when a lockdown ends **(call)**).
- A failure that is silent: if the invite pause is refused, or no mod-log channel exists, the lockdown still runs and the alert (or `/antiraid status`) says what could not be done.
- A leaked invite link kicking a crowd of real people: the account-age filter, the admin-tunable numbers and the `status` output exist for this; the design accepts that very new real accounts can be caught.

## What the admin sees

- `/antiraid enable` / `disable` (the shared toggle).
- `/antiraid config [joins:<number>] [window:<time>] [account_age:<time>] [duration:<time>] [ping_role:<role>]`: every option optional, only the ones given are changed; values are checked and a bad one is refused with a clear message and nothing is saved. Ranges **(call)**: joins 3 to 100; window 10 seconds to 10 minutes; account age 1 hour to 90 days; duration 5 minutes to 24 hours (Discord limits the invite pause to 24 hours); the ping role cannot be `@everyone`. Times use the existing duration format (`30s`, `10m`, `24h`, `7d`, `src/core/duration.js`).
- `/antiraid status`: on or off, the numbers, whether a lockdown is on and when it ends, how many accounts it removed, and whether the invite pause and the alert worked.
- `/antiraid start` and `/antiraid end`: a moderator starts or ends a lockdown by hand. `start` runs the same steps as an automatic one (candidates for the kick are the young accounts that joined within the detection window); the alert names who started it. `end` is refused when no lockdown is on.

## How it runs (the admin never sees this)

- A small in-memory list of recent human joins per server (member id, join time, account creation time), pruned by time. Bots are not counted and never kicked. The shape of the existing automod sliding-window stores is the model.
- Lockdown state lives in the feature's config (merge-written; `state`, `lockedUntil`, counts, whether the pause was made by the lockdown) and a scheduler job `antiraid.end` keyed by server, due at `lockedUntil`, so a restart does not lose the end.
- Starting: set state, queue the end job, send the alert (a direct message with a role ping, because the shared mod-log helper cannot ping), pause invites (`guild.setIncidentActions({ invitesDisabledUntil })`; Discord's `incidentsData` shows whether invites were already paused), then kick the candidates through the moderation engine, one after another, capped at **100** per lockdown start **(call)**.
- Ending (timer, `end`, or `disable`): set state idle, lift only the invite pause the lockdown made, clear the join list, log the end. The end is idempotent.
- Jobs and handlers re-check the state when they fire: an end job for a lockdown that already ended does nothing.

## Constraints

- The moderation engine (`runAction` in `src/features/moderation/actions.js`) is the only way a kick is created, so cases, the mod log, DM text and the moderation settings behave as for a moderator's own `/kick`.
- The alert goes to the mod-log channel of the logging feature (category `mod`). If the logging feature has no mod channel, the alert is skipped and `/antiraid status` says so; the lockdown still runs **(call)**. A ping must only mention the one chosen role (`safeMentions`).
- Config is merge-written (`setFeature`), never replaced. No new table or migration is needed (state in config, end in the shared scheduler).
- The registry stub `f('antiraid', 2, null)` in `src/core/registry.js` becomes a real feature with the `antiraid` command; the tests that expect "Anti-raid: Coming soon" (`test/features/panel.test.js`, `test/features/help.test.js`) change with it.
- The bot needs Kick Members and (to be confirmed by the builder against the Discord API) the permission for the invite pause (likely Manage Server); `docs/discord-bot-setup.md` and `/antiraid status` must say so.
- Reuse, do not rewrite: `parseDuration`/`formatDuration`, `scheduleJob`/`cancelJobs`, `runAction`, `canManage`, the unverified-policy "spared member" rules, `toggleSubcommands`/`guard`, `trySend` and `safeMentions`.
- **Moderation settings:** the moderation feature does not have to be enabled. The kick is made with the moderation settings read from the server's stored moderation config (defaults when none), exactly as the unverified policy does; a moderation DM or reason rule therefore applies as it would to a moderator's own `/kick`.
- **Verification:** anti-raid does not look at verification. A young account in the burst is kicked even if it already holds the Verified role **(call: in an emergency a bot can click a button; the owner may want verified members spared instead)**. A kick cancels that member's queued verification jobs because the existing leave handler already does it. A member kicked by both features gets one kick case, because the second kick finds the member gone and does nothing.
- **Discord library and permission:** the installed discord.js (14.27) has `Guild.setIncidentActions` and `incidentsData.invitesDisabledUntil`. If the bot lacks the permission for the invite pause, the lockdown still runs without the pause and the alert and `status` say so; nothing is refused up front.
- **Single process:** the bot runs as one process (no sharding), so the in-memory counter is the only counter. After a restart a lockdown that is still on (state in config, end job queued) keeps kicking young accounts that join; only the join list is empty.
- **Counting and candidates:** the detector counts **every** human join in the window, whatever the account age; only young accounts are kicked, so a burst of older accounts slows the door (alert plus invite pause) but removes nobody **(call)**. The join that makes the count reach the threshold is part of the window. Candidates for the kick come from the in-memory join list only, so a manual `start` right after a restart, or right after `enable`, may kick nobody **(call)**.
- **Language and channel:** the alert, reasons and log lines use the server language. The mod-log channel is found through the logging feature's existing channel resolution for the `mod` category; if it cannot be found or the bot cannot post there, the alert is skipped and `status` says so.
- **An earlier admin pause:** if invites were already paused when the lockdown starts, the bot leaves that pause untouched and does not lift it at the end, even if the lockdown outlasts it.

## Left to the builder

- Exact option names and choice labels within the shape above.
- Whether the invite pause permission needs a check before the call, and how to detect "already paused by someone else".
- How the join list is pruned and swept (the automod sweep is the model), and how the kick loop paces itself.
- The wording of the alert, the kick reason and the log lines in all three languages.
- How to test timing (injected clock, fake scheduler and fake guild, as the rollout and unverified-policy tests do).
- Which docs and tests to extend: `docs/testing-checklist.md`, the `docs/memory/` notes, `docs/discord-bot-setup.md`.

## Open points for the owner to check

- The default numbers marked **(call)**: 10 joins in 60 seconds, 7 days account age, 30 minutes, the ranges, the 100-kick cap.
- The pinged role defaulting to the bot manager role, and the alert being skipped when there is no mod-log channel.
- Kicking young accounts that join while the lockdown is on, and the manual `start`.
- `disable` ending an active lockdown first.
- Whether members who already hold the Verified role should be spared from the burst kick (currently they are not).
- That every human join counts toward the threshold, but only young accounts are kicked.
