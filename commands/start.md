---
description: First run of Recade. Check the machine, set your preferences, show the commands.
allowed-tools: Bash(node:*), Bash(npm ci:*), Bash(gh api user:*), Read, AskUserQuestion
---

Run the steps below in order. This command can be run again at any time. Skip every step that is already done.

<!-- shared:cli-plugin -->In this file, `recade <sub>` means `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" <sub>`. Run it exactly that way.<!-- /shared:cli-plugin -->

Write short, plain sentences. No exclamation marks, no emoji. Answer the user in English until Step 0 is done. After that, answer in the language of `languages.chat` once you know it (see Step 1). Whatever the language, keep Recade keywords in English: slice, gate, lane, harness, BIBLE, PLAN, DEC, retro (in French: "fiche de slice", never "tranche").

## Step 0. Dependencies

<!-- shared:deps-plugin -->Run `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" version`. If it prints a version, go on. If it fails with `ERR_MODULE_NOT_FOUND` or another module error, run `npm ci --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"`, then run `version` again. Report the result in one line. If it still fails, show the error and stop.<!-- /shared:deps-plugin -->

## Step 1. Presentation

Run `recade config get languages.chat` and `recade config get started`. From here on, answer in the language of `languages.chat` if it is set to something other than `en`.

If `started` is `true`, skip the rest of this step. Otherwise, before anything else in your reply, print this text exactly as written, as a quote, in English, whatever `languages.chat` says. Do not summarize, shorten or rephrase it:

> Recade takes a software project from "we should build this" to agents shipping it slice by slice, with an expert-inspired team, real documents and a human at every gate. It is named after the scepter the kings of Danxomè gave their messengers so that their word became law, and it was made by Loyc COSSOU (loycossou[at]gmail.com).

## Step 2. Machine check

1. Run `recade doctor`. Show the results as a table: status, check, detail.
2. `recade doctor` exits 1 when a required check is missing. This is expected, not a tool failure. Read the output anyway.
3. For each check with status `missing`, show its `fix` line and ask the user to run it. You cannot run `/plugin` yourself.
4. For each check with status `warn`, show it, say in one sentence what it affects and show its `fix` line if it has one. A `warn` does not block: go on with the next step.
5. Do not run the fix commands yourself; show them to the user.
6. If something was missing, offer to run `recade doctor` again once the user has fixed it.

## Step 3. Languages

Skip this step if `recade config get started` prints `true`. The preferences were saved on a previous run. `/recade:languages` changes them.

Ask with `AskUserQuestion`: "Recade works in English everywhere by default. Keep it that way?" Options: `Yes, English everywhere (recommended)` and `Customize languages`.

On `Yes`, set all five keys to `en`. Run these five commands:

- `recade config set languages.chat en`
- `recade config set languages.work en`
- `recade config set languages.deliverables en`
- `recade config set languages.code en`
- `recade config set languages.product_ui en`

On `Customize languages`, ask these five questions. Each offers English and French. `AskUserQuestion` adds an Other choice itself, so do not list it. Use one question at a time.

1. "Which language do you want to use with Recade and its agents (questions, choices, reports, gates)?" One answer. Save with `recade config set languages.chat <code>`.
2. "Which language for working documents (BIBLE, PLAN, slice sheets, DEC, retros)?" One answer. Save with `recade config set languages.work <code>`.
3. "Which language or languages for delivered documents (D1, D2, D3, delivery plan)?" Multi-select, one version per language. Save with `recade config set languages.deliverables <code,code>`.
4. "Which language for code, comments and commit messages?" One answer. Save with `recade config set languages.code <code>`.
5. "Which language or languages must the product interface exist in?" Multi-select. Save with `recade config set languages.product_ui <code,code>`.

Codes are `en`, `fr` or the ISO 639-1 code of the other language. For a list, join the codes with commas and no spaces.

## Step 4. GitHub owner, projects root, writing model, extra files, voice

Skip this step if `recade config get started` prints `true`.

1. GitHub owner, the account or organization where private project repositories are created. Get the default with `gh api user --jq .login`. If that command fails, ask the user for the GitHub owner instead. Otherwise ask with `AskUserQuestion`: the default, or another name. Save with `recade config set github_owner <name>`.
2. Projects root, the folder that holds your projects. Default `~/projects`. Ask, then save with `recade config set projects_root <path>`.
3. Writing model, the model of the agents that write and review the documents. Ask with `AskUserQuestion`: "Which model should write your documents?"
   - **Opus** (recommended): the latest Opus, at high effort. Saved as `opus`.
   - **Fable**: Fable, at the same high effort. Saved as `fable`.

   AskUserQuestion adds "Other" by itself; if the answer is neither, ask again once, then save `opus`. Save with `recade config set models.writer <opus or fable>`. Say in one line that `recade config set models.writer fable` changes it later, and that the second opinion of the harness runs on Opus 5.5 whatever the answer, by the owner's decision of 2026-11-21.
4. Extra files, the optional deliverables for your stakeholders. Ask with `AskUserQuestion` with `multiSelect` on: "Which extra files should Recade render for your stakeholders? D1, D2, D3 and the PLAN are always rendered."
   - **Stack**: the stack decision as `STACK.docx` and `STACK.pdf`, and its weighted matrix as `STACK-matrix.xlsx`. Saved as `stack`.
   - **Decisions**: one register of every decision (`DEC-*`) as `DECISIONS.docx`, `DECISIONS.pdf` and `DECISIONS.xlsx`. Saved as `decisions`.
   - **Design**: each design direction board as its own PDF, `design-<board>.pdf`. Saved as `design`.
   - **Reviews**: every review note gathered in `REVIEWS.docx` and `REVIEWS.pdf`. Saved as `reviews`.

   AskUserQuestion adds "Other" by itself. Join the names the owner picked with commas and no spaces, and save with `recade config set deliverables.extras <names>`. Keep the valid picks and ignore the rest of the answer; save `none` only when no valid pick remains, and say so in one line. Say in one line that `recade config set deliverables.extras stack,decisions` (or `none`) changes it later, and that `/recade:docs` and `/recade:amend` render the extra files after the usual ones.
5. Writing voice, the style of every document, comment and report Recade writes. Ask with `AskUserQuestion`, always naming the person in full, never by a short id:
   - **Randall Munroe** (recommended): plain words, short sentences, deadpan humour born from precision. Saved as `randall-munroe`.
   - **Julia Evans**: warm and curious, explains things step by step, friendly without fluff. Saved as `julia-evans`.
   - **Paul Graham**: plain and direct essay style, no jokes, every sentence earns its place. Saved as `paul-graham`.

   AskUserQuestion adds "Other" by itself; if the user names someone else, save the full name in lowercase with hyphens. Save with `recade config set voice <id>`. When you mention the voice later, use the full name ("Randall Munroe"), never the id.

## Step 5. Mark the setup as done

Skip this step if `recade config get started` prints `true`. Otherwise run `recade config set started true`.

## Step 6. Command map

Run `recade help` and show the output.

## Step 7. Next step

Run `recade entry-mode` in the current directory. It prints one of three values. Suggest:

- `new` (an empty folder): `/recade:new <project>`
- `from-docs` (a folder with documents): `/recade:new <project> --from <folder>`
- `adopt` (an existing code repository): `/recade:adopt`

For `new` and `from-docs`, say that Recade creates a workspace, a folder named `<project>-workspace` that holds the documents and the state, and that the code repositories are created inside it later.

For `adopt`, say that Recade checks each repository first: no uncommitted work, the default branch and nothing unpushed. Then it clones it into a new workspace. It never edits a file of the original, and in the clone it never edits a file it did not create.
