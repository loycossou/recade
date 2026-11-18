---
description: Change the languages Recade uses for chat, documents, code and the product interface.
allowed-tools: Bash(node:*), Bash(npm ci:*), AskUserQuestion
---

In this file, `recade <sub>` means `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" <sub>`. Run it exactly that way.

Write short, plain sentences. No exclamation marks, no emoji. Answer the user in English until Step 0 is done.

Keywords stay in English whatever the choice: commands, agents, statuses, identifiers, file names, YAML keys, branches.

## Step 0. Dependencies

Run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" version`. If it prints a version, go on. If it fails with `ERR_MODULE_NOT_FOUND` or another module error, run `npm ci --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"`, then run `version` again. Report the result in one line. If it still fails, show the error and stop.

## Step 1. Show the current choices

From here on, answer in the language of `languages.chat` (`recade config get languages.chat`). If it is not set, use English.

Run `recade config get languages` and show the result.

## Step 2. Ask

Ask with `AskUserQuestion`: "Recade works in English everywhere by default. Keep it that way?" Options: `Yes, English everywhere (recommended)` and `Customize languages`.

On `Yes`, set all five keys to `en`. Run these five commands:

- `recade config set languages.chat en`
- `recade config set languages.work en`
- `recade config set languages.deliverables en`
- `recade config set languages.code en`
- `recade config set languages.product_ui en`

On `Customize languages`, ask these five questions, one at a time. Each offers English and French. `AskUserQuestion` adds an Other choice itself, so do not list it.

1. "Which language do you want to use with Recade and its agents (questions, choices, reports, gates)?" One answer. Save with `recade config set languages.chat <code>`.
2. "Which language for working documents (BIBLE, PLAN, slice sheets, DEC, retros)?" One answer. Save with `recade config set languages.work <code>`.
3. "Which language or languages for delivered documents (D1, D2, D3, delivery plan)?" Multi-select, one version per language. Save with `recade config set languages.deliverables <code,code>`.
4. "Which language for code, comments and commit messages?" One answer. Save with `recade config set languages.code <code>`.
5. "Which language or languages must the product interface exist in?" Multi-select. Save with `recade config set languages.product_ui <code,code>`.

Codes are `en`, `fr` or the ISO 639-1 code of the other language. For a list, join the codes with commas and no spaces.

## Step 3. Show the result

Run `recade config get languages` and show the result.
