# Verification (Phase 2, step 5): design

Status: design, not built. Roadmap: `2026-10-14-feature-roadmap.md`, Phase 2 step 5 (anti-raid, step 6, depends on it). Items marked **(call)** are choices the designer made without the owner saying so; the owner should check them while reading.

## Intent and why

Anyone who joins the server must prove they are a real person before they can read the server or chat in it. Until then they see only a verify area, plus the few channels Discord Onboarding needs to be public; in those public channels they can read but anything they try to send is not sent. Passing verification unlocks the server. The owner wants this to work with Discord's own Onboarding, not replace it.

## Goals

- A **Verified** role is the gate. A member without it is unverified. A member who holds it is verified.
- Two modes, chosen by the admin, one at a time:
  - **Button**: a Verify button in the verify channel; one click verifies.
  - **Captcha**: the same button, but it shows an image captcha that the person must type correctly.
- Unverified members:
  - can see the verify channel, and the **public channels** (see below);
  - cannot send messages, create threads, react or use application commands in the verify channel or any public channel;
  - cannot see any other channel.
- Admin setup in one command that creates what is missing (role, verify channel, verify message), shows a preview, and applies the permission changes to every channel on confirmation.
- Two admin-managed channel lists (see "Channel lists"): **public** channels (visible to unverified, sending blocked) and **skipped** channels (left exactly as they are).
- When verification is first switched on, **every member already in the server** (bots included) gets Verified, so nobody is locked out. New members and newly added bots after that follow the rules below.
- Failed captcha attempts: the person gets a fresh image after a short cooldown. Nothing punitive.
- Staff can verify or un-verify a member by hand.
- Every action that matters writes a line to the `mod` log (no case numbers).
- All user-facing text in English, French and Arabic.
- A way to undo the permission changes.

## Non-goals

- Kicking, banning or timing out people who never verify. They stay locked out with no timer.
- Staff approval queues, questions written by the admin, or any verification step other than the button and the image captcha.
- Replacing or configuring Discord Onboarding / Rules Screening (the bot cannot, and does not try to).
- Anti-raid behaviour (lockdown, raising the mode automatically). Verification only exposes a plain way to change the mode so anti-raid can use it later.
- Per-channel exceptions beyond the two lists, or per-role exceptions (staff are verified like everyone else).
- Re-verifying existing members.

## Anti-goals (a failure even if it technically works)

- Locking out existing members, staff or other bots when verification is switched on (members must be granted Verified **before** any channel is hidden).
- Giving Verified (or anyone) access to a channel that ordinary members could not see before setup (private staff channels must stay private).
- Changing any permission bit other than the ones listed in "What it does", or touching another role's overwrites.
- The gate failing open: if the bot is down when someone joins, they must still be unverified (they simply have no role).
- Leaving the server half-converted without telling the admin (setup is interrupted, restarted or partly refused by Discord).
- A captcha that can be answered without seeing the image, or a code reusable by someone else.

## What it does

**Feature and commands.** A new feature `verification` (registry entry exists as a "coming soon" stub; replace it). Off by default like other features. All commands need the manager check (`guard`, Manage Server or the bot manager role) and reply privately (ephemeral). Subcommands of `/verification`:

- `setup [mode] [role] [channel]`: choose mode (`button` default, `captcha`), optionally an existing role and channel; missing ones are created. Role is created with **no permissions**, named "Verified" (localized to the server language at creation), no colour, not hoisted, not mentionable **(call)** and placed just below the bot's top role; the verify channel is created with the existing auto-channel helper conventions (needs Manage Channels). Shows a preview (below) with Confirm and Cancel buttons, valid for 2 minutes and only for the admin who ran it.
- `mode <button|captcha>`: change mode; edits nothing else; the verify message keeps working.
- `public add|remove|list <channel>` and `skip add|remove|list <channel>`: manage the two lists. Changing a list on a server that is already set up applies to that channel right away (same rules as setup) and asks for no confirmation.
- `verify <member>` and `unverify <member>`: give or take the Verified role by hand; refused for members the bot cannot manage (hierarchy), for bots on `unverify`, and when verification is not set up.
- `status`: mode, role, verify channel, rollout progress, lists, channels changed.
- `remove`: undo (below).
- Enable and disable use the shared toggle. Disabling pauses the button (it answers "verification is off") and stops granting; it does not undo permissions.

**Channel lists (what the gate does to each channel).** Every channel (and category) in the server is exactly one of:

1. **Skipped**: untouched. If the admin skips a channel that members can read and write today, unverified people can too; the preview warns about that.
2. **Public**: unverified can view and read history; sending is blocked. The overwrite denies, for `@everyone`: Send Messages, Send Messages in Threads, Create Public Threads, Create Private Threads, Add Reactions, Use Application Commands; allows for Verified: the same bits. Intended for Onboarding's default channels, rules, announcements. Voice and stage channels in this list get Connect and Speak denied instead.
3. **The verify channel**: `@everyone` can view and read history; the same sending bits as a public channel are denied; Verified is denied View Channel so the channel disappears after verification (**(call)**). The Verify button works because button interactions do not need Send Messages.
4. **Gated** (everything else): `@everyone` is denied View Channel; Verified is allowed View Channel (and nothing else).

Only channels where `@everyone` can currently view are changed. "Can view" means the **computed permission of the `@everyone` role alone** in that channel (the server-wide `@everyone` View Channel bit, adjusted by the channel's `@everyone` overwrite); other roles and member overwrites are ignored for this test, which is what keeps channels that only some role can see untouched. **(call)** A channel that ordinary members already cannot view is left exactly as it is, so Verified never opens a private channel. The public list is the only way a channel becomes visible to unverified people; adding a channel to it that `@everyone` cannot view today is refused.

**Categories and synced channels.** The builder decides how to treat categories and channels that sync with their category (change the category once and detach/keep sync, or write each channel). Invariants: the resulting effective access is as above for every channel; sync status of channels the bot did not need to change is preserved; and a channel the bot edited is recorded for undo.

**Preview.** Before applying, the confirm reply shows counts: channels to gate, public, skipped, left alone because already private, and the members who will be granted Verified. It names any channel where **a role other than Verified has an explicit View Channel allow** that will keep that channel visible to people holding that role even when unverified (for example a role given automatically on join) so the admin can fix it. The warning is informational; it does not block setup.

**State.** The feature keeps a setup state: `none`, `rolling_out`, `active` or `failed`. The feature is switched on when the admin confirms setup (state `rolling_out`). The Verify button, the bot-joins handler and the new-channel handler all work in `rolling_out` and `active`; only `none`/disabled turn them off. **(call)** Running `setup` when the state is not `none` is refused with a message to run `remove` first (re-posting the verify message or changing the role or channel is not supported in this version). **(call)**

**Rollout order (must not change).** On Confirm: (1) create role, channel and the verify message if missing; (2) grant Verified to every member who was in the server at the moment of Confirm, bots included, in batches under Discord's rate limits through the scheduler (members who join afterwards are not granted, and they verify through the button like any newcomer, which works from step 1 on **(call)**); (3) only when step 2 is finished, apply the channel changes in batches, recording each channel's previous `@everyone` and Verified overwrite bits (a missing overwrite is recorded as "none", distinct from an overwrite with zero bits, so undo deletes what it created and restores what existed; the **first** record for a channel is the original and is never overwritten by later list changes, which always compute their target from it) **(call)**; (4) mark verification enabled and post the finished notice in the admin's reply or the mod log. Both batch steps are scheduler jobs that survive a restart and are idempotent; `/verification status` shows progress. The gate is not enforced until step 3 begins for a channel, so a restart or failure mid-way leaves a state that only ever errs toward more access, never lockout.

**Newcomers.**
- A human who joins gets no role. They see the verify channel and public channels.
- A bot that joins is granted Verified by the bot immediately (a bot that is added while verification is on must keep working). **(call)**
- A channel created after setup follows the same rules as existing ones: a new channel that `@everyone` can view is gated automatically unless it is in the public or skipped list; failures are logged as a warning to the admin via the mod log. **(call)** A moved or renamed channel needs nothing.

**The bot's own access.** The verify channel gets an explicit overwrite for the bot's member (View Channel, Send Messages, Read History, Embed Links, Attach Files, Manage Messages) so the bot keeps access after it is granted Verified itself. Members with Administrator ignore overwrites and are unaffected. **(call)**

**Channel types.** Voice and stage channels in the public list keep View Channel for `@everyone` and also get Connect and Speak denied, plus the sending bits (their built-in text chat). Forum and media channels are supported with the same bits (in Discord's permission model "Create Posts" is Create Public Threads, so the listed bits cover it; the builder verifies this against the API). Threads inherit from their parent and are never edited. Announcement channels behave like text channels. **(call)**

**Verify message.** The bot posts one message in the verify channel with a single Verify button (localized to the server language). The button uses the loader's component routing with a feature prefix. Clicking when already verified answers privately that they are verified. Clicking when verification is disabled answers privately and does nothing.

**Button mode.** One click grants Verified and answers privately. Rate limit: one grant attempt per person at a time.

**Captcha mode.** Clicking replies privately with an image of a random code and a button to enter it; the entry opens a short form (modal) with one text field. Details:
- Code: 5 characters, letters and digits without easily confused ones (no 0/O, 1/I/l), case-insensitive on entry. **(call)**
- Valid 5 minutes, single use, held in memory per person (lost on restart; the person simply clicks Verify again). A new click replaces the old code.
- A wrong entry counts a failure; after 3 failures there is a 30-second cooldown, then a new code and image. **(call)**
- Correct entry grants Verified and answers privately.
- The image is generated by the bot, distorted and noisy enough that reading the code requires seeing it; it is sent as an ephemeral attachment and never stored.
- Library: the builder picks one. Constraint: it must install without a compiler on Windows, Linux and macOS (a prebuilt binary is fine if the version works with the Node range `^22.22.2 || ^24.15.0 || >=26.0.0`, as `re2` does); fall back to a pure-JavaScript renderer if none qualifies. **(call)** on mode-independent defaults (code length, timing).

**Manual verify and un-verify.** `verify` adds the role; `unverify` removes it. Both write a `mod` log line naming the staff member. `unverify` does not kick or otherwise punish.

**Undo.** `remove` restores every recorded channel's previous `@everyone` and Verified overwrite bits for the bits the gate changed (leaving any later hand edits to other bits alone), deletes the verify message, and disables verification. It leaves the role and the verify channel in place (the admin deletes them if wanted) and does not remove Verified from anyone. If some channels fail to restore, it reports exactly which.

**Logging.** One `mod` line (through the hidden `modAction` event) for: setup confirmed, rollout finished or failed (with counts), a member verified (mode and method, button/captcha/manual), manual verify and un-verify, undo, and a warning when a new channel could not be gated. Failed captcha attempts are not logged one by one. **(call)**

**Permissions the bot needs.** Manage Roles (create the role, grant it; the Verified role must sit below the bot's top role), Manage Channels (create the verify channel, edit overwrites), View Channel and Send Messages in the verify channel, Embed Links, Attach Files (captcha image). The Server Members intent is already on. Setup refuses with a clear message when one of these is missing.

## Constraints

- Node 22+ ESM, discord.js 14, existing structure: `src/features/verification/` wired through `src/modules.js` and the registry; commands are registered with no default member permissions and checked in code with `guard`; button and modal handling through the loader's `components` mechanism with a feature prefix.
- Reuse: `core/scheduler.js` for the two rollout jobs (handlers idempotent, return rather than throw on permanent Discord errors), `core/auto-channel.js` conventions for the verify channel, `core/role-safety.js` (`botCanGive`) for the Verified role, `sendLog` through `modAction` for the mod log.
- One new table for the undo record (guild, channel id, previous `@everyone` allow/deny bits, previous Verified allow/deny bits, changed-at), migration 008; settings (mode, role id, channel id, message id, lists, state) live in `guild_settings` like other features. The builder may change the table shape if it keeps the undo guarantee.
- All user text in `src/i18n/en.json`, `fr.json`, `ar.json`, flat dotted keys, `{name}` placeholders, parity enforced by `test/i18n.test.js`.
- Tests hit the DB (`node --test --test-concurrency=1`); fake guilds, members and channels as the existing tests do.
- Docs: update `docs/testing-checklist.md`, `docs/discord-bot-setup.md` (permissions) and the `docs/memory/` notes; new commands need `npm run deploy`.

## Left to the builder

Which exact image library; how categories and synced channels are handled (within the invariants); batch sizes and delays under Discord's rate limits; the modal and button ids; wording of all replies (kept short, three languages); whether the undo record lives in a table or in settings JSON; how `status` formats progress.

## Open points the owner has already settled

- Admin picks button **or** captcha; image captcha chosen over a simple question.
- Existing members are all granted Verified on first switch-on.
- Never-verified members stay locked out with no timer.
- Failed captcha attempts: fresh code after a short cooldown, nothing punitive.
- Setup is automatic across all channels, with a way to exclude channels; Discord Onboarding needs some channels visible to everyone, and unverified members' messages there must not be sent.
