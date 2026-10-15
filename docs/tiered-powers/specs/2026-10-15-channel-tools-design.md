# Channel tools (Phase 2, step 3): design

Status: draft for approval (builder check done; its questions are answered in this text). Roadmap: `2026-10-14-feature-roadmap.md`, Phase 2 step 3. Builds on the moderation feature (`2026-10-14-moderation-design.md`).

## Intent and why

Moderators need quick ways to clean up and calm a channel: delete a batch of messages, wipe a channel completely, slow it down, or stop people talking for a while. The owner wants these for all the usual situations equally (spam and raid cleanup, heated arguments, everyday tidying), so the defaults are balanced: fast to use, with a visible notice where the whole channel is affected and a private reply where only the moderator needs to know.

## Goals

- `/purge messages count [user] [bots] [reason]`: delete recent messages in the current channel, optionally only from one member or only from bots.
- `/purge channel [channel] [reason]`: wipe the whole channel (the current one unless `channel` is given) by making an identical copy and deleting the old one, behind a confirm button.
- `/slowmode seconds [channel] [reason]`: set or clear the slowmode of one channel.
- `/lock [channel] [reason]` and `/unlock [channel] [reason]`: stop and restore @everyone's right to send messages in one channel. The reason is optional and, when given, is announced in the channel.
- Every action writes one line to the `mod` log. No case numbers (these are not punishments).
- Works for people with the Discord permission or a moderation permitted role, like the other moderation commands.
- All user-facing text in English, French and Arabic.

## Non-goals

- Whole-server lockdown, timed locks, scheduled slowmode (anti-raid and later steps may add them).
- Purging by message text, by date range, or by attachments.
- Purging or locking threads and forum posts (refused with a clear reply); voice, stage, category, rules and community-updates channels are refused for `/purge channel` and `/lock`.
- Restoring a purged channel's old messages, webhooks, invites or threads.

## Anti-goals (a failure even if it technically works)

- A whole-channel purge that wipes the wrong channel, runs for someone who did not click confirm, or leaves settings pointing at a channel that no longer exists.
- Lock or unlock changing permission bits other than SendMessages on @everyone, or locking out staff roles that were explicitly allowed to speak.
- The bot saying "done" when Discord refused, or half-finishing a channel replacement without telling the moderator.
- Ordinary members able to use any of these commands.

## What it does

**Permissions** (extend `ACTION_PERMISSIONS` in `src/features/moderation/rules.js`): `purge` needs ManageMessages; `purgeall`, `slowmode`, `lock` and `unlock` need ManageChannels. A permitted role may use all of them, like the other moderation commands. The bot itself must hold the permission in the target channel; when it does not, the moderator gets a localized refusal and nothing changes. Commands are registered with no default member permissions and checked in code; they need the moderation feature switched on (`guard(..., { requireManager: false })`).

**`/purge messages`**
- `count` 1 to 100 = how many messages to delete. The bot scans up to the 500 most recent messages, skips pinned messages and messages older than 14 days (Discord's bulk-delete limit), applies the filters (`user`: only that member; `bots`: only messages written by bots; giving both is refused with a localized "pick one"), and deletes up to `count` matches, newest first. The command's own reply is not counted.
- Reply is private (ephemeral): how many were deleted, and a note when fewer than `count` were found or old/pinned messages were skipped.
- The existing logging `messagePurge` event already records the deletion; the command adds one `mod` log line ("Purge by X in #channel: N messages", plus the reason). Both lines may appear; that is accepted.
- Works in text and announcement channels and in threads the bot can manage; other channel types are refused.

**`/purge channel`**
- `channel` is optional and defaults to the current channel. The confirm warning names the target channel (`<#id>`) so a wrong pick is visible before clicking.
- Private reply with a short warning (what will be lost: messages, pins, webhooks, invites, threads) and two buttons, Confirm and Cancel, valid for 2 minutes and only for the moderator who ran the command; the button carries the target channel id, so confirming always wipes the channel the warning named.
- On Confirm: (1) clone the channel (name, topic, NSFW flag, slowmode, permission overwrites, category, position); if cloning fails, stop, nothing changed; (2) move every setting that points at the old channel to the copy (list below); if that fails, delete the copy and stop, nothing changed; (3) delete the old channel; if that fails, tell the moderator the old channel is still there and the settings already point at the copy; (4) post a short notice in the new channel and the `mod` log line.
- Settings that store a channel id and are moved: logging `config.channels.<category>` and `config.ignore.channels`; greet, leave and boost `config.channelId`; media `config.channelId`. `setFeature` shallow-merges config, so whole nested objects are written back. All of these updates run in one database transaction, so either all of them move or none do (if the existing helpers cannot share a client, the builder adds a small transaction helper; no new tables). Anything not on this list does not store channel ids (checked against the code).
- Refused up front: a channel that holds media library items (`media_items.channel_id` = this channel). Those items point at messages inside it and would break, so the reply says to pick another channel or remove the items first. Old mod-log message links (`mod_cases.log_channel_id`, `log_message_id`) are not moved: `/reason` already ignores a missing log message, so after a purge of the mod log channel old cases still update in the database but their old log posts are gone.
- The clone uses discord.js `channel.clone()` (keeps type, topic, NSFW flag, slowmode, overwrites, category, default thread settings), then sets the same position. Announcement-channel followers and webhooks are lost; the confirm warning says so.
- Allowed only for guild text and announcement channels that are not the server's rules or community-updates channel.

**`/slowmode`**
- `seconds` 0 to 21600 (0 = off), `channel` defaults to the current one. Allowed in text channels and threads (not announcement channels: Discord does not support it there).
- When the value changes, a short public notice is posted in the channel ("Slowmode set to 10s by X" / "off"), with the reason when given. If the value is already that, reply privately and change nothing.

**`/lock` and `/unlock`**
- `channel` defaults to the current one. Allowed for text and announcement channels.
- Lock sets only SendMessages = deny on the @everyone overwrite (other bits kept; other roles' overwrites are untouched, so staff roles with an explicit allow keep speaking). A short public notice ("Channel locked by X", with the reason when given) is posted in the channel. Already locked = private reply, no change.
- Unlock sets only SendMessages back to "unset" on @everyone and posts "Channel unlocked". Already unlocked = private reply, no change.
- Known limits (nothing is stored for locks): if @everyone had an explicit SendMessages *allow* before the lock, unlock returns it to "unset", not to "allow"; and unlock cannot tell its own deny from an admin's deliberate one (for example a read-only channel), so unlocking such a channel makes it writable. The unlock reply just says "unlocked".

**Who may target which channel:** the permitted-role rule still applies, but the moderator must be able to see the target channel (View Channel in it) for `/purge messages`, `/purge channel`, `/slowmode` and `/lock`/`/unlock` with a `channel` option; otherwise the reply says they cannot use it there. The bot must hold View Channel, Send Messages (for the notice) and the action's own permission in the target channel; a missing action permission refuses the command. Order for lock, unlock and slowmode: apply the change first, then post the public notice best effort; a failed notice is reported to the moderator as a short note, not as a failed action.

**Replies and records:** moderator replies are private (ephemeral) except the public notices above. The `mod` log line is an ordinary embed through `sendLog(ctx, guildId, 'modAction', embed)`; no case is created, no case number is used.

## Constraints

- Node 22 ESM, discord.js 14, existing structure: new commands live in `src/features/moderation/`, wired through `src/features/moderation/index.js` and the `moderation` registry entry (add `purge`, `slowmode`, `lock`, `unlock`); button handling goes through the `components` mechanism of the loader.
- No new dependencies; no new database tables (the purge-channel step only updates existing columns/JSON).
- All user text in `src/i18n/en.json`, `fr.json`, `ar.json`, flat dotted keys, `{name}` placeholders, parity enforced by `test/i18n.test.js`. Slash option descriptions 1 to 100 characters.
- The bot invite permissions gain Manage Messages (Manage Channels is already there); update README and the setup doc.

## Calls I made (override any of them)

- Commands are subcommands of `/purge` (`messages`, `channel`), not separate top-level commands.
- `/purge channel` takes an optional `channel` (owner's call), default the current channel.
- Purge `count` means messages deleted, scanned from the latest 500; `user` and `bots` cannot be combined.
- Whole-channel purge is clone-and-replace with a confirm button and automatic migration of stored channel ids; the new channel gets the same position and permissions.
- Lock/unlock store nothing, with the limits above.
- A permitted-role holder may run every command here, including `/purge channel`, as long as they can see the channel; this is the one call that widens power for destructive action, so the owner may want `/purge channel` to need the real Manage Channels permission instead.
- `/purge channel` is refused for a channel that holds media library items; old mod-log post links are not moved.
- The settings move runs in one transaction.
- Public notices only for lock, unlock and slowmode; everything else private.

## Left to the builder

- Exact wording of every localized string, embed layout, and button styling.
- How the confirm button's custom id and expiry are encoded.
- How to batch deletion and how many messages to fetch per request, within the 500-scan cap.
