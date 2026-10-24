# Autoresponder stage 2: random values and message words

Status: draft, waiting for the builder check and owner approval. Parent design: `2026-10-24-autoresponder-design.md` (its "Stage 2 functions" section is the starting point and this document refines it). Stage 1 and the interactive builder (`2026-10-24-autoresponder-builder-design.md`) are built on `phase-3`. Prior art: Mimu's autoresponder guides (https://docs.mimu.bot/autoresponder).

## Intent and why

Staff want autoresponders that feel alive: an `!8ball` that answers differently each time, a `!roll` that gives a number, a `!say` or `!greet` that uses the words the member typed, a `!hug @sam` that mentions the person, a `!role @sam` that changes someone else's role, and a rare reply that comes up now and then. Stage 1 can only reply the same way to everyone, about the person who wrote the message. Stage 2 adds random values and the member's words to the script language.

## Decisions by the owner

- **Use cases to support:** random replies (8ball, coin flip, dice), echoing the member's words, acting on a mentioned person, weighted rare replies.
- **No economy.** Balance, inventory, shop and currency stay out (parent design). Nothing here touches them.
- **Pings:** a person named in the reply is pinged only when the script required that word to be a real user (`{requirearg:N|user}`). Any other mention the member types is shown but never pings (consistent with the stage 1 final review: member-typed text cannot ping).
- **Role targets:** `{addrole:role|target}` and `{removerole:role|target}` act on the target. **Saving is refused unless the script also has a `{requirerole}` or `{requireperm}` condition**, so a rule anyone can trigger cannot change other members' roles.
- **Builder:** the interactive builder gets controls for the new pieces in the same stage (random choices, argument checks, role targets), as well as the text editor.

## Goals

- New functions: `{range:min-max}`, `{choose:a|b|c}`, `{weightedchoose:60%|30%|10%}`, `{lockedchoose:x|y|z}`, `{requirearg:N}` and `{requirearg:N|type}` (types `user`, `channel`, `color`, `role`, `number`).
- New values written in square brackets: `[$N]`, `[$N+]`, `[$N-M]` (the member's words) and `[range]`, `[choice]`, `[lockedchoice]` (random results).
- Role targets for `addrole`/`removerole` (the reserved second argument from stage 1).
- Every function checked at save with the localized error, position and code, and again at run time (parent design); `/autoresponder test` and the builder's Try it show the new behaviour with no side effects.
- Rules saved in stage 1 keep working with no change.

## Non-goals

- Economy functions and stored variables (parent design).
- Stage 3 (buttons).
- Loops, arithmetic, nested functions, nested brackets.
- Reading words from regex trigger groups, or from the text before an `endswith` trigger.

## Anti-goals (a failure even if it technically works)

- A member typing `@everyone`, a role mention or another person's mention and the bot pinging them through a relay rule.
- A rule changing another member's role without being limited to chosen people, or changing a role the bot or the writer should not give, or a member above the bot.
- A stage 1 rule changing behaviour after the upgrade (a `[Note]` in an old reply starting to mean something, a stored `compiled` rule no longer running).
- A script that saves but fails every time at run time with no word to staff.
- Random results that differ between the text, the nickname and the embed of one reply (every random value is drawn once per message).
- Slowing every message in every server: a rule with no stage 2 functions costs nothing extra.

## Constraints

- Node 22, discord.js 14.27, ESM, Postgres; no new dependency, no new intent. Likely no migration (the stored `compiled` JSON gains fields; confirm).
- Reuse, do not duplicate: the parser/compiler/evaluator/executor pipeline in `src/features/autoresponder/script/` and `execute.js`, the role checks in `core/role-safety.js` (`isDangerousRole`, `botCanGive`, `callerCanGive`), the user/channel/role/color resolution helpers the compiler already uses, `describeRun` for test and Try it, and the builder's compile-and-revert (`tryChange`).
- Limits (parent design): script 4000 characters, message content 2000, nickname 32, at most 3 role/nickname actions together (a role target counts), up to four of each random function per script.
- Every user-facing string (errors, builder text, docs) in `src/i18n/{en,fr,ar}.json`; new error codes each get an `autoresponder.error.<CODE>` key; run-time codes get `autoresponder.run.<CODE>`.
- Tests hit the database (`npm test`, concurrency 1); the parser, argument splitting and random drawing are pure and carry the bulk of the tests (the random source is injectable so tests are deterministic).

## What it does

### The words after the trigger (arguments)

- **Which words:** for `startswith` and `includes` rules, the words after the trigger (for `includes`, after the first occurrence). Words are split on whitespace. For `exact`, `endswith` and `regex` rules there are no words: `[$N]` is empty there and the save reply says so (my call).
- **`[$N]`** is word N (1-based). **`[$N+]`** is word N and everything after it, original spacing kept. **`[$N-M]`** is words N to M. A missing word makes `[$N]` empty, unless the script has `{requirearg:N}`, which makes the rule not run (see below).
- **`{requirearg:N}`** requires word N to exist; **`{requirearg:N|type}`** also requires it to be a `user` (a mention or id of a member in the server), `channel`, `role`, `color` (`#rrggbb`) or `number`. When it fails the rule is skipped with a short notice to the member (same notice rules as other gates; none under `{silent}`) (my call). A word checked as a `user` also becomes a person the reply may ping (owner decision).
- `[$N]` works in the reply text, in embeds written in the script, in `{setnick}`, and as the target of `addrole`/`removerole`. It is substituted only in the script's own text, not inside a stored named embed (parent design).

### Random values

- `{range:min-max}` draws a whole number between the two (inclusive). `{choose:a|b|c}` picks one option. `{weightedchoose:60%|30%|10%}` picks an option index by weight (weights are integers or decimals and need not sum to 100; they are relative). `{lockedchoose:x|y|z}` gives the value paired with the option chosen by the matching `choose` or `weightedchoose`; the counts must match, otherwise a save-time error (`CHOICE_NOT_CHOSEN_YET` when there is no `choose` for it to follow).
- The results are read as `[range]`, `[choice]` and `[lockedchoice]`. With more than one of a kind the later ones are `[range2]`, `[range3]`, `[range4]` (and likewise `choice`, `lockedchoice`); up to four of each per script (my call on the numbering; the parent design only says "up to four").
- For `choose`, `[choice]` is the picked text. For `weightedchoose`, `[choice]` is the picked option's position (1, 2, 3) and `[lockedchoice]` is the paired value (my call; check against the Mimu guides).
- Every random value in a script is drawn exactly once per message, before the text, the nickname and the actions are rendered, so they all agree. Order of functions in the script still does not matter.

### Role targets

`{addrole:role|target}` and `{removerole:role|target}`: the target is `[$N]` where the script has `{requirearg:N|user}` (the only accepted form; a typed id or a name is not accepted). Checks: the stage 1 save-time role checks; the script must contain a `{requirerole}` or `{requireperm}` gate (owner decision); at run time the target must still be a member of the server and one the bot can manage (not above the bot, not the owner), and the role must still pass `isDangerousRole` and `botCanGive`. A refused change is skipped, the rest of the script still runs, and the run-time error line tells staff (parent design). Role target changes count toward the three role/nickname actions.

### Where else it shows up

- **Dry run and Try it:** take the words from the sample message the same way the live handler does and draw random values once; the output shows the drawn values.
- **Interactive builder:** a Random section on the Reply page or a new page (random values and where to insert them), argument checks on the Conditions page, and a target choice on the role actions. Typing `[` forms in guided reply text works; the builder's brace and `|` refusals extend to the new forms where they would break the script.
- **Stored rules:** `compiled` gets a version bump and new fields. Rules compiled by stage 1 keep their format and keep running; no migration of stored rules is needed unless the builder check shows otherwise.

### Errors

Save-time, trigger-time and run-time errors work as in the parent design. New save-time codes include bad range, mismatched `choose`/`lockedchoose` counts, weights that are not numbers or are all zero, too many of a kind, `requirearg` type problems, a role target that is not a checked user word, a role target without a `requirerole`/`requireperm` gate, and `[$N]` in a mode that has no words (a warning, not an error).

## Calls made after the builder check (all mine; the owner can reverse them)

- **Which square brackets are special.** Only `[$N]`, `[$N+]`, `[$N-M]` and the exact names `[range]`, `[choice]`, `[lockedchoice]` with optional numbers `2` to `4` (`[range2]`, `[choice3]`, and so on) are tokens. Any other `[...]` is plain text, so `[Note]` in an old reply is unchanged. A `[range]`, `[choice]` or `[lockedchoice]` token is live only if the script has the function that produces it; without it, it stays literal text (so re-saving an old rule that happens to contain the word `[choice]` changes nothing). `[$N]` forms are always tokens. `\[` still writes a literal bracket.
- **Numbering and pairing.** `choose` and `weightedchoose` share one list, numbered in the order they appear in the script: the first is `[choice]`, the second `[choice2]`, and so on, at most four together. The nth `lockedchoose` pairs with the nth of that list and gives `[lockedchoice]`/`[lockedchoice2]`...; its option count must equal its partner's, and a `lockedchoose` with no partner is `CHOICE_NOT_CHOSEN_YET`. A `weightedchoose` with no `lockedchoose` is allowed (`[choice]` is then its position, 1, 2, 3). `range` has its own list of up to four.
- **Role target gate.** The check is a simple presence check: the script must contain at least one `{requirerole}` or `{requireperm}`; several gates all have to pass, as in stage 1. A gate that every member passes (the `@everyone` role, a permission everyone has) is not detected; staff are trusted to choose a meaningful gate. A member may target themselves. The authority checks stay as in stage 1: the writer is checked at save, the bot (`isDangerousRole`, `botCanGive`, manageable target) at run time.
- **Failed `requirearg`.** The member gets one short notice (a new `autoresponder.notice.arg` string with the word position and the expected type, for example "word 1 must be a user"), throttled like the other notices and silent under `{silent}`. `/autoresponder test` and Try it show the failed gate.
- **Modes without words.** `{requirearg}` in an `exact`, `endswith` or `regex` rule is a hard save error (`NO_ARGUMENTS_IN_MODE`), because the rule could never run. A `[$N]` in such a rule is only a warning (it renders empty). Changing a rule's match mode with `editmatchmode` recompiles the stored script under the new mode and refuses the change if it would become invalid; the builder saves with the mode it has.
- **Words after the trigger.** Match behaviour is unchanged (no word boundary: `!sayhello` still matches a `startswith` `!say`). The words are computed from the original message text, found case-insensitively; leading whitespace before the trigger is ignored; for `!sayhello`, word 1 is `hello`.
- **Number grammar.** `{requirearg:N|number}` accepts an optional leading `-`, digits and an optional decimal part, no thousands separators. `{range:min-max}` takes whole numbers written `min-max`, where either may start with `-` (`{range:-5-10}`), each at most 1,000,000,000 in size, and min must not exceed max. `user` accepts `<@id>`, `<@!id>` or a bare id of a current member of the server (checked when the rule runs, so an id of someone who left fails); `channel` and `role` accept their mention form or a bare id of an existing one; no names.
- **Dry run.** The sample message's words are resolved against the real server by the same code the live handler uses (a nonexistent user fails the `user` check). `/autoresponder test` and Try it show the drawn random values and the list of people who would be pinged, in addition to what they show today.

## Left to the builder

- The exact token grammar and error codes, and how `[` forms are recognized without changing the meaning of stage 1 text such as `[Note]`.
- How the trigger remainder is computed so words survive case folding and trimming (the matcher normalizes with lowercase and trim today).
- Where the random draw and the words live in the evaluator context and the stored `compiled` shape.
- The random source (injectable for tests).
- The layout of the new builder controls and the draft's data shape.
- The test plan, and updating README, `docs/testing-checklist.md` and `docs/memory/`.
