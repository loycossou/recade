# Recade

[![A two-minute introduction to Recade, video of 19 MB](docs/video-poster.jpg)](https://github.com/loycossou/recade/releases/download/v1.0.0/recade-intro.mp4)

Recade takes a software project from "we should build this" to agents shipping it slice by slice, with an expert-inspired team, real documents and a human at every gate. It is named after the scepter the kings of Danxomè gave their messengers so that their word became law, and it was made by Loyc COSSOU (loycossou[at]gmail.com).

It is a Claude Code plugin. It builds a team of roles, picks the stack from measured evidence, writes the documents (D1 Functional Specifications, D2 Technical Architecture, D3 Security Requirements, a delivery plan), writes the rules (the BIBLE), cuts the plan into slices, and installs a harness of agents, commands, hooks and CI in the workspace of the project and in each of its code repositories. It stops at every gate and waits for your yes. How it works, and why, is in [docs/design.md](docs/design.md).

## Requirements

- Claude Code.
- Node 20 or later.
- git.
- The GitHub CLI `gh`, signed in, with the `project` scope (`gh auth refresh -s project`), unless the project stays local (see "GitHub or local" below).

`/recade:start` checks all of this, and installs the npm dependencies itself on first run. The Mermaid figures and the design boards need Chromium (see Rendering documents).

## Install

In Claude Code:

```
/plugin marketplace add loycossou/recade
/plugin install recade@recade
/recade:start
```

`/recade:start` checks your machine, asks which languages, writing model, extra files and writing voice to use, and shows the commands. Run it again at any time. It skips what is already done.

To test a local copy, start Claude Code with `claude --plugin-dir <path>`, where `<path>` is the folder of this repository.

## Three ways in

| Mode | Command | When |
|---|---|---|
| Scratch | `/recade:new <project>` | You have an idea and few or no documents. Recade creates the workspace of the project. |
| Given specs | `/recade:new <project> --from <folder>` | Documents exist. Recade files them, fits them to its templates and lists what is missing. |
| Adopt | `/recade:adopt` | You have one or more code repositories under way. Recade creates a workspace and clones them into it. |

`/recade:adopt` changes nothing in your architecture, stack, CI files or layout. It asks for the parent folder of the new workspace and for the repositories (a local folder or a URL), and it refuses to start when a local repository has uncommitted work, is not on its default branch or has commits that are not pushed, and says which. The workspace clones the remote of each repository, so the original folder is only read and is never written. In a code repository it writes only the harness: `.claude/`, `.githooks/`, its own workflow files, a block of `CLAUDE.md`, and `.gitignore` when absent or by appended lines. It never edits or deletes a file it did not create. Everything else goes into the workspace. It then:

- takes an inventory of each package or repository (S-00) and describes the stack in place;
- writes what agents need from the code: `docs/RULES.md` (with golden files), `docs/INVARIANTS.md` and `docs/CONTRACTS.md`, and a deviations register where each departure from the code's own conventions is recorded and never fixed (`--full` writes D1 to D3 instead);
- matches the existing GitHub boards and open issues of your repositories to the slices after a multiple-choice question, without duplicating anything;
- installs the harness beside your own CI.

## The project workspace

Every project lives in one folder, `<project>-workspace`, which is a private git repository. It holds what is private (the intake, the decisions, the BIBLE, the team, the slice sheets), the state of Recade and the rendered documents, and it keeps the code repositories of the product under `repos/<name>/`.

```
<project>-workspace/     private git repository
  recade/  intake/  team/  design/  decisions/  retros/  docs/  slices/
  BIBLE.md  INDEX.md  CLAUDE.md  .claude/  .githooks/  .github/
  repos/                 ignored by git: one ordinary clone for each code repository (api, web...)
  worktrees/  artifacts/  tmp/   ignored: slice worktrees (worktrees/<repo>/<S-nn>), builds and exports, drafts
  .recade/               ignored: local to this machine
```

- **Code repositories.** `recade repo add <name> --new | --clone <url or folder>` registers one, `recade repo list` and `recade repo check` show them, and `recade repo sync` clones the missing ones and writes the links on another machine. A local folder is cloned; the registry records the folder's own `origin`, or `none` when it has none. A URL with a password or a token is refused. Each repository has its own GitHub repository, created only after your yes. A document of Recade is never copied into a code repository, a pull request or its CI log. **GitHub or local:** `/recade:slices` asks once where the code lives. `Local only` keeps everything on this machine: no `gh` call, no remote, the board is `slices/STATUS.md`, and a slice ends with a review request in `slices/reviews/<S-nn>.md` instead of a pull request. You merge it: `recade slices merge <S-nn> --dry-run` prints the exact `git -C '<repo>' merge --no-ff <branch>` for each repository, and `/board` runs it only after your yes (or you run it in a terminal). Branch protection, the GitHub-only workflows and dependabot are skipped. `GitHub` gives private repositories, a board, issues and pull requests. `recade state set forge github` moves a local project to GitHub later.
- **One entry point.** Every session starts at the root of the workspace, and you type `/slice <S-nn>` there. `recade harness install --target workspace` puts every command and every agent in the workspace. `--target code --repo <name>` gives a code repository what belongs to the code: its git hooks, its CI, the guard, and a pointer command that sends a session opened there back to the workspace. `/slice` reads `touches:` and opens the worktree of each repository it names under `worktrees/<repo>/<S-nn>`: you never choose a folder. A project made before this layout moves with `recade harness migrate` (try `--dry-run` first), which `/recade:harness` offers.
- **Slices across repositories.** `touches:` globs start with the repository (`api:src/orders/**`, `web:src/pages/orders/**`). A slice has one status and one pull request for each repository, and is `done` when every one is merged. The GitHub board holds one epic for each lot of the PLAN, with its stories and slices as sub-issues, and each story carries its text, acceptance criteria and estimate from the PLAN. `recade github sync` keeps it in step when the PLAN or the slices change, after your yes, and `/board` closes an epic when its slices are done.
- **Automatic push.** When you create the workspace repository on GitHub, Recade asks once whether to push the workspace after each step. It pushes only the workspace and only its default branch, never a code repository. A failed push is one warning line, never an error. `recade workspace auto-push off` turns it off.
- **Second opinion in CI.** The slice sheet is private, so the optional CI job reads it by cloning the workspace. You set, in the code repository, the secret `RECADE_WORKSPACE_TOKEN` (a fine-grained token with Contents read-only on the workspace repository only) and the variable `RECADE_WORKSPACE_REPOSITORY` (`owner/name` of the workspace). Without them the job ends with a notice and the second opinion runs locally with `/second-opinion`. The reviewer is told never to quote the sheet in its comment: that rule is in its prompt and is not enforced by anything else.

## The phases and the gates

| Phase | Command | Gate |
|---|---|---|
| 0. Intake | `/recade:new` | G0 |
| 1. Team | `/recade:team` | G1 |
| 2. Documents | `/recade:docs` | G2-stack, then G2 |
| 3. Bible | `/recade:bible` | G3 |
| 4. Slices | `/recade:slices` | G4 |
| 5. Harness | `/recade:harness` | G5, then `/slice S-01` |

The documents phase is meant to be short. Each document has a word budget, code blocks excluded: D1 10,000, D2 9,000, D3 7,000, PLAN 7,000, STACK 6,000, BIBLE 8,000. `recade docs size --project <dir>` prints the words of each document against its budget (a word in a table counts for half, and translations are not measured) (over it is a warning, over 150% an error the author fixes by cutting), `recade docs budgets` prints the budgets in force, and `recade state set budgets 'D1=12000,PLAN=8000'` changes them for one project. Each document has one reviewer and one review (D1 the domain expert when there is one, otherwise the architect; D2 the security lead; D3, the PLAN and the STACK the architect, the STACK with at most one more role; the art direction the UX designer; the BIBLE the chief reviewer): a `blocker` or a `should fix` is applied in one revise round, a `nit` is listed and not applied. You are asked only what is costly, binding, irreversible, legal, or what changes the scope, the budget or the calendar, a few questions at a time (aim: 10 at most). What is reversible, technical or a convention is decided by the team with a one-line reason, recorded in `decisions/TEAM.md` (`recade decision team add | list | challenge`), and shown to you as one list at each gate: challenge any line and it becomes a question. If you would rather answer less, `/recade:new` lets you trust the team (`recade state set decisions trust` changes it later): the team then also takes the recommended option of every decision that is reversible and costs nothing, and of every stack layer whose finalists cost the same and lock you in the same way. You still get what costs money, binds the client or cannot be undone, and you still pass every gate. Every main step of `/recade:docs` and `/recade:bible` starts with one line that says where you are ("Step 3 of 9: D1, functional specifications") and what comes next.

When the stack is chosen (G2-stack), each layer with a real choice gets a ranked top 5 in `docs/STACK.md`: the option and its version, why it fits this project, and its main drawback. You read the top 5 in the chat and pick one. The question lists ranks 1 to 4, and you type the name of the 5th in `Other`. Only the top 2 or 3 are tried in a spike, a short real test on your machine: Recade first says what it would install, checks the free memory and disk (`recade spikes check`), and when the spikes end removes what they created, as their manifests list it, and nothing else (`recade spikes clean`). A layer you impose yourself has no top 5. The analyst puts the framework you prefer first when it fits: `stack.prefer` in your user config, `php: symfony` by default (`recade config set stack.prefer.python django`, or `none`).

`/recade:new` asks for a track. The short track, for a first version, a small team or an internal tool, halves the word budgets, revises a document only for a blocker, offers two art directions, keeps a top 3 per stack layer and spikes a layer only when its two best options are within 10 percent and you say yes, keeps the BIBLE to its core rules and the team to its core roles, makes S-01 a walking skeleton (`skeleton: true` in its sheet), and writes sheets for the first increment only, S-01 plus at most 5, with the rest in `slices/BACKLOG.md` for the next run of `/recade:slices`. The full track, the default, is for money, health data, regulation or several teams. Both keep every gate. `recade state set track short` changes it. `/recade:status` and the retro say how many days the first slice took. A phase does not start while the gate before it is open, and a gate passes only on your answer. `/recade:status` shows where you are. `/recade:resume` picks up after a break. `/recade:amend` changes an approved document and regenerates what depends on it.

Before an agent reads a file you gave it, `recade intake scan` checks it for invisible Unicode and bidirectional controls. A file that cannot be checked, such as a PDF or an image, is blocked until you accept it yourself.

## Design references

The art direction can draw on screens of real apps. If you connected a design-reference server with your own account, `/recade:docs` finds it when the art direction starts and asks whether the designer picks the references or you give your criteria (platform, product type, key screens, style). It lists at most 12 candidates, you pick, and your picks are written to `design/references.md`. The boards draw on them and cite each one by name and link, as text: a board never loads anything, it stays offline. The servers are Mobbin (`https://api.mobbin.com/mcp`), Refero (`https://api.refero.design/mcp`) and Nicelydone (`https://mcp.nicelydone.club/mcp`). Each needs your own paid plan. `/recade:start` and, when none is connected, the art direction offer to connect one: Recade runs the command for you after your yes (`claude mcp add --transport http --scope user nicelydone https://mcp.nicelydone.club/mcp`, and the same for the others), or shows you how, or goes on from the brief alone. You then sign in with `/mcp`: no key is ever written in a file. The tools of a server may ask your permission the first time. To redo the references, delete `design/references.md`. What a server returns is treated as untrusted data, and only an app name, a screen type, a short note and an `https` link are kept.

## The writing model

The agents that write and review your documents (the team, D1 to D3, the STACK, the BIBLE, the slice sheets, the intake and the code reading of an adopted repository) run on the latest Opus by default, at high effort. You can choose Fable instead, at the same effort. `/recade:start` asks once. Change it later with `recade config set models.writer fable` (or `opus`), and read it with `recade models writer`, which prints the alias, or `recade models writer --id`, which prints the full id (`claude-fable-5-2` or `claude-opus-5-5`). Every `/recade:*` command reads it once and passes it to each agent that writes. The mechanical agents (the inventory and the spikes) keep their own model. The second opinion runs on Opus 5.5 by default (the same family as the reviewer, allowed by `second_opinion.same_family: warn` in `harness/models.yaml`). `/recade:start` also asks it: `recade config set models.second_opinion fable` puts it on Fable 5.2, another family, so a more independent view at about twice the price, applied by the first `recade harness install` of a project. Once installed, the project copy holds the choice, so every machine agrees: change it for the project with `recade harness models --dir .claude/agents --second-opinion fable` (or `opus`), then commit. The mechanical stages (a translation, the glossary, your decisions applied to a text, a style, index or render fix) run on Sonnet at medium effort, read with `recade models mechanical`. Drafting and reviewing never do.

## The harness

Phase 5 installs the harness in two places: the workspace (the project commands, the 8 agents that write documents, hooks, git hooks and a CI workflow for the documents) and each code repository (the slice commands, 20 agents, hooks, git hooks, CI workflows), each with a protocol (`.claude/protocol.md`). Each slice follows a lane (`sensitive`, `standard` or `no-code`) with fixed statuses and verdicts. No agent merges, pushes to `main`, skips a git hook or deletes a test. The whole chain, with diagrams and the role of each agent, is in [docs/delivery.md](docs/delivery.md).

The hooks stop the usual mistakes and the obvious detours. In a slice session the guard judges every write across the repositories of the slice and the workspace, and it refuses all of them when the link between a code repository and its workspace is missing (`recade repo sync` repairs it). The hooks read a command line, they do not run a shell, and they are not a sandbox: the known limits are listed in [harness/protocol.md](harness/protocol.md). While `loycossou/recade` is private, the CI of a project on another account needs a read-only deploy key in the secret `RECADE_DEPLOY_KEY` ([docs/design.md](docs/design.md#a-private-recade)). The real barrier to a merge is GitHub branch protection with required reviews and checks. `/recade:harness` offers to set it up, and only with your explicit yes. On the local forge there is none: you are the barrier, and `recade slices merge`, which the guard refuses to every agent, is the merge path.

From the terminal, `recade cost record` stores the minutes, the fix loops and the tokens of a slice. With `--transcript` and `--session-dir` the tokens are counted from the session file itself, and when no single session can be found it records `tokens: not recorded` and never guesses. `recade retro` turns those records into a retrospective, `recade release-notes` writes release notes from conventional commits, and `recade cases` lists the agent test cases and replays them with `--run`. `recade quarantine` keeps flaky tests in `tests/quarantine.json` until they are fixed. `recade cost estimate` prints what each phase not passed yet should cost, as a range in dollars at API prices with the number of agent runs and a range of hours, and `--slice standard` or `--slice sensitive` does the same for one slice. Each phase shows its line in its first message, and each step's progress line says how long the step usually takes. Every question to you is a closed choice, the recommended option first. It is an estimate, never a measure, and on a Claude subscription the work counts against your usage limits instead.

## Commands

<!-- commands:start -->
### Plugin commands

| Command | What it does | Status |
|---|---|---|
| `/recade:start` | First run: check the machine, set preferences, show the commands. | available |
| `/recade:setup` | Check the machine and say how to fix what is missing. | available |
| `/recade:help` | Show this list. | available |
| `/recade:languages` | Change the languages for chat, documents, code and product. | available |
| `/recade:new` | Start a project: intake, team, documents, bible, slices, harness. | available |
| `/recade:adopt` | Bring an existing code repository under Recade. | available |
| `/recade:team` | Build or revise the expert-inspired team of a project. | available |
| `/recade:docs` | Write or render the project documents (D1, D2, D3, STACK, PLAN). | available |
| `/recade:bible` | Write or update BIBLE.md and the ID index. | available |
| `/recade:slices` | Cut the plan into slices and write the slice sheets. | available |
| `/recade:harness` | Install the agent harness in the project. | available |
| `/recade:status` | Show the phase, the gates and the next action of a project. | available |
| `/recade:resume` | Pick up a project where it stopped. | available |
| `/recade:amend` | Change an upstream document and regenerate what depends on it. | available |

### Commands the harness installs in each project

| Command | What it does | Status |
|---|---|---|
| `/status` | Slices, satisfied dependencies, gates waiting for a human, launchable slices. | available |
| `/slice` | Deliver one slice end to end, following its lane. | available |
| `/slice-check` | Check that a slice sheet is ready, then refresh CLAUDE.md. | available |
| `/slice-write` | Create a slice sheet from the template and the sources. | available |
| `/parallel` | Propose 3 to 5 slices to start now and open one worktree each. | available |
| `/review` | Review a branch against its slice sheet. | available |
| `/design` | Design work: direction, system, variants, spec or review. | available |
| `/board` | Reconcile the board, then clean the repository, worktrees and branches. | available |
| `/inventory` | S-00: inventory of what already exists. | available |
| `/decision` | Open a DEC file through a multiple-choice questionnaire. | available |
| `/retro` | Increment review with DORA metrics and cost per slice. | available |
| `/amend` | Change an upstream document and regenerate what depends on it. | available |
| `/explain` | Explain a project tool step by step. | available |
| `/second-opinion` | Second-opinion review of an open pull request, by an agent with fresh eyes. | available |
| `/merge-order` | Order the open pull requests, rebase the next one after each merge, resolve mechanical conflicts. | available |
<!-- commands:end -->

The project commands of the harness (`/status`, `/board`, `/parallel`, `/merge-order`, `/retro`, `/slice-write`, `/slice-check`, `/decision`, `/inventory`, `/design`, `/amend`) are installed in the workspace. The slice commands (`/slice`, `/review`, `/second-opinion`, `/explain`) are installed in each code repository.

The same list is available in Claude Code with `/recade:help`. The table is generated by `node bin/recade.js help --markdown`.

## Rendering documents

`recade render` turns Markdown documents into Word and Excel files, and an HTML dossier to read on a screen. Each is named after its ID and its title in the document language, with no accent or space: `D1_Functional-Specifications.docx`, and `D1_Specifications-Fonctionnelles.docx` for `docs/D1.fr.md`. From the plugin folder:

```
node bin/recade.js render docs/D1.md docs/PLAN.md [--format docx,xlsx,html,pdf] [--out <dir>] [--no-check]
```

Outputs go to `docs/deliverables` of the project (the nearest folder holding `recade/state.yaml`). `PLAN.md` also yields a workbook of the same name. Each document also gets a self-contained HTML dossier (light and dark theme, no network), and the folder an index page that links them. The author writes a short companion next to the document, `docs/D1.story.yaml`: a kicker, a one-sentence lede, key facts, the recap in a few sentences, and an everyday image for the hardest sections. The dossier and the Word cover read from it; without it they render from the Markdown alone. There is no PDF unless you ask: `recade config set deliverables.pdf true` adds one next to each Word file. A file of an older render (`D1.docx`, `D1.pdf`) is left as it was and listed once with `Left as it was:`; delete it when you no longer need it. The source is checked first (style, IDs, line anchors); nothing is written if a check fails or a figure cannot be drawn. Mermaid or HTML figures, the PDF and the boards need Chromium: `npx --prefix "<path>" playwright install chromium`. `/recade:setup` shows what is missing. Drawn figures are cached in `.recade-cache/` (keyed on the plugin version, the bundled Mermaid, the figure stylesheet and the page size), and `render` adds `.recade-cache/` to an existing `.gitignore`. Assets linked from an HTML figure are not part of the cache key: delete `.recade-cache/` after changing one.

### Look of the documents

The default look is coloured: navy table headers, light grey zebra rows, light blue key cells, pastel callouts, and Mermaid figures in a pastel palette (add `:::ok`, `:::warm`, `:::error` or `:::system` to a node; `-.->` is an optional path). Each figure is numbered and captioned in the language of the document, and the templates ask for a minimum set: D1 three, D2 three, D3 one, the PLAN one (the render warns when a document has fewer, or a figure has no caption). IDs are small and muted, and `PROVISIONAL` is a small tag, not a highlight. `design/theme.json` changes the brand (fonts, `color.accent`, `color.chartFill`); the colours of the tables, callouts, tag and `figure` palette are theme keys too (6 hex digits, no `#`), and the art direction leaves them alone unless you ask. The headings of D1, D2 and D3 are translated into the document language by the author; the PLAN shows its sheet and column titles in that language.

### Extra deliverables

D1, D2, D3 and the PLAN are always rendered. `/recade:start` also asks which of four extras to render for your stakeholders, and keeps the answer in your user config as `deliverables.extras` (none by default). Change it with `recade config set deliverables.extras stack,decisions`, or `none` to clear it.

| Extra | Files in `docs/deliverables/` |
|---|---|
| `stack` | `STACK_<Title>.docx` and `STACK_<Title>.xlsx` (one sheet for each table of the weighted matrix) |
| `decisions` | `DECISIONS_<Title>.docx` and `.xlsx` (one section, and one row, for each decision) |
| `design` | `DESIGN_<Board>.pdf`, one for each board of `design/directions/`, and `DESIGN_<Title>.docx` from `design/references.md` when it exists |
| `reviews` | `REVIEWS_<Title>.docx`, one section for each note of `docs/reviews/` |

`recade render extras --project <dir>` renders the ones you chose, and `/recade:docs` and `/recade:amend` run it after the usual render. The PowerPoint deck for a steering committee, `DECK_<Title>.pptx`, has its own key, `deliverables.deck` (`ask` by default, then `yes` or `no`): `/recade:start` or `/recade:docs` asks you once, and nothing is made before your `yes`. It sums up the context, the scope, the architecture, the security, the lots, the decisions, the open points and the next steps, in the colours of your logo or your art direction. The decision and review registers are built in memory and never saved in `docs/`. A missing source is a warning line, not a failure. An extra you un-choose, or whose source you remove, leaves its old files in `docs/deliverables/`: Recade never deletes them, so delete them by hand. Each board is its own PDF: no PDF merge library is part of Recade, and a board prints without JavaScript, with no network and with no file from outside the project.

## Development

```
npm ci
npm test
npm run e2e
npm run publish-check
```

`npm test` runs the unit tests, then the style check (`node bin/recade.js lint-style .`). `npm run e2e` runs the made-up example project in `example/` end to end in the three entry modes (scratch, given specs and adopt), and once more on the local forge (`local`, where the fake `gh` must never be called), with a fake `gh`, so no network is used. The workspace is created under a parent folder with a space and an accent in its name. A new product gets two code repositories, `api` and `web`, the adopted one is cloned, and each run ends with a slice that goes from `todo` to `done` with a fake pull request in each repository. A change to the file format of any phase fails it with the phase, the file and the first differing line. `npm run e2e -- --update` records the expected files again. A line that carries `recade-style-ignore` is skipped by the style check, that line only. CI runs the tests on Node 20 and 22. `npm run publish-check` checks what would be published: no em dash, no raw e-mail address, no private name when a list is given (`--names <file>` or `RECADE_PRIVATE_NAMES`; without one the names are not checked, and `--require-names` makes a missing list fail), no file over 5 MB, no private working file, matching versions and a licence. `npm run publish-check -- --history` lists the commits that ever held a private path.

Checks that no test can make are in [docs/live-checklist.md](docs/live-checklist.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Acknowledgements

Some ideas were adapted from the public ecc repository (affaan-m/ecc, MIT licence). No text was copied.

## Licence

MIT. See [LICENSE](LICENSE).

## Author

Loyc COSSOU · loycossou[at]gmail.com · https://github.com/loycossou
