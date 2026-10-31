# Autoresponder stage 3: buttons

Status: draft, waiting for the builder check and owner approval. Parent design: `2026-10-24-autoresponder-design.md` (its "Stage 3 (buttons)" section is the starting point; this document refines it). Stages 1 and 2 (`2026-10-24-autoresponder-stage2-design.md`) and the interactive builder (`2026-10-24-autoresponder-builder-design.md`) are built on `phase-3`. Prior art: Mimu's button responders (https://docs.mimu.bot/autoresponder).

## Intent and why

An autoresponder reply can carry buttons. Each button runs its own script when someone presses it, so a reply can become a small interaction: "Show the rules", "Roll again", a yes/no confirmation only the asker can answer, or a claim button that works once. Reaction roles already covers pure "press for a role" buttons, so this stage is about buttons that run any script, not role handout.

## Decisions by the owner

- **Not a role-button feature.** A button may change a role through its script like any rule can, but role buttons stay with reaction roles.
- **A press keeps the original context.** The words and random results from the message that created the buttons are remembered, so `[$1]`, `{requirearg}` and checked users keep working when a button is pressed.
- **The reply is public.** What a button's script says is posted in the channel (as a reply to the button's message), not shown privately.
- **Builder:** the interactive builder gets controls for buttons too (as in stage 2; my reading of the owner's earlier "both").
- **Commands:** `/autoresponder button add|edit|remove|list`.

## Goals

- Named buttons stored per server: label, emoji, colour (blue, green, grey, red), a script, and two behaviour settings: `invoker_only` (only the member whose message created the buttons may press) and `limitations` (`none`; `limited` = that button disables after one press; `strict` = every button on the message disables after one press).
- `{addbutton:name}` attaches a stored button to a reply (up to 25 per message); `{addlinkbutton:...}` attaches a link button (no script).
- A press runs the button's script with the presser as "the member", through the same gates, role checks, ping rules and run-time errors as a normal rule.
- Pressing keeps working after a bot restart until the buttons expire.
- `/autoresponder test` and the builder's Try it show which buttons a reply would carry.
- Rules and scripts from stages 1 and 2 keep working with no change.

## Non-goals

- Role-handout buttons, dropdown menus, reactions (reaction roles).
- Modals opened by a button, select menus in a reply, per-press counters or stored variables, economy.
- Editing a posted reply's buttons after it is sent (beyond disabling them).

## Anti-goals (a failure even if it technically works)

- A button press bypassing a safety check a normal rule has: the button script's gates, role checks (`isDangerousRole`, `botCanGive`), the target checks of stage 2, and the ping rules all apply at press time.
- Another member pressing an `invoker_only` button, or pressing a `limited`/`strict` button twice (including two presses at the same moment).
- A press doing something after its button, rule or the feature is gone or switched off: it answers "this button has expired" and does nothing else.
- Unbounded growth: posted-message records must expire and be cleaned up.
- Member-typed text pinging through a button reply (the stage 2 ping rule: only the writer's mentions and words checked as a user).
- Slowing every message in every server: a rule with no buttons costs nothing extra.

## Constraints

- Node 22, discord.js 14.27, ESM, Postgres; no new dependency, no new intent. Migration `011_autoresponder_buttons.sql` (next after 010), new tables in the `resetDb` TRUNCATE list.
- Reuse, do not duplicate: the pipeline in `src/features/autoresponder/script/` and `execute.js`, `prepareRun` and `describeRun(For)`, the component-handler pattern of reaction roles (one component prefix, ids carry what is needed), `core/scheduler.js` housekeeping for cleanup, the builder's compile-and-revert (`tryChange`).
- Discord limits: at most 25 buttons and 5 per row, custom id at most 100 characters, label at most 80, link URL at most 512.
- Every user-facing string in `src/i18n/{en,fr,ar}.json`; new compile codes get `autoresponder.error.<CODE>`, run codes `autoresponder.run.<CODE>`.
- Tests hit the database (`npm test`, concurrency 1); the button model, the press rules and the instance bookkeeping are pure or DB-only and carry the bulk of the tests.

## What it does

### A stored button

Per server and unique by name (a short lowercase name, like embed names): `label`, `emoji` (optional), `style` (`blue`, `green`, `grey`, `red`), `script` (up to 4000 characters, compiled and stored like a rule's), `invoker_only` (default off), `limitations` (default `none`). `/autoresponder button add` opens a modal (label, emoji, script) with the name, style and the two settings as command options, `edit` reopens it prefilled, `remove` deletes it, `list` shows names, labels and settings. Setup needs Manage Server or the bot manager role, replies are ephemeral, each setup action writes one mod-log line (parent design).

### Attaching

`{addbutton:name}` in a rule's script or in another button's script: the name must exist at save (a missing one is a save error); up to 25 buttons per reply, ordered as they appear. `{addlinkbutton:label|url}` (optional third argument: emoji) attaches a link button; the URL must be `http` or `https`. The buttons are sent with the reply. Order of functions in the script still does not matter for effects; buttons keep script order.

### Instances and the press

When a reply with buttons is sent, one record is stored for that message: message id and channel, guild, the rule id, the member who triggered it (the invoker), the list of buttons attached (stored button name or the link), the original words, and the random results drawn for that message, plus the per-button state (pressed or not). The custom id of each button is `autoresponder:p:<messageId>:<index>`.

A press: look up the record (none, expired, or the feature switched off -> "this button has expired", no other effect); load the stored button (deleted -> expired); if `invoker_only` and the presser is not the invoker, refuse with a short ephemeral notice; claim the press atomically for `limited` and `strict` buttons (a second press, even at the same moment, is refused with a short notice and the buttons are re-rendered disabled); then run the button's script: the presser is "the member", the channel and message are the button's message, the original words are restored and re-checked (`requirearg` runs again, so someone who left fails), and the button's own random functions are drawn at press time. The reply is posted publicly as a reply to the button's message without pinging the replied user. After a `limited` press that button is disabled on the message; after a `strict` press all of the message's buttons are.

### Context rules (my calls)

- Random tokens in a button's script resolve against the button's own `range`/`choose` functions; a token whose kind the button does not define resolves from the random results stored with the original message (so the button can reuse them). In button scripts such tokens are therefore always live.
- In a button script `{delete}` and `{react}` act on the message that carries the button; `{reactreply}` and `{delete_reply}` act on the reply the press posts; `{cooldown}` is per presser per button.
- `{addbutton}` and `{addlinkbutton}` are allowed inside a button's script (a chain needs a human press at every step); each reply creates its own record.

### Expiry and cleanup

A record lives 14 days (my call). A scheduler housekeeping function deletes older records. Deleting a stored button, deleting its rule, or switching the feature off makes later presses answer "expired"; removing a stored button does not rewrite posted messages.

### Where else it shows up

`describeRun` / Try it list the buttons a reply would carry. The builder gets a Buttons page (pick stored buttons to attach, with the 25 cap) and the stored-button commands stay in `/autoresponder button`. Stage 1 and 2 compiled rules are unaffected (no `buttons` field).

## Calls made after the builder check (all mine; the owner can reverse them)

- **Where buttons can go.** Buttons need a message in a server channel. `{addbutton}`/`{addlinkbutton}` together with `{dm}` is a save error (`BUTTONS_NEED_CHANNEL`). With `{sendto:#channel}` the buttons go on the message sent there, and the stored record uses that message's channel. A reply that has buttons but no text and no embed is a save error (`BUTTONS_NEED_TEXT`), because Discord would not accept it.
- **Chained buttons.** When a button's script posts a new reply with buttons, the new record's invoker is the member who pressed (the person that script ran for), and the original words and random results are copied forward, so `[$1]` and `{requirearg}` keep working at every step. A cycle (a button attaching itself) is allowed, because every step needs a human press.
- **What a press checks.** In order: the feature is on, the record exists and has not expired, the rule that created the message still exists and is **enabled** (switching a rule off also stops its posted buttons; editing a rule changes nothing), the stored button still exists, `invoker_only`, then the `limited`/`strict` claim, then the button script's own gates. The rule's own conditions and its rule-level cooldown are not used; a `{cooldown}` in the button script is per presser per button.
- **Pings and targets at press time.** "The member" is the presser for placeholders, role changes and nicknames; `isDangerousRole` and `botCanGive` apply as for any rule. Restored words are re-checked at press time (`requirearg`, checked users, role targets from stage 2), and the allowed-pings list is computed fresh from the button script and those re-checked words (never from text the member typed).
- **Acknowledging.** A press is answered with `deferUpdate` first (Discord's 3 seconds); the public reply is a normal channel reply to the button's message (falling back to a plain channel send if that message is gone); disabling buttons is an edit of the original message. Refusals ("expired", "only the asker", "already pressed", "slow down") are ephemeral interaction replies.
- **Claims.** A `none` press never changes any state. A `limited` press disables that one button. A `strict` press locks the whole message: every later press of any button on it, including `none` buttons, is refused and all non-link buttons are rendered disabled. A press claimed at the same moment by two members is decided by one atomic database statement; the loser gets the "already pressed" notice.
- **Spam.** There is no global cap on `none` buttons; staff are expected to add `{cooldown}`. As a floor, one member can press buttons on the same message at most once every 3 seconds (in memory, "slow down" notice).
- **Dangling references.** A stored button cannot be renamed (`edit` keeps the name). Removing a button that scripts still mention is allowed; a missing button is skipped at send time with a run error `BUTTON_MISSING`, and a press on a removed button answers "expired".
- **Compiled form and old rules.** Rules and scripts compiled before this stage have no buttons and need no recompile; `{addbutton}` is validated when a rule or button is saved. The compiled form gains a `buttons` list (version bump or not is left to the builder).
- **Counting.** The 25-button cap is counted statically at save (the language has no conditionals or loops, so every `{addbutton}`/`{addlinkbutton}` in a script is sent).
- **Builder.** The builder attaches existing stored buttons only (a select of the stored buttons, with the 25-option limit and the same stale-list handling as the embed picker); creating and editing stored buttons stays in `/autoresponder button`. Try it only lists the buttons a reply would carry; it does not simulate a press.

## Left to the builder

- The compiled form for buttons (a `buttons` list on `compiled`; version bump or not), the table layout, the claim statement for `limited`/`strict`, and the custom id details.
- How the press path reuses `events.js` logic without pulling in message-only parts (trigger matching, auto-mod handshake, rule cooldown).
- How disabled state is rendered after a restart.
- The layout of the builder controls and the draft data shape; the test plan; updating README, `docs/testing-checklist.md` and `docs/memory/`.
