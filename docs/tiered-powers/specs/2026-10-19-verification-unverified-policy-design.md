# Verification: what happens to members who never verify (design)

Status: design, not built. Extends `2026-10-17-verification-design.md` (built on `phase-2`). Items marked **(call)** are choices the designer made without the owner saying so; the owner should check them while reading.

## Intent and why

Verification locks newcomers out of the server until they verify, but today someone who never verifies stays in the member list forever as a dead account. The owner wants the admin to decide what happens to them: nothing, removal after a set time, or a warning first and removal later. The earlier verification design listed this as a non-goal ("Kicking, banning or timing out people who never verify"); this design reverses that non-goal, and the decision note in `docs/memory/decisions.md` must say so.

## Goals

- A per-server setting, `/verification unverified`, with three policies:
  - **none** (the default; exactly today's behaviour);
  - **kick**: a member who has not verified is kicked after a set time (default **24 hours**);
  - **warn_kick**: the member is warned at one time and kicked at a later one.
- The admin chooses the times. Times use the existing duration format (`30m`, `24h`, `2d`, as in `src/core/duration.js`).
- The warning is a **real moderation warn case** (it appears in `/warnings`, in the mod log, and gets a case number) and, through the moderation engine's own DM setting, a private message. The kick is a **real moderation kick case** with the reason "did not verify within <time>". The bot is recorded as the moderator.
- The policy covers **only members who join after the policy is saved**. Members already waiting unverified, and the grandfathered ones, are left alone, and changing the times later only affects later joins.
- Bots are never touched. Members the bot cannot kick anyway, and members with the bot manager role, are skipped (see "Who is spared").
- Verifying at any point before the deadline stops everything for that member.
- Everything survives a bot restart (scheduled jobs, same machinery as the rollout jobs).
- All user-facing text in English, French and Arabic (captcha text stays English as before).

## Non-goals

- A different time per member or per role, a "second chance" button, or an appeal flow.
- Banning, timing out, or any action other than warn and kick.
- Acting on members who were already waiting when the policy was turned on or changed.
- Penalties for coming back after a kick (the person can rejoin and gets a fresh clock).
- Anti-raid behaviour (still its own later step).

## Anti-goals (a failure even if it technically works)

- Kicking a member who verified, left, or was never subject to the policy (bots, staff, people who joined before the policy).
- Kicking, or warning, while verification is off or removed: if the feature is not active, nothing happens.
- Two kicks, two warnings, or a kick without the warning when the policy says warn first. A restart or a rerun of a job must never act twice.
- A kick that quietly fails and leaves the admin believing the policy works: a failure must reach the mod log.
- Locking out the admin who sets a bad value: bad times are refused with a clear message, not saved.

## What the admin sees

`/verification unverified policy:<none|kick|warn_kick> [kick_after:<time>] [warn_after:<time>]`

- Only `policy` is required. `kick_after` defaults to **24h** when never set; once set it is remembered. `warn_after` is used only by `warn_kick`; when never set it defaults to **half of `kick_after`** **(call)**.
- Rules, checked when saving, with a clear refusal reply: `kick_after` between **10 minutes and 30 days** **(call; 30 days is `MAX_DELAY` in `src/core/duration.js`)**; for `warn_kick`, `warn_after` must be earlier than `kick_after` and leave at least **10 minutes** **(call)** between the warning and the kick, so the person can still act.
- Saved values are kept even when the policy is `none`, so switching back on is one option.
- The command is guarded like the other `/verification` subcommands (manager) and replies privately. Setting the policy works before setup as well as after; it only takes effect while verification is running (state `rolling_out`, `active` or `failed`).
- `/verification status` shows the policy and the times. `/verification remove` also cancels every pending warn and kick job.
- Switching the policy to `none` cancels the pending jobs. Any other change (for example `kick` to `warn_kick`, or new times) leaves jobs already queued exactly as they were **(call)**: each job carries the policy it was queued under, so a member who joined under `kick` is never kicked "as if warned", and a member who joined under `warn_kick` still gets the warning and the kick they were queued for. Only later joins use the new settings.

## How it runs (the admin never sees this)

- When a **human** member joins and verification is running and the policy is not `none`, two scheduled jobs are queued for that member, due at join time + `warn_after` (only for `warn_kick`) and join time + `kick_after`. A returning member gets fresh jobs. The times used are the ones saved at join time.
- Job types are `verification.warn` and `verification.kick`, keyed by the member id, handled through the shared scheduler like `verification.grant` and `verification.gate`.
- A successful verification (button, captcha or manual verify) cancels that member's jobs. A member leaving cancels them too; a job that finds the member gone does nothing.
- When a job fires it re-checks everything: feature enabled, state still running, the policy is not `none`, member still in the server, member still without the Verified role. If any check fails it does nothing. It does not re-read which policy applies: it uses the one it was queued with.
- Members who join while the rollout is still `rolling_out` follow the same rule as other new joins: they are not given Verified (the existing design), so they get jobs like any new member.
- **Warn**: calls the moderation engine's warn with the bot as actor and a reason in the server language that tells the person to verify in the verify channel before the kick time. The engine sends the DM if moderation's own DM setting is on and records the case and mod-log line. A closed DM only adds a "DM failed" note in the log; the warn case is still recorded.
- **Kick**: calls the moderation engine's kick with the bot as actor and the reason "did not verify within <time>". If the kick is refused or fails (the bot lost the Kick Members permission, the member's role is above the bot, Discord error), the verification feature writes one line to the mod log saying who and why, and does not retry **(call)**.
- If the **warn** is refused or fails (the moderation engine can refuse it, for example because of role hierarchy), the verification feature writes one line to the mod log with the reason, and **the kick for that member is skipped too** **(call)**: under `warn_kick` nobody is kicked without having been warned. The kick job decides this by checking whether the warn job recorded a refusal or failure for that member (stored in the kick job's own data when the warn job fires, or by the warn case existing in the case store; how is left to the builder).
- A warning is not repeated, and a restart or rerun of a job never produces a second case.

## Who is spared

At the moment a job fires, it skips (and does not log as an error) a member who is a **bot**, the **server owner**, someone whose highest role is at or above the bot's, someone holding the **bot manager role** (the one set with `/panel manager-role`), or someone with the **Manage Server** permission **(call: the owner said "bots and staff"; this is the definition of staff, using the same notion of manager as `guard`)**. Skipped members are simply left as they are.

## Constraints

- The moderation engine (`runAction` in `src/features/moderation/actions.js`) is the only way a warn or kick is created, so cases, the mod log, DM text and the per-server moderation settings behave exactly as for a moderator's own `/warn` and `/kick`. The moderation feature does not have to be enabled for this to work, but when it is off no moderation settings exist and the defaults apply **(call)**.
- The warn case counts as an ordinary warning (it is visible in `/warnings`). Anything else that counts warnings counts this one too; that is intended and must be mentioned in the docs.
- Config lives in the existing verification config JSON and is written merge-style (the config holds extra keys such as `grantDone` that must survive). New keys: the policy, `kick_after`, `warn_after` (seconds).
- No new database table or migration is needed (jobs use the shared scheduler).
- Reuse, do not rewrite: `parseDuration`/`formatDuration`, `scheduleJob`/`cancelJobs`, `runAction`, `logVerification`, `sendLog`.

## Left to the builder

- Exact command option names and choice labels, within the shape above.
- How jobs are queued on join (the existing `GuildMemberAdd` handler in `events.js` is the natural place).
- The exact wording of the warn reason, the kick reason and the log lines (all three languages), within the content above.
- How to test the timing (injected clock and fake scheduler, as the rollout tests do).
- Which existing docs and tests to extend: `docs/testing-checklist.md`, the `docs/memory/` notes, `docs/discord-bot-setup.md` if a permission becomes newly needed (Kick Members for the bot).

## Open points for the owner to check

- The times and limits marked **(call)**: default warn time of half the kick time, the 10 minute / 30 day limits, the 10 minute gap, no retry after a failed kick, jobs keeping the policy they were queued under, and no kick when the warn was refused.
- The definition of "staff" used for sparing members.
