---
description: Show every Recade command in one line each.
allowed-tools: Bash(node:*), Bash(npm ci:*)
---

## Step 0. Dependencies

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" version`. If it prints a version, go on. If it fails with `ERR_MODULE_NOT_FOUND` or another module error, run `npm ci --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"`, then run `version` again. Report the result in one line. If it still fails, show the error and stop.

## Step 1. Show the commands

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" help` and show the output as it is.

Answer the user in the language of `languages.chat` (`node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" config get languages.chat`). If it is not set, use English. Keep the command names and the summaries from the output unchanged.

Then run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" config get models.writer` and add one line: the writing agents use that model (`fable` or `opus`), and `recade config set models.writer fable` or `recade config set models.writer opus` changes it.

Then run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" config get deliverables.extras` and add one line: it prints `[]` when no extra file is chosen, else the extras to render (`stack`, `decisions`, `design`, `reviews`) next to D1, D2, D3 and the PLAN, which are always rendered, and `recade config set deliverables.extras stack,decisions` (or `none`) changes it.
