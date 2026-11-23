# Recade: how it works

This page explains what Recade does, in what order, and where it stops. It is written for the person who uses Recade. The README has the install steps and the command list. This page has the reasons.

In this page, the **owner** is the person who uses Recade and decides at the gates.

## 1. What Recade does

Recade is a Claude Code plugin. It takes a software project from an idea, or from existing code, to slices delivered by agents. It always works the same way:

1. It builds an **expert-inspired team**. Each role has a written doctrine drawn from the public work of a real expert, with sources.
2. The team picks the **stack** and writes the starting documents: D1 Functional Specifications, D2 Technical Architecture, D3 Security Requirements and a delivery plan. They are rendered as `.docx` and `.xlsx`, named after their title in the document language (`D1_Functional-Specifications.docx`), with a `.pdf` on request.
3. It writes the **BIBLE** (the rules) and the **PLAN** (what, when, who).
4. It cuts the plan into **slices**. A slice is the biggest unit that one session can finish with green tests and an end-to-end demo. Three to five can run in parallel.
5. It creates the private GitHub repository of the project and its board, and fills them.
6. It installs a **harness** in the project: agents, commands, hooks, CI and conventions. After that, `/slice S-01` works.

Every project lives in one folder, the **workspace**, which is a private git repository. It holds the documents and the state of Recade and keeps the code repositories of the product under `repos/` (section 10). The plugin is generic. The workspace of each project is private to its owner.

### What Recade does not do

- It does not host or deploy the products it helps to build. It prepares the infrastructure code and the CI. Deployment is slice work.
- It does not replace the human decision. It prepares, recommends and stops at each gate.
- It does not carry client content. Its examples use a made-up project.

## 2. Principles

1. **One source for each fact.** Markdown is the source. The `.docx`, `.pdf`, `.xlsx` and `INDEX.md` files are generated and marked "do not edit". Progress lives in `STATUS.md` and on the board, never copied into the BIBLE or `CLAUDE.md`.
2. **Cite an ID with what it says, never a line number.** For example `FR-PAY-03 (refund only within 24 h)`. The ID keeps the citation stable. The gist makes it readable. `recade index --check` refuses an unknown ID and flags a gist that no longer matches the title. The same holds in the chat: a command that names an ID to the owner adds its gist, and names as few IDs as it can.
3. **Explicit human gates.** Each phase ends at a gate. Decisions are asked as multiple-choice questions, with the stakes, the options, a recommendation and a default. Every question to the owner is a closed choice (the shared block `owner-choice`, in every command that asks): `AskUserQuestion` with 2 to 4 options, the recommended one first with its reason, or lettered options in the chat when the tool is not available. An open question is only for an answer that is free text by nature: a name, a path, a date. The intake questionnaire offers 2 or 3 likely answers for each question, plus `Not known yet`, and the intake analyst writes each blocking gap with its options.
4. **A gate that was not run is not a gate.** Every "green" comes with the raw output and a stamp tied to the exact state of the tree.
5. **Ceremony in proportion to risk.** Three lanes: `sensitive`, `standard`, `no-code`.
6. **Nobody summarises another agent's work.** The next agent reads the source file.
7. **Two failures on the same step: stop.** Fix the prompt or escalate.
8. **Resume after any break.** All progress is in files, mainly `recade/state.yaml`.
9. **The harness is a template that a team specialises.** It is not rewritten for each project.
10. **Nothing generic in the interfaces** (section 9).
11. **The workspace stays in order** (section 10). Nothing of the project lives outside its folder: worktrees, builds and drafts have a place inside it.
12. **The cheapest model that does the job** (section 8).
13. **Reuse what exists.** Recade calls well-known Claude plugins and skills instead of copying them.

## 3. Languages and writing voice

**Fixed.** Keywords are always English: commands, agents, statuses, verdicts, IDs, files and folders, board fields, YAML keys, branches. The internal prompts of the agents are English too. This is what makes the harness portable.

**Default: English everywhere.** `/recade:start` asks one question. If you choose to customise, it asks five more, and each answer is saved in `~/.config/recade/config.yaml`:

| Question | Several answers? |
|---|---|
| The language for chat with Recade and its agents | no |
| The language for working documents (BIBLE, PLAN, slice sheets, DEC, retros) | no |
| The language or languages for delivered documents (D1, D2, D3, delivery plan) | yes, one version per language |
| The language for code, comments and commit messages | no |
| The language or languages of the product interface | yes |

A project copies these answers into `recade/state.yaml`, under `languages:`. `/recade:languages` changes them later. Changing `deliverables` regenerates the documents.

**One voice.** Everything Recade writes follows one voice, chosen in `/recade:start` and saved as `voice:`. The default voice uses plain words, short sentences and a dry humour that comes from precision. Two other voices are offered: a warm step-by-step one, and a plain essay one with no jokes. The rules are the same for all of them:

- Easy to read first. One idea per sentence. A concrete word instead of an abstract one.
- Short. No preamble and no recap.
- No humour in warnings, security requirements, error messages, contract clauses or documents a client signs.
- No machine tics: no em dash, no stock phrases, no lists of three adjectives, no closing paragraph that congratulates the reader.
- The rules are checked. `recade lint-style` and the render step refuse the em dash and flag the tics. The commit-message hook refuses it too.

A line that carries the comment `recade-style-ignore` is skipped by the style linter, and only that line. The marker is for text that must quote a forbidden word, such as this rule list. The intake scan (section 6.1) never honours it, so a client file cannot exempt itself.

**Invisible characters.** A zero-width space, a word joiner, a byte order mark that is not at the start of a file, and the bidirectional controls can change what a reader sees or what an agent reads. The linter reports them as errors with the file, line, column and code point. A zero-width joiner or non-joiner is a warning, because some scripts need it.

## 4. Install and first run

```
/plugin marketplace add loycossou/recade
/plugin install recade@recade
/recade:start
```

Two families of commands exist:

- **Plugin commands**, `/recade:*`: the entry, the phases, the status and the resume.
- **Harness commands**, `/slice`, `/slice-check`, `/board` and others: installed in the project's `.claude/` folder in phase 5.

`/recade:start` runs once and can run again at any time. It skips what is done:

1. It shows a two-sentence introduction.
2. It checks the machine (`recade doctor`): `gh` signed in with the `project` scope, Node 20 or later, the render dependencies, the Playwright browser. Each line says `ok`, `warn` or `missing` with how to fix it. `/recade:setup` runs only this step.
3. It asks for your preferences: languages, the GitHub account for private project repositories, the projects folder (the default parent of a workspace), the writing model (Opus or Fable, section 8.2), the extra files to render (section 7.3) and the voice.
4. It shows the command map.
5. It suggests the next step for the current folder: `/recade:new <project>` in an empty folder, `/recade:new <project> --from <folder>` when documents exist, or `/recade:adopt` in a code repository.

Until `/recade:start` has run, a SessionStart hook prints one line to remind you, and nothing more. `/recade:help` shows the command map again.

## 5. Three ways in

| Mode | Command | Situation | What Recade does |
|---|---|---|---|
| Scratch | `/recade:new <project>` | An idea, few or no documents | Creates the workspace and runs the six phases |
| Given specs | `/recade:new <project> --from <folder>` | Documents exist, maybe complete | Reads them, files them, fits them to the Recade templates without rewriting them, lists what is missing. The phases write only what is missing |
| Adopt | `/recade:adopt` | A project already under way, in one or more code repositories | Creates a workspace, clones the repositories into it and keeps their architecture. Adds the method and the harness (section 5.1) |

### 5.1 Adopt

Adopt respects what exists. It changes no architecture, stack, CI file or code layout without an explicit owner decision recorded as a DEC.

**The workspace and the original.** `/recade:adopt` asks for the parent folder of the workspace and for the repositories to adopt (a local folder or a URL, one or several). `recade adopt init --parent <dir> --repo <path or url> [--repo ...]` creates `<name>-workspace` there and clones each repository into `repos/<name>/`. The original folder is only read, never written: the owner deletes it if they want to. Everything Recade writes for the project (inventory, stack, rules, invariants, contracts, BIBLE, PLAN, slice sheets) goes into the workspace. The code repository receives only the harness.

**Safety rules.**
- Before anything is created, `recade adopt preflight` checks each local original: no uncommitted work, the default branch, and no commit that is not pushed to its remote (the workspace clones the remote, so a local-only commit would be lost). A refusal for one repository creates nothing for any of them, and each reason is listed. It never stashes, resets, checks out or cleans.
- The clone is made from the `origin` URL of the original, and the registry records that URL. A repository with no remote is cloned from its path, the registry says `remote: none`, and Recade warns. What a clone does not carry (branches that exist only in the original, stashes, ignored files) is listed in a warning, with the advice to keep the original until you have what you need.
- In a code repository Recade writes only its harness: `.claude/`, `.githooks/`, `.github/workflows/recade*.yml`, `.github/dependabot.yml` and `.gitignore` when absent or by appended lines, and the generated block of `CLAUDE.md`. It never edits or deletes a file it did not create. The files it created are listed in `.recade/created.json` of that repository. A file of yours in the way is kept byte for byte.
- A re-run on an existing workspace folder is refused: nothing is overwritten.

**Phases.** The phases run in the workspace, so after `adopt init` the owner starts the next session there.
1. **Inventory (S-00).** `recade inventory scan` reads manifests, CI files and a few read-only git commands of each registered repository. It runs no project code. A monorepo or a repository with several languages gets one section for each package, and `docs/inventory.md` has one section for each repository. A registered repository that is not cloned on this machine is listed as `Not cloned` with the advice to run `recade repo sync`. The analyst writes `docs/inventory.md` and `docs/STACK.md`, which describes the stack in place instead of choosing one. Gate: `G0-inventory`.
2. **Documents from the code.** `recade adopt from-code` copies the documents the repositories already hold (README, files under `docs/`, ADRs) under `docs/source/<repo>/` of the workspace, each with an ID `SRC-nn` in one `docs/source/INDEX.md`. The originals are never edited. Code is cited as `repos/<name>/<path>:<line>`. By default the reader writes what agents need:
   - `docs/RULES.md`: golden files (the best examples to copy), rules and DONTs. A pattern followed by over 95 percent of the files, or at least 80 percent with fewer than 10 counter cases, is a rule and no question is asked. When a convention is really split, the owner gets one closed multiple-choice question with the `path:line` evidence of each side.
   - `docs/INVARIANTS.md`: each requirement is a "WHEN ... THEN ..." line, and each behaviour says how it is enforced: `test <path>`, `code <path:line>` or `no`.
   - `docs/CONTRACTS.md`: the interfaces between parts.
   - A **deviations register** in `docs/inventory.md`: where the code departs from its own conventions. Each row has a `path:line`, an axis, a severity from P0 to P3 and an effort of S, M or L. A deviation is recorded here, never fixed here.

   With `--full`, the reader writes D1, D2 and D3 instead, as for a new project. The reading depth depends on the size: under 50 source files all are read, from 50 to 500 a sample is read, and above 500 the entry points come first with at most 15 files per capability. What is not read is listed as deferred. Gates: `G2-stack`, then `G2`.
3. **BIBLE, slices and board.** The BIBLE cites the documents above and states rules for the remaining work only. The slices cover the remaining work only. Nothing already built is cut into a slice again. P0 and P1 deviations may become slices if the owner wants it.
4. **Board matching, without duplicates.** `recade adopt board` runs before `recade github init`. It reads the open issues of every adopted repository that has a GitHub remote, the issues of the workspace repository when it exists, and the Projects boards of the owner (closed ones too). It only reads, with two exceptions: `--accept` records issue links (`<repo>#<issue>=<slice>`) in `recade/state.yaml`, and `--create` makes one board, only when none exists and the owner says yes. The owner picks the board and confirms the links in a multiple-choice question. Then `recade github init` creates the private workspace repository, adds each linked issue to the board by its URL and creates an issue, in the workspace repository, only for a slice that has none. A linked issue stays in its code repository and is never renamed, edited or duplicated. It is only put under the epic of its lot as a sub-issue; when it already has a parent of its own, Recade leaves it there and says so.
5. **Harness beside your CI.** Your `ci.yml` and `dependabot.yml` stay as they are. The Recade CI of a code repository is `.github/workflows/recade.yml`, and its jobs are named `Recade: ...`. Your own agents, commands and git hooks are kept. Your `.claude/settings.json` is merged, not replaced. `CLAUDE.md` keeps every line you wrote: only a block between two Recade markers is added, and only after you say yes. If you already use another git hook folder, such as `.husky`, Recade keeps yours and says that its hooks do not run. Switching is a DEC and your own command.

## 6. The six phases

| Phase | Command | Produces | Gate |
|---|---|---|---|
| 0. Intake | `/recade:new` | The workspace (a private git repository), `intake/brief.md`, the questionnaire, the attachments, the gaps, the provisional values | **G0**: the frame is complete or completed provisionally |
| 1. Team | `/recade:team` | A project lead, a proposed team, doctrines | **G1**: the owner approves the team |
| 2. Documents | `/recade:docs` | D1, art direction, stack, D2, D3, delivery plan, figures, then the code repositories | **G2-stack**, then **G2** |
| 3. Bible | `/recade:bible` | `BIBLE.md`, `PLAN.md`, `INDEX.md` | **G3** |
| 4. Slices | `/recade:slices` | Slice sheets `S-nn`, the graph, `STATUS.md`, the GitHub repository of the workspace and its board | **G4** |
| 5. Harness | `/recade:harness` | The harness of the workspace and of each code repository: `.claude/`, the CI, `CLAUDE.md` | **G5**, then `/slice S-01` |

- `/recade:status` says where the project is and what to do next.
- `/recade:resume` picks up the current phase at its first unfinished step.
- `/recade:amend <document>` handles a change to an approved document. It lists what cites it, lets you pick what to regenerate, and takes the project back to the earliest gate that must be passed again.
- A phase does not start while the gate before it is open. A gate is passed only on the owner's yes, through `recade state pass`.
- Adopt has its own gate names, shown in section 5.1.

### 6.1 Phase 0: intake

`/recade:new` first asks where the workspace should go, in `projects_root` or in another parent folder (`recade new <name> --parent <dir>`), and creates `<slug>-workspace` there with its folders, its `.gitignore` and its first commit.

The questionnaire covers the client and their business, the problem, the users, the scope, the constraints (budget, deadline, hosting, regulation), what exists, the integrations, the client team, the success criteria and the brand. Files you provide go to `intake/attachments/`.

**Before an agent reads any attachment**, `recade intake scan` checks the text files and the XML inside `docx`, `pptx`, `xlsx` and `odt` files for invisible Unicode and bidirectional controls. A finding that cannot be cleared is BLOCKING. So is a file that cannot be checked at all: a PDF, an image, an unreadable archive, a symbolic link, a file over the size cap. The analysis does not read such a file until the owner has fixed it or has accepted the finding, and the owner is asked. Recade never accepts for you.

**A missing fact does not stop the project.** Each gap is classed:
- **Blocking:** without it, the wrong thing would be built (the problem, the users, the scope). The owner is asked, and the phase waits.
- **Replaceable:** Recade generates a **provisional value** and goes on. Examples: a working name, a temporary logo, a palette, personas, estimated volumes, interface text, demo data.

Each provisional value is marked `PROVISIONAL` wherever it appears and is logged in `intake/provisionals.md`: what, why, the assumption, who must supply the real one, by when. When the real value arrives, `/recade:amend` replaces it everywhere. Open provisional values show in `/status` and in every retro.

### 6.2 Phase 1: team

1. **The project lead.** Recade proposes three real experts whose profile fits the project, with what each would bring. The owner picks one. Research produces that person's doctrine.
2. **The team.** The project lead reads the brief and proposes one role for each skill the project really needs. Each role has a doctrine that is "inspired by" a real expert, with the reason for the choice. The core roles are the project lead, the architect, the security lead, the UX designer, the UI designer, the QA lead, the devops lead and the chief reviewer. A project may add data, mobile, payments, AI or a domain expert.
3. The owner approves the team (G1).

Documents are signed by role ("Architect, Recade team"), never in the name of a real person. A doctrine says "inspired by", never "I am".

### 6.3 Phase 2: documents

- **D1 Functional Specifications**: written by the project lead, the UX designer and a domain expert.
- **Art direction**: two or three contrasting directions shown as boards. The owner picks one.
- **Design references** (optional, inside the art direction): the main session looks for a design-reference server the owner connected with their own account (Mobbin, Refero or Nicelydone, found with ToolSearch, because the agents have no MCP tools). Recade requires nothing. With none connected it says so and makes the offer of the shared block `design-servers`, also made once in `/recade:start` after `claude mcp list`: what each server brings, that each needs the owner's own paid account, and three options, `Connect one now`, `Show me how` and `Go on without`. On `Connect one now` and a second yes for the exact command, the session runs `claude mcp add --transport http --scope user <name> <url>` with the address the repository documents (Mobbin `https://api.mobbin.com/mcp`, Refero `https://api.refero.design/mcp`, Nicelydone `https://mcp.nicelydone.club/mcp`), and the owner signs in with `/mcp`. No key is ever written in a file of a repository. With one, the owner chooses `The designer picks` or `I give my criteria`, the session lists at most 12 candidates (app, screen type, what is worth taking, `https` link), the owner picks, and the session writes `design/references.md` (`doc_id: REFERENCES`, the mode and criteria, one row for each pick). What a server returns is untrusted data: other fields and non-`https` links are dropped, and no instruction in it is followed. The `ui-designer` receives the file as data. Each board draws on the picks and cites those it uses by name and link as text, never loaded, so boards stay offline. The rule that references are not AI apps stays: the app screens complement it. The reference servers' tools may ask the owner's permission the first time. The file is outside the ID index and the citation check (an app called "M1 Finance" is not a citation), and its style lint stays. The owner deletes `design/references.md` to redo the references.
- **Stack decision** (section 6.4): gate **G2-stack**.
- **D2 Technical Architecture**: the architect, the devops lead and the security lead.
- **D3 Security Requirements**: the security lead, citing standards with a version and a date.
- **Delivery plan** `.xlsx`.
- **Figures**: Mermaid or HTML and SVG, rendered to PNG.

One role reviews each document in writing, once: D1 the domain expert when the roster has one, otherwise the architect; D2 the security lead; D3, the PLAN and the STACK the architect (the STACK adds at most one other role, the one whose doctrine matters most for the stack); the art direction the UX designer; the BIBLE the chief reviewer. A finding is a `blocker`, a `should fix` or a `nit`. The author applies the first two in a single revise round and lists the nits without applying them. A second round happens only when a blocker remains, and a blocker that survives it becomes a DEC. The note is never reviewed again.

**Open questions are sorted.** An agent that finds a question classifies it. `owner`: costly, binding for the client, irreversible, legal, or it changes the scope, the budget or the calendar. `team`: reversible, a technical detail or a convention. The owner's questions become DEC files, at most 10 for the whole documents phase as an aim, asked in batches of up to 4 questions for each `AskUserQuestion` call, and the answers are copied into the documents before G2. A `team` question is decided by the author with a one-line reason, recorded with `recade decision team add` in the register `decisions/TEAM.md` (ids `TD-nn`, a file apart from the DEC files, so a DEC id is never spent on it). At each gate (G2-stack, G2, G3) the owner reads the register as one list and challenges any line in one go: `recade decision team challenge <TD-nn> --dec <DEC-nn>` points the line to the DEC that replaces it. A decision is cited once, where it applies. After the stack choice, the project lead may add a specialist in the chosen technology.

**Trust the team.** The first real user found the framing long: the owner DECs came four at a time on each document, and every stack layer came one at a time, over six gates. The setting `decisions` of `recade/state.yaml` lets the owner hand more to the team. `ask`, the default and the value of a project without the key, keeps the rules above. `trust` adds a second sort, right before a DEC is asked. The rule lives in one place, the skill `skills/decision-sorting/SKILL.md`, which `/recade:docs`, `/recade:bible` and the `stack-analyst` cite. A DEC goes to the owner when it costs money (a licence, a paid service, a hosting tier), binds the client (scope, dates, legal terms, a promise to a third party) or cannot be undone cheaply; also when it has no clear recommendation or supersedes another DEC, and when in doubt. Otherwise the command takes the recommended option with `recade decision close <DEC-nn> --choice <letter> --by team --why <reason>`: in one locked step this adds a `TD-nn` line to `decisions/TEAM.md` and writes `By: team (TD-nn)` and the reason in the Decision box. A box that says `By: owner`, as every box written before, reads as the owner's. For the stack, a layer goes to the owner only when its finalists differ in money or in lock-in (a layer with no spike, such as a short-track layer with a clear leader, compares its top 3 ranked options instead); the team takes rank 1 of any other layer. At each gate the summary is short: what the team decided, one line each with its gist, what the owner must answer, and the details on request. `recade decision team challenge <TD-nn> --reopen` turns a line that closed a DEC into a new DEC that supersedes it (the closed one is never edited), and that DEC always goes to the owner. Trust mode skips questions, never a gate: the owner still passes G0 to G5, and the guards, the scopes and the rule that no agent merges do not change. Only the dispatching command closes a DEC by the team; an agent never closes one.

**Size.** Each document has a word budget, code blocks excluded, in `src/budgets.js`: D1 10,000, D2 9,000, D3 7,000, PLAN 7,000, STACK 6,000, BIBLE 8,000. A project overrides them with a `budgets:` map in `recade/state.yaml` (`recade state set budgets 'D1=12000'`). `recade docs size [doc...] [--json]` counts the words of `docs/D1.md` and the others (the front matter, the fenced code, the comments and the table rules are left out, a word in a table row counts for half so that table-heavy documents such as the PLAN are not punished for real tabular data, an unclosed fence counts as prose, and a translation is not measured) and prints them against the budget: over it is a `warn`, over 150% an `error` (exit 1) that goes back to the author with the stage `revise`, "cut, do not summarise the cut". The dispatcher gives each author its budget, and the `writing-voice` skill tells it to write for a busy client: one idea once, tables only for real tabular data, other documents cited instead of restated. The contributors of a document share its budget with the author of the draft, who aims at about three quarters of it.

**Progress.** Every main step of `/recade:docs` and `/recade:bible` opens with one line that says where the project is and what comes next ("Step 3 of 9: D1, functional specifications. Next: the art direction.").

**The code repositories.** D2 section 2.5 lists one code repository for each deployable container (`api`, `web`...). After G2, and after a yes from the owner, `recade repo add <name> --new` creates each one under `repos/<name>/`. When there are two or more, section 12 of `STACK.md` carries one table for each repository (`### api`, `### web`), because each one has its own build and test commands.

### 6.4 The stack decision

A team decision, argued like an architecture decision and settled by the owner. It comes after D1 (we know what to build) and before D2 (which describes it). In adopt mode, `STACK.md` describes the stack in place and nothing is chosen.

1. **Criteria come from the project, not from habit.** Each cites its source (an `NFR-*`, a `PAR-*`, an intake constraint) and has a weight. They cover non-functional needs, constraints, the skills of the people who will maintain it, lifetime, security, fitness for development by agents (measured, not assumed) and total cost.
2. **A ranked top 5 for each layer** with a real choice: each option with its current version, why it fits this project (two plain lines at most, tied to D1 and the criteria), its main drawback and its dated sources. At least one option is outside the reflex choices, and there are fewer than five only when fewer real options exist. The top 5 is a sub-section of section 2 of `STACK.md`, so the section numbers do not move. A layer imposed by the owner or by a source has no top 5. The stated biases are fashion, the writer's comfort and the tendency of language models to pick the same stack for every project.
3. **Dated research:** versions, support calendars, licences, recent vulnerabilities and field reports at the project's scale.
4. **A spike for the finalists only** (the top 2 or 3; ranks 4 and 5 are researched, not spiked): the same real task, done by an agent in each option. Recade measures unaided success, fix loops, build and test time and readability. A spike runs on the owner's machine and installs things there, so `/recade:docs` first says in one plain sentence what a spike is and what it would install (Docker images, runtimes, caches). In the short track it then asks whether to run them at all (section 6.7); in the full track they run. Before each spike, `recade spikes check` reads the free memory (`MemAvailable`, what `free -m` shows) and the free disk of the project and of the home folder (what `df` shows), and below 2048 MB of memory or 5120 MB of disk the spike is skipped with a notice and recorded as not run. Each runner names its Docker objects `recade-spike-<layer>-<option>-...`, keeps its package caches in its folder, and lists what it creates, before it creates it, in `spikes/<layer>-<option>/MANIFEST.json`: `containers`, `images`, `volumes`, `networks`, `processes` (a pid with its command) and `paths`. When the spikes end, the command runs `recade spikes clean` unasked and reports what it removed. Before each spike, `recade spikes check --spike <layer>-<option>` also records the machine in `spikes/<layer>-<option>.before.json`, outside the runner's folder: the time, the Docker image IDs, and which known caches of the home folder exist. It prints the environment the runner sets before any install (`npm_config_cache`, `PIP_CACHE_DIR`, `COMPOSER_HOME`, `COMPOSER_CACHE_DIR`, `CARGO_HOME`, `GOPATH`, `TMPDIR` and others), so that every cache lands in the spike folder. The cleanup removes only what a manifest lists and Recade can prove, never the runner's word alone: a container, volume or network only with the `recade-spike-` prefix; an image, without force, only with the prefix or when its ID is not in the record; a process only when its pid and full command line match exactly and it started after the record; a path only when the real location of its parent is inside the spike folder, a link removed as a link and never followed; outside the spike folder, only a known cache of the home folder (`OUTSIDE_CACHES`) that the record says was absent, still a real folder. Never the project, `RESULT.md` or the manifest. With no record, it keeps every process and every unnamed image. What it keeps is listed with the reason.
5. **Owner preferences.** The user config holds `stack.prefer`, a map of a language to the framework the owner prefers, `php: symfony` by default (`recade config set stack.prefer.python django`, `recade config set stack.prefer none` to clear, `recade config get stack.prefer` to read; the map in the file replaces the default, so a cleared map stays cleared). `/recade:docs` shows it in one line under the layers and gives it to the analyst. A preferred option that fits the criteria and the layers already chosen is rank 1 of its layer and the recommendation, and says it follows the owner's preference; another option may stay in the ranking but is never the recommendation while the preferred one fits. Laravel is never the default PHP recommendation. A preference is not an imposition: the layer is still asked.
6. **A weighted matrix** with reasons, risks, exit cost and the architect's recommendation. Each contributor writes an opinion, disagreements included.
7. **The decision**, asked layer by layer (G2-stack). The top 5 of the layer is shown in the chat, ranked again against the layers already chosen (an option that no longer fits drops out, with the reason). The question offers ranks 1 to 4, and the 5th is picked by typing its name in `Other`, because the question tool allows four options. An option without a spike (rank 4 or 5) follows the same path as an option typed by the owner: its research is already dated, and a spike runs only when the layer had spikes. A DEC keeps at most three options (the chosen one, the recommendation and the next best); the full top 5 stays in `STACK.md`. Each choice becomes an `ADR-nn`. `docs/STACK.md` records the pinned versions, the matrix, the spikes, the rejected options, the **conditions to revisit**, and the **harness technical sheet** (build, test, lint, format, local run, conventions, quality and security tools).

Each retro re-reads the stack against its conditions to revisit. A change goes through `/amend`.

### 6.5 Phases 3 and 4: bible and slices

- **`BIBLE.md`** holds the rules, written so that agents apply them without interpretation. It cites D1, D2 and D3 by ID with their gist and does not copy them. Its plan, in short: mission and quality bar, reading order, dated facts, binding documents by precedence ("if none answers, it is not yours to answer: `BLOCKING`, stop"), decisions, invariants each with the test that guarantees it, business rules, conventions, design rules, the writing voice, exclusions, escalation, the definition of done, session discipline, parallelism and model policy, quality gates, one list of prohibitions, and where to read the state.
- **`PLAN.md`** holds increments, milestones, the calendar, roles, a RACI and risks. It is the source of the workbook.
- **`INDEX.md`** is generated.
- **Slicing.** The owner first picks a formula (section 7.4). Recade then writes the slice sheets, the dependency graph (Mermaid) and `STATUS.md`. It then asks where the code lives (section 6.8). On the local forge it commits the sheets and asks G4. On GitHub, after a dry run and a yes, it creates the private GitHub repository of the workspace and the board, with one issue for each slice and story. The owner answers three separate questions: the private workspace repository, the automatic push of the workspace (section 10.6) and, one by one, each new code repository.

### 6.6 Phase 5: harness

Recade copies the template harness at two targets: first the workspace (`recade harness install --target workspace`), which gets every command and every agent and is the one place to work from, then each code repository, one at a time (`--target code --repo <name>`), which keeps what belongs to the code. Section 10.4 says what each one gets. The team specialises it: invariants, lanes, verification commands, the domain expert, the model table, the board fields, the art direction and the stack skills. Then it writes the first `CLAUDE.md`. `recade harness verify` checks that each agent loads, each command is present, and each guard blocks what it must. Branch protection is offered, and applied only with the owner's explicit yes. On the local forge (section 6.8) it is skipped, with the GitHub-only workflows and dependabot, in one line.

### 6.7 Two tracks

The first real project found the framing long and repetitive: six gates and a full set of documents before the first line of product code, and one run wrote 190,000 words. Most of those words were right for a project with money or regulated data at stake, and too many for a first version. So a project has a track, `track: full` (the default, and what a state without the key means) or `track: short`, asked at intake by `/recade:new` and changed with `recade state set track`. `/recade:adopt` keeps its own choice of documentation depth.

The short track cuts length, not control:

- **Half the words.** `recade docs budgets` prints half of each default budget. A `budgets:` key the owner set still wins, so a project can loosen one document without leaving the track.
- **One reviewer, a revise round for blockers only.** Every document keeps its one written review. A `should fix` is shown to the owner and kept in the note, and the author is sent back only for a `blocker`. A defect the owner cares about is one `/recade:amend` away.
- **Two art directions, not three.** Two that truly differ are enough to choose from.
- **A top 3 per stack layer, and a spike only when it is close and the owner wants it.** The analyst scores the top 3 from the dated research first. A spike costs real time, so it can run only when the two best totals are within 10 percent: below that gap a spike rarely changes the answer. Even then the owner chooses, after one plain sentence on what a spike is and what it would install: no spikes, decide from the research (recommended), or run them. A first trial ran three spikes (two frameworks and a container host) that took most of two hours of a framing under six, started containers and filled caches on a machine short of memory, and the owner had to ask what they were for and then for the cleanup. Declined or skipped spikes make the layer one with no spike, which in trust mode compares its top 3 (section 6.3). The architect gives the one opinion.
- **The core of the BIBLE.** Invariants, the business rules of the first increment, the security rules that bind the code, the conflict rules, the defaults and the prohibitions. Every section stays, so the harness finds what it reads.
- **The core team.** The 8 core roles, plus a role only for payments, health data or regulated data.
- **A walking skeleton first.** S-01 is the thinnest end-to-end path through the real stack, deployed where the owner can see it, with one business rule at most. It is marked `skeleton: true`, and `recade slices check` warns in the short track when it is not. The owner sees the product run before the rest is built.
- **A capped first increment.** The same trial cut 27 slice sheets for a first version due in a month. The short track writes sheets for the first increment only: S-01 plus at most 5 slices, 6 in all (S-00 aside). The slicer still cuts the whole PLAN, and writes the later slices as `slices/BACKLOG.md`: one table, `Slice`, `Gist`, `Stories`, one row for each later slice. A row covers its stories for the story check, and a story in a sheet and in the backlog is `story-twice`. `recade slices check` warns with `slice-cap` when more than 6 sheets are open (not `done`), and `recade slices status` adds the number of rows under `## Backlog` of `slices/STATUS.md`. Once G4 is passed, `/recade:slices` offers to cut the next increment: the slicer, at the stage `next`, turns the first rows into sheets, 6 open at most, numbered after the last id, and removes those rows; the checks, the graph, the status and the issues of the board follow, and G4 stays passed.

Nothing else moves. Every gate, G0 to G5, still needs the owner's yes. The guards, the file scopes, the lanes and the rule that no agent merges are the same on both tracks.

**Time to first slice.** To see whether a track is short in practice, the state records `started:` when `recade new` creates the workspace, and `first_slice_done:` the first time any slice becomes `done` (through `recade slices status --set` or `/board`), once, never overwritten. Recording the day never blocks a move: when `recade/state.yaml` holds uncommitted changes that are not Recade's, the move goes through alone, one notice line says so, and a later move to `done` records the day. A state from before these keys falls back to the day its first gate was passed, or says nothing. `/recade:status`, `recade state show` and the retro print one line: "Started on X. First slice delivered on Y, N days later.", or "N days since the start, no slice delivered yet."

### 6.8 Where the code lives: GitHub or local

In a real trial the owner did not want the project on GitHub. The slices phase offered G4 only after `recade github init` had made the repositories, the board and the issues, so the project stopped at G4, with no harness and no delivery. GitHub is now an option: `forge: github|local` in `recade/state.yaml`. `/recade:slices` asks it once, as a closed choice, before anything touches GitHub: `Local only` (git on this machine, nothing leaves it, the board is `slices/STATUS.md`) or `GitHub` (private repositories, a board, issues and pull requests). A state without the key reads as `github`, so an older project goes on as it was. `recade state set forge github` moves a local project to GitHub later, and `recade github init` then works as before.

On the local forge every gate, guard, lane and file scope stays. What changes is where a slice ends and who reads git:

- **No `gh` at all.** `recade github init`, `recade harness protect` and `recade adopt board` refuse before their first call. `recade board reconcile`, `recade board cleanup`, `recade merge-order` and `recade retro` read git instead of pull requests. A slice branch is merged when a merge commit of the default branch has the tip of the branch as a parent. That is why the owner merges with `--no-ff`: a fast forward leaves no proof, and an empty branch would look merged.
- **A local review request.** The `release-manager` writes the body it would have put in the pull request into `slices/reviews/<S-nn>.md` of the workspace, one section for each repository. It is private like the sheet, so it may sit next to it, and it is committed like any document of the workspace.
- **The owner merges.** No agent merges, on either forge. On GitHub the barrier is the branch protection. On the local forge there is none, so the merge has one path, `recade slices merge <S-nn>`, which only the main session runs: the guard refuses it to every agent, as it refuses `git merge` into `main` to everyone. It also refuses to every agent each other way to move the default branch (`update-ref`, a `fetch` or `push` refspec into it, `branch -f`, `-M` or `-D`, `reset`, `commit` or `checkout -B` on it, `symbolic-ref HEAD`) and any write to the branch of another slice. Its dry run prints the exact `git -C '<repo>' merge --no-ff <branch>` of each repository, in the merge order, and `/board` or `/merge-order` runs it only after the owner's yes in that session. It refuses a slice that is not `ready-to-merge`, a Definition of Done not ticked, a missing review request, and a checkout that is dirty or on another branch, and it aborts a conflict. The owner may also run the printed commands in a terminal, where no hook stands between them and git.
- **`/board`** writes `merged:` with the merge commit, moves the slice to `done`, and removes the worktree and the local branch. It reads and deletes no remote branch.
- **What is skipped.** Branch protection, the conflicts and second-opinion workflows with their secrets, and `dependabot.yml`: each needs GitHub. `ci.yml` is still written, so the gates are the same and a later move to GitHub finds it. The second opinion runs on this machine with `/second-opinion <S-nn>`, on the diff of the branch, and its verdict goes into the review request.

## 7. Documents, identifiers, slices

### 7.1 Document skeletons

All documents share a header: a cover, metadata (document, project, version, date, status, author, approver, companion documents, classification), a revision history, an approval table, the note "Markdown is the source of truth", a table of contents and a list of figures.

- **D1** covers purpose and conventions, context and objectives, business principles, actors and roles, modules, end-to-end journeys, requirements per module, non-functional requirements, configurable parameters, acceptance criteria per milestone, exclusions, **decisions to close before sign-off**, traceability to the backlog, and a computed traceability matrix.
- **D2** covers architecture principles (each with how it is verified), context and containers, trust boundaries, environments, infrastructure with a **monthly cost estimate**, CI/CD, data model, API conventions, applications and jobs, security summary, observability and recovery, the tech stack and test strategy, **ADRs**, and technical risks.
- **D3** covers standards with version and date, security decisions, assets, actors, trust boundaries and flows, cross-cutting and per-component requirements, a coverage matrix, residual risks and open decisions. Each requirement has an ID, a priority (MUST or SHOULD), a reference, a verification method, a status and an owner.
- **Delivery plan** `.xlsx`: Summary, Backlog, Sprints, Milestones, External dependencies, Decisions, Risks, RACI and Gantt tabs, with input cells in yellow, frozen headers, filters, validation lists and formulas.

### 7.2 Identifiers

| Nature | Form | Defined in |
|---|---|---|
| Functional requirement | `FR-<MOD>-<nn>` | D1 |
| Non-functional requirement | `NFR-<nn>` | D1 |
| Parameter | `PAR-<nn>` | D1 |
| Principle | `PRI-<nn>` | D1, D2 |
| Project decision | `DEC-<nn>` | `decisions/` |
| Architecture decision | `ADR-<nn>` | D2, `STACK.md` |
| Security requirement | `SEC-<DOM>-<nn>` | D3 |
| Trust boundary | `TB-<n>` | D3 |
| Risk | `RSK-<nn>` | PLAN, D2, D3 |
| External dependency | `EXT-<nn>` | PLAN |
| Open question | `Q-<nn>` | D1 |
| Provisional value | `PRV-<nn>` | `intake/provisionals.md` |
| Backlog story | `<LOT>-<nn>` | PLAN |
| Slice | `S-<nn>` (split: `S-09a`) | `slices/` |
| Increment | `INC-<n>` | PLAN |
| Milestone | `M<n>` | PLAN |
| Source document (adopt) | `SRC-<nn>` | `docs/source/INDEX.md` |

`D1`, `D2` and `D3` name only the documents.

### 7.3 The render engine

One Node pipeline, installed by `npm ci`. `recade render` takes Markdown with a YAML header, GFM tables, `> [!NOTE]` callouts, Mermaid blocks and figures.

- `.docx` with the `docx` library: cover, tables, callouts, numbered captions, headers and footers, table of contents.
- `.pdf`, only when the user config says `deliverables.pdf: true` or `--format` names it: the same content as printable HTML, printed by Chromium through Playwright. Word and Excel are what stakeholders open, so the PDF is off by default; it stays because it costs one small module and no dependency of its own (Chromium is there for the figures).
- File names: `<ID>_<Title>`, the ID from the source file name (`D1`, `PLAN`, `STACK`) and the title from the front matter without the project name the templates put first, in the language of that source: `docs/D1.md` gives `D1_Functional-Specifications.docx` and `docs/D1.fr.md` gives `D1_Specifications-Fonctionnelles.docx`. Accents go (`é` to `e`, `ß` to `ss`), every other character that is not a letter or a digit becomes a hyphen, each word starts with a capital, and the title part stops at 60 characters. A title with no Latin letter gives the ID alone. A language copy whose name would be the one of its source keeps its language: `PLAN_Plan.fr.docx`. The registers take their title from `registers` in the labels of the deliverable language.
- An older render: names of before (`D1.docx`, `D1.pdf`, `STACK-matrix.xlsx`, `design-<board>.pdf`), and a PDF that is no longer asked for, are never deleted, since the owner may have put a file of that name there. The render lists each one once, `Left as it was: <file>`, and the next render writes the new names.
- A renamed document: a new title gives a new name, and the files of the old name stay. `docs/deliverables/.recade-rendered.json` records, for each source, the names Recade wrote there and those it left. The render names each old file with `Left as it was:` until it is gone, and builds the index from the current names only, so a document has one card. A file of a render before the record counts only when Recade can prove it wrote it: a dossier whose embedded entry names the same source (or the same document and language), with the files of the same base beside it. A file Recade did not write is never named and never deleted.
- `.xlsx` with `exceljs`.
- Figures: Chromium captures HTML, SVG and Mermaid to PNG, cached in `.recade-cache/`.
- Font: Inter Tight (OFL, shipped with the plugin and embedded), with Arial as the declared fallback.
- Theme: the bundled default is coloured: a navy table header with white text (`color.headerFill`, `headerText`), dark navy headings (`heading`, a key of its own, so a light `headerFill` never makes the headings pale), light grey zebra rows (`zebra`), light blue key cells (`keyCell`), pastel callouts (`calloutNote`, `calloutWarning`, `calloutDecision`) and a small `PROVISIONAL` tag (`provisional`, `provisionalText`). `design/theme.json` is merged over it, and the art direction writes only the brand there (fonts, `accent`, `ink`, `chartFill`), never the structure of tables, callouts and figures, unless the owner asked. Every one of these keys is 6 hex digits or the render stops with a one-line error.
- Figures: Mermaid is drawn with a pastel palette (`figure.info`, `ok`, `warm`, `error`, `system`, each with `fill`, `stroke`, `text`; `figure.line`). Flowcharts, graphs and state diagrams get a `classDef` for each kind, so `A:::ok` or `B:::system` colours a node without hand styling, and the other diagram types take the same colours as theme variables. Boxes are rounded, `-.->` draws an optional path. A figure is numbered and captioned in the document language (`Figure 1: ...`, `Figure 1 : ...` in French). The templates ask for a minimum set (D1: actors and system context, main journeys, states of the main object; D2: containers, deployment, one key sequence; D3: trust boundaries and data flows; PLAN: phases timeline), and the render warns about a figure with no caption and about a document under its minimum.
- Quiet identifiers: in a table the `ID` column is narrow and muted, and the column that names the row is a key cell; in a sentence an ID is small and muted. `PROVISIONAL` and `PRV-nn` are a small coloured tag, written in the document language (`Provisoire`), not a highlight.
- Language: the author translates the headings of D1, D2 and D3 and opens each main section with one sentence. The PLAN keeps its English sheet and column titles in the Markdown, because the workbook is read from them, and the render shows them from the French labels (`planTerms`). The code-reader of an adopted project keeps the English headings that `recade adopt` checks.
- Checks before anything is written: IDs and gists, the em dash and tics, and `PROVISIONAL` values shown in the margin. Labels exist in English and French.

**The dossier and the companion.** A Word file is good for signing and bad for reading on a screen. So each document also gets an HTML dossier in `docs/deliverables/`, named like its Word file (`D1_Functional-Specifications.html`), and the folder an index page that links every dossier with its Word, Excel and PDF files. The index is named through the same helper, `INDEX_<title>.html` in the language of the documents (`INDEX_The-Project-Documents.html`, `INDEX_Les-Documents-du-Projet.html`), one page for each language, so each dossier links to the index of its own language. A dossier is one self-contained file: the font, the figures and the styles travel inside it. The whole page is set in Inter Tight, the default font of every deliverable, with Arial when it cannot load, and a Content-Security-Policy forbids any fetch, so it opens offline and never calls the network. It has a top navigation, numbered sections, a light and a dark theme (the reader's system setting, or the toggle), and the colours of `design/theme.json`. Its header holds a small kicker, the title, a one-sentence lede and fact chips; then comes "The recap in N sentences", a grid of short numbered statements; then each main section, where a hard idea comes twice: first **the image**, an everyday comparison in a tinted box, then **the real thing**, the text of the document with its real names. A section can also carry stat tiles (a big number, a small label) and before and after rows. The metadata, revisions and approvals close the page, folded. The top of the D1 dossier of the made-up example: [docs/dossier.jpg](dossier.jpg). `recade render` writes the dossier by default; `--format html` writes only it, which is how the BIBLE gets its dossier in `/recade:bible`.

The summary layer comes from a **companion** written by the author of the document, next to it: `docs/D1.story.yaml` for `docs/D1.md`, `docs/D1.fr.story.yaml` for the French source, `BIBLE.story.yaml` for the BIBLE. It is YAML because an agent writes it easily and the render parses it without guessing, and it is outside the Markdown so the index, the size budgets and the workbook never see it. Its keys are `kicker`, `lede`, `facts` (`{ label, value }`), `recap` (a list of sentences), `decisions` (`{ decision, why }`) and `sections` (`{ section, image, stats, before_after }`, `section` being the number of a main heading or its text). Every text takes bold, italic, code and IDs. The authors write it at the stage `story`, on the mechanical model, once the documents are final (step 9 of `/recade:docs`, step 9 of `/recade:bible`), under 400 words, adding no fact. The render lints it like the document (an em dash stops it) and warns, never fails, on a broken file, an unknown key, a section that matches no heading, or a size over its limit. Without a companion, the dossier renders from the Markdown with a plainer header (the document ID and the project as the kicker, the version, date and status as chips) and no recap.

The Word file takes the same feel where Word allows it, without weight: its cover starts with the kicker, the title, the lede and the facts as tiles, and the metadata table follows; the recap grid and the decisions that matter come right after the cover, before the contents; and each image is a tinted box under its heading, followed by the small label of the real thing.

**Extra deliverables.** D1, D2, D3 and the PLAN are always rendered, and that never changes. The owner can add four more, chosen once in `/recade:start` and kept in the user config as `deliverables.extras` (a list among `stack`, `decisions`, `design`, `reviews`, empty by default; `recade config set deliverables.extras stack,design`, or `none` to clear). `recade render extras --project <dir>` renders the chosen ones into `docs/deliverables/`, and `/recade:docs` and `/recade:amend` run it after the usual render.

| Extra | Source | Files |
|---|---|---|
| `stack` | `docs/STACK.md` | `STACK_<Title>.docx`, and `STACK_<Title>.xlsx` with one sheet for each table of section 5, "Weighted matrix", its header row styled like the PLAN workbook |
| `decisions` | `decisions/DEC-*.md` | `DECISIONS_<Title>.docx` (a summary table, then one section for each DEC: question, options, chosen option, status, date), and `DECISIONS_<Title>.xlsx` with one row for each DEC |
| `design` | `design/directions/*.html`, and `design/references.md` when it exists | one `DESIGN_<Board>.pdf` for each board, and `DESIGN_<Title>.docx` |
| `reviews` | `docs/reviews/*.md` | `REVIEWS_<Title>.docx`, one section for each note |
| the deck (`deliverables.deck`) | D1, D2, D3 and their companions, the PLAN, `decisions/DEC-*.md`, `intake/provisionals.md`, `recade/state.yaml`, the logo | `DECK_<Title>.pptx`, a summary for a steering committee |

The decision and review registers are built in memory from their source files and rendered, never saved as Markdown, so nothing new appears in `docs/` and the index check never sees them. The `STACK` is a real source and goes through the same checks as D1. The boards are printed by the same Chromium helper, one PDF each (a board is a page to look at, so it stays a PDF whatever `deliverables.pdf` says), with only file and data URLs fetched; there is no combined PDF because no PDF merge library is a dependency and a deliverable did not justify adding one. `design/references.md` is a real source like the STACK: it goes through the same checks and the same inside-the-project test, and its absence is not a warning. A symbolic link in `design/directions/` is skipped, and so is any source folder or file that is a link out of the project. A board is printed with JavaScript off, the network off, and only data URLs and files inside the project fetched; the HTML figures of the other documents get the same file restriction. An extra the owner un-chooses, or whose source is removed, leaves its old files in `docs/deliverables/`: nothing is deleted automatically, so delete them by hand. Everything is built in memory first and written all at once, as for `recade render`, so a failure writes nothing. A missing source (no STACK, no DEC, no board, no note) is one `Warning:` line on stderr and exit 0; with no extra chosen the command prints one line and exits 0; a missing Chromium gives the same message as `recade render`, with `/recade:setup`.

**The deck for a steering committee.** It is not a fifth extra: the question of the extras is a multiple choice, and `AskUserQuestion` takes at most four options. So the deck has its own key, `deliverables.deck` in the user config: `ask` by default, then `yes` or `no`. `/recade:start` asks it right after the extras, with `No` recommended (an owner working alone rarely faces a committee), and `/recade:docs` asks it once before `recade render extras` when it is still `ask`, so an owner who ran `/recade:start` before the deck existed is asked too. Nothing is produced before the owner said `yes`. `recade render extras` then writes `DECK_<Title>.pptx` (`DECK_Project-Overview.pptx`, `DECK_Synthese-du-Projet.pptx`), with `pptxgenjs`, and says one line when the key is `ask` or `no`. The slides: a title with the kicker and the lede of the D1 companion, then three parts, each opened by a full-bleed divider. The project: the context and goal (the D1 recap and facts, else its context paragraph and its objectives), the key figures (the `stats` of the companions), the scope (the module catalogue of D1, else its main headings) as cards, and the look and feel (a picture of the board of the chosen art direction, taken by the same Chromium helper as the board PDFs, with the same rules). The technical side: the architecture (the D2 recap, then the first figure of D2, drawn through the figure cache, on a slide of its own), the security essentials (the D3 recap, else its first table). The delivery: the lots of the PLAN as coloured chevrons with the points of their backlog items (a PLAN written before its `## Lots` table gives the lots of its backlog), the decisions as big numbers and cards, the open provisional values, and the next gate with the milestones still ahead. A missing source drops its slide with one `Warning:` line. The colours come from the logo of the project when there is one (a file named `logo` in `design/`, `assets/`, the intake attachments or the figures: the main colours of a PNG, read with `node:zlib`, or the colours an SVG declares; an SVG logo is drawn to a PNG by the same Chromium helper as the figures), else from the tokens of the art direction (`design/tokens.json`, brand and primary first), else from the render theme; a source with fewer than four colours is completed by neighbours of its main hue. The title and the dividers are full-bleed with vector motifs in the palette (leaves for the project, hexagons for the technical side, chevrons for the delivery); every other slide has a coloured title band over a light tint, and white cards. The project is named as its documents write it (`Potager partagé` for the `project` `potager-partage`). Text on a colour is white or the ink, whichever reads better, and a fill under white text is darkened until it reaches WCAG AA (AAA for the full-bleed slides). Every text is in Inter Tight, the theme fonts too. The zip entries and the document properties carry the date of the render, so the same sources give the same bytes.

### 7.4 Slices

**Size.** A slice is the biggest unit one session can finish with a green test gate and an end-to-end demo. Past these caps, it is split:

| Item | Cap |
|---|---|
| Sheet | about 300 lines |
| Frozen decisions | 10 |
| Definition of done lines | 15 |
| Screens | 6 |
| Target duration | one day of agent work |

**How to cut.**
- S-00 (inventory) first when code exists.
- A walking skeleton first: the first slices cross the whole chain (API, data, a minimal screen in the art direction, CI, preview deployment) before widening.
- Contract first: no integration between modules without a versioned contract.
- One module, one writing agent. Slices that run together have disjoint file scopes.
- Each story is covered by exactly one slice.
- Hardware or an outside service goes behind an interface. The real connection is its own slice.

**The sheet** `S-nn-<name>.md` has a header (repositories and branch, format `large` or `small`, lane, model and effort, increment, depends on, blocks, `touches:` file scope, provisional values used) and sections: goal in one sentence, scope (IDs with their gist), out of scope, sources, frozen decisions, interfaces, expected tree, design, the **definition of done** (command, expected result, "seen red first?"), work order, human actions after, the implementer prompt, "decided while building" and proposed spec changes.

**Across code repositories.** With two or more code repositories, each `touches:` glob starts with the name of its repository: `api:src/orders/**`, `web:src/pages/orders/**`. A glob with no prefix is refused (rule `touch-prefix`), a prefix that is not in the registry is refused (`touch-repo`), and `workspace:` is valid only in the `## Writes` of an agent. With one repository the prefix is optional. When `recade repo add` makes the second repository, it prefixes the unprefixed globs of the slices that are not `done` with the name of the first one, and prints the list of changes. The overlap check and the hot files compare repository by repository (`hotspots:` take the same prefix). A slice that touches several repositories has one status and one pull request for each repository, and may carry `merge_order: [api, web]`; without it, the order of the prefixes in `touches:` is used. When the last pull request is merged, `merged:` in the sheet records the merge commit of each repository.

**The formula.** At the start of phase 4, the owner picks one:

| Formula | How it works | Fits |
|---|---|---|
| `small` | Three to five slices at a time, within the caps, one pull request each | Several reviewers, a need for raw speed |
| `large` | One slice for each feature, cut into tasks. A fresh sub-agent does each task and it is reviewed before the next. Then the whole slice is reviewed. One pull request, one human gate | One reviewer who prefers fewer interruptions |
| `mixed` (default) | `large` for the core and whatever touches invariants, `small` for independent parts such as screens, integrations and infrastructure | Most projects |

A `large` slice keeps the orchestrator's context under control because the work lives in sub-agents and files. It has a tracking ledger, at most 12 tasks, a review for each task, a review of the whole slice on the most capable model, and one readable commit for each task. The caps above apply to each task, not to the whole slice. The formula is saved as `slicing:` in `recade/state.yaml`.

## 8. The harness

### 8.1 Agents

| Agent | Role |
|---|---|
| `spec-writer` | Writes and checks slice sheets: modes `write`, `check`, `revise`, `backport` |
| `ux-designer` | Journeys, information architecture, two or three really different variants, then stops: a human picks |
| `ui-designer` | Art direction, design system, components, motion, accessibility |
| `test-engineer` | Failing tests, one for each definition-of-done line and guardrail, seen red for the right reason |
| `implementer` | Makes the tests pass without changing them |
| `implementer-critical` | Same role, for slices that touch an invariant, money, cryptography, offline state or a transaction boundary |
| `reviewer` | Conformance to the sheet, guardrails proven by mutation, reruns the gates itself, honesty of the log, code review. One verdict |
| `security-reviewer` | The slice's `SEC-*` requirements, dependencies, secrets |
| `design-reviewer` | Delivered screens against the art direction, with screenshots |
| `product-reviewer` | Looks at finished screens like a future user. Reads neither the code nor the spec |
| `domain-reviewer` | A pluggable domain checklist, with sources |
| `devops` | CI/CD, infrastructure code, preview environments, observability, runbooks |
| `doc-writer` | The slice's deliverable documentation |
| `release-manager` | Prepares the pull request. Never merges |
| `board-keeper` | Reconciles the board, then cleans up |
| `test-runner` | Runs lint, types and tests and reports. Never fixes |
| `explorer` | Read only: finds code and conventions |
| `code-teacher` | Explains a project tool step by step and checks understanding. Never writes code |
| `second-opinion` | Reads an open pull request with fresh eyes (section 8.8) |
| `merge-keeper` | Orders merges, rebases, resolves mechanical conflicts (section 8.7) |

The main session orchestrates, through `/slice`. A sub-agent never does.

### 8.2 Models and efforts

One table, `harness/models.yaml`, is the only source. `recade harness models` writes it into each agent's header, and `recade harness models --check` fails on drift. The rules:

- The models that judge (spec, review, design, product view) run on the strongest model. Building and testing run on a mid-size model at high effort. The rest runs at medium. There is no smaller model: the floor is mid-size at medium effort, except `test-runner`, which only runs commands.
- The two highest effort levels are not used. Effort changes the time spent, not the intelligence.
- **Per slice:** the sheet picks the implementer. After a second `FIX` on the same slice, the next attempt goes to `implementer-critical`, and the report says so.
- The `security-reviewer` moves up a model in the `sensitive` lane.
- The `second-opinion` agent runs on a different model family from the `reviewer`, unless `second_opinion.same_family: warn` in `harness/models.yaml` allows the same family; then `recade harness models` and `recade harness verify` warn instead of refusing.
- Phases 0 to 4 use the most capable model for the team, the documents and the BIBLE, and a mid-size model for mechanical cutting and board creation.
- **The owner chooses the writing model.** The plugin agents of the `writer` tier (15 of the 17 in `agents/`) run on the latest Opus by default, at high effort. The user preference `models.writer` (`opus`, the default, or `fable`) replaces the model, never the effort. `/recade:start` asks it once, `recade config set models.writer fable` changes it, and `recade models writer` prints the alias to dispatch with (`--id` prints the full id, `claude-fable-5-2` or `claude-opus-5-5`). Each `/recade:*` command that dispatches a writer agent reads it once and passes it as the `model` of every such dispatch; the recruiter writes the chosen id in the model column of the roster. The front matter of the agents holds Opus 5.5 as the fallback, so `tools/sync-agent-models.js --check` stays green, and the mechanical agents (`inventory-analyst`, `spike-runner`) are not touched.
- **The second-opinion runs on Opus 5.5** (`claude-opus-5-5`) by default, whatever `models.writer` says. It shares the reviewer's family, so `harness/models.yaml` sets `second_opinion.same_family: warn`, and `recade harness models` reports a warning instead of an error. Its independence comes from what it reads: the PR, the sheet and the requirements, never the reports of the other agents. The fallback of the writer agents in `agents/models.json` is `claude-opus-5-5` too.
- **The owner chooses the second-opinion model.** `/recade:start` asks it right after the writing model, as a closed choice: `opus` (the default, the table as it is) or `fable`, another family than the reviewer, so a more independent view at about twice the price. It is `models.second_opinion` of the user config, changed with `recade config set models.second_opinion fable`. The first `recade harness install` applies it to the project copy: with `fable`, `.claude/agents/second-opinion.md` runs on `claude-fable-5-2` and the family check passes with no warning. The plugin's own `harness/agents/` keep the table. Once installed, the project copy is the source of truth and the user config is only the default of a first install: `recade harness verify`, `recade harness models --dir` (to re-apply or to check, as `/second-opinion` does) and a later install read the choice from the copy, so CI and another machine agree. `recade harness models --dir .claude/agents --second-opinion opus|fable` changes it for the project; the CI workflow reads the model of that copy too. `recade cost estimate --slice` prices the second opinion on the chosen model.
- The real cost of each slice is measured (section 8.9) so the table can be tuned.
- **Mechanical stages run on the mechanical tier.** The `mechanical` entry of `agents/models.json` (Sonnet, medium) runs, besides the inventory and the spikes, the framing stages that carry out what is already decided or approved: `translate` (an approved source into another language of `languages.deliverables`), `glossary` (the terms the contributors reported, added to Annex A of D1), `apply-decisions` of D1, D2, D3, the PLAN and the BIBLE (the owner's choice carried into the text), `story` (the companion of a written document, which adds no fact), and a `revise` sent back for a line of `recade lint-style`, `recade index check` or `recade render` (a format fix). `/recade:docs`, `/recade:bible` and `/recade:amend` read it once with `recade models mechanical` (and `--effort`) and pass it as the `model` of those dispatches. Judgement stays on the writing model: every draft and contribution, every review, a `revise` after a review note, a size error (cutting needs choices) or the owner's words, the `apply-decisions` of the `stack-analyst` (it writes the ADR sections of the STACK), the team, the slicer and the harness roles. `MECHANICAL_STAGES` in `src/models.js` holds the split, and the estimate reads it.

### 8.3 Chain and lanes

| Lane | Triggers | Chain |
|---|---|---|
| `sensitive` | Money, security, personal data, an invariant, a migration, a breaking contract | design, full spec, domain review, **gate-1 (human)**, tests, `implementer-critical`, review (with mutation) and security review, docs, pull request, second opinion, **gate-2 (reservations)**, human merge, `/board` |
| `standard` | Everything else | short spec, tests, `implementer`, review, docs, pull request, human merge, `/board` |
| `no-code` | A decision, or work with no code (spikes, a document, a dossier) | A DEC file with two options and a recommendation, then the human decides; or the work of the sheet, then its Definition of Done line by line. A line that needs another command (`/amend`) is run from `/slice` after one question, a line only a person can close stays open and says who |

When in doubt between two lanes, take the stricter one. A screen adds the design and product reviewers.

**A slice across repositories** is `ready-to-merge` when every one of its pull requests is open, green and approved, or already merged. It is `done` only when every pull request is merged and the definition of done is ticked. When one is merged and another fails, the slice stays `ready-to-merge` and `/board` names the failing one.

**One vocabulary.**
- Slice statuses: `todo`, `design`, `spec`, `gate-1`, `tests`, `implementation`, `audit`, `gate-2`, `ready-to-merge`, `done`, `blocked`. Any other is an invalid transition.
- Verdicts: spec `READY` or `GAPS`. Audit `CONFORMS`, `CONFORMS_WITH_RESERVATIONS`, `FIX` or `REOPEN`. Design `ON_DIRECTION` or `FIX`. Second opinion `CONCURS`, `CONCERNS` or `BLOCKING`.

Loops are bounded. `FIX` goes back to the implementer at most twice, then escalates. `REOPEN` goes back to the spec, and to gate-1 in the `sensitive` lane. A `BLOCKING` goes to the human as written. **No agent merges.** The full rules, the report block every agent ends with, and the stamp rules are in `harness/protocol.md` of the plugin, copied to `.claude/protocol.md` in your project.

### 8.4 Harness commands

Every command is installed at the root of the workspace (section 10.4), and every session starts there. A code repository gets one pointer command, `/slice`, that tells a session opened there by hand to work from the workspace.

| Command | What it does |
|---|---|
| `/status` | Slices, satisfied dependencies, gates waiting for a human, open provisional values, launchable slices |
| `/slice <S-nn>` | Delivers one slice end to end, following its lane |
| `/slice-check <S-nn>` | Checks that a sheet is ready, builds nothing, then refreshes `CLAUDE.md` |
| `/slice-write <S-nn>` | Creates a sheet from the template and the sources |
| `/parallel` | Proposes three to five slices to start now and opens a worktree for each |
| `/review <S-nn>` | Reviews a branch against its sheet |
| `/design <mode>` | `direction`, `system`, `variants`, `spec` or `review` |
| `/board` | Reconciles the board, then cleans the repository, worktrees and branches |
| `/inventory` | S-00: inventory of what exists |
| `/decision <topic>` | Opens a DEC file through a multiple-choice questionnaire |
| `/retro <INC-n>` | Increment review with DORA metrics and cost for each slice |
| `/amend <document>` | Upstream change and regeneration downstream |
| `/explain <file>` | Explains a project tool step by step |
| `/second-opinion <PR>` | Second-opinion review of an open pull request |
| `/merge-order` | Orders the open pull requests and rebases the next after each merge |

### 8.5 Original interfaces and interface rules

**Against generic AI design.** These are off by default and can be lifted only by an explicit art direction decision: purple-blue gradients, glassmorphism, soft shadows everywhere, a centred hero with three icon cards and a pill button, emoji as icons, blob illustrations, one system font as the only interface font, the same 12 px rounding on everything, neutral greys with no stance, dashboards made of identical cards, and filler text such as "Welcome back!".

**Instead.** Each project gets an **art direction** chosen at G2 from two or three contrasting ones. Each has a one-sentence concept, references (no AI apps), a type pair, a palette drawn from the brand and the trade, a grid and rhythm, data treatment, motion (durations, curves, intent), iconography and tone. It becomes **tokens** that the code consumes. A hard-coded value outside the tokens is a `FIX`. Screen variants differ by concept, not by colour.

**Sensitive actions need a confirmation.** Every destructive or irreversible action (delete, bulk archive, revoke, refund, publish, bulk send, reset) goes through a confirmation that names the object and the consequence ("Delete 3 invoices. This cannot be undone."), keeps the confirm button away from cancel with a verb label ("Delete invoices", never "OK"), asks for the name to be typed when the impact is high and the action irreversible, and offers undo when possible. Tests prove it: one end-to-end test for each sensitive action shows it does not happen without confirmation.

**Drawers where they fit.**
- Drawer: detail or edit of an item without leaving the list, advanced filters, secondary forms, side panels.
- Modal: a confirmation or a short blocking decision.
- Page: a long or multi-step task, or one that deserves a shareable URL.

Drawers have a URL, close on Escape and handle focus and back navigation. Accessibility is WCAG 2.2 AA, with full keyboard use and contrast checked in CI.

### 8.6 Hooks, guards and their limits

- **Allowed paths for each agent.** An agent writes only in the paths in its `## Writes` section.
- **No "green" without a stamp.** `recade gate run` writes a stamp for the current tree fingerprint. `recade gate check` passes only when a stamp exists for it. The fingerprint is `HEAD`, the count of changed lines and a hash of those lines and of the content of the changed files. A second edit of an already modified file counts.
- **Style and history.** The pre-commit hook runs the style linter, which covers invisible characters. The commit-message hook refuses the em dash and any subject that is not a conventional commit.
- **Forbidden:** merging, pushing to `main`, `--no-verify` and the other ways around the git hooks, deleting tests, weakening thresholds, and editing stamps, hooks, settings or thresholds.
- **Across repositories.** Claude Code applies only the hooks of the folder where the session starts, and every session starts at the root of the workspace, so one guard judges every write: the worktrees of the slice and the workspace. `/slice` ties its session to the slice with `recade slices open`, and the guard records the slice under `.recade/sessions/` by the session ID. It attaches each path to its repository and compares it with the globs of that repository, mapped to the worktree: `api:src/**` is `worktrees/api/<S-nn>/src/**`. A slice that touches only `api` cannot write into `worktrees/web/`, no agent writes a main checkout under `repos/` or the worktree of another slice, and a session that runs no slice writes no worktree. In the workspace an agent writes only the paths its `## Writes` gives with the `workspace:` prefix (for example `workspace:slices/<S-nn>-*.md` for the spec-writer); everything else goes through the CLI. `recade/state.yaml` (its harness keys), `.recade/`, `.claude/hooks/`, `.claude/agents/` and `.claude/commands/` are protected everywhere. A path outside the registry and the workspace is refused.
- **Fails closed on the link.** A code repository finds its workspace through `.recade/workspace`. When that file is missing or names another workspace (the workspace was moved or cloned again), the guard refuses every write and the message says `recade repo sync`. `/slice` stops with the same advice. An agent never runs `recade repo sync`, `recade repo add`, `recade harness specialise`, `recade workspace commit`, `recade workspace auto-push`, `recade guard snapshot`, `recade slices merge` or `recade slices open`: the guard refuses all eight, and so it does for a nested shell, a git environment variable or a hard link.
- **Audit.** `recade guard snapshot` records the state of the repositories when a slice starts and `recade guard audit` compares it with the end. A write outside the allowed paths shows as a `BLOCKING:` line, and `/slice` stops on it.

**What the guard cannot do.** The guard reads a command line. It does not run a shell and it is not a sandbox. A variable that holds a path or a command, a command substitution, an interpreter that writes a file (`node -e`, `python3 -c`, a script), a pipe into a shell or an encoded string is out of its reach, and so are a few git settings written by a script. `harness/protocol.md` lists the known limits. Do not rely on the guard as a wall.

**The real barrier is GitHub branch protection** with required reviews and required checks, and no direct push to `main`. `/recade:harness` offers to set it up, and `recade harness protect --apply` applies it (without `--apply` it only reads). Until it is on, a human who watches the pull requests is the barrier. On the local forge there is no branch protection, and the owner's merge (`recade slices merge`, main session only) is the one path to `main`.

### 8.7 Slices in parallel without conflicts

Conflicts come from files every slice touches and from branches that live too long. Recade acts at four moments.

**At launch (`/parallel`).** Each sheet declares its file scope in `touches:`. `/parallel` refuses to launch two slices whose scopes overlap, repository by repository. The project keeps a list of hot files (`hotspots:` in `recade/state.yaml`: routes, menus, migrations, dependency files, each with its repository prefix), and slices that touch them go one after the other. It opens one worktree for each repository the slice touches, at `worktrees/<name>/<S-nn>` of the workspace, on the same branch in each, through `recade slices open`, which `/slice` also runs for its own slice. Each slice then runs in its own session, started at the root of the workspace.

**In the design (BIBLE rules checked by the reviewer).** No central list edited by hand: routes, modules, migrations and translations are discovered, one file for each item. Migrations are named by timestamp. `STATUS.md`, `INDEX.md` and the changelog are never changed in a slice branch. Dependency updates go in their own slice.

**During the slice.** The branch is rebased on `main` at the start, before the audit and just before the pull request. A CI check (`recade conflicts check`) compares each pull request with the other open ones and flags a conflict as soon as it appears.

**At merge (`/merge-order`, also called by `/board`).** `merge-keeper` proposes a merge order, smallest and most independent first, for each repository, and rebases the next pull requests after each merge. The pull requests of one slice merge in the order of `merge_order:` or of the prefixes (the API before the web). It resolves mechanical conflicts only (imports, neighbouring lines, generated files), reruns the gates and shows the result before anything is pushed. A substantive conflict goes to the owner as a multiple-choice question. The merge stays human.

### 8.8 Second opinion

The reviewer in the chain has seen the sheet, the tests and the reports. The second opinion comes from a fresh agent that shares none of that.

- It reads the pull request (diff and description), the slice sheet and the requirements it cites. It never reads the reports of the implementer or the reviewer. The sheet is private and stays in the workspace: locally it is read there, and it is never copied into a pull request or into a code repository.
- It runs on the model of `harness/models.yaml`, Opus 5.5 by default, the reviewer's family, allowed by `second_opinion.same_family: warn`, or on Fable 5.2 when the owner chose `models.second_opinion: fable`.
- It posts a comment on the pull request with a verdict, `CONCURS`, `CONCERNS` or `BLOCKING`, each point with a file and a line. `BLOCKING` stops gate-2. The owner decides `CONCERNS` at gate-2.
- It runs always in the `sensitive` lane and on pull requests of more than 400 changed lines. Elsewhere it is optional. `second_opinion: always | sensitive | off` in `recade/state.yaml` sets it.
- `/second-opinion <PR>` runs it locally. An optional GitHub workflow can run it when a pull request opens (see section 10.7 for what the owner sets).

### 8.9 Cost, retros and the rest of the harness

- **Cost for each slice.** `recade cost record <S-nn> --minutes <n> --fix-loops <n>` adds tokens in one of two ways. Give `--transcript <path|auto>` and the CLI counts real tokens from the session file, subagents included and each message once, over a window that starts at `--since` or after the previous record of the slice, so records add up with no double count. `--session-dir` names the folder the session was started in. When no single session file can be found, the record says `tokens: not recorded` and never guesses. `--tokens <n>` exists for a count you already have.
- **Cost before a phase.** `recade cost estimate [--phase intake|team|docs|bible|slices|next|harness] [--json]` prints a range in dollars and the number of agent runs for each phase not passed yet, then the total. `--phase next` prices the next increment of the short track alone (the slicer with the stage `next`, then the checks), which `/recade:slices` shows in place of the whole phase when G4 is already passed; it is never in the list of phases left. `--slice standard|sensitive` prices the delivery of one slice with the chain of `harness/protocol.md` and the models of `harness/models.yaml`. Each phase command shows its line to the owner in its first message, before any question or dispatch, translated to the chat language, and says nothing when the estimate fails (the shared block `cost-line`): a line left in the tool output is never seen. The line also gives a range of hours, and `--phase` adds a line `Usual time of each step:` that the progress line of each step of `/recade:team`, `/recade:docs`, `/recade:bible` and `/recade:slices` reads (the shared block `progress-time`). The durations scale from a measured short-track framing (trust mode, 57 agent runs, about $70 at API prices): intake 10 minutes, team 14, D1 25, art direction 29, stack 114 with 3 spikes, D2 42, D3 43, PLAN 23, render and G2 17, BIBLE 27, slices 28; the harness, not measured, counts 30. Each figure scales with the runs of the project against the runs of that trial (`RUN_WEIGHT` 0.4: twice the runs is 1.4 times the minutes, the rest is the owner reading and answering), by 1.3 for the full track, and is spread by 0.85 to 1.2. The documents phase is measured step by step; the steps of the team, the BIBLE and the slices share their phase by fixed shares, an assumption until a project measures them. The runs come from what the commands dispatch (drafts, contributions, one review per document, one revise round and a possible second, the decisions applied, the format fixes, the translations, the companions of the dossiers with the stage `story`, four in the documents phase and one in the BIBLE phase, on the mechanical model, the spikes, one doctrine per role of the roster). The stack step is timed in two parts: the research, the matrix and the answers, scaled from the trial's 114 minutes less its 3 spikes, and the spikes, 4 to 5 minutes each plus 5 minutes once for the sentence, the room check and the cleanup. The short track (section 6.7) changes the runs, not only the budgets: no spike, since the owner decides from the research by default (with `spikes: run` in the state, recorded by `/recade:docs` when the owner answers, two finalists for each close layer, or 2 to 4 before the tasks exist; `spikes: none` counts none on either track), 4 to 6 sheets and a backlog for the slicer, the architect's opinion alone on the stack, a revise round of 0 to 1 for each document and for the art direction, two boards, and the 8 core roles plus at most one while there is no roster. The tokens of a run are its written words times 1.4 (the budgets of `budgetsOf(state)` for the documents), what it reads (its input documents), and a fixed overhead for the system prompt and the tool turns, written to the cache once and read back on each turn. Thinking is billed as output, by effort. The prices are those of `src/pricing.js` (API prices of 2026-11-03); on a subscription the same work counts against the usage limits. Every assumption is a named constant of `src/estimate.js`, so the figures can be tuned against the costs that `recade cost record` measures. An estimate is never written as a measure.
- **Retros.** `/retro <INC-n>` runs `recade retro` and writes `retros/INC-<n>.md`: demo, delivered, decisions, carry-over, open provisional values, DORA metrics from git and `gh`, cost for each slice, recalibrated dates and spec back-ports.
- **Flaky tests** go into quarantine (`recade quarantine`), listed in `tests/quarantine.json`, reported but not blocking, and must be fixed before the end of the increment.
- **Release notes** are generated from conventional commits: `recade release-notes <from>..<to> --write`.
- **Dependency updates** are automated through Dependabot and go through the same chain.
- **The harness has its own tests.** Each agent, in the plugin and in the harness, has test cases: an incomplete sheet must give `GAPS`, a weakened test must give `FIX`. `recade cases` lists them and `recade cases --run` replays them with `claude -p`. It refuses to run under `CI`.
- **CI jobs** installed with the harness: lint, types and tests, end-to-end and accessibility and performance budgets, SAST and dependency audit and SBOM and secret scan, quarantined tests, and the conflict check.

### 8.10 `/board`: reconcile, then clean

After a merge, `/board` first **reconciles the board**: statuses and comments, and `done` only when every pull request of the slice is merged and the definition of done is ticked (it then writes `merged:` in the sheet and closes the issue of the slice in the workspace repository). It then **cleans up**, showing the list before acting: worktrees of merged slices in each repository (their services stopped, then removed and pruned), merged local and remote branches, `artifacts/<repo>/<S-nn>/` and `tmp/` of the workspace, and caches in removed worktrees. The folders of a version under `artifacts/<repo>/<version>/` are kept. It reports the space freed. Nothing unmerged is deleted without the owner's explicit answer. A branch or worktree with unpushed changes is reported, never erased. Each step starts as a dry run.

### 8.11 `CLAUDE.md` stays current

`/slice-check` ends by refreshing `CLAUDE.md`: an analysis of the repository like `/init` (build and test commands, structure, real conventions), merged with the rules you wrote by hand, which are kept. `CLAUDE.md` stays short: rules and pointers, never project state. The diff is shown and nothing is written without your yes.

### 8.12 The GitHub board

One GitHub project for each Recade project, on the repository of the workspace: an epic for each lot, an issue for each backlog story and each slice, and the fields `Status`, `Increment`, `Sprint`, `Lane`, `Points`, `Priority`, `Due`, `Owner` and `Epic`. Field IDs are read with `gh project field-list`, never hard-coded. `/board` leaves a comment on the issue each time it moves a slice. Recade only writes to private repositories. The code repositories carry the code and the pull requests, and no issue. A pull request links the issue of the workspace by its full URL, because a closing keyword such as `Closes #12` does not work from one repository to another; `/board` closes the issue when the last pull request is merged.

**Epics.** Each lot of the PLAN has an epic issue with the label `epic`, found by the marker `<!-- recade:epic <code> -->` in its body. Its title is the lot code and its name, its body the goal of the lot (from the `## Lots` table of the PLAN), its stories and its slices. Each story and each slice issue is a sub-issue of the epic of its lot (`POST /repos/{owner}/{repo}/issues/{n}/sub_issues` through `gh api`); a slice that serves several lots sits under the lot of its first story. A story issue carries the marker `<!-- recade:story <ID> -->` and what the PLAN says of the story. The `Epic` field holds the lot code of each item. `recade github sync` keeps all of this in line when the PLAN or the slices change: it closes the epic of a lot that left the PLAN with a comment, never deletes an issue, and edits only the issues Recade wrote. `/board` closes an epic when every slice that serves its lot is done, and reopens it when one is not.

**Recade does not create board views.** GitHub's API for them is not used. Make the views you want by hand, once, in the browser. A useful set:
1. Open the project and choose **New view**.
2. **Slices in progress:** layout Board, grouped by `Status`.
3. **Backlog by increment:** layout Table, group by `Increment`, sort by `Priority`.
   **Backlog by epic:** layout Table, group by `Epic`.
4. **Critical path:** layout Table, filter on `Priority:P0,P1`, sort by `Due`.
5. **Milestones:** layout Roadmap, using `Due` as the date field.

## 9. Modern methods built in

| Method | Where Recade applies it |
|---|---|
| Spec-driven development | The slice sheet, the contract and the definition of done come before the code |
| Tests seen red first | `test-engineer`, the "seen red first?" column, proof by mutation |
| Contract testing | Contract first, a CI gate |
| Short pull requests, one slice for each | Flags for what is not ready |
| Conventional commits, clean history | The reviewer and the commit-message hook |
| CI/CD and a preview for each pull request | `devops`, the walking skeleton |
| Dependency analysis, SAST, SBOM, secret scan | `security-reviewer` and CI |
| ADRs | D2 and `STACK.md` |
| Observability from S-01 | The walking skeleton and D2 |
| DORA metrics | `retros/` |
| WCAG 2.2 AA and a design system of tokens | `ui-designer`, `design-reviewer`, CI |

## 10. The project workspace

Every Recade project lives in one folder, `<slug>-workspace`, which is a **private git repository**. It holds the documents of work, the state of Recade, the heavy deliverables and the code repositories of the product. Two reasons: everything has one place, and what is private stays private. The intake, the decisions, the BIBLE, the team and the slice sheets are backed up on GitHub in private, even when a code repository is public or belongs to the client. A document of Recade is never copied into a code repository, a pull request or the log of a code repository's CI.

### 10.1 The tree

```
<slug>-workspace/            private git repository
  recade/state.yaml          mode, phase, gates passed, next action, voice, languages, the registry of code repositories
  intake/  team/  design/  decisions/  retros/
  docs/                      D1, D2, D3, STACK, PLAN, figures/, deliverables/ (generated, committed), source/ (adopt)
  BIBLE.md, INDEX.md, CLAUDE.md
  slices/                    S-nn-*.md, graph.md, STATUS.md
  .claude/  .githooks/  .github/   the workspace harness
  repos/                     ignored by git
    <name>/                  an ordinary clone, with its own remote, its git hooks and its CI
  worktrees/                 ignored: <name>/<S-nn>/, the worktree of a slice in each repository it touches
  artifacts/                 ignored: <name>/<S-nn or version>/ (builds, APK, exports)
  tmp/                       ignored: drafts, emptied by /board
  .recade/                   ignored, local to this machine
```

The `.gitignore` of the workspace holds `artifacts/`, `tmp/` and `.recade/`. The code checkouts, `repos/` and `worktrees/`, are kept out of the git of the workspace by its `.git/info/exclude`, which only git reads: in the `.gitignore`, a tool run inside a checkout that honours the ignore files of the folders above it (a dependency scanner, a search) would skip the whole checkout. Each command that makes a checkout (`recade repo sync`, `recade repo add`, `recade slices open`, the harness install) writes the two lines when they are missing, and the harness install moves them out of an older `.gitignore`. The rendered documents in `docs/deliverables/` are committed. A worktree, a build or a draft never goes outside this folder. A code repository name is lower-case words joined by hyphens (`api`, `web-app`), and is never `workspace`.

### 10.2 The registry and the link

`recade/state.yaml` holds the list `repos`: for each code repository its `name`, `path` (`repos/<name>`), `remote`, `default_branch`, `role` and `visibility`. Four commands work on it:
- `recade repo add <name> --new | --clone <url or local path> [--role <text>] [--visibility private|public|internal]`. A local folder is cloned; the registry records the folder's own `origin`, or `none` when it has none. A URL with a password or a token is refused.
- `recade repo list`
- `recade repo check`: each entry exists, is a git repository, has its link and its harness.
- `recade repo sync`: see section 10.8.

Each code repository has a file `.recade/workspace` (local to the machine, ignored by git) that names its workspace. The guard, the harness commands and the git hooks find the workspace through it and fail closed when it is missing or names another one. A code repository depends on its workspace: a developer who has only the code repository can code, but cannot run `/slice`. `recade workspace root` prints the workspace of the folder it runs in.

### 10.3 Phases 0 to 5 in the workspace

The first commit of a workspace is made by `recade new`. Every Recade command that writes the state, a decision, a provisional value, a slice status or the registry commits its own file, under a lock file in `.recade/` that serialises the commits of several sessions. A command that finds one of its files already changed by someone else stops and says so: it never mixes its commit with work in progress. A document that a session wrote and that no Recade command commits (a slice sheet, a design file, a retro) is committed with `recade workspace commit --paths <path>[,<path>...] -m <message>`, under the same lock and for the document folders only (never the state, the harness or a code repository). Commits are made on the default branch only.

### 10.4 Two harness targets, one entry point

Every session starts at the root of the workspace, and the owner types every command there, `/slice <S-nn>` included. The reason: the owner never knows in advance which repositories a slice touches, so a harness split between the workspace and the code repositories made the owner pick a folder before the work could start, and a session in the wrong one did not have the command. Now there is one place to work from. `/slice` reads `touches:` and opens the worktrees itself, and the owner never chooses a folder.

| Target | Command | Gets | Does not get |
|---|---|---|---|
| Workspace | `recade harness install --target workspace` | Every command and every agent, the protocol, the guard, git hooks (style check and ID index), `.github/workflows/workspace.yml` (style, ID index, slice check), `repos/` and `worktrees/` in `.git/info/exclude` | Gates, the CI of a code repository |
| Code repository | `recade harness install --target code --repo <name>` | What belongs to the code: the git hooks with the gate check and stamps, the CI, the conflict check, the optional second opinion, Dependabot, the settings and the guard (so a session opened by hand there stays held), the pointer command `/slice` that sends that session to the workspace, the link | Any agent, any other command, the protocol, any document of Recade |

The CI of a code repository starts with the job `Code present`: while the repository holds only the harness files (`.claude/`, `.githooks/`, `.github/`, `CLAUDE.md`, `AGENTS.md`, the README, the licence, `.gitignore`, `.gitattributes`, `.editorconfig`, `tests/quarantine.json`), the quality, end to end, security and quarantine jobs are skipped and the run summary says so. GitHub counts a skipped job as passing, so a required check does not hold a new repository red until its first slice. The style job always runs.

Run in a code repository, the command means that repository. Run at the root of a workspace without `--target`, it means the workspace. A project that was started before the workspace (no `kind: workspace` in its state) keeps the whole harness in one folder. `recade harness verify` takes the same options and checks each target by its own files. In a code repository the harness technical sheet comes from the table of that repository in `docs/STACK.md` of the workspace. The commands that only the main session runs are `recade repo sync`, `recade repo add`, `recade harness specialise` (which writes the specialisation of an agent or command file), `recade workspace commit` (which commits files of the workspace under the commit lock), `recade workspace auto-push` (which records the owner's consent), `recade guard snapshot` (which writes the evidence of the audit), `recade slices merge` and `recade slices open` (which opens the worktrees of a slice and then ties the session to it: the command itself writes `.recade/sessions/<session id>` with the session ID of its shell, only when every worktree opened and the command runs from inside the workspace; `--keep-session` adds the slice to the ones the session runs, for `/review` and `/design`, and `--tie-only` adds it with no worktree, for the rebase worktree `worktrees/<repo>/merge-<S-nn>` of `/merge-order`).

**Migration.** A project installed before this layout has its agents and its slice commands in each code repository and its slice worktrees under `repos/<repo>/.claude/worktrees/<S-nn>`. `recade harness migrate` (with `--dry-run` first, from the workspace) installs the harness at the root of the workspace, moves each slice worktree to `worktrees/<repo>/<S-nn>` with `git worktree move`, and removes the old copies from the code repositories only where they are Recade's: the hash of the install record (`.recade/installed.json`), the record of an adopted repository, the text the install of that version writes, or, above the specialisation line, the text of an earlier version of Recade. The plugin ships the fingerprint of every version of its templates in `harness/history.json` (written by `node tools/harness-history.js` from the git history, version header and model line left out); a re-install replaces that text anyway. Text of the team below the line is first carried to the copy of the workspace with `recade harness specialise` (for the protocol, which `specialise` does not write, the workspace copy must hold it word for word already), and the old copy goes only once that is done. A worktree with uncommitted changes stays where it is, named, and so does a file the team changed above the line, or one whose text could not be carried. Only a worktree whose name is a slice ID moves; any other one under `.claude/worktrees/` (a worktree of Claude Code itself, a rebase worktree) stays, named. The ledger of a moved worktree goes to `.recade/slices/<S-nn>/progress.md` of the workspace, where `/slice` reads it; a ledger already there is never overwritten, and both are reported. A second run finds nothing to do. `recade repo check` reports such a repository as `old layout`, and `/recade:harness` offers the migration.

### 10.5 Settings: for the project and for each repository

- **For the project**, in `recade/state.yaml` of the workspace: the gates G0 to G4, the decisions mode (`ask` or `trust`, section 6.3), the forge (`github` or `local`, section 6.8), the registry, the GitHub board, the hot files with their prefixes and the languages.
- **For each code repository**: the harness technical sheet (its table in `docs/STACK.md`, so its own test, build and end-to-end commands), `required_gates` and `threshold_files` in `.claude/recade.yaml`, `tests/quarantine.json` (`recade quarantine` works inside a repository, or with `--repo <name>` from the workspace), and the stamps of `.recade/`.
- A slice across repositories is green when its required gates are green in each of its repositories, each with its own stamp.

### 10.6 GitHub, branch protection and automatic push

- The repository of the workspace carries the board and the issues of the slices. The code repositories carry the code and the pull requests. Each GitHub repository is created only after the owner's yes, one question at a time. A code repository is named `<owner>/<project>-<name>`. A repository that already exists on GitHub is looked at, never created and never pushed over.
- **Branch protection.** `recade harness protect --apply` is asked for each repository. A code repository gets the strict rules (a pull request, the required checks, no force push). The workspace gets looser ones, because Recade commits documents straight to its default branch: no pull request and no required check, force push and deletion blocked, linear history.
- **Automatic push.** At the creation of the private workspace repository, the owner says yes or no once. A yes is recorded as `workspace.auto_push: true` with its date. After that no step pushes: each step only commits. The workspace is pushed once, at the end of each turn of a session: the Stop hook of the plugin runs `recade workspace push`, which pushes every commit the turn made, so that the work leaves the machine in one push and a slice paused for days does not keep its commits on one machine. The hook reads the state with two line tests and does nothing outside a workspace with auto-push on. It pushes only the workspace and only its default branch, never a code repository. A push that fails (network, rights) never fails the command: one line on stderr, and the next push carries the missed commits. `recade workspace auto-push off` stops it, and with it off no push call is made at all. The push to `main` stays forbidden to agents in the code repositories.

### 10.7 CI of the workspace and of the code repositories

- **The workspace** runs the style check on the documents, the ID index and the slice check.
- **Each code repository** runs build, tests, lint, quarantine, the conflict check and, when the owner turns it on, the second opinion. The ID index job is not there: the documents are not.
- **The second opinion in CI needs the sheet, which is private.** The job clones the workspace with a read-only token and copies only the sheet of the slice into the checkout of the runner. The owner sets, in the settings of the code repository:
  - the variable `RECADE_SECOND_OPINION` to `on`, and the secret `ANTHROPIC_API_KEY`;
  - the secret `RECADE_WORKSPACE_TOKEN`: a fine-grained personal access token with Contents set to read-only, on the workspace repository only;
  - the variable `RECADE_WORKSPACE_REPOSITORY`: the `owner/name` of the workspace repository.

  Without the token and the variable the job prints a notice and ends in success, and the second opinion is run locally with `/second-opinion`. **The guarantee that the reviewer does not quote the sheet is a prompt rule, nothing more.** The job removes its clone and never prints the sheet, but the reviewer can read the sheet in the runner, and only its instructions keep it from repeating the text in a public pull request comment. When that is not acceptable, do not set the token and run the second opinion locally.

### 10.8 Another machine, a moved workspace

`recade repo sync`, run from the workspace, clones the repositories of the registry that are missing from `repos/`, writes `.recade/workspace` and `.recade/plugin-root` in each repository, and repairs the git worktrees of the slices of a moved workspace, under `worktrees/` (and under `.claude/worktrees/` of a repository not migrated yet). A repository with no remote cannot be cloned: it is skipped with the reason. `/recade:resume` offers the sync when something is missing. When `.recade/plugin-root` is missing (a fresh clone, a cloud session), the hook launcher falls back to the Recade plugin that Claude Code installed on that machine, read from `plugins/installed_plugins.json` of its config folder; with none, write tools and Bash are refused. A cloud session does not add the marketplace a repository lists, so the harness settings add a `SessionStart` hook that runs the launcher with `--session-start`: when `CLAUDE_CODE_REMOTE` is `true` and no plugin is found, it runs `claude plugin marketplace add loycossou/recade` and `claude plugin install recade@recade`, and the launcher finds the plugin at the next tool call. It never runs on a machine of the team, and it never fails the session. A link is valid when the path it names is the workspace that holds the repository in `repos/` (for a worktree, the main repository of the worktree is used).

### 10.9 Deliverables and drafts

The builds, APK and exports of a slice go to `artifacts/<repo>/<S-nn>/`, and those of a version to `artifacts/<repo>/<version>/`. Drafts go to `tmp/`. The `release-manager` and the build instructions enforce it. `/board` removes the worktrees, the merged branches, `tmp/` and `artifacts/<repo>/<S-nn>/` at the end of a slice, and keeps the version folders. Nothing unmerged or unpushed is deleted without the owner's yes.

### 10.10 What stays unchanged

A doctrine file `team/<role>.md` has a header (role, `inspired_by`, model, effort, dated sources) and the sections: why this profile for this project, convictions with their sources, working rules, review checklist, what they refuse, how they settle a disagreement, and limits.

## 11. Quality of Recade itself

- The made-up project in `example/` is run end to end in each of the three entry modes in CI, under a parent folder whose name has a space and an accent. The two new modes create the code repositories `api` and `web`, and the adopt mode clones an existing repository; each run ends with a slice that touches two repositories going from `todo` to `done` with a fake pull request in each. The run checks the workspace tree and its `.gitignore`, that nothing is written outside the workspace, that the adopted original is untouched, and that the automatic push calls only the workspace repository. A fourth run, `local`, plays the scratch project on the local forge (section 6.8) and fails if the fake `gh` is called at all: its slice ends with a review request and an owner's merge with `--no-ff`. A change to the file format of any phase breaks that run, not a user. The run fails with the phase, the file and the first differing line.
- The render engine is tested on reference documents: the structure of the `.docx`, the tabs and formulas of the `.xlsx`, the pages of the `.pdf`, and the absence of the em dash.
- The agent test cases are listed in CI and can be replayed on demand.
- `npm run publish-check` fails on an em dash (also written as an entity), a raw e-mail address, a private name (only with a list: `--names <file>`, or `RECADE_PRIVATE_NAMES`; `--require-names` fails when there is none, and without a list the names are not checked), a file over 5 MB, a command advertised but not available, a missing licence, an e-mail in `plugin.json`, a version mismatch, a missing changelog section, and any private working file in the tree. `npm run publish-check -- --history` lists the commits that ever held one.
- Checks that no test can make are in [live-checklist.md](live-checklist.md) and are walked by hand before each release.
- **Shared prompt blocks.** A rule that many commands and agents repeat has one source: `tools/shared/<name>.md`, one block per file. Each prompt file holds it between the comments `<!-- shared:<name> -->` and `<!-- /shared:<name> -->`, inside a sentence or on lines of its own, never in the front matter. To change the rule, edit its source and run `npm run sync-shared`. `node tools/sync-shared.js --check` reports the drift and exits 1. `tests/shared-blocks.test.js` fails on a block that differs from its source, a source that no file uses, unbalanced markers, and a command or agent that lacks a block its family must hold.
- **Defaults stated once.** The table below is built from the code by `npm run sync-shared`. `tests/defaults-docs.test.js` checks it, and the sentences of the README, of this file, of `docs/delivery.md` and of `/recade:start` that state one of these defaults, so a default changed in the code and not in the documents fails the tests.

<!-- generated:defaults -->
| Setting | Default | Set in |
|---|---|---|
| `models.writer`, in the user config | `opus` | `src/config.js` |
| `models.second_opinion`, in the user config | `opus` (`fable` puts the project copy on Fable 5.2) | `src/config.js` |
| `slicing`, in `recade/state.yaml` | `mixed` | `src/project/state.js` |
| `second_opinion`, in `recade/state.yaml` | `sensitive` | `src/project/state.js` |
| `budgets`, in `recade/state.yaml`, in words | D1 10,000, D2 9,000, D3 7,000, PLAN 7,000, STACK 6,000, BIBLE 8,000 | `src/budgets.js` |
| The model of the `second-opinion` agent | `claude-opus-5-5` (Opus 5.5) | `harness/models.yaml` |
<!-- /generated:defaults -->

## A private Recade

Every action the workflow templates call is pinned to a full commit, with its release in a comment (`actions/checkout@<sha> # v4.4.0`): a tag can be moved, a commit cannot. Dependabot moves the commit and the comment together, and waits 7 days before a new version of an action or a dependency (`cooldown`). The CI workflows fetch the Recade tools from `loycossou/recade` at the ref pinned at install. While that repository is private, a project on another account cannot read it, and the step `Fetch the Recade tools` fails with `could not read Username`. Give each repository of the project a read-only deploy key:

1. `ssh-keygen -t ed25519 -N '' -C recade-ci -f recade-ci` makes the pair.
2. `gh repo deploy-key add recade-ci.pub --repo loycossou/recade --title '<project> CI'` adds the public half, read-only.
3. `gh secret set RECADE_DEPLOY_KEY --repo <owner>/<repo> < recade-ci` stores the private half in the workspace repository and in each code repository (or once for the organisation, with `--org` and the `admin:org` scope).
4. Delete both files.

The workflows fetch over SSH when `RECADE_DEPLOY_KEY` is set, with the host key GitHub publishes pinned, and over HTTPS otherwise. A run that gets no secrets (a Dependabot pull request, a fork) still fails on that step until Recade is public.
