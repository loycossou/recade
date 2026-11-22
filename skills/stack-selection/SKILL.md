---
name: stack-selection
description: How to choose, or to describe, the technology stack of a Recade project. Criteria with weights from the project, candidates per layer, dated research, spikes for the finalists, a weighted matrix, one multiple-choice question per layer. Load it before any stack decision work.
---

# Stack selection

The stack is a team decision, argued like an architecture decision and settled by the owner at gate G2-stack. It comes after D1 (we know what to build) and before D2 (which describes it). Use this with `writing-voice` for every text, and with `templates/STACK.md` for the shape of `docs/STACK.md`.

Declare three biases at the start and fight them in the text: fashion, the comfort of the writer, and the habit of a language model to propose the same stack for every project. Say what you did against each one.

## Mode adopt

When `recade/state.yaml` says `mode: adopt`, the stack exists. Describe it, do not choose it.

1. Read the repository: manifests, lock files, CI files, build and test scripts, Docker and infrastructure files. Run what is safe to run (version commands, the test suite, the linter) and record the real output.
2. Fill section 1 (the constraints that make the existing stack the one to keep), section 9 (selected stack, with the pinned versions, the licences and the support dates, each looked up), section 11 (conditions for re-examination) and section 12 (harness technical sheet). Fill section 10 with the options the code shows were left behind, when the history says so. Sections 2 to 7 are one line each: "Not applicable, adopt mode".
3. In section 8, one `ADR-nn` row for each layer, the Choice cell saying "Adopted as found, imposed by <source>", with the date. No spike, no matrix, no choice for the owner.
4. Say in the report what is old, unsupported, unpinned or unlicensed. Each of these is a finding, and a choice the owner must make is a DEC.

## The six steps, to choose a stack

### 1. Criteria from the project, not from habit

Derive the criteria from D1, the NFR and PAR, the brief and the intake. Each criterion cites its source (`NFR-*`, `PAR-*`, an intake constraint, a human fact) and gets a weight. The weights sum to 100. Cover these families:

- Non-functional needs: performance, volume, real time, offline, mobile.
- Constraints: hosting, regulation, budget, deadline, existing systems, the client's own stack.
- People: the skills of those who will maintain it, local hiring.
- Lifespan: maturity, long-term support, breaking changes, licence, community.
- Security: history of flaws, supply chain, the requirements of D3 when it exists.
- Fitness for development by agents: typing, conventions, fast tests, usable error messages. Measure it in step 4, never assume it.
- Total cost: licences, hosting, the people.

A criterion with no source is dropped or marked PROVISIONAL.

### 2. Candidates per layer

List the layers the project needs (for example front end, back end, data, hosting, queue, auth). For each layer with a real choice, rank a top 5 and write it as a sub-section `### 2.n Top 5 for <layer>` of `STACK.md` (one for each layer, in the order of the layer loop, so the section numbers 3 to 12 never move; in adopt mode there is none). Each row of the top 5 has: the rank, the option with its current version, why it is in this place for THIS project (two plain lines at most, tied to D1 and to the criteria of section 1), its main drawback, and whether it gets a spike. The dated sources are the rows of section 3, as for any candidate. The options must really differ, and at least one is outside the reflex choices. Write fewer than 5 only when fewer real options exist, and say why under the table. The top 2 or 3 are the finalists of the layer, and the table of section 2 lists them. A layer with one possible answer (imposed by the client, the law or the existing system) is stated with its source, and not dressed up as a choice. It gets no top 5, no spike and no DEC, and its ADR row in section 8 says "imposed by <source>". The same holds for a layer the owner imposed.

### 3. Research, dated

For every option of every top 5, the ranks 4 and 5 included: the current version, the support calendar, the licence, flaws of the last 12 months, and field reports at the scale of this project. Search the web and read the pages. Write the date you read each one. Nothing rests on the memory of the model alone: a version or a date without a source and an accessed date is not written.

### 4. Proof by spike

Take the top 2 or 3 of a layer, the finalists. Ranks 4 and 5 are researched and never spiked: a spike costs too much for options that are unlikely to win. The analyst writes one real task of this project, from D1, that touches the layers that matter (a form that writes to the data store, an import, a screen with a list and a filter), in `spikes/TASK-<layer>.md`. The task is chosen before any result exists, and its text is the same for every option, with the budget and the measures asked.

Each spike is run by a fresh `spike-runner` agent that knows nothing of the other options, so that no option gets help from the work done on another. The analyst never runs a spike, never fixes one and never helps one. The dispatcher runs the finalists of a layer one after the other, so that the build times are comparable.

- Each spike works in `spikes/<layer>-<option>/`, never in the product folders.
- Each spike has a short budget, written in the task before it starts (for example 30 minutes of work or 40 tool calls, whichever comes first). When the budget runs out, the runner stops and records where it was.
- The runner measures and reports: done without help (yes or no), fix loops (how many times a build, a test or the linter failed before it passed), build time and test time in seconds, readability (a one-line note), and every install command it ran.
- Its commands and raw numbers stay in `spikes/<layer>-<option>/RESULT.md` while the work runs. The analyst copies the results that matter into section 4 of `STACK.md`, as reported: the spikes folder is deleted after G2-stack.
- A spike that could not be run (no network, no licence, no tool) is recorded as not run, with the reason. Never write a measure nobody took.

A spike is a short real test of each finalist on the owner's machine, and it installs things there: Docker images, runtimes, package caches. So the dispatcher says that in one plain sentence before any spike. In the short track it then asks one closed question, no spikes (decide from the research, recommended) or run them; in the full track the spikes run after the same sentence. Before each spike it runs `recade spikes check --spike <layer>-<option>`: below 2048 MB of free memory or 5120 MB of free disk, the spike is skipped with a notice and recorded as not run, with the reason. Otherwise the check records the machine before the spike (the time, the Docker image IDs, which known caches exist) and prints the environment the runner sets, so that every cache lands in the spike folder. Each runner lists what it creates in `spikes/<layer>-<option>/MANIFEST.json` (containers, images, volumes, networks, processes, paths) and names its Docker objects `recade-spike-...`. When the spikes end, the dispatcher runs `recade spikes clean`, unasked. It removes only what a manifest lists and Recade can prove the spike created: a path whose real location is inside the spike folder, a link as a link, a Docker name with the prefix, an image whose ID is new since the record, a process whose pid and full command line match exactly and that started after the record, a known cache in the home folder that did not exist before. It never follows the runner's word alone outside the spike folder, keeps anything it cannot prove, and the owner reads what was removed and what was kept, with the reason.

### 5. Weighted matrix

Score each candidate from 1 to 5 on each criterion, with a one-line justification. Multiply by the weights and total. Then write the risks and the cost of leaving each option later. Then the recommendation of the architect, with its price. Then the written opinion of each contributor, disagreements included. There are two contributors, not a panel: the architect, and at most one other role, the one whose doctrine matters most for this stack (the dispatcher chooses it: the devops-lead for hosting-heavy stacks, the security-lead for regulated data or authentication, the ui-designer for a front-end-heavy product, the domain expert when the project has one and a layer is its domain). Each one gives an independent written opinion in `docs/reviews/STACK-<role>.md`, from its own doctrine, after it has read the draft and the spike results. The analyst copies each opinion into section 7 and puts every disagreement there, in the contributor's own words, never smoothed or shortened. The qa-lead has no agent: its view is read from `team/qa-lead.md` and marked "from doctrine, no independent review". A role whose doctrine file does not exist is recorded as "no doctrine available". Never write words in the name of the expert who inspires a role.

When the matrix and your recommendation disagree, say so and say why.

### 6. Decision

One multiple-choice question per layer that has a real choice and that the owner must settle, as a DEC (`recade decision new --doc 'STACK' ...`). The recommended option is first. A DEC holds 2 or 3 different options: the one the owner chose, the recommendation, and the next best of the top 5 that still fits. When the owner chose the recommendation, the options are the recommendation plus the next one or two of the top 5 that still fit. Never the same option twice. The full top 5 stays in section 2 of `STACK.md`. The question says what the owner gets, what it costs, and what would change the recommendation. The owner answers through the dispatcher. Each answer becomes an `ADR-nn` in section 8 of `STACK.md`.

After the owner's answers, write the sections 8 to 12 of `STACK.md`:

- 8: one `ADR-nn` row per layer, with the DEC it comes from cited in the Choice cell. A layer imposed by a source says "imposed by <source>" there.
- 9: the selected stack, with pinned versions, licences and support dates.
- 10: the options that lost, and why.
- 11: the conditions for re-examination. Facts that would reopen the decision (an end of support, a price change, a flaw, a measure that drifts). The retro reads them; a change goes through `/recade:amend`.
- 12: the harness technical sheet. Build, test, lint, format, local run, conventions, quality and security tools, useful skills. Every command exact, as it will be run from the repository root. Run each one once in a throwaway folder in `spikes/` (for example `spikes/harness-check/`), never in the repository root, and say which ones could not be run.

D2 section 12 mirrors the ADRs of section 8. The ids are defined once, in `STACK.md`.

## Short track

When `recade/state.yaml` says `track: short`, the six steps run lighter. Everything else holds: the criteria, the dated research, the fresh spike runners, the DEC for each owner layer, the gate.

- **Top 3, not top 5.** Each layer with a real choice gets a ranked top 3, as `### 2.n Top 3 for <layer>`. Read "top 5" as "top 3" in the rest of this skill. A DEC still holds 2 or 3 different options.
- **A first matrix from the research.** At the stage `draft`, score the top 3 of each layer in section 5 from the research of section 3, before any spike.
- **A spike only when it is close, and only if the owner wants it.** A layer can get a spike only when its two best totals are within 10 percent: the second total is at least 90 percent of the first. Its finalists are those two, with one task as in step 4. Any other layer has no spike and no task: section 4 says "no spike, short track: the leader is ahead by more than 10 percent", with the two totals. Even for a close layer the owner chooses: no spikes is the recommended answer, and then section 4 says "not run: the owner chose to decide from the research" and the layer counts as a layer with no spike. The stage `matrix` then updates section 5 for the layers that had a spike.
- **One opinion.** The architect alone gives the independent opinion on the stack.

## Owner preferences

The owner can prefer a framework for a language, in the user config: `stack.prefer`, a map such as `php: symfony`, read with `recade config get stack.prefer` and changed with `recade config set stack.prefer.<language> <framework>` (or `none`). The shipped default is `php: symfony`. The dispatcher gives the map to the analyst as data.

- A preference is a strong default, not an imposition. The layer still gets its top 5, its research and its question.
- When the preferred option fits the criteria of section 1 and the layers already chosen, it is rank 1 of its layer, its why cell says "follows the owner's preference", and it is the recommendation. It applies to the framework layer once the language is that one.
- Another option may stay in the ranking, but it is never the recommendation while the preferred one fits, even when the matrix scores it higher: say so, with both totals.
- When the preferred option does not fit (a hard constraint, a layer already chosen, a support date), say why in one line under the table, and rank on the criteria alone.
- Laravel is never the default PHP recommendation. It is recommended only when the owner names it, or changes the PHP preference to it.

## Ask the owner, layer by layer

The owner is not an engineer. The questions come in a fixed order and in plain words. Mode adopt asks no layer question: the stack exists.

- **Layers announced first.** The layers are announced before any analysis. List them: language, framework, database, data access, hosting, authentication, CI and test tools, plus any layer that D1 needs (payments, search, mobile, offline). The owner is asked once, in the chat, what is imposed or preferred for each. Each answer is written in section 1 of `STACK.md` as a constraint with source `owner`. A layer the owner imposed is not studied as a choice: it has no spike.
- **Owner or team.** In ask mode, language, framework, database, data access and hosting are the owner's. Any other layer that is reversible and that no later layer depends on (a test tool, a linter, a CI service) is decided by the team: the analyst picks it, records it with `recade decision team add --doc 'STACK'` and a one-line reason, and the owner reads it in the list of team decisions at the gate. The aim is 10 owner DECs at most for the whole documents phase, the layers included. In trust mode, "The stack in trust mode" of the `decision-sorting` skill replaces this point: a layer goes to the owner only when its finalists differ in money or in lock-in (its top 3 ranked options when it has no spike), and the team takes rank 1 of any other layer.
- **Questions in dependency order.** Language, framework, database, data access, hosting, then the rest. Each answer is given to the analyst before the next question, so the later layers are re-ranked: the top 5 of a layer is ranked again against the layers already chosen, an option that no longer fits drops out with the reason, and the next one comes in.
- **The top 5 is shown first.** Before the question, the owner reads the ranked top 5 of the layer in the chat: the rank, the option, why it is in this place, its main drawback, the recommended one first, and a plain word beside every term or ID. The question tool allows at most 4 options, so the options are ranks 1 to 4, and the question says that the 5th can be picked by typing its name in `Other`.
- **One plain line for each option.** The owner reads one plain line for each option: cost, skills to hire, hosting and lock-in. No jargon without a plain word beside it.
- **Other.** The owner may answer with an option that is not a finalist: the 5th of the top 5, or an option of their own. For an option of the top 5 (ranks 4 and 5 have no spike), the dated research is already in section 3, so the analyst does not research it again from scratch: it checks it against the layers already chosen, adds a spike when the layer had spikes, and weighs its risks against the recommendation. For an option that is not in the top 5, the analyst runs dated research on it, checks it against the layers already chosen, adds a spike when the layer had spikes (a fresh runner, the same task text as the finalists), and weighs its risks against the recommendation. The owner sees the gap in plain words and answers `Keep my choice` or `Take the recommendation`. When the owner keeps the choice, the ADR says "owner choice" and the recommendation is listed in section 10 as an option not taken.

## After the gate

`spikes/` is deleted after the owner passes G2-stack. Its results already live in `STACK.md`. The dispatcher does the deletion and commits, not you.

When the stack needs a specialist (a framework or a platform with its own habits that no core role covers), say so in the report with the name of the technology. The project lead may then add a role to the roster, and a doctrine is written for it.

## Checks before you report

- Every criterion has a source and a weight, and the weights sum to 100.
- Every layer with a real choice has a ranked top 5 (fewer only with the reason), with why and main drawback for each rank, and one option outside the reflex choices. A layer imposed by the owner or by a source has none.
- Only the top 2 or 3 of a layer have a spike. Ranks 4 and 5 are researched and dated.
- A preferred option that fits is rank 1 and the recommendation, and says it follows the owner's preference.
- A DEC holds 2 or 3 different options, and the full top 5 stays in section 2.
- Every version and date in the text has a source and an accessed date.
- Every spike has its budget, its measures and its commands, reported by its runner, or says it was not run.
- Section 7 holds every disagreement of the independent notes, in the contributors' words.
- Every layer has its DEC. No DEC is closed by you.
- `recade lint-style docs/STACK.md` and `recade index check` print no error.
