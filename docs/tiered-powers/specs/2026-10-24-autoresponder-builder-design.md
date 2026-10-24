# Autoresponder interactive builder: design

Status: draft, waiting for the builder check and owner approval. Follows `2026-10-24-autoresponder-design.md` (stage 1 built on `phase-3`). Prior art: the reaction roles builder (`src/features/reactionroles/builder.js`, `components.js`, `setup.js`).

## Intent and why

Staff make autoresponder rules today by typing a whole reply script into a modal (`/autoresponder add`). The owner wants the same click-through experience as the reaction roles builder: a panel where staff pick a trigger, a reply, conditions and actions with buttons and menus, and the builder writes the script. The owner has not used the text editor yet, so the goal is a friendly first experience, not a fix for one known annoyance (my reading).

## Decisions by the owner

- **Command and panel:** an interactive builder panel in `/autoresponder`, modelled on the reaction roles builder. It is **one more subcommand, `builder`**. Every existing command (`enable`, `disable`, `add`, `edit`, `editmatchmode`, `toggle`, `remove`, `list`, `show`, `test`) stays exactly as it is, the way `/reactionroles builder` sits next to `/reactionroles add`.
- **Script text:** guided. The builder writes the script. The panel also has an "edit script text" button for people who know the syntax.
- **Draft:** held until Save. Nothing is stored before Save; closing or timing out discards it.
- **New rules only.** Existing rules keep using `/autoresponder edit` (the text modal). The builder never reads a stored script back.
- **Scope of the panel:** everything in stage 1. Trigger and match mode, reply text, embed, every condition (cooldown, role, permission, channel and user gates and their deny versions) and every action (add and remove role, nickname, reactions, DM, send to a channel, delete, delete reply, silent).
- **Preview:** a readable summary of the rule so far plus a "Try it" button. Try it asks for a sample message and shows the same result as `/autoresponder test` (matching rule, gates, rendered text, action list), with no side effects.

## Goals

- `/autoresponder builder` opens an ephemeral panel only the person who opened it can use.
- Staff can build any rule the stage 1 script language can express, without typing a `{function}`.
- Save runs the same checks as the text editor (trigger check, script compile with the saving member as writer, 100 rule cap), writes the same mod-log line, invalidates the rule cache, and replies with the rule id. If a check fails, the panel stays open with the localized errors and the draft intact.
- A rule saved by the builder is an ordinary rule: it appears in `list` and `show` with its generated script, and `edit` opens it in the text modal.
- All user-facing text in `src/i18n/{en,fr,ar}.json`.

## Non-goals

- Stages 2 and 3 functions (random, arguments, buttons).
- Opening an existing rule in the builder, or parsing a script back into the panel.
- Saving drafts across a bot restart or after the panel times out.
- Storing the builder's draft structure in the database; only the finished rule is stored.

## Anti-goals (a failure even if it technically works)

- The builder saving a rule that the text editor would refuse, or skipping a safety check (dangerous role, role above the bot or the writer, role pings).
- Another member using, reading or saving someone else's draft.
- A panel that breaks on Discord's limits (5 component rows, 25 select options, 100-character custom ids, modal size, message length) instead of saying so.
- Edits made with the raw script text button being silently lost or contradicting what the panel shows.
- A half-saved rule: Save either stores the whole rule or nothing.

## Constraints

- Node 22, discord.js 14.27, ESM, Postgres. No new dependency, no new intent, no new migration (the rule table already holds trigger, mode, script and compiled).
- Reuse, do not copy: `compileScript`, `checkTrigger`, `MATCH_MODES`, `createRule` and the 100 rule cap, `invalidate`, `logAutoresponder`, `guard` with `requireManager`, `ephemeral`, `fitLines`, the dry-run code behind `/autoresponder test` (extract it into a shared function rather than duplicating it), and the role checks used by the text editor.
- Setup replies are ephemeral; the builder needs Manage Server or the bot manager role, like every other setup command, and the feature must be on.
- Panel interactions go through the existing `autoresponder` component prefix (`autoresponder:b:<action>:<userId>:<panelId>` style ids; the reaction roles builder's `b` segment is the model). Custom ids stay under 100 characters.
- Tests hit the database with `npm test`, concurrency 1; the script generator and the draft model are pure and should have the bulk of the tests.

## What it does

### The panel

One ephemeral message with a few pages (my call): **Basics** (trigger and match mode), **Reply** (text, optional embed, where it goes: in place, DM, or a channel; delete the trigger message; silent), **Conditions**, **Actions**, **Review**. The head of the panel always shows the readable summary of the draft. Review has **Try it**, **Edit script text**, **Save** and **Cancel**. Role, channel and user choices use Discord's own pickers where they fit; text uses short modals.

### The draft

A structured draft (trigger, mode, reply, embed choice, flags, a list of conditions, a list of actions) held in the bot's memory under a short random panel id, bounded in number, expiring 15 minutes after the last click (my call; reaction roles uses a fixed 10 minutes, which is short for a draft with several modals). One open draft per member per server; opening the builder again replaces it (my call). A bot restart loses open drafts (my call, accepted because nothing is stored before Save).

A pure generator turns the draft into script text, escaping `{`, `[`, `|` and `\` in the reply text, and respecting the language's rules (no nesting, one cooldown, one embed and so on). The builder only offers choices the language accepts, and Save still compiles the generated script.

### Edit script text

Opens the same text modal as `/autoresponder add`, prefilled with the generated script. Submitting switches that draft to **script mode** (my call): the panel pages for conditions and actions are replaced by a note, the summary is built from the compiled script, and Try it, Save and Cancel keep working. Going back to guided steps is not possible for that draft; starting a new builder is. This keeps the owner's "guided, with a raw edit button" without having to parse arbitrary text back.

### Try it

Asks for a sample message, compiles the draft, and shows the dry-run result with the member who pressed the button as the author. It sends nothing, changes no role, writes no cooldown and no log.

### Save

Runs `checkTrigger` and `compileScript` (writer = the saving member), then `createRule`. On success: invalidate the cache, one mod-log line, close the panel with the rule id. On a script error: the localized error list (up to 10 lines) and the draft stays. On the 101st rule: the existing "full" reply.

## Calls made after the builder check (all mine; the owner can reverse them)

- **Embeds:** the Reply page offers all three forms of `{embed}`: none, a plain colour embed (hex colour typed in a small modal), or a named stored embed (a select of the server's stored embeds, the first 25 with a note when there are more). An embed does not replace the reply text; the text and the embed are both sent, as the executor already does. A named embed deleted between picking and Save is caught by the Save-time compile.
- **Script mode:** the "Edit script text" button only changes the draft when the modal is submitted; cancelling or closing the modal changes nothing. After a submit the draft is in script mode for good. In script mode the panel shows the script text itself (in a code block) in place of the readable summary, plus Try it, Save and Cancel. No second "compiled to prose" renderer is built.
- **Pickers:** roles, channels and users use Discord's own role, channel and user selects (they return ids). Permission gates use a string select of the commonly used permissions plus a modal for typing any other permission name (the compiler validates the name). A role is checked with the same save-time role rules (dangerous, above the bot, above the writer) the moment it is added to the draft, and refused with the localized reason, since Discord's role select cannot be pre-filtered.
- **Limits in the draft model:** the draft model enforces the language's caps itself (at most 3 role and nickname actions together, 5 reactions combined, 10 values per gate, one cooldown, one embed) by refusing to add more with a short message. Save still compiles, and the compiler stays the source of truth.
- **Conflicting choices:** the Reply page picks one destination (reply in place, DM, or a channel), so the DM and channel send-to cannot both be set. Combinations the compiler accepts but that do nothing useful (for example react on the trigger while the trigger is deleted) are shown as a short note in the summary rather than blocked.
- **Dry run:** the dry run behind `/autoresponder test` is moved into a shared function that takes the compiled rule, the member, the channel and the sample message, and no interaction. Try it runs it on the draft alone and never consults the saved rules; `/autoresponder test` keeps using the saved rules through the same function, with identical output.
- **Timer:** the panel expires 15 minutes after the last click (sliding). A click on an expired panel, on a panel replaced by a newer draft, or after a bot restart replies that the builder panel has expired and to run `/autoresponder builder` again.
- **Mod log:** Save writes the same `created` line the text editor writes, with the detail noting it came from the builder.
- **Help and deploy:** `builder` appears in `/help` automatically (help reads the command definition) and needs `npm run deploy`. There are well under Discord's 25 subcommand limit.

## Left to the builder

- Page layout, which component sits where, labels, emoji, and the wording of the summary.
- How many roles, channels or users a single condition can list (the language allows up to 10 values per gate).
- The draft's exact data shape and the memory store's bounds.
- The test plan; the generator and draft model are pure and should carry the bulk.
- Updating README, `docs/testing-checklist.md` and `docs/memory/` when it ships.
