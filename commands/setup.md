---
description: Check that the machine has what Recade needs and say how to fix what is missing.
allowed-tools: Bash(node:*), Bash(npm ci:*)
---

In this file, `recade <sub>` means `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" <sub>`. Run it exactly that way.

Write short, plain sentences. No exclamation marks, no emoji. Answer the user in English until Step 0 is done.

## Step 0. Dependencies

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" version`. If it prints a version, go on. If it fails with `ERR_MODULE_NOT_FOUND` or another module error, run `npm ci --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"`, then run `version` again. Report the result in one line. If it still fails, show the error and stop.

## Step 1. Machine check

From here on, answer in the language of `languages.chat` (`recade config get languages.chat`). If it is not set, use English.

1. Run `recade doctor`. Show the results as a table: status, check, detail.
2. `recade doctor` exits 1 when a required check is missing. This is expected, not a tool failure. Read the output anyway.
3. For each check with status `missing`, show its `fix` line and ask the user to run it. You cannot run `/plugin` yourself.
4. For each check with status `warn`, show it, say in one sentence what it affects and show its `fix` line if it has one. A `warn` does not block: go on with the next step.
5. Do not run the fix commands yourself; show them to the user.
6. If something was missing, offer to run `recade doctor` again once the user has fixed it.

## Step 2. The writing model

Run `recade config get models.writer`. It prints `fable` or `opus`: the model the agents that write and review the documents use, at high effort either way. Show it in one line. Say that `recade config set models.writer fable` or `recade config set models.writer opus` changes it, and that it applies to the next dispatch.
