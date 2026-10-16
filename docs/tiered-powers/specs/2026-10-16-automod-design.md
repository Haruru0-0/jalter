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

## Calls made after the builder check (my calls, not the user's)
- **Pipeline:** every violation deletes the message (if delete is on). Strikes are per member, per rule, in a sliding window. When the count reaches N, warn/timeout fire and that rule's strikes reset, so later violations start a new count. The mod log line is always posted for any enforcement (it is not an optional action; remove it from the per-rule action choices).
- **Several rules on one message:** evaluate all rules; each records its own strike and runs its own actions; merge into one mod log line listing the rules. Invites are excluded from the links rule.
- **Lists:** invites and links each have an allow-list and a block-list. Allow-list entries always pass. Otherwise a block-list entry blocks; a rule can also be set to "block everything not allowed". Links match by domain (subdomains included); invites by target server id, resolved with `fetchInvite` (cached; if lookup fails, treat as foreign and block). The server's own invites always pass.
- **Exemptions:** global, apply to every rule including the nickname check.
- **Nickname check:** runs on member join, on nickname change, and on a member's first message after a bot start. Username is checked at those same points. Rename at most once per member per 10 seconds to avoid loops. Needs the GuildMembers intent if not already present.
- **Timeout length and thresholds:** per rule, defaults 10 minutes and 3 strikes in 10 minutes.

## Non-goals
- Using Discord's native AutoMod rules.
- Anti-raid, verification (later steps).
- Image/attachment scanning, regex rules from users, machine-learning detection.

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
