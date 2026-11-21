# Recade: how it works

This page explains what Recade does, in what order, and where it stops. It is written for the person who uses Recade. The README has the install steps and the command list. This page has the reasons.

In this page, the **owner** is the person who uses Recade and decides at the gates.

## 1. What Recade does

Recade is a Claude Code plugin. It takes a software project from an idea, or from existing code, to slices delivered by agents. It always works the same way:

1. It builds an **expert-inspired team**. Each role has a written doctrine drawn from the public work of a real expert, with sources.
2. The team picks the **stack** and writes the starting documents: D1 Functional Specifications, D2 Technical Architecture, D3 Security Requirements and a delivery plan. They are rendered as `.docx`, `.pdf` and `.xlsx`.
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
2. **Cite an ID with what it says, never a line number.** For example `FR-PAY-03 (refund only within 24 h)`. The ID keeps the citation stable. The gist makes it readable. `recade index --check` refuses an unknown ID and flags a gist that no longer matches the title.
3. **Explicit human gates.** Each phase ends at a gate. Decisions are asked as multiple-choice questions, with the stakes, the options, a recommendation and a default.
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
3. It asks for your preferences: languages, the GitHub account for private project repositories, the projects folder (the default parent of a workspace), the writing model (Fable or Opus, section 8.2) and the voice.
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
4. **Board matching, without duplicates.** `recade adopt board` runs before `recade github init`. It reads the open issues of every adopted repository that has a GitHub remote, the issues of the workspace repository when it exists, and the Projects boards of the owner (closed ones too). It only reads, with two exceptions: `--accept` records issue links (`<repo>#<issue>=<slice>`) in `recade/state.yaml`, and `--create` makes one board, only when none exists and the owner says yes. The owner picks the board and confirms the links in a multiple-choice question. Then `recade github init` creates the private workspace repository, adds each linked issue to the board by its URL and creates an issue, in the workspace repository, only for a slice that has none. A linked issue stays in its code repository and is never renamed, edited or duplicated.
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
- **Stack decision** (section 6.4): gate **G2-stack**.
- **D2 Technical Architecture**: the architect, the devops lead and the security lead.
- **D3 Security Requirements**: the security lead, citing standards with a version and a date.
- **Delivery plan** `.xlsx`.
- **Figures**: Mermaid or HTML and SVG, rendered to PNG.

The roles concerned review each document in writing. Open decisions go to the owner as multiple-choice questions, and the answers become `DEC-nn` files copied into the documents before G2. After the stack choice, the project lead may add a specialist in the chosen technology.

**The code repositories.** D2 section 2.5 lists one code repository for each deployable container (`api`, `web`...). After G2, and after a yes from the owner, `recade repo add <name> --new` creates each one under `repos/<name>/`. When there are two or more, section 12 of `STACK.md` carries one table for each repository (`### api`, `### web`), because each one has its own build and test commands.

### 6.4 The stack decision

A team decision, argued like an architecture decision and settled by the owner. It comes after D1 (we know what to build) and before D2 (which describes it). In adopt mode, `STACK.md` describes the stack in place and nothing is chosen.

1. **Criteria come from the project, not from habit.** Each cites its source (an `NFR-*`, a `PAR-*`, an intake constraint) and has a weight. They cover non-functional needs, constraints, the skills of the people who will maintain it, lifetime, security, fitness for development by agents (measured, not assumed) and total cost.
2. **Candidates for each layer:** two or three options that really differ, at least one outside the reflex choices. The stated biases are fashion, the writer's comfort and the tendency of language models to pick the same stack for every project.
3. **Dated research:** versions, support calendars, licences, recent vulnerabilities and field reports at the project's scale.
4. **A spike for the finalists:** the same real task, done by an agent in each option. Recade measures unaided success, fix loops, build and test time and readability.
5. **A weighted matrix** with reasons, risks, exit cost and the architect's recommendation. Each contributor writes an opinion, disagreements included.
6. **The decision**, asked layer by layer (G2-stack). Each choice becomes an `ADR-nn`. `docs/STACK.md` records the pinned versions, the matrix, the spikes, the rejected options, the **conditions to revisit**, and the **harness technical sheet** (build, test, lint, format, local run, conventions, quality and security tools).

Each retro re-reads the stack against its conditions to revisit. A change goes through `/amend`.

### 6.5 Phases 3 and 4: bible and slices

- **`BIBLE.md`** holds the rules, written so that agents apply them without interpretation. It cites D1, D2 and D3 by ID with their gist and does not copy them. Its plan, in short: mission and quality bar, reading order, dated facts, binding documents by precedence ("if none answers, it is not yours to answer: `BLOCKING`, stop"), decisions, invariants each with the test that guarantees it, business rules, conventions, design rules, the writing voice, exclusions, escalation, the definition of done, session discipline, parallelism and model policy, quality gates, one list of prohibitions, and where to read the state.
- **`PLAN.md`** holds increments, milestones, the calendar, roles, a RACI and risks. It is the source of the workbook.
- **`INDEX.md`** is generated.
- **Slicing.** The owner first picks a formula (section 7.4). Recade then writes the slice sheets, the dependency graph (Mermaid) and `STATUS.md`. After a dry run and a yes, it creates the private GitHub repository of the workspace and the board, with one issue for each slice and story. The owner answers three separate questions: the private workspace repository, the automatic push of the workspace (section 10.6) and, one by one, each new code repository.

### 6.6 Phase 5: harness

Recade copies the template harness at two targets: first the workspace (`recade harness install --target workspace`), then each code repository, one at a time (`--target code --repo <name>`). Section 10.4 says what each one gets. The team specialises it: invariants, lanes, verification commands, the domain expert, the model table, the board fields, the art direction and the stack skills. Then it writes the first `CLAUDE.md`. `recade harness verify` checks that each agent loads, each command is present, and each guard blocks what it must. Branch protection is offered, and applied only with the owner's explicit yes.

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
- `.pdf`: the same content as printable HTML, printed by Chromium through Playwright.
- `.xlsx` with `exceljs`.
- Figures: Chromium captures HTML, SVG and Mermaid to PNG, cached in `.recade-cache/`.
- Font: Inter Tight (OFL, shipped with the plugin and embedded), with Arial as the declared fallback.
- Theme: per-project tokens derived from the art direction.
- Checks before anything is written: IDs and gists, the em dash and tics, and `PROVISIONAL` values shown in the margin. Labels exist in English and French.

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
- The `second-opinion` agent always runs on a different model family from the `reviewer`.
- Phases 0 to 4 use the most capable model for the team, the documents and the BIBLE, and a mid-size model for mechanical cutting and board creation.
- **The owner chooses the writing model.** The plugin agents of the `writer` tier (15 of the 17 in `agents/`) run on Fable by default, at high effort. The user preference `models.writer` (`fable`, the default, or `opus`, the latest Opus) replaces the model, never the effort. `/recade:start` asks it once, `recade config set models.writer opus` changes it, and `recade models writer` prints the alias to dispatch with (`--id` prints the full id, `claude-fable-5-2` or `claude-opus-5-5`). Each `/recade:*` command that dispatches a writer agent reads it once and passes it as the `model` of every such dispatch; the recruiter writes the chosen id in the model column of the roster. The front matter of the agents keeps Fable as the fallback, so `tools/sync-agent-models.js --check` stays green, and the mechanical agents (`inventory-analyst`, `spike-runner`) are not touched.
- **The second-opinion stays on Fable** whatever `models.writer` says, because it must come from a family different from the reviewer's, which is `opus`. If the second opinion followed the owner to Opus, it would share the reviewer's family and the rule above would fail. `harness/models.yaml` says so, and `recade harness models` still checks the rule.
- The real cost of each slice is measured (section 8.9) so the table can be tuned.

### 8.3 Chain and lanes

| Lane | Triggers | Chain |
|---|---|---|
| `sensitive` | Money, security, personal data, an invariant, a migration, a breaking contract | design, full spec, domain review, **gate-1 (human)**, tests, `implementer-critical`, review (with mutation) and security review, docs, pull request, second opinion, **gate-2 (reservations)**, human merge, `/board` |
| `standard` | Everything else | short spec, tests, `implementer`, review, docs, pull request, human merge, `/board` |
| `no-code` | A decision or research | A DEC file with two options and a recommendation, then the human decides |

When in doubt between two lanes, take the stricter one. A screen adds the design and product reviewers.

**A slice across repositories** is `ready-to-merge` when every one of its pull requests is open, green and approved, or already merged. It is `done` only when every pull request is merged and the definition of done is ticked. When one is merged and another fails, the slice stays `ready-to-merge` and `/board` names the failing one.

**One vocabulary.**
- Slice statuses: `todo`, `design`, `spec`, `gate-1`, `tests`, `implementation`, `audit`, `gate-2`, `ready-to-merge`, `done`, `blocked`. Any other is an invalid transition.
- Verdicts: spec `READY` or `GAPS`. Audit `CONFORMS`, `CONFORMS_WITH_RESERVATIONS`, `FIX` or `REOPEN`. Design `ON_DIRECTION` or `FIX`. Second opinion `CONCURS`, `CONCERNS` or `BLOCKING`.

Loops are bounded. `FIX` goes back to the implementer at most twice, then escalates. `REOPEN` goes back to the spec, and to gate-1 in the `sensitive` lane. A `BLOCKING` goes to the human as written. **No agent merges.** The full rules, the report block every agent ends with, and the stamp rules are in `harness/protocol.md` of the plugin, copied to `.claude/protocol.md` in your project.

### 8.4 Harness commands

The commands are installed at two places (section 10.4). The project commands (`/status`, `/board`, `/parallel`, `/merge-order`, `/retro`, `/slice-write`, `/slice-check`, `/decision`, `/inventory`, `/design`, `/amend`) go to the workspace. The slice commands (`/slice`, `/review`, `/second-opinion`, `/explain`) go to each code repository.

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
- **Across repositories.** Claude Code applies only the hooks of the folder where the session starts, so the guard of a slice session judges every write: its own repository, the other repositories of the slice and the workspace. It attaches each path to its repository and compares it with the globs of that repository. A slice that touches only `api` cannot write into `repos/web/`. In the workspace an agent writes only the paths its `## Writes` gives with the `workspace:` prefix (for example `workspace:slices/<S-nn>-*.md` for the spec-writer); everything else goes through the CLI. `recade/state.yaml` (its harness keys), `.recade/`, `.claude/hooks/`, `.claude/agents/` and `.claude/commands/` are protected everywhere. A path outside the registry and the workspace is refused.
- **Fails closed on the link.** A code repository finds its workspace through `.recade/workspace`. When that file is missing or names another workspace (the workspace was moved or cloned again), the guard refuses every write and the message says `recade repo sync`. `/slice` stops with the same advice. An agent never runs `recade repo sync`, `recade repo add`, `recade harness specialise`, `recade workspace commit`, `recade workspace auto-push` or `recade guard snapshot`: the guard refuses all six, and so it does for a nested shell, a git environment variable or a hard link.
- **Audit.** `recade guard snapshot` records the state of the repositories when a slice starts and `recade guard audit` compares it with the end. A write outside the allowed paths shows as a `BLOCKING:` line, and `/slice` stops on it.

**What the guard cannot do.** The guard reads a command line. It does not run a shell and it is not a sandbox. A variable that holds a path or a command, a command substitution, an interpreter that writes a file (`node -e`, `python3 -c`, a script), a pipe into a shell or an encoded string is out of its reach, and so are a few git settings written by a script. `harness/protocol.md` lists the known limits. Do not rely on the guard as a wall.

**The real barrier is GitHub branch protection** with required reviews and required checks, and no direct push to `main`. `/recade:harness` offers to set it up, and `recade harness protect --apply` applies it (without `--apply` it only reads). Until it is on, a human who watches the pull requests is the barrier.

### 8.7 Slices in parallel without conflicts

Conflicts come from files every slice touches and from branches that live too long. Recade acts at four moments.

**At launch (`/parallel`).** Each sheet declares its file scope in `touches:`. `/parallel` refuses to launch two slices whose scopes overlap, repository by repository. The project keeps a list of hot files (`hotspots:` in `recade/state.yaml`: routes, menus, migrations, dependency files, each with its repository prefix), and slices that touch them go one after the other. It opens one worktree for each repository the slice touches, at `repos/<name>/.claude/worktrees/<S-nn>`, on the same branch in each. The session starts in the worktree of the first repository and receives the others as additional folders.

**In the design (BIBLE rules checked by the reviewer).** No central list edited by hand: routes, modules, migrations and translations are discovered, one file for each item. Migrations are named by timestamp. `STATUS.md`, `INDEX.md` and the changelog are never changed in a slice branch. Dependency updates go in their own slice.

**During the slice.** The branch is rebased on `main` at the start, before the audit and just before the pull request. A CI check (`recade conflicts check`) compares each pull request with the other open ones and flags a conflict as soon as it appears.

**At merge (`/merge-order`, also called by `/board`).** `merge-keeper` proposes a merge order, smallest and most independent first, for each repository, and rebases the next pull requests after each merge. The pull requests of one slice merge in the order of `merge_order:` or of the prefixes (the API before the web). It resolves mechanical conflicts only (imports, neighbouring lines, generated files), reruns the gates and shows the result before anything is pushed. A substantive conflict goes to the owner as a multiple-choice question. The merge stays human.

### 8.8 Second opinion

The reviewer in the chain has seen the sheet, the tests and the reports. The second opinion comes from a fresh agent that shares none of that.

- It reads the pull request (diff and description), the slice sheet and the requirements it cites. It never reads the reports of the implementer or the reviewer. The sheet is private and stays in the workspace: locally it is read there, and it is never copied into a pull request or into a code repository.
- It runs on a model family different from the reviewer's.
- It posts a comment on the pull request with a verdict, `CONCURS`, `CONCERNS` or `BLOCKING`, each point with a file and a line. `BLOCKING` stops gate-2. The owner decides `CONCERNS` at gate-2.
- It runs always in the `sensitive` lane and on pull requests of more than 400 changed lines. Elsewhere it is optional. `second_opinion: always | sensitive | off` in `recade/state.yaml` sets it.
- `/second-opinion <PR>` runs it locally. An optional GitHub workflow can run it when a pull request opens (see section 10.7 for what the owner sets).

### 8.9 Cost, retros and the rest of the harness

- **Cost for each slice.** `recade cost record <S-nn> --minutes <n> --fix-loops <n>` adds tokens in one of two ways. Give `--transcript <path|auto>` and the CLI counts real tokens from the session file, subagents included and each message once, over a window that starts at `--since` or after the previous record of the slice, so records add up with no double count. `--session-dir` names the folder the session was started in. When no single session file can be found, the record says `tokens: not recorded` and never guesses. `--tokens <n>` exists for a count you already have.
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

One GitHub project for each Recade project, on the repository of the workspace: an issue for each backlog story and each slice, and the fields `Status`, `Increment`, `Sprint`, `Lane`, `Points`, `Priority`, `Due` and `Owner`. Field IDs are read with `gh project field-list`, never hard-coded. `/board` leaves a comment on the issue each time it moves a slice. Recade only writes to private repositories. The code repositories carry the code and the pull requests, and no issue. A pull request links the issue of the workspace by its full URL, because a closing keyword such as `Closes #12` does not work from one repository to another; `/board` closes the issue when the last pull request is merged.

**Recade does not create board views.** GitHub's API for them is not used. Make the views you want by hand, once, in the browser. A useful set:
1. Open the project and choose **New view**.
2. **Slices in progress:** layout Board, grouped by `Status`.
3. **Backlog by increment:** layout Table, group by `Increment`, sort by `Priority`.
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
    <name>/                  an ordinary clone, with its own remote and its own harness
      .claude/worktrees/<S-nn>/
  artifacts/                 ignored: <name>/<S-nn or version>/ (builds, APK, exports)
  tmp/                       ignored: drafts, emptied by /board
  .recade/                   ignored, local to this machine
```

The `.gitignore` of the workspace holds `repos/`, `artifacts/`, `tmp/` and `.recade/`. The rendered documents in `docs/deliverables/` are committed. A worktree, a build or a draft never goes outside this folder. A code repository name is lower-case words joined by hyphens (`api`, `web-app`), and is never `workspace`.

### 10.2 The registry and the link

`recade/state.yaml` holds the list `repos`: for each code repository its `name`, `path` (`repos/<name>`), `remote`, `default_branch`, `role` and `visibility`. Four commands work on it:
- `recade repo add <name> --new | --clone <url or local path> [--role <text>] [--visibility private|public|internal]`. A local folder is cloned; the registry records the folder's own `origin`, or `none` when it has none. A URL with a password or a token is refused.
- `recade repo list`
- `recade repo check`: each entry exists, is a git repository, has its link and its harness.
- `recade repo sync`: see section 10.8.

Each code repository has a file `.recade/workspace` (local to the machine, ignored by git) that names its workspace. The guard, the harness commands and the git hooks find the workspace through it and fail closed when it is missing or names another one. A code repository depends on its workspace: a developer who has only the code repository can code, but cannot run `/slice`. `recade workspace root` prints the workspace of the folder it runs in.

### 10.3 Phases 0 to 5 in the workspace

The first commit of a workspace is made by `recade new`. Every Recade command that writes the state, a decision, a provisional value, a slice status or the registry commits its own file, under a lock file in `.recade/` that serialises the commits of several sessions. A command that finds one of its files already changed by someone else stops and says so: it never mixes its commit with work in progress. A document that a session wrote and that no Recade command commits (a slice sheet, a design file, a retro) is committed with `recade workspace commit --paths <path>[,<path>...] -m <message>`, under the same lock and for the document folders only (never the state, the harness or a code repository). Commits are made on the default branch only.

### 10.4 Two harness targets

| Target | Command | Gets | Does not get |
|---|---|---|---|
| Workspace | `recade harness install --target workspace` | The 11 project commands and the 8 agents that write documents, the protocol, the guard, git hooks (style check and ID index), `.github/workflows/workspace.yml` (style, ID index, slice check) | Slice commands, gates, the CI of a code repository |
| Code repository | `recade harness install --target code --repo <name>` | The 4 slice commands, all 20 agents, the guard, the git hooks with the gate check and stamps, the CI, the conflict check, the optional second opinion, Dependabot, the link | Any document of Recade |

Run in a code repository, the command means that repository. Run at the root of a workspace without `--target`, it means the workspace. A project that was started before the workspace (no `kind: workspace` in its state) keeps the whole harness in one folder. `recade harness verify` takes the same options and checks each target by its own files. In a code repository the harness technical sheet comes from the table of that repository in `docs/STACK.md` of the workspace. The commands that only the main session runs are `recade repo sync`, `recade repo add`, `recade harness specialise` (which writes the specialisation of an agent or command file), `recade workspace commit` (which commits files of the workspace under the commit lock), `recade workspace auto-push` (which records the owner's consent) and `recade guard snapshot` (which writes the evidence of the audit).

### 10.5 Settings: for the project and for each repository

- **For the project**, in `recade/state.yaml` of the workspace: the gates G0 to G4, the registry, the GitHub board, the hot files with their prefixes and the languages.
- **For each code repository**: the harness technical sheet (its table in `docs/STACK.md`, so its own test, build and end-to-end commands), `required_gates` and `threshold_files` in `.claude/recade.yaml`, `tests/quarantine.json` (`recade quarantine` works inside a repository, or with `--repo <name>` from the workspace), and the stamps of `.recade/`.
- A slice across repositories is green when its required gates are green in each of its repositories, each with its own stamp.

### 10.6 GitHub, branch protection and automatic push

- The repository of the workspace carries the board and the issues of the slices. The code repositories carry the code and the pull requests. Each GitHub repository is created only after the owner's yes, one question at a time. A code repository is named `<owner>/<project>-<name>`. A repository that already exists on GitHub is looked at, never created and never pushed over.
- **Branch protection.** `recade harness protect --apply` is asked for each repository. A code repository gets the strict rules (a pull request, the required checks, no force push). The workspace gets looser ones, because Recade commits documents straight to its default branch: no pull request and no required check, force push and deletion blocked, linear history.
- **Automatic push.** At the creation of the private workspace repository, the owner says yes or no once. A yes is recorded as `workspace.auto_push: true` with its date. After that Recade pushes the workspace after each step (end of phase, gate, slice `done`, `/board`, retro, decision closed). It pushes only the workspace and only its default branch, never a code repository. A push that fails (network, rights) never fails the command: one line on stderr, and the next push carries the missed commits. `recade workspace auto-push off` stops it, and with it off no push call is made at all. The push to `main` stays forbidden to agents in the code repositories.

### 10.7 CI of the workspace and of the code repositories

- **The workspace** runs the style check on the documents, the ID index and the slice check.
- **Each code repository** runs build, tests, lint, quarantine, the conflict check and, when the owner turns it on, the second opinion. The ID index job is not there: the documents are not.
- **The second opinion in CI needs the sheet, which is private.** The job clones the workspace with a read-only token and copies only the sheet of the slice into the checkout of the runner. The owner sets, in the settings of the code repository:
  - the variable `RECADE_SECOND_OPINION` to `on`, and the secret `ANTHROPIC_API_KEY`;
  - the secret `RECADE_WORKSPACE_TOKEN`: a fine-grained personal access token with Contents set to read-only, on the workspace repository only;
  - the variable `RECADE_WORKSPACE_REPOSITORY`: the `owner/name` of the workspace repository.

  Without the token and the variable the job prints a notice and ends in success, and the second opinion is run locally with `/second-opinion`. **The guarantee that the reviewer does not quote the sheet is a prompt rule, nothing more.** The job removes its clone and never prints the sheet, but the reviewer can read the sheet in the runner, and only its instructions keep it from repeating the text in a public pull request comment. When that is not acceptable, do not set the token and run the second opinion locally.

### 10.8 Another machine, a moved workspace

`recade repo sync`, run from the workspace, clones the repositories of the registry that are missing from `repos/`, writes `.recade/workspace` and `.recade/plugin-root` in each repository, and repairs the git worktrees of the slices of a moved workspace. A repository with no remote cannot be cloned: it is skipped with the reason. `/recade:resume` offers the sync when something is missing. A link is valid when the path it names is the workspace that holds the repository in `repos/` (for a worktree, the main repository of the worktree is used).

### 10.9 Deliverables and drafts

The builds, APK and exports of a slice go to `artifacts/<repo>/<S-nn>/`, and those of a version to `artifacts/<repo>/<version>/`. Drafts go to `tmp/`. The `release-manager` and the build instructions enforce it. `/board` removes the worktrees, the merged branches, `tmp/` and `artifacts/<repo>/<S-nn>/` at the end of a slice, and keeps the version folders. Nothing unmerged or unpushed is deleted without the owner's yes.

### 10.10 What stays unchanged

A doctrine file `team/<role>.md` has a header (role, `inspired_by`, model, effort, dated sources) and the sections: why this profile for this project, convictions with their sources, working rules, review checklist, what they refuse, how they settle a disagreement, and limits.

## 11. Quality of Recade itself

- The made-up project in `example/` is run end to end in each of the three entry modes in CI, under a parent folder whose name has a space and an accent. The two new modes create the code repositories `api` and `web`, and the adopt mode clones an existing repository; each run ends with a slice that touches two repositories going from `todo` to `done` with a fake pull request in each. The run checks the workspace tree and its `.gitignore`, that nothing is written outside the workspace, that the adopted original is untouched, and that the automatic push calls only the workspace repository. A change to the file format of any phase breaks that run, not a user. The run fails with the phase, the file and the first differing line.
- The render engine is tested on reference documents: the structure of the `.docx`, the tabs and formulas of the `.xlsx`, the pages of the `.pdf`, and the absence of the em dash.
- The agent test cases are listed in CI and can be replayed on demand.
- `npm run publish-check` fails on an em dash (also written as an entity), a raw e-mail address, a private name (only with a list: `--names <file>`, or `RECADE_PRIVATE_NAMES`; `--require-names` fails when there is none, and without a list the names are not checked), a file over 5 MB, a command advertised but not available, a missing licence, an e-mail in `plugin.json`, a version mismatch, a missing changelog section, and any private working file in the tree. `npm run publish-check -- --history` lists the commits that ever held one.
- Checks that no test can make are in [live-checklist.md](live-checklist.md) and are walked by hand before each release.
