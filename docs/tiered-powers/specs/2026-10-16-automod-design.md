# Auto-mod design

Phase 2, step 4 (after channel tools, before verification and anti-raid). Date: 2026-10-16.

## Intent
Servers need the bot to catch spam, unwanted links and invites, and bad words without a moderator watching. Auto-mod reuses the moderation pieces already built: warn cases, timeouts, the `modAction` mod log, the scheduler.

## Goals
- Rules: **spam**, **invites**, **links**, **bad words**, plus a **nickname/username check** that uses the bad-word list.
- Spam covers repeated messages, message bursts, caps, emoji spam and mass mentions. Each is a sub-check with its own limit; the builder picks sensible defaults.
- Each rule is a separate toggle with its **own action set**, chosen from: delete the message, warn (a normal case), timeout, mod log line.
- **Strike threshold** per rule: the first offence is always deleted (if delete is on); warn/timeout apply once a member has N violations of that rule inside a time window. Guess, not decided: default 3 strikes in 10 minutes, both configurable.
- Invites and links are **two independent rules**, each with an allow-list/block-list and its own action. A server's own invite is never blocked.
- Bad-word list: a **small built-in starter list in en/fr/ar** plus admin-added words; admins can also remove built-in words. Matching ignores case and accents and handles simple letter swaps.
- Nickname/username containing a listed word: rename the member to a placeholder such as `Moderated Nickname 1234` and post a mod log line. Warn/timeout is not applied to renames.
- Every enforcement posts a mod log line via `modAction`. Warns create normal cases so they show in `/warnings`.
- Exemptions (my guess, not decided by the user): members with Manage Server, the bot manager role and moderation permitted roles; plus admin-chosen exempt channels and roles.
- Off by default; Manage Server or bot manager role to configure; replies ephemeral. All text in `en`, `fr`, `ar`.

## Additions after comparing with YAGPDB and Carl-bot (user asked for these on 2026-10-16)
- **Honeypot channel:** one admin-chosen channel per server; anyone who posts there is punished with that rule's actions (delete, plus warn/timeout; the first post may punish immediately, builder's call on strikes). Exempt members are not punished.
- **Attachment spam and link-rate spam:** new spam sub-checks, with a limit of N per user inside S seconds. Link-rate counts links per user over time; it is separate from the links allow/block-list rule.
- **Identical-message detection:** the same message (after normalising case, spaces and accents) N times in a row by one member within S seconds.
- **Account-age condition:** a rule can be limited to accounts younger than a set age, or members who joined less than a set time ago (for example only apply the links rule to new members).
- **Edit checks:** edited messages are re-checked by every message rule, so editing a message cannot dodge a filter.
- **Timed role effect:** an optional action that gives a role (such as a "restricted" role) for a set duration, removed by a scheduler job when it ends.
- **Regex rules:** admins can add regex patterns to the bad-word rule (and to the nickname check). Patterns are validated when saved, limited in length and count, and run with a guard against catastrophic backtracking (builder picks the approach, for example a safe regex engine or a match time limit).
- Existing defaults (exemptions, strikes, per-rule actions) apply to all of these.

## Discord native AutoMod as a trigger (user asked for this on 2026-10-16, modelled on YAGPDB)
YAGPDB's "Message triggers Discord Automod" trigger (`automod/automod_bot.go` `handleAutomodExecution`, `automod/triggers.go` `AutomodExecution`) works like this, and we copy the approach:
- It listens to Discord's auto-moderation action execution event, then runs the same trigger pipeline as its own rules, so strikes and effects behave the same for native and own rules.
- It de-duplicates executions for 5 seconds on a key of content, rule id, user id and message id.
- It fetches the member and, if it still exists, the message before evaluating.
- The trigger has one optional setting, a native **rule id**; blank means any native rule.

For Jalter:
- Add a rule `native` (a **trigger**, not a scanner). On discord.js's `autoModerationActionExecution` event, resolve the member, skip exempt members, de-duplicate on rule id + user id + message id (in-memory, 5 seconds), and treat it as one violation of rule `native`.
- It uses the same pipeline as every other rule: strike counted per member in the window, the rule's own actions (warn, timeout, timed role, mod log line), threshold and reset. Delete is a no-op if Discord already blocked the message; if the message still exists and delete is on, delete it, and ignore a "message not found" error.
- Settings: optional list of native rule ids to react to (empty means all native rules), plus the usual per-rule actions and threshold. The mod log line names the native rule (name and id from the event) and the matched keyword if Discord gives one.
- Setup help: `/automod native` can list the server's native AutoMod rules (`guild.autoModerationRules.fetch()`) with their ids so admins can pick. Creating native rules from the bot is **not** in scope.
- Needs the `AutoModerationExecution` gateway intent and the Manage Server permission for the bot (Discord only sends the event to bots that hold it). Update invite permissions and the testing checklist.
- The native rule's own `alert message` or `block message` action keeps working as configured in Discord; we only add strikes, cases and logging on top.
- This makes the "hybrid" possible: an admin can let native AutoMod do keyword/spam/mention filtering and have Jalter add strikes, cases and nickname checks. Our own scanners stay available for people who want everything in one place.

## Ideas borrowed from YAGPDB's code (user said to edit the spec on 2026-10-16)
- **Tiered escalation, only the highest tier fires:** a rule's strike threshold can have steps (for example 3 strikes warns, 5 times the member out, 8 kicks). When a member reaches several steps, only the highest one reached runs. This replaces the single threshold in the Goals; one step is still valid. Strikes reset after the top step fires.
- **Automod history:** store which rules fired for each enforcement (member, rule names, message id, time, actions taken), keep the latest 200 rows per server (trim on insert), and add `/automod history [user]` to list them. Needs a migration.
- **One shared text normaliser:** a single `normalizeText()` (case, accents, simple letter swaps, repeated characters) used by the bad-word, regex, identical-message and nickname checks, run once per message.
- **Cheap checks first (implementation note):** check feature enabled, bot author, exemptions and account-age conditions before any scanning, then run the rules.
- Not adopted: shared named counters across rules and reusable named lists; the builder may add them later.

## Calls made after the builder check (my calls, not the user's)
- **Pipeline:** every violation deletes the message (if delete is on). Strikes are per member, per rule, in a sliding window. When the count reaches N, warn/timeout fire and that rule's strikes reset, so later violations start a new count. The mod log line is always posted for any enforcement (it is not an optional action; remove it from the per-rule action choices).
- **Several rules on one message:** evaluate all rules; each records its own strike and runs its own actions; merge into one mod log line listing the rules. Invites are excluded from the links rule.
- **Lists:** invites and links each have an allow-list and a block-list. Allow-list entries always pass. Otherwise a block-list entry blocks; a rule can also be set to "block everything not allowed". Links match by domain (subdomains included); invites by target server id, resolved with `fetchInvite` (cached; if lookup fails, treat as foreign and block). The server's own invites always pass.
- **Exemptions:** global, apply to every rule including the nickname check.
- **Nickname check:** runs on member join, on nickname change, and on a member's first message after a bot start. Username is checked at those same points. Rename at most once per member per 10 seconds to avoid loops. Needs the GuildMembers intent if not already present.
- **Timeout length and thresholds:** per rule, defaults 10 minutes and 3 strikes in 10 minutes.

## Non-goals
- Creating or editing Discord's native AutoMod rules from the bot (reacting to them is in scope, see the native trigger section).
- Anti-raid, verification (later steps).
- Image content scanning, machine-learning detection, a free-form rule builder like YAGPDB's, the Carl-bot drama channel and auto-purge, safe-file-type deletion.

## Anti-goals
- Never punish exempt members, the bot, or staff.
- A failed action (missing permission, deleted message) must not crash the bot or skip the other actions; log and continue.
- No false-positive floods: one message triggers at most one enforcement per rule, and one mod log line per message.

## Constraints
- Part of the moderation feature (like channel tools): off until `/moderation enable`, plus its own per-rule toggles. Code in `src/features/moderation/` or a sibling folder if it grows, registered through `src/modules.js`/`FEATURES`.
- Slash command group `/automod` (subcommands per rule: enable/disable, action, threshold, lists, exempt, status). `/help` picks up new commands automatically.
- Migrations for per-guild rule config and strike tracking; strike counts can be in memory if restart-loss is acceptable (builder's call, note it in gotchas).
- Requires the Message Content intent and the bot permissions Manage Messages, Moderate Members, Manage Nicknames. Update invite permissions docs and the testing checklist.
- Tests hit the DB (`npm test`, concurrency 1).

## Left to the builder
Exact defaults for spam limits, matching algorithm details, the starter word list, config schema, command option names, strike storage, and how timeouts reuse `runAction`.
