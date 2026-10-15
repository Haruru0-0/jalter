# Moderation (Phase 2, step 1): design

Status: built on branch `phase-2` (Tasks 1 to 9 of the plan; final review pending). Roadmap: `2026-10-14-feature-roadmap.md`, Phase 2 steps 1 and 2 (cases, commands and timed actions are built together here).

## Intent and why

The owner wants Jalter's moderation to work "like YAGPDB". The reference pages are <https://help.yagpdb.xyz/docs/moderation/moderation-tools/> and <https://help.yagpdb.xyz/docs/moderation/logging/>. YAGPDB gives moderators a small set of commands (timeout, mute, kick, ban, unban, warn and a warnings manager, `/reason`), numbers every action, posts each one to a mod log channel, can DM the offender, and has per-server settings. Jalter already has a `mod` logging category waiting for this, a shared scheduler for timed actions, and a feature registry slot (`moderation`, currently "coming soon").

## Goals

- Moderators can warn, timeout, mute, kick, ban and unban from slash commands, and manage warnings, with the same shape as YAGPDB.
- Every action becomes a numbered **case** (per server: 1, 2, 3 ...) stored in the database and posted to the logging feature's `mod` category.
- Bans and mutes can have a duration and end on their own, surviving a bot restart (uses the shared scheduler).
- Server admins configure it with a `/moderation` settings command (enable/disable, status and the options below).
- Moderators cannot act on people they should not (see anti-goals), and always get a clear reply when the bot cannot do something.
- All user-facing text exists in English, French and Arabic.

## Non-goals (later steps or deliberately left out)

- `/clean` / purge, slowmode, lock (Phase 2 step 3), `/report`, `/giverole` and `/removerole`.
- Auto-mod, verification, anti-raid (Phase 2 steps 4 to 6). Automatic action after N warnings is not built (YAGPDB has none either); auto-mod will add it.
- Message-log snapshots with a web viewer (YAGPDB's `/logs`): Jalter has no web server.
- Customizable DM templates: the offender DM text is fixed (translated) and can only be switched on or off.
- Cases for actions taken outside the bot (YAGPDB's "external logging"): the logging feature already logs bans, unbans and timeouts with a "By" field.
- Deleting a kicked member's recent messages; removing other roles while muted.

## Anti-goals (a failure even if it technically works)

- A moderator ending up able to ban, kick, mute or timeout the server owner, themselves, a bot above them, or anyone whose highest role is equal to or above their own or the bot's.
- A temp ban or mute that never ends because the bot restarted or crashed.
- Duplicate or skipped case numbers when two moderators act at the same moment.
- The bot saying "done" when Discord refused the action, or going silent when it cannot DM or cannot post to the mod log (both must be handled without failing the action).
- Moderation commands usable by ordinary members.

## What it does (decided with the owner: "do it like YAGPDB"; details below are my calls and marked)

**Commands** (top-level slash commands, like YAGPDB; every one except `/warnings list` and `/warnings top` needs the action's Discord permission or a permitted role):
- `/warn user reason` · `/warnings list user` · `/warnings edit id reason` · `/warnings delete id` · `/warnings clear user` · `/warnings top` (server ranking by active warning count).
- `/timeout user [duration] [reason]` — Discord's native timeout, 60 seconds to 28 days, default from settings (10 minutes). `/untimeout user [reason]`.
- `/mute user [duration] [reason]` and `/unmute user [reason]` — the configured mute role; no duration means until unmuted.
- `/kick user [reason]`, `/ban user [duration] [delete_days] [reason]`, `/unban user [reason]` (user given as a mention or ID; unban must work for people not in the server).
- `/reason case reason` — edit the reason of a past case (and update its mod log message if the bot still can).
- `/moderation enable|disable|status` plus option commands (see Settings).

**Cases:** one row per action with case number, type (warn, timeout, untimeout, mute, unmute, kick, ban, unban), target, moderator, reason, optional duration and end time, creation time, and the mod log message reference. A warning's id is its case number. Deleted or cleared warnings are marked inactive, not erased, so case numbers never move; edits keep the case.

**Mod log:** each case posts an embed (case number, type, target, moderator, reason, duration) through the logging feature as a new event in the `mod` category, so `/logging set category:mod`, `/logging event` toggles and the status view work. If logging is off or no channel is set, the action still succeeds.

**DMs:** by default the offender is DMed for warn, timeout, mute, kick and ban with the reason (and duration). A failed DM (closed DMs) never fails the action. A setting turns DMs off.

**Settings** (`/moderation ...`, Manage Server or bot manager role as elsewhere): `reason-required` (default on, like YAGPDB; when on, actions without a reason are refused), `dm` on or off, `timeout-default` (duration), `ban-delete-days` (0 to 7 default for `/ban`), `mute-role` (role; with an optional one-time "apply to all channels" that denies Send Messages, Add Reactions and Speak for that role), `permitted-role add|remove` (roles that may use the moderation commands without the Discord permission; max 10), `status` (shows everything).

**Timed actions:** `/ban duration` and `/mute duration` schedule a `mod.unban` or `mod.unmute` job on the shared scheduler with a key per server and user, so a second timed action replaces the first; a manual `/unban` or `/unmute` cancels it. The handlers are idempotent (unban if still banned) and finish quietly on permanent Discord errors, per the scheduler's rules. A muted member who leaves and rejoins before the mute ends gets the mute role back (my call).

**Rules for who can be acted on:** never the server owner, the bot itself, or the moderator themselves; never a member whose highest role is at or above the moderator's, or at or above the bot's; bots may be actioned like members if the role rules allow. Refusals say why.

## Constraints

- Node 22, ESM, Postgres, discord.js 14, `node --test`; follow the structure of existing features (`src/features/<name>/`, `commands` and `events`/`jobs` exports, `guard()`, config through `setFeature`/`getFeature`, ephemeral replies for settings).
- Features stay off by default: `moderation` must be switched on (`/moderation enable`) before the action commands work; they reply with the standard "feature is off" message otherwise.
- All user-facing text in `src/i18n/{en,fr,ar}.json` (`test/i18n.test.js` enforces parity).
- Register the commands in `src/modules.js` and replace the `moderation` stub in `src/core/registry.js` so `/panel` and `/help` list it.
- Reuse the duration parser in `src/features/autorole/duration.js` (move it to a shared place if needed).
- New bot permissions to document in the README and `docs/discord-bot-setup.md` invite lists: Kick Members, Ban Members, Moderate Members (Manage Roles is already there). Update `docs/testing-checklist.md`, `docs/memory/` and the roadmap.
- Commits carry no Co-Authored-By lines; do not change git identity.
- Slash option choices max 25, command descriptions max 100 characters.

## Left to the builder

Exact command and option shapes within the list above, table layout and the safe way to hand out case numbers, how the mod log message is stored and edited, file layout, how the mute-role channel overrides are applied (and failure reporting for channels the bot cannot edit), the exact order of checks, and test structure.

## Calls I made after the builder check (not discussed with the owner; change any you disagree with)

- **Mod log message reference:** `sendLog` is changed to return `{ channelId, messageId }` (or `null` when nothing was posted). The case stores both ids, so `/reason` still finds the message after `/logging set` moves the channel; if the message is gone `/reason` just updates the case.
- **Double logging:** a `/ban`, `/unban` or `/timeout` by the bot also fires the logging feature's existing `ban`, `unban` and `timeout` events (members category, "By" shows the bot). That is left as is: the mod case embed is the authoritative record, and a server that dislikes the duplicate can turn those events off with `/logging event`.
- **Who sees warnings:** `/warnings list` takes an optional user: a member may list their own warnings (ephemeral); listing someone else's, `edit`, `delete`, `clear` and `top` need moderator rights. This replaces the looser wording above ("every command except list and top").
- **Permitted roles:** one list per server; a member with a listed role may use every moderation action command (warn, warnings management, timeout, untimeout, mute, unmute, kick, ban, unban, reason) even without the matching Discord permission. It does not bypass the "feature is off" check, `reason-required`, or the who-can-be-acted-on rules, and it never grants `/moderation` settings. Commands are registered with no default member permission so permitted-role holders can see them; the check happens in code. This is a deliberate privilege grant by the server admin, as in YAGPDB.
- **Mute state:** a user is "currently muted" when their latest mute case has no later unmute case and has not ended; no separate table. `/mute` with no mute role configured (or a deleted role) is refused with a message; it does not fall back to a timeout. A timed unmute whose role or member is gone finishes quietly.
- **Automatic expiry:** when a timed ban or mute ends, the handler creates an unban or unmute case attributed to the bot user and posts it to the mod log, reason "Timed action expired".
- **Limits:** durations are at least 1 minute; timeout at most 28 days; ban and mute have no maximum. `/ban` on an already-banned user and `/mute` on an already-muted user are refused. A new timed ban or mute on a user with a pending one replaces it.
- **Warnings are mutated, not re-cased:** `edit`, `delete` and `clear` change the warn case(s) only and post nothing to the mod log. `/warnings top` counts all active warnings (no expiry). `/reason` may edit any case type and any moderator may use it, and always requires a non-empty reason.
- **Order of operations:** DM the offender first (best effort) for kick and ban, and for the other actions as well to keep one rule; then do the Discord action; create the case (and number) only after the action succeeds, so failed attempts consume no case numbers; then post the mod log. If the action succeeded but saving the case failed, the moderator is told the action happened but was not recorded, and the error is logged.
- **`reason-required`** applies to warn, timeout, mute, kick and ban. The undo actions (`untimeout`, `unmute`, `unban`) and `/warnings clear` never require one.
