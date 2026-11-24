---
description: Pick up a Recade project where it stopped, at the first unfinished step of the current phase.
allowed-tools: Bash(node:*), Bash(npm ci:*), Bash(git:*), Read, Write, Edit, AskUserQuestion
---

<!-- shared:cli-plugin -->In this file, `recade <sub>` means `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" <sub>`. Run it exactly that way.<!-- /shared:cli-plugin -->

Write short, plain sentences. No exclamation marks, no emoji. Answer the user in English until Step 0 is done.

<!-- shared:owner-choice -->**How to ask.** Ask the owner every question as a closed choice with `AskUserQuestion`: 2 to 4 options, the recommended one first, with its reason in its description (the tool adds `Other` by itself). When `AskUserQuestion` is not available, write the question in the chat with lettered options (A, B, C; for a DEC, the letters of its file), the recommended one first with its reason, and wait for the answer. Ask an open question only for an answer that is free text by nature: a name, a path, a date, or the owner's own words after they picked an option that asks for them.<!-- /shared:owner-choice -->

## Step 0. Dependencies

<!-- shared:deps-plugin -->Run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" version`. If it prints a version, go on. If it fails with `ERR_MODULE_NOT_FOUND` or another module error, run `npm ci --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"`, then run `version` again. Report the result in one line. If it still fails, show the error and stop.<!-- /shared:deps-plugin -->

## Step 1. Read the state

On a fresh clone of the workspace on another machine, the guard has no plugin root yet: run `recade repo sync --project '<dir>'` first. It writes the plugin root of the workspace and of each repository, clones what is missing and turns the git hooks on. Then go on. `recade repo check` names a repository whose git hooks are off. Here `<dir>` is the folder of the workspace, the current folder. You know it is a fresh clone when a Recade command is refused with a message that names the missing plugin root and `recade repo sync`; on any other machine, skip this paragraph.

<!-- shared:chat-language-config -->From here on, answer in the language of `languages.chat` (`recade config get languages.chat`).<!-- /shared:chat-language-config --> If it is not set, use English. Keep Recade keywords in English: slice, gate, lane, harness, BIBLE, PLAN, DEC, retro. <!-- shared:id-gist -->When you name an ID to the owner (a DEC, a PRV, a requirement, a slice, a gate), add its gist in parentheses, as in `DEC-03 (weekly payouts)` or `G2 (the documents)`, and name an ID only when the owner needs it to act.<!-- /shared:id-gist -->

Run `recade state show --json` in the current folder. <!-- shared:state-show-lookup -->It looks for `recade/state.yaml` in this folder and in the folders above it, and, in a code repository, through its link to its workspace.<!-- /shared:state-show-lookup --> `recade workspace root` prints the workspace folder.

<!-- shared:no-project -->If it exits 1 with "No Recade project here", say so in one line, suggest `/recade:new <project>`, and stop.<!-- /shared:no-project --> If it exits 1 and the message names `recade repo sync`, this folder is a code repository whose link to its workspace is missing or wrong: say so, tell the owner to run `/recade:resume` from the workspace folder, and stop.

Tell the owner in one sentence where the project stands: the phase (`phase`, `phase_name`) and `next_action`.

1. Run `recade repo check` from the workspace. It only reads. If it says that every repository is present, linked and has its harness, and exits 0, go on to Step 2. Otherwise it prints one line `<repo>: <problem>` for each finding and exits 1. The problems are `missing` (the folder is not in `repos/`), `not a git repository`, `link missing`, `link points elsewhere`, `git hooks off` (the local git hooks of this machine are missing: `recade repo sync` installs them), `old layout` (the harness and the slice worktrees are still in the code repositories) and `invalid entry`. This happens after a move of the workspace, a new clone or a new machine.
2. Show the lines to the owner in plain words. For `old layout`, that `/recade:harness` moves the project to the one entry point at the root of the workspace (`recade harness migrate`), and go on: the harness is not a reason to stop. For any other problem, ask with `AskUserQuestion`: "Relink the code repositories now?" Options: `Yes, run recade repo sync` and `Not now`. Only on `Yes, run recade repo sync`, run `recade repo sync`. It clones the repositories that are missing from `repos/` (from the remote of the registry), writes the link and the plugin folder again in each one, and repairs the worktrees of the slices. Run it from the workspace folder: from a code repository with a wrong link it stops and changes nothing. If it exits 1, it prints a line `Skipped <repo>: <reason>` for each repository it skipped (a repository with no remote cannot be cloned): show each line, and tell the owner what to do by hand. On `Not now`, say that the slice sessions and the commands inside a code repository stop until the link is right.
3. Never give `recade repo sync` or `recade repo add` to an agent. The guard refuses both for an agent, and only you run them, after the owner's yes.

## Step 2. Re-enter the phase

The phase to resume is the one in `phase`. Its command is `command` (`new`, `adopt`, `team`, `docs`, `bible`, `slices` or `harness`).

1. If `phase` is 5 and the `G5` gate is passed, the project is set up. Say so, suggest `/status` in the project, and stop.
2. If `command_available` is `false`, say in one sentence that the phase `phase_name` is not available in this version, give `next_action` as it is, and stop. Do not try to do the work of that phase.
3. Otherwise, read `${CLAUDE_PLUGIN_ROOT}/commands/<command>.md` with Read. In mode `adopt` (`mode` of the state) there is no intake: phase 1 is `team.md`, which takes `docs/inventory.md` and `docs/STACK.md` as the brief; phase 2 (`docs`) is Step 5.1 of `adopt.md`, which `docs.md` sends you to; phases 3 and 4 are `bible.md` and `slices.md`, which read `docs/RULES.md`, `docs/INVARIANTS.md` and `docs/CONTRACTS.md` (D1 to D3 when `full` is true) and the PLAN of the remaining work, with the rules of Steps 5.2 and 5.3 of `adopt.md` on top; phase 5 is Step 6 of `adopt.md`. Do not start another slash command. Follow the instructions of that file yourself, step by step, with these rules:
   - Skip every step that is already done. Check the files and the state to know: a step is done when the file it writes exists and is complete.
   - Start at the first unfinished step.
   - Say in one line which step you start at, and why the earlier ones are skipped.
4. Gates are never passed by this command. A gate is passed only through the phase command's own owner question: when you reach that question while following the file, ask it as the file words it, and only on the owner's yes run the `recade state pass <gate>` that the file gives. Never pass a gate on an earlier answer, on the owner's wish to resume, or without that question.
