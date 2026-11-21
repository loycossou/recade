# Changelog

This file is curated by hand for each release. At tag time, `recade release-notes <from>..<to> --version <v> --write` produces the raw list from the conventional commits, and this section is then edited from it.

## Unreleased

### The writing model

- You choose the model of the agents that write and review your documents: Fable (the default) or the latest Opus, at the same high effort. `/recade:start` asks it once, `recade config set models.writer opus` changes it, `/recade:setup` and `/recade:help` show it.
- `recade models writer` prints the alias to dispatch with (`fable` or `opus`), and `recade models writer --id` the full id (`claude-fable-5-2` or `claude-opus-5-5`). Every `/recade:*` command that dispatches a writing agent reads it once and passes it to each dispatch, and the recruiter writes it in the model column of the roster. The mechanical agents keep their own model.
- The second opinion of the harness stays on Fable whatever you choose, because it must come from another model family than the reviewer, which runs on Opus.

## 1.0.0 (2026-11-18)

First public release.

### Getting started

- `/recade:start` checks the machine, asks for your languages, writing voice, GitHub account and projects folder, and shows the commands. It can run again at any time.
- `/recade:setup` runs the machine check alone. `/recade:help` shows the command map. `/recade:languages` changes the languages later.
- English everywhere by default. Keywords stay in English, whatever the language of the chat or the documents.
- One writing voice for everything Recade writes, with the em dash and common writing tics refused by the style check.

### Three ways in

- `/recade:new` starts a project from scratch and creates its workspace.
- `/recade:new --from <folder>` starts from existing documents: it files them, fits them to the Recade templates and lists what is missing.
- `/recade:adopt` brings existing code repositories under Recade, in a new workspace, without changing their architecture, stack, CI or layout.

### The project workspace

- Every project lives in one private git repository, `<slug>-workspace`, that holds the intake, decisions, BIBLE, team, slice sheets, state and rendered documents, and keeps its code repositories under `repos/<name>/`. `repos/`, `artifacts/`, `tmp/` and `.recade/` are not tracked. A document of Recade is never copied into a code repository, a pull request or the CI log of a code repository.
- `recade repo add|list|check|sync` keeps the registry of code repositories, and `recade repo sync` clones the missing ones and writes the links on another machine. `recade workspace root`, `recade workspace auto-push on|off` and `recade workspace commit --paths <paths> -m <message>` (for the documents of the workspace) work from any folder of the project.
- The harness installs at two targets: the project commands in the workspace (`recade harness install --target workspace`), the slice commands, the 20 agents, the guard, the git hooks and the CI in each code repository (`--target code --repo <name>`).
- `touches:` globs carry the repository (`api:src/orders/**`). A slice across repositories has one status and one pull request for each repository, an optional `merge_order:`, a `merged:` record of the commit of each, and is `done` when every pull request is merged. `/parallel`, `/board`, `/merge-order`, the conflict check and `recade retro` work across the repositories of a slice.
- The guard of a slice session judges the writes of every repository of the slice and of the workspace, and refuses all of them when the link between a code repository and its workspace is missing or points to another workspace.
- Automatic push of the workspace after one yes from the owner at the creation of its GitHub repository. It pushes only the workspace and only its default branch, and a failed push is one warning line. The workspace repository gets looser branch protection than a code repository, because Recade commits documents to its default branch.
- The optional second-opinion job of a code repository reads the private slice sheet by cloning the workspace with the secret `RECADE_WORKSPACE_TOKEN` (a fine-grained token with Contents read-only) and the variable `RECADE_WORKSPACE_REPOSITORY`. Without them the job ends with a notice and the second opinion runs locally. That the reviewer does not quote the sheet is a rule of its prompt, not a technical barrier.
- The recorded example runs end to end under a parent folder with a space and an accent, with the code repositories `api` and `web`, and a slice across both goes from `todo` to `done`.

### Phases and gates

- Intake with a questionnaire, a gap list and provisional values marked `PROVISIONAL` until the real value arrives (G0).
- Team of expert-inspired roles with a written doctrine for each (G1).
- Documents: D1 Functional Specifications, art direction, the stack decision with measured spikes, D2 Technical Architecture, D3 Security Requirements and the delivery plan (G2-stack, G2).
- BIBLE, PLAN and a checked ID index that cites each requirement with what it says (G3).
- Slices, with a choice of `small`, `large` or `mixed` slicing, a dependency graph and a status table (G4). The private GitHub repository, the board fields and the issues are created only after a dry run and your yes.
- Harness install and verification, with GitHub branch protection offered and applied only on your explicit yes (G5).
- `/recade:status`, `/recade:resume` and `/recade:amend` to see where you are, pick up after a break and change an approved document.

### Documents

- `recade render` turns Markdown into Word, PDF and Excel files, with figures drawn from Mermaid or HTML, an embedded font and checks on IDs, style and provisional values.

### The harness in your project

- 20 agents with one model table, and 15 commands, including `/slice`, `/parallel`, `/board`, `/review`, `/retro`, `/second-opinion` and `/merge-order`.
- Three lanes (`sensitive`, `standard`, `no-code`) with fixed statuses and verdicts. No agent merges, pushes to `main`, skips a git hook or deletes a test.
- Hooks, git hooks and a deny list that stop the usual mistakes. They are not a sandbox: the known limits are in `harness/protocol.md`, and GitHub branch protection is the real barrier.
- Gate stamps tied to the exact state of the tree, so a "green" always has a run behind it.
- Slices in parallel without conflicts: file scopes, hot files, a conflict check against open pull requests, and an ordered merge with mechanical conflicts resolved for you.
- A second opinion on pull requests from an agent on another model family.
- Cost per slice, with real token counts read from the session (`recade cost record --transcript`), and retros with DORA metrics (`recade retro`).
- Quarantine for flaky tests, a demo for interface pull requests, and release notes from conventional commits.
- Test cases for every agent, listed by `recade cases` and replayed on demand with `--run`.

### Adopting an existing repository

- A preflight that refuses to start with uncommitted work, off the default branch or with commits that are not pushed, and names each reason. The original repository is only read, never written: the workspace clones its remote.
- An inventory of each package, then rules, invariants and contracts written from the code, with golden files and a register of deviations. `--full` writes D1 to D3 instead.
- Matching of your existing GitHub board and the open issues of your repositories to the slices after a multiple-choice question, with no duplicate board or issue. A linked issue stays in its code repository.
- The harness installs in the clone of each repository beside your own CI, git hooks and `CLAUDE.md`. Files you wrote are never edited or deleted. In the code repository Recade writes only its harness (`.claude/`, `.githooks/`, its own workflow files); `.gitignore` gets appended lines, `CLAUDE.md` a generated block, and `dependabot.yml` is written only when absent. The documents of Recade stay in the workspace.

### Safety

- The intake scan refuses invisible Unicode and bidirectional controls in attachments, and blocks files it cannot check until you accept them.
- The style check reports the same characters in your own files. `recade-style-ignore` skips one line only.
- `npm run publish-check` checks what would be published, and `npm run e2e` runs the made-up example project in the three entry modes.
