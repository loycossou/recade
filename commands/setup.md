---
description: Check that the machine has what Recade needs and say how to fix what is missing.
allowed-tools: Bash(node:*), Bash(npm ci:*)
---

<!-- shared:cli-plugin -->In this file, `recade <sub>` means `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" <sub>`. Run it exactly that way.<!-- /shared:cli-plugin -->

Write short, plain sentences. No exclamation marks, no emoji. Answer the user in English until Step 0 is done.

## Step 0. Dependencies

<!-- shared:deps-plugin -->Run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" version`. If it prints a version, go on. If it fails with `ERR_MODULE_NOT_FOUND` or another module error, run `npm ci --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"`, then run `version` again. Report the result in one line. If it still fails, show the error and stop.<!-- /shared:deps-plugin -->

## Step 1. Machine check

<!-- shared:chat-language-config -->From here on, answer in the language of `languages.chat` (`recade config get languages.chat`).<!-- /shared:chat-language-config --> If it is not set, use English.

1. Run `recade doctor`. Show the results as a table: status, check, detail.
2. `recade doctor` exits 1 when a required check is missing. This is expected, not a tool failure. Read the output anyway.
3. For each check with status `missing`, show its `fix` line and ask the user to run it. You cannot run `/plugin` yourself.
4. For each check with status `warn`, show it, say in one sentence what it affects and show its `fix` line if it has one. A `warn` does not block: go on with the next step.
5. Do not run the fix commands yourself; show them to the user.
6. If something was missing, offer to run `recade doctor` again once the user has fixed it.

## Step 2. The writing model

Run `recade config get models.writer`. It prints `fable` or `opus`: the model the agents that write and review the documents use, at high effort either way. Show it in one line. Say that `recade config set models.writer fable` or `recade config set models.writer opus` changes it, and that it applies to the next dispatch.

## Step 3. The extra files

Run `recade config get deliverables.extras`. It prints `[]` when the owner chose none, else one line `- <name>` for each extra among `stack`, `decisions`, `design` and `reviews`. Show it in one line, with what each chosen name adds (`stack`: STACK and its matrix, `decisions`: the decision register, `design`: one PDF for each design board, `reviews`: every review note in one file). Say that `recade config set deliverables.extras stack,decisions` (or `none`) changes it, and that `recade render extras --project '<dir>'` renders them. D1, D2, D3 and the PLAN are always rendered. Then run `recade config get deliverables.deck` and show it in one line: `yes` renders the PowerPoint deck for a steering committee with the extras, `no` does not, and `ask` means `/recade:docs` asks the owner once; `recade config set deliverables.deck yes` (or `no`) changes it.
