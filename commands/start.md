---
description: First run of Recade. Check the machine, set your preferences, show the commands.
allowed-tools: Bash(node:*), Bash(npm ci:*), Bash(gh api user:*), Bash(claude mcp list:*), Bash(claude mcp add:*), Read, AskUserQuestion
---

Run the steps below in order. This command can be run again at any time. Skip every step that is already done.

<!-- shared:cli-plugin -->In this file, `recade <sub>` means `node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" <sub>`. Run it exactly that way.<!-- /shared:cli-plugin -->

Write short, plain sentences. No exclamation marks, no emoji. Answer the user in English until Step 0 is done. After that, answer in the language of `languages.chat` once you know it (see Step 1). Whatever the language, keep Recade keywords in English: slice, gate, lane, harness, BIBLE, PLAN, DEC, retro (in French: "fiche de slice", never "tranche").

<!-- shared:owner-choice -->**How to ask.** Ask the owner every question as a closed choice with `AskUserQuestion`: 2 to 4 options, the recommended one first, with its reason in its description (the tool adds `Other` by itself). When `AskUserQuestion` is not available, write the question in the chat with lettered options (A, B, C; for a DEC, the letters of its file), the recommended one first with its reason, and wait for the answer. Ask an open question only for an answer that is free text by nature: a name, a path, a date, or the owner's own words after they picked an option that asks for them.<!-- /shared:owner-choice -->

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

## Step 4. GitHub owner, projects root, writing model, second opinion, extra files, deck, voice, design servers

Skip this step if `recade config get started` prints `true`.

1. GitHub owner, the account or organization where private project repositories are created. Get the default with `gh api user --jq .login`. If that command fails, ask the user for the GitHub owner instead. Otherwise ask with `AskUserQuestion`: the default, or another name. Save with `recade config set github_owner <name>`.
2. Projects root, the folder that holds your projects. Default `~/projects`. Ask, then save with `recade config set projects_root <path>`.
3. Writing model, the model of the agents that write and review the documents. Ask with `AskUserQuestion`: "Which model should write your documents?"
   - **Opus** (recommended): the latest Opus, at high effort. Saved as `opus`.
   - **Fable**: Fable, at the same high effort. Saved as `fable`.

   AskUserQuestion adds "Other" by itself; if the answer is neither, ask again once, then save `opus`. Save with `recade config set models.writer <opus or fable>`. Say in one line that `recade config set models.writer fable` changes it later.
4. Second-opinion model, the model of the agent that reads each pull request with fresh eyes before the merge. Ask with `AskUserQuestion`, right after the writing model: "Which model should give the second opinion on your pull requests?"
   - **Opus 5.5** (recommended): the same family as the reviewer of the chain. Its independence comes from what it reads (the pull request, the sheet and the requirements, never the reports of the other agents). The cheaper choice. Saved as `opus`.
   - **Fable 5.2**: another family than the reviewer, so a more independent view, at about twice the price of Opus for each second opinion. Saved as `fable`.

   If the answer is neither, ask again once, then save `opus`. Save with `recade config set models.second_opinion <opus or fable>`. Say in one line that `recade config set models.second_opinion fable` changes it later, and that it is the default of the next `recade harness install`. A project that has the harness keeps its own choice: `recade harness models --dir .claude/agents --second-opinion <opus or fable>` changes it there.
5. Extra files, the optional deliverables for your stakeholders. Ask with `AskUserQuestion` with `multiSelect` on: "Which extra files should Recade render for your stakeholders? D1, D2, D3 and the PLAN are always rendered."
   - **Stack**: the stack decision as a Word file, and its weighted matrix as an Excel file (`STACK_<Title>.docx` and `.xlsx`). Saved as `stack`.
   - **Decisions**: one register of every decision (`DEC-*`) as `DECISIONS_<Title>.docx` and `.xlsx`. Saved as `decisions`.
   - **Design**: each design direction board as its own PDF, `DESIGN_<Board>.pdf`. Saved as `design`.
   - **Reviews**: every review note gathered in `REVIEWS_<Title>.docx`. Saved as `reviews`.

   AskUserQuestion adds "Other" by itself. Join the names the owner picked with commas and no spaces, and save with `recade config set deliverables.extras <names>`. Keep the valid picks and ignore the rest of the answer; save `none` only when no valid pick remains, and say so in one line. Say in one line that `recade config set deliverables.extras stack,decisions` (or `none`) changes it later, and that `/recade:docs` and `/recade:amend` render the extra files after the usual ones.
6. Deck, a separate question right after the extra files (`AskUserQuestion` takes at most 4 options, so it cannot be a fifth extra). Skip it when `recade config get deliverables.deck` prints `yes` or `no`. Ask with `AskUserQuestion`, single choice: "Do you want a PowerPoint deck that sums up the project for a steering committee?" Say in the question that the deck holds the context and goal, the scope, the architecture, the security essentials, the lots of the PLAN, the decisions, the open points and the next steps, in the colours of the project.
   - **No** (recommended): an owner working alone rarely presents to a committee, and the Word files and dossiers already hold everything. Saved as `no`.
   - **Yes**: `recade render extras` also writes `DECK_<Title>.pptx` into `docs/deliverables/`. Saved as `yes`.

   If the answer is neither, ask a second time, and save `no` when it is still neither. Save with `recade config set deliverables.deck <yes or no>`. Say in one line that `recade config set deliverables.deck yes` (or `no`) changes it later.
7. Writing voice, the style of every document, comment and report Recade writes. Ask with `AskUserQuestion`, always naming the person in full, never by a short id:
   - **Randall Munroe** (recommended): plain words, short sentences, deadpan humour born from precision. Saved as `randall-munroe`.
   - **Julia Evans**: warm and curious, explains things step by step, friendly without fluff. Saved as `julia-evans`.
   - **Paul Graham**: plain and direct essay style, no jokes, every sentence earns its place. Saved as `paul-graham`.

   AskUserQuestion adds "Other" by itself; if the user names someone else, save the full name in lowercase with hyphens. Save with `recade config set voice <id>`. When you mention the voice later, use the full name ("Randall Munroe"), never the id.
8. Design reference servers, optional. Run `claude mcp list`. A server is connected when a line names it: its name contains `mobbin`, `refero` or `nicelydone`, case-insensitive. If the command fails, run ToolSearch with each keyword instead: a server is connected when a tool comes back whose server part (the word between the first two double underscores of `mcp__<server>__<tool>`) contains it. When all three are connected, say so in one line and go on. Otherwise: <!-- shared:design-servers -->Say in plain words what each server not yet connected brings. Mobbin: screens and flows of real iOS, Android and web apps. Refero: screens and flows of real web and iOS apps, searched by style and pattern. Nicelydone: screens and flows of real web products, mostly SaaS. With one, the art direction draws on real screens instead of the brief alone. Each needs the owner's own paid account: Recade pays for nothing, never asks for a key, and runs a command only after the owner's yes. Ask with `AskUserQuestion`: "Connect a design reference server?" Options: `Connect one now` (recommended when you have an account: Recade runs the command for you), `Show me how` and `Go on without` (the directions come from the brief alone). On `Connect one now`, ask which one, with only the servers not connected as options, show its exact command, and ask "Run this command?" with `Yes, run it` and `No`. Only on `Yes, run it`, run it with Bash. The commands are, for Mobbin `claude mcp add --transport http --scope user mobbin https://api.mobbin.com/mcp`, for Refero `claude mcp add --transport http --scope user refero https://api.refero.design/mcp`, and for Nicelydone `claude mcp add --transport http --scope user nicelydone https://mcp.nicelydone.club/mcp`. `--scope user` makes the server available in every project of this machine. Then tell the owner to type `/mcp`, pick the server and sign in with their account in the browser: the sign-in stays in Claude Code, never in a file of a repository. Its tools appear after the sign-in, or in a new session. If the command fails, show its error in one line and go on without. On `Show me how`, show the command of each server not connected and the `/mcp` sign-in, then go on without. On `Go on without`, go on.<!-- /shared:design-servers --> `/recade:docs` offers it again before the art direction when none is connected.

   Then, with no question, run `recade config get stack.prefer` and say in one line the stack preference it prints (`php: symfony` by default): the stack analyst puts that framework first when it fits, and `recade config set stack.prefer.<language> <framework>` (or `none`) changes it.

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
