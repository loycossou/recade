# Changelog

This file is curated by hand for each release. At tag time, `recade release-notes <from>..<to> --version <v> --write` produces the raw list from the conventional commits, and this section is then edited from it.

## Unreleased

### Coloured documents, captioned figures, quieter IDs

- The default look is coloured, as in a hand-made report: a navy header row with white text, light grey zebra rows, light blue cells for what names a row, pastel callouts and covers in navy. The colours are theme keys (`color.headerFill`, `headerText`, `zebra`, `keyCell`, `calloutNote`, `calloutWarning`, `calloutDecision`, `provisional`, `provisionalText`), checked as 6 hex digits. The default accent is now navy. A `design/theme.json` that sets these keys still wins; the art direction now writes only the brand (fonts, accent, ink, chart colour), so a new project no longer gets grey documents from a sober product theme.
- Mermaid figures use a pastel palette (`figure` group of the theme: info, ok, warm, error, system, line). A flowchart or a state diagram takes `A:::ok`, `:::warm`, `:::error`, `:::system` with no hand styling, boxes are rounded, and diagrams are drawn at their real size, so their text is readable. Captions read `Figure n: ...`, with a French spacing before the colon in French.
- The templates require a minimum set of captioned figures (D1: actors and system context, main journeys, states of the main object; D2: containers, deployment, a key sequence; D3: trust boundaries and data flows; PLAN: phases timeline), each with an example to replace, and the draft prompts say so. The render warns about a figure with no caption and about a document under its minimum.
- IDs are small and muted: a narrow first column in the ID tables, a small grey ID in a sentence. `PROVISIONAL` is a small coloured tag, written in the document language, instead of a yellow highlight.
- Headings in the document language: the writing agents now translate the headings of D1, D2 and D3 (they used to keep the English ones), and open each main section with one plain sentence. The PLAN keeps its English sheet and column titles in the Markdown and the render shows them in French.
- Headings use their own colour key, `color.heading` (default dark navy), for H1, H2, the cover title and the "Figure n" label, so a light `headerFill` in an older project theme no longer makes them pale. The headings translated by the writing agents are those of D1, D2 and D3 only: the PLAN, the STACK tech sheet, the BIBLE and the slice sheets keep their English headings, because code reads them.
- An ID is cited gist first, ID after: `upload a proof of income (FR-EX-01)`. `recade index check` reads both this form and `FR-EX-01 (gist)`, for the missing gist and the gist mismatch. A `classDef ok,warm ...` list now counts for every kind in it. The muted IDs include the backlog IDs of the project's lots, and a bare `M1` in a sentence is no longer muted (it still is in an ID column).
- A wide Mermaid figure is captured at its real width, up to 3,200 pixels, and the page scales it. The templates tell the authors to use a top-down layout beyond about 8 nodes in a row.

### A shorter documents phase

- Each document has a word budget, code blocks excluded: D1 10,000, D2 9,000, D3 7,000, PLAN 7,000, STACK 6,000 and BIBLE 8,000. `recade docs size --project <dir>` prints the words of each document against its budget (a word in a table counts for half, translations are not measured): over it is a warning, over 150% an error that the author fixes with a revise stage ("cut, do not summarise the cut"). `recade docs budgets` prints the budgets in force. A project changes them with `recade state set budgets 'D1=12000'` (the `budgets:` key of `recade/state.yaml`). The authors are given the budget in their prompt, and the `writing-voice` skill says to write for a busy client: one idea once, tables only for real tabular data, other documents cited instead of restated.
- One reviewer and one review for each document: D1 the domain expert (the architect when there is none), D2 the security lead, D3 and the PLAN the architect, the STACK the architect and at most one other role, the art direction the UX designer, the BIBLE the chief reviewer. A `blocker` or a `should fix` is applied in a single revise round, a `nit` is listed and not applied. A second round happens only when a blocker remains.
- Fewer questions for you. The team sorts every open question. What is costly, binding, irreversible, legal, or what changes the scope, the budget or the calendar is yours, a few questions at a time (up to 4 in one call, 10 at most as an aim for the phase). The rest is decided by the team with a one-line reason and written in `decisions/TEAM.md`. At each gate you read that register as one list and challenge any line in one go: it becomes a question. `recade decision team add | list | challenge` manages it.
- `/recade:docs` and `/recade:bible` open each main step with one line that says where you are ("Step 3 of 9: D1, functional specifications") and what comes next.

### A ranked top 5 for each layer

- For each layer of the stack with a real choice, `docs/STACK.md` now holds a ranked top 5: the option and its version, why it fits your project (two plain lines at most), its main drawback and its dated sources. A layer you impose has none.
- In `/recade:docs`, you read the top 5 of the layer in the chat before the question. The question lists ranks 1 to 4, and you type the name of the 5th in `Other`. After each answer the next layers are ranked again, and an option that no longer fits drops out with the reason.
- Only the top 2 or 3 are tried in a spike. Ranks 4 and 5 are researched, not spiked. A decision still keeps at most three options.

### Extra deliverables

- D1, D2, D3 and the PLAN are rendered as before. You can now add four extras for your stakeholders: `stack` (`STACK.docx`, `STACK.pdf` and `STACK-matrix.xlsx`, one sheet for each table of the weighted matrix), `decisions` (`DECISIONS.docx`, `DECISIONS.pdf` and `DECISIONS.xlsx`, one section and one row for each DEC), `design` (one `design-<board>.pdf` for each board of `design/directions/`) and `reviews` (`REVIEWS.docx` and `REVIEWS.pdf`, one section for each note).
- `/recade:start` asks once which extras you want. The choice is the user config key `deliverables.extras`, empty by default: `recade config set deliverables.extras stack,decisions` changes it, `none` clears it, and a name that is not one of the four is refused. `/recade:setup` and `/recade:help` show it.
- `recade render extras --project <dir>` renders the chosen extras into `docs/deliverables/`. `/recade:docs` and `/recade:amend` run it after the usual render and list the files. A missing source is a warning line, nothing is written unless every output succeeded, and the registers are built in memory, never saved in `docs/`.

### Design references

- The art direction can draw on screens of real apps. `/recade:docs` (and `/design direction` in a harness) looks for a design-reference server you connected with your own account: Mobbin, Refero or Nicelydone. You choose `The designer picks` or `I give my criteria`, pick from at most 12 candidates, and your picks are written to `design/references.md`. The boards draw on them and cite each by name and link as text, never loaded.
- Recade installs nothing and never requires a server. With none connected it says so in one line and goes on as before. What a server returns is untrusted data.
- The `design` extra also renders `design/references.md` to `design-references.pdf` when it exists.

### Render theme

- `design/theme.json` takes a `style` group: `h1Rule` and `calloutBar` set the width in points of the rule under an H1 and of the bar on the left of a callout (0 removes them), `headerSeparator` the text between the parts of the running header and of the sheet titles, and `tableRules` `grid` or `horizontal` (rules between rows only). `color.chartFill` fills the Gantt bars and the Mermaid boxes, and falls back to `color.accent`. A theme without these keys renders as before; an invalid value stops the render with a one-line error that names the key.

### Plain words in the chat

- When a command names an ID to you (a DEC, a provisional value, a requirement, a slice, a gate), it adds what that ID says in parentheses, as in `DEC-03 (weekly payouts)`, and it names an ID only when you need it to act.

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
