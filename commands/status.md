---
description: Show the phase, the gates, the open provisionals and blockers, and the next action of a Recade project.
allowed-tools: Bash(node:*), Bash(npm ci:*), Read
---

In this file, `recade <sub>` means `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" <sub>`. Run it exactly that way.

Write short, plain sentences. No exclamation marks, no emoji. Answer the user in English until Step 0 is done.

## Step 0. Dependencies

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" version`. If it prints a version, go on. If it fails with `ERR_MODULE_NOT_FOUND` or another module error, run `npm ci --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"`, then run `version` again. Report the result in one line. If it still fails, show the error and stop.

## Step 1. Read the state

From here on, answer in the language of `languages.chat` (`recade config get languages.chat`). If it is not set, use English. Keep Recade keywords in English: slice, gate, lane, harness, BIBLE, PLAN, DEC, retro. When you name an ID to the owner (a DEC, a PRV, a requirement, a slice, a gate), add its gist in parentheses, as in `DEC-03 (weekly payouts)` or `G2 (the documents)`, and name an ID only when the owner needs it to act.

Run `recade state show --json` in the current folder. It looks for `recade/state.yaml` in this folder and in the folders above it, and, in a code repository, through its link to its workspace.

If it exits 1 with "No Recade project here", say so in one line and suggest `/recade:new <project>`. Stop.

This command only reads. It never changes the state and never passes a gate.

## Step 2. Show the status

Show, in this order:

1. The phase: its number and name (`phase`, `phase_name`).
2. The gates, as a table: gate, state (`passed` or `open`), date. Take them from `gates`. Gates run in the order `G0`, `G1`, `G2-stack`, `G2`, `G3`, `G4`, `G5`. In mode `adopt` the first gate is `G0-inventory` instead of `G0`.
3. The open provisionals: read `intake/provisionals.md` with Read if the file exists. List each PRV record that is not closed, one line each: id and title. If the file does not exist or nothing is open, write "No open provisional".
4. The open blockers: read `BLOCKERS.md` at the project root with Read if the file exists. List each blocker that is not closed, one line each. If the file does not exist or nothing is open, write "No open blocker".
5. The code repositories: run `recade repo list`, then `recade repo check`. Both only read. Show one line for each repository (its name, its remote, its visibility). Then show each line `<repo>: <problem>` of the check as it is, and say that `/recade:resume` relinks the repositories when a link or a folder is the problem. If the list says there is no code repository yet, write "No code repository yet".
6. The next action: `next_action`, as it is. If `command_available` is `false`, add one sentence: that phase is not available in this version.

Keep it short. Do not add advice the state does not support.
