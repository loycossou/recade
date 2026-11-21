# Recade

Recade takes a software project from "we should build this" to agents shipping it slice by slice, with an expert-inspired team, real documents and a human at every gate. It is named after the scepter the kings of Danxomè gave their messengers so that their word became law, and it was made by Loyc COSSOU (loycossou[at]gmail.com).

It is a Claude Code plugin. It builds a team of roles, picks the stack from measured evidence, writes the documents (D1 Functional Specifications, D2 Technical Architecture, D3 Security Requirements, a delivery plan), writes the rules (the BIBLE), cuts the plan into slices, and installs a harness of agents, commands, hooks and CI in the workspace of the project and in each of its code repositories. It stops at every gate and waits for your yes. How it works, and why, is in [docs/design.md](docs/design.md).

## Requirements

- Claude Code.
- Node 20 or later.
- git.
- The GitHub CLI `gh`, signed in, with the `project` scope (`gh auth refresh -s project`).

`/recade:start` checks all of this, and installs the npm dependencies itself on first run. The PDF output and the Mermaid figures need Chromium (see Rendering documents).

## Install

In Claude Code:

```
/plugin marketplace add loycossou/recade
/plugin install recade@recade
/recade:start
```

`/recade:start` checks your machine, asks which languages, writing model and writing voice to use, and shows the commands. Run it again at any time. It skips what is already done.

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
  artifacts/  tmp/       ignored: builds and exports, drafts
  .recade/               ignored: local to this machine
```

- **Code repositories.** `recade repo add <name> --new | --clone <url or folder>` registers one, `recade repo list` and `recade repo check` show them, and `recade repo sync` clones the missing ones and writes the links on another machine. A local folder is cloned; the registry records the folder's own `origin`, or `none` when it has none. A URL with a password or a token is refused. Each repository has its own GitHub repository, created only after your yes. A document of Recade is never copied into a code repository, a pull request or its CI log.
- **Two harness targets.** `recade harness install --target workspace` puts the project commands in the workspace. `--target code --repo <name>` puts the slice commands, all the agents, the guard, the git hooks and the CI in a code repository. A slice session starts in a worktree of the code repository.
- **Slices across repositories.** `touches:` globs start with the repository (`api:src/orders/**`, `web:src/pages/orders/**`). A slice has one status and one pull request for each repository, and is `done` when every one is merged.
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

A phase does not start while the gate before it is open, and a gate passes only on your answer. `/recade:status` shows where you are. `/recade:resume` picks up after a break. `/recade:amend` changes an approved document and regenerates what depends on it.

Before an agent reads a file you gave it, `recade intake scan` checks it for invisible Unicode and bidirectional controls. A file that cannot be checked, such as a PDF or an image, is blocked until you accept it yourself.

## The writing model

The agents that write and review your documents (the team, D1 to D3, the STACK, the BIBLE, the slice sheets, the intake and the code reading of an adopted repository) run on Fable by default, at high effort. You can choose the latest Opus instead, at the same effort. `/recade:start` asks once. Change it later with `recade config set models.writer opus` (or `fable`), and read it with `recade models writer`, which prints the alias, or `recade models writer --id`, which prints the full id (`claude-fable-5-2` or `claude-opus-5-5`). Every `/recade:*` command reads it once and passes it to each agent that writes. The mechanical agents (the inventory and the spikes) keep their own model, and the second opinion stays on Fable whatever you choose: it must come from another model family than the reviewer.

## The harness

Phase 5 installs the harness in two places: the workspace (the project commands, the 8 agents that write documents, hooks, git hooks and a CI workflow for the documents) and each code repository (the slice commands, 20 agents, hooks, git hooks, CI workflows), each with a protocol (`.claude/protocol.md`). Each slice follows a lane (`sensitive`, `standard` or `no-code`) with fixed statuses and verdicts. No agent merges, pushes to `main`, skips a git hook or deletes a test.

The hooks stop the usual mistakes and the obvious detours. In a slice session the guard judges every write across the repositories of the slice and the workspace, and it refuses all of them when the link between a code repository and its workspace is missing (`recade repo sync` repairs it). The hooks read a command line, they do not run a shell, and they are not a sandbox: the known limits are listed in [harness/protocol.md](harness/protocol.md). The real barrier to a merge is GitHub branch protection with required reviews and checks. `/recade:harness` offers to set it up, and only with your explicit yes.

From the terminal, `recade cost record` stores the minutes, the fix loops and the tokens of a slice. With `--transcript` and `--session-dir` the tokens are counted from the session file itself, and when no single session can be found it records `tokens: not recorded` and never guesses. `recade retro` turns those records into a retrospective, `recade release-notes` writes release notes from conventional commits, and `recade cases` lists the agent test cases and replays them with `--run`. `recade quarantine` keeps flaky tests in `tests/quarantine.json` until they are fixed.

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

`recade render` turns Markdown documents into Word, PDF and Excel files. From the plugin folder:

```
node bin/recade.js render docs/D1.md docs/PLAN.md [--format docx,pdf,xlsx] [--out <dir>] [--no-check]
```

Outputs go to `docs/deliverables` of the project (the nearest folder holding `recade/state.yaml`). `PLAN.md` also yields a workbook. The source is checked first (style, IDs, line anchors); nothing is written if a check fails or a figure cannot be drawn. The PDF and Mermaid or HTML figures need Chromium: `npx --prefix "<path>" playwright install chromium`. `/recade:setup` shows what is missing. Drawn figures are cached in `.recade-cache/` (keyed on the plugin version, the bundled Mermaid, the figure stylesheet and the page size), and `render` adds `.recade-cache/` to an existing `.gitignore`. Assets linked from an HTML figure are not part of the cache key: delete `.recade-cache/` after changing one.

## Development

```
npm ci
npm test
npm run e2e
npm run publish-check
```

`npm test` runs the unit tests, then the style check (`node bin/recade.js lint-style .`). `npm run e2e` runs the made-up example project in `example/` end to end in the three entry modes (scratch, given specs and adopt) with a fake `gh`, so no network is used. The workspace is created under a parent folder with a space and an accent in its name. A new product gets two code repositories, `api` and `web`, the adopted one is cloned, and each run ends with a slice that goes from `todo` to `done` with a fake pull request in each repository. A change to the file format of any phase fails it with the phase, the file and the first differing line. `npm run e2e -- --update` records the expected files again. A line that carries `recade-style-ignore` is skipped by the style check, that line only. CI runs the tests on Node 20 and 22. `npm run publish-check` checks what would be published: no em dash, no raw e-mail address, no private name when a list is given (`--names <file>` or `RECADE_PRIVATE_NAMES`; without one the names are not checked, and `--require-names` makes a missing list fail), no file over 5 MB, no private working file, matching versions and a licence. `npm run publish-check -- --history` lists the commits that ever held a private path.

Checks that no test can make are in [docs/live-checklist.md](docs/live-checklist.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Acknowledgements

Some ideas were adapted from the public ecc repository (affaan-m/ecc, MIT licence). No text was copied.

## Licence

MIT. See [LICENSE](LICENSE).

## Author

Loyc COSSOU · loycossou[at]gmail.com · https://github.com/loycossou
