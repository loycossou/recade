# Changelog

This file is curated by hand for each release. At tag time, `recade release-notes <from>..<to> --version <v> --write` produces the raw list from the conventional commits, and this section is then edited from it.

## 1.4.1 (2026-11-23)

### The board and the slices with no code

- `recade board reconcile` (run by `/board`) no longer looks for a pull request for a `no-code` slice, which never has one. The board follows `slices/STATUS.md` for it: a done slice goes to `Done`, its stories with it, and its issue is closed like the one of a merged slice. Before, a done slice with no code was shown `In review`, or stayed where it was.

## 1.4.0 (2026-11-23)

### A slice with no code goes to the end

- `/slice` on a `no-code` slice that is not a decision does the work of its sheet, then goes through its Definition of Done line by line, and marks the slice `done` when every line is ticked. A line that needs another command of the harness (`/amend` on STACK, `/decision`, `/design`) is run from `/slice` after one question, by following that command's own file, instead of being left for another session. A line that only a person or a third party can close stays open, and `/slice` says who closes it. Install the harness again to get it.

### The workspace is pushed at the end of each turn

- With auto-push on, the Stop hook of the plugin runs the new `recade workspace push` at the end of each turn of a session. It pushes the commits a step left behind (a tick, a status move in the middle of a slice): before, they waited for the next end of phase, so a paused slice kept them on one machine. A failed push is shown once and tried again at the next turn. Outside a workspace with auto-push on, the hook does nothing. Only the main session and the hook run `recade workspace push`, never an agent.

## 1.3.0 (2026-11-23)

### A code repository with no code yet

- The CI of a code repository starts with a job `Code present`. While the repository holds only the harness files (`.claude/`, `.githooks/`, `.github/`, `CLAUDE.md`, the README, the licence, `.gitignore`), the lint, build, test, end to end, security and quarantine jobs are skipped, and the run summary says why. GitHub counts a skipped job as passing, so a new repository is no longer red until its first slice. The style job always runs. Install the harness again to get it.

### The plugin in a cloud session

- A cloud session does not add the marketplace a repository lists, so its guard found no Recade plugin and refused every write. The harness now adds a `SessionStart` hook: in a cloud session only (`CLAUDE_CODE_REMOTE=true`), when no Recade plugin is found, it installs the public plugin with `claude plugin`, and the guard finds it at the next tool call. On a machine of the team it does nothing. When the install fails, the session is told why, and the refusal of the guard says how to install the plugin in the setup script of the cloud environment. Install the harness again to get it.
- `recade harness install` merges every hook event of the harness settings the way it merged the guard: the hook of the harness first, the project's own hooks kept after it.

### Names of the deliverables

- A short word after the first word of a title (`de`, `du`, `of`, `the`, `und`, `do`) stays in lower case in the file name: `D3_Exigences-de-Securite.docx`, not `D3_Exigences-De-Securite.docx`. A file of the old spelling is replaced by the new one at the next render, also on a disk that ignores case, and is never reported as left behind.

## 1.2.2 (2026-11-23)

### The agents of the plugin in a slice session

- An agent of the plugin itself writes the workspace by its Writes lines in a session that runs a slice too. Its lines are workspace lines: these agents never write code. Before, in a session tied to a slice by `/slice`, the guard counted only the `workspace:` lines, and the spike runner could write nothing.
- A command that reads `.recade/plugin-root` and writes a file in the same command is still refused, now with its own reason and the way out (read the plugin folder in a command of its own first). It used to say that the stamps, the hooks and the settings are not changed through the shell, which was not the case.

## 1.2.1 (2026-11-23)

### The agents of the plugin under the guard

- The guard reads the Writes of an agent of the plugin itself (`recade:spike-runner`, `recade:stack-analyst`, the writers of the documents) in `agents/` of the plugin. Before, it looked only in the project and in `harness/agents/`, so once the harness was installed these agents had no Writes and could write nothing in the workspace: a spike could not run, an amend could not rewrite a document.
- A placeholder of a Writes line other than `<S-nn>`, `<touches>` and `<conflicted-files>` (`spikes/<layer>-<option>/**`, `docs/D1.<lang>.md`) stands for one part of a name, `*`. It used to match nothing.
- A clone of a workspace with no `.recade/plugin-root` (a cloud session, a fresh clone) finds the Recade plugin that Claude Code installed on that machine, from its record of installed plugins, and the guard runs. With no plugin installed, write tools and Bash stay refused, as before.

## 1.2.0 (2026-11-23)

### A deck for the steering committee

- A PowerPoint deck that sums up the project for a steering committee, `DECK_<Title>.pptx` in `docs/deliverables/`, named in the documents language. It is never made without asking: the user config key `deliverables.deck` is `ask` by default, `/recade:start` asks it right after the extra files (`No` recommended), and `/recade:docs` asks it once before `recade render extras` when it is still `ask`. `recade config set deliverables.deck yes` (or `no`) changes it.
- `recade render extras` writes it on `yes`: a title, then the project (context and goal, key figures, scope), the technical side (architecture with the first figure of D2, security essentials) and the delivery (the lots as a timeline, the decisions, the open provisional values, the next gate and the milestones ahead), each part opened by a divider. A missing source drops its slide with a `Warning:` line.
- The slides are full of colour: full-bleed title and dividers with vector motifs, a coloured band on every other slide, cards and big numbers. The look and feel slide shows the board of the chosen art direction, and the figure of D2 gets a slide of its own. The project is named as its documents write it, accents included.
- It is in the colours of the logo when the project has one, else of the art direction tokens, else of the render theme, with the logo on every slide, text contrast checked against WCAG AA, and Inter Tight everywhere. One new dependency, `pptxgenjs` (MIT).

### Dependencies checked at setup

- `recade version`, the probe of `/recade:setup` and of the first step of each command, now fails with `ERR_MODULE_NOT_FOUND` when a dependency of the plugin is missing, so the setup runs `npm ci` after an update that adds one (here `pptxgenjs`).

## 1.1.1 (2026-11-23)

### A private Recade

- The CI workflows fetch the Recade tools over SSH with a read-only deploy key when the secret `RECADE_DEPLOY_KEY` is set, with the host key GitHub publishes pinned, and over HTTPS otherwise. A project on another account can now run its checks while Recade is private. The README says how to set the key.

## 1.1.0 (2026-11-23)

### One entry point: every session starts at the root of the workspace

- Every command and every agent is installed at the root of the workspace, and `/slice <S-nn>` is typed there. Before, the slice commands and the agents were in each code repository, `/slice` had to start in the worktree of the first repository of `touches:` with the others added by `/add-dir`, and a session opened in the workspace did not have `/slice`. The owner never knows in advance which repositories a slice touches, so there is now one place to work from.
- The worktree of a slice is `worktrees/<repo>/<S-nn>` of the workspace, a git worktree of `repos/<repo>`, and `worktrees/` is in the `.gitignore` of the workspace. `recade slices open <S-nn>` reads `touches:` and opens the worktree of each repository it names, on the branch of the sheet; it keeps one that is there and attaches a branch that exists. `/slice` runs it: the owner never chooses a folder. A `no-code` slice opens none. `/parallel` runs it for each slice it opens, with `--no-session`.
- A code repository keeps what belongs to the code: its git hooks, its CI, `.claude/recade.yaml`, the guard, and one pointer command, `/slice`, that tells a session opened there to work from the workspace. No agent and no protocol.
- The guard judges a session at the root of the workspace. `recade slices open`, run by the main session, ties the session to its slice once every worktree is open (`.recade/sessions/<session id>`, with the session ID of its shell, which no tool writes and no command sets). A slice that fails to open, or a command run from outside the workspace it opens, ties nothing. `/review` and `/design` add their slice with `--keep-session`, so a session in the middle of `/slice` keeps its own. An agent of that session writes only the worktrees of its slices, within their `touches:` (`api:src/**` is `worktrees/api/<S-nn>/src/**`), and the workspace paths of its `## Writes`. The main checkouts under `repos/`, the worktree of another slice, a repository the slice does not touch, and every worktree of a session that runs no slice are refused. The merge-keeper writes the conflicted files of the merge worktree of its slice, `worktrees/<repo>/merge-<S-nn>`, which `/merge-order` ties with `--tie-only`: a merge worktree of another slice is refused. The shell is held the same way, and a relative path is read from the folder the shell runs in. Only the main session runs `recade slices open`.
- On the local forge no branch protection stands behind the guard, so it refuses to every agent any command that writes the default branch (`update-ref`, a `fetch` or `push` refspec into it, `branch -f`, `-M` or `-D`, `reset`, `commit` or `checkout -B` on it, `symbolic-ref HEAD`) or the branch of another slice. A removal is judged like a write: `rm`, `rmdir`, the source of `mv`, `find -delete`, `git clean`, `git rm` and `git worktree remove` hold only inside the touches and the Writes of the agent, so a `git clean` of a whole checkout is refused.
- `recade harness migrate [--dry-run]` moves a project of the old layout: it installs the harness at the root of the workspace, moves each slice worktree with `git worktree move` (a worktree with uncommitted changes stays, named) with its ledger, which goes to `.recade/slices/<S-nn>/progress.md` of the workspace unless one is there already, and removes the old copies from the code repositories only where they are Recade's, of this version or an earlier one (`harness/history.json` holds the fingerprint of every version of the templates, from `node tools/harness-history.js`). Text of the team below the line is carried to the copy of the workspace first. A file the team changed above the line stays and is reported, and so does a protocol whose text the workspace copy does not hold word for word. A worktree whose name is not a slice ID (a worktree of Claude Code, a rebase worktree) stays where it is, named. A second run finds nothing to do. `recade repo check` reports `old layout`, `/recade:harness` offers the migration, and the install writes a per-machine record of what it wrote, `.recade/installed.json`.
- `recade board cleanup` removes the worktrees under `worktrees/<repo>/`, `recade repo sync` repairs them after a move, `recade harness verify` checks that `worktrees/` is ignored, and `/second-opinion` passes the remote of the repository to every `gh` call.

### The version number moves

- This release is 1.1.0. Claude Code keeps its own copy of a plugin and refreshes it only when the version number changes, so every change since 1.0.0 stayed out of that copy until now. Run `claude plugin update recade@recade`, then start a new session.

### Inter Tight everywhere

- Every deliverable is set in Inter Tight, with Arial when it is missing: the Word and Excel files, the figures, and now the HTML dossiers too, body included (the font travels inside each dossier). The art direction no longer writes a font in `design/theme.json`; another document font comes only from the owner's request.
- The dossiers no longer use a monospace face for the fact chips, the stat labels, the recap numbers, the IDs, the navigation and the file links: they are in Inter Tight too, with tabular figures where numbers line up. Monospace stays for code only.

### Documents that read like a dossier

- Each document now also renders as a self-contained HTML dossier in `docs/deliverables/`, named like the Word file (`D1_Functional-Specifications.html`), with an index page (`INDEX_The-Project-Documents.html`, in the language of the documents) that links every dossier and its Word, Excel and PDF files. A dossier has a kicker, the title, a one-sentence lede and fact chips, "The recap in N sentences", numbered sections where a hard idea comes first as an everyday image and then as the real thing, stat tiles and before and after rows, a top navigation, and a light and a dark theme in the colours of `design/theme.json`. Fonts and figures are embedded and a Content-Security-Policy forbids any network fetch. `recade render --format html` writes only the dossier: `/recade:bible` uses it for the BIBLE.
- The summary layer comes from a short companion that the author of each document writes next to it, `docs/D1.story.yaml` (stage `story` of the `project-lead`, the `architect`, the `security-lead` and the `bible-writer`, on the mechanical model, under 400 words). It is optional: without it the dossier renders from the Markdown with a plainer header. The render lints it like a document and warns on a broken file, an unknown key, a section it cannot place or a size over its limit.
- The Word cover now starts with the kicker, the title, the lede and the facts, with the metadata table after them. The recap grid and the decisions that matter come before the contents, and each image is a tinted box under its heading.
- The writing voice asks for documents that read warmly and stay precise: a sentence before each table that says what it holds and why, the reason of a rule when it fits in a sentence, and an everyday image before a hard idea. An exact comparison is not a joke, so D3 may use one. The rules on IDs, requirements and budgets are unchanged.
- The fictional example has a companion for D1, so the end-to-end run checks the dossier, its recap and the index; every mode checks the dossiers of the PLAN and the BIBLE.

### GitHub or local

- A project setting `forge: github|local` in `recade/state.yaml`. A state without the key reads as `github`, so an existing project does not change. `/recade:slices` asks it once, as a closed choice, before anything touches GitHub: `Local only` (git on this machine, nothing leaves it, the board is `slices/STATUS.md`) or `GitHub`. `recade state set forge github` moves a project to GitHub later, and `recade github init` then works as before. `recade state show` and `/recade:status` print it, and `--json` adds `forge` and `forge_asked`.
- On the local forge `/recade:slices` commits the sheets, the graph and `STATUS.md` and asks G4 with no `gh` call. Before, a project that did not want GitHub stopped at G4.
- On the local forge no command calls `gh`. `recade github init`, `recade harness protect` and `recade adopt board` refuse before their first call. `recade board reconcile`, `recade board cleanup`, `recade merge-order` and `recade retro` read git instead: a slice branch is merged when a merge commit of the default branch has its tip as a parent.
- A slice ends with a local review request: the `release-manager` writes the body it would have put in the pull request into `slices/reviews/<S-nn>.md` of the workspace. The second opinion runs with `/second-opinion <S-nn>` on the diff of the branch and writes its verdict there.
- `recade slices merge <S-nn> [--dry-run]` is the owner's merge on the local forge: the dry run prints `git -C '<repo>' merge --no-ff <branch>` for each repository in the merge order, and the real run refuses a slice that is not `ready-to-merge`, an unticked Definition of Done, a missing review request, or a checkout that is dirty or on another branch, and aborts a conflict. `/board` and `/merge-order` run it only after the owner's yes. The guard refuses it to every agent, and now also refuses `git -C <folder> merge` when that folder is on `main`, for everyone.
- `/recade:harness` installs and verifies the harness with no remote, and skips what needs GitHub: branch protection, the conflicts and second-opinion workflows with their secrets, and `dependabot.yml`. The install says so in one line.
- `npm run e2e` has a fourth mode, `local`: the scratch project on the local forge, from the first question to a slice merged with `--no-ff` in both code repositories and marked `done`, and the fake `gh` is never called.

### Epics on the GitHub board, kept in step with the documents

- `recade github init` makes one epic issue for each lot of the PLAN, with the label `epic`: its title is the lot code and its name, its body the goal of the lot, its stories and its slices. Each story and each slice issue is a sub-issue of the epic of its lot. A slice that serves several lots sits under the lot of its first story and names the others in its body. The board gains an `Epic` text field, so a view can be grouped by lot.
- A story issue carries what the PLAN says of it: the item, the user story and the acceptance criteria of its `### Story <ID>` block, the estimate, the priority, the increment, the sprint and its dependencies. `Points`, `Priority` and `Increment` on the board follow the PLAN. The PLAN template gains a `## Lots` table (code, name, goal) and an optional story block.
- `recade github sync [--dry-run]` brings an existing board in line with the PLAN, the slices and the state: an epic for a new lot, a new title or body for a renamed lot, a changed goal or a changed story, a story or slice moved to the epic of its new lot, and the epic of a removed lot closed with a comment, never deleted. It finds its epics and stories by a marker in the body, so it never duplicates one, and it never edits an issue Recade did not write. It does nothing when `forge` is not `github`. `/recade:amend` and a new cut in `/recade:slices` offer it, after a yes.
- `/board` closes the epic of a lot when every slice that serves it is done, and reopens it when one is not done any more.

### How Recade talks to you

- The cost line is shown. Each phase command (`/recade:new`, `/recade:team`, `/recade:docs`, `/recade:bible`, `/recade:slices`, `/recade:harness`) puts the line of `recade cost estimate` in its first message to you, in your chat language, before any question or dispatch. A line left in the tool output was never seen.
- Durations. `recade cost estimate` gives a range of hours next to the dollars ("about $16 to $100 and 4 to 8.5 hours"), for each phase and for the total, and `--phase` adds `Usual time of each step:`. The figures scale from a measured short-track framing (the stack step took 1 hour 54 with 3 spikes) with the runs of your project and the track. The progress line of each step of `/recade:team`, `/recade:docs`, `/recade:bible` and `/recade:slices` says how long the step usually takes, and the stack step says how many spikes and layers are left.
- Every question is a closed choice: `AskUserQuestion` with 2 to 4 options, the recommended one first with its reason, or lettered options in the chat when the tool is not there. An open question only for a name, a path, a date or your own words. The intake questionnaire offers likely answers for each question, and the intake analyst writes each blocking gap with its options.
- You choose the model of the second opinion: `/recade:start` asks it after the writing model. `models.second_opinion` is `opus` (the default, as before) or `fable`: Fable 5.2, another family than the reviewer, a more independent view at about twice the price. `recade harness install` and `recade harness models --dir .claude/agents` apply it to the project copy, `recade harness verify` reads it from there, and `recade cost estimate --slice` prices it.
- Once installed, the project copy holds the second-opinion choice. `recade harness models --dir` reads it from the copy, to check or to re-apply, so another machine with another `models.second_opinion` no longer blocks `/second-opinion`. A later install and `recade cost estimate --slice` read it from the copy too. `recade harness models --dir .claude/agents --second-opinion opus|fable` changes it for the project, and a drift message names that command and `recade harness models --dir <dir>`.
- Design reference servers. `/recade:start`, and the art direction when none is connected, say what Mobbin, Refero and Nicelydone bring and that each needs your own paid account, then offer `Connect one now`, `Show me how` or `Go on without`. After your yes, Recade runs `claude mcp add --transport http --scope user <name> <url>` and you sign in with `/mcp`. No key is written in a file.

### Deliverables named in their language, and no PDF by default

- Every file of `docs/deliverables/` is named `<ID>_<Title>`, the title taken from the document in its own language, with no accent and no space: `D1_Functional-Specifications.docx`, and `D1_Specifications-Fonctionnelles.docx` for `docs/D1.fr.md`. The PLAN gives `PLAN_Delivery-Plan.docx` and `.xlsx`. The extras follow: `STACK_<Title>.docx` and `.xlsx` (was `STACK-matrix.xlsx`), `DECISIONS_<Title>`, `REVIEWS_<Title>`, `DESIGN_<Board>.pdf` (was `design-<board>.pdf`), and `DESIGN_<Title>.docx` from `design/references.md` (was `design-references.pdf`). The registers take their title in the deliverable language.
- No PDF by default: Word and Excel are what stakeholders open. `recade config set deliverables.pdf true` adds a PDF next to each Word file, and `--format pdf` still works. The design boards stay PDF.
- Upgrading: an existing project keeps working. The next render writes the new names. Files of an older render (`D1.docx`, `D1.pdf`, `STACK-matrix.xlsx`, and a PDF no longer asked for) are left as they were, since the owner may have put a file of that name there: the render lists each once with `Left as it was:`, and `/recade:docs`, `/recade:bible` and `/recade:amend` tell the owner they can go.
- A document whose title changed no longer leaves two cards in the index. `docs/deliverables/.recade-rendered.json` records what Recade rendered for each source, the files of the old title are named with `Left as it was:`, and the index lists the current documents only. A file Recade cannot prove it wrote is never named.

### A lighter short track, and stack preferences

- The short track cuts the first increment only: the walking skeleton S-01 plus at most 5 slices, 6 sheets in all (S-00 aside). The slicer writes the rest of the PLAN as `slices/BACKLOG.md`, one row for each later slice with its gist and its stories. A backlog row covers its stories for the story check. `recade slices check` warns (`slice-cap`) above 6 open sheets, and `recade slices status` counts the backlog rows in `slices/STATUS.md`. Once G4 is passed, `/recade:slices` offers to cut the next increment from the backlog (the slicer stage `next`), and G4 stays passed. The full track is unchanged.
- A spike is now explained before it runs: one plain sentence on what it is and what it would install. In the short track the owner then chooses, no spikes and a decision from the research (recommended) or run them; in the full track they run as before. A layer whose spikes did not run counts as a layer with no spike, also in trust mode.
- `recade spikes check` reads the free memory and disk before each spike, and below 2048 MB of memory or 5120 MB of disk the spike is skipped with a notice. Each spike runner lists what it creates in `spikes/<layer>-<option>/MANIFEST.json` (containers, images, volumes, networks, processes, paths) and names its Docker objects `recade-spike-...`. `recade spikes clean` removes exactly what the manifests list, unasked, when the spikes end and again before `spikes/` is deleted, and reports what it removed and what it kept and why.
- The spike cleanup proves each item before it removes it. `recade spikes check --spike <layer>-<option>` records the machine before the spike (the time, the Docker image IDs, the known caches) and prints the environment that keeps every cache in the spike folder. A path is removed only when its real location is inside the spike folder, and a link is removed as a link. Outside the spike folder, only a known cache of the home folder that did not exist before is removed: a manifest that lists another folder, such as a sibling project, no longer removes it. An image goes only with the `recade-spike-` prefix or a new ID, and a process only when its pid and full command line match exactly and it started after the record.
- Owner stack preferences: the user config key `stack.prefer`, a map of a language to a framework, `php: symfony` by default (`recade config set stack.prefer.<language> <framework>`, `recade config set stack.prefer none`). The stack analyst ranks a preferred option first when it fits and says so, and another option is never the recommendation while the preferred one fits. Laravel is never the default PHP recommendation.
- The cost estimate of the short track counts no spike, and 4 to 6 sheets plus the backlog for the slicer.
- The time of the stack step no longer carries the 3 spikes of the trial when none runs: the research and the spikes are timed apart, 4 to 5 minutes for each spike plus a setup. `/recade:docs` records the owner's spike choice with `recade state set spikes run|none`, and the estimate follows it in time and cost.
- The estimate counts the companions of the dossiers (four `story` runs in the documents phase, one in the BIBLE phase, on the mechanical model), and `recade cost estimate --phase next` prices the next increment of the short track alone. `/recade:slices` shows that line, not the whole phase, before it cuts the next increment, and names the writing model for the stage `next`.

### A short track, and the time to the first slice

- A project has a track: `track: full` (the default, and what an existing state means) or `track: short`. `/recade:new` asks it at intake as a closed choice: short for a first version, a small team or an internal tool, full when money, health data, regulation or several teams are involved. `recade state set track short` changes it, and `/recade:status` and `recade state show` print it.
- The short track halves the word budgets (a `budgets:` key still wins), sends a document back to its author only for a blocker, offers two art directions, keeps a top 3 per stack layer with a spike only when the two best are within 10 percent in the weighted matrix, keeps the BIBLE to its core rules and the team to its core roles (plus a role for payments, health data or regulated data), and makes S-01 a walking skeleton. `recade slices check` warns (`slice-skeleton`) in the short track when S-01 has no `skeleton: true`. Every gate, guard and file scope stays.
- Time to first slice: `recade new` records `started:` in the state, and the first slice that becomes `done` records `first_slice_done:`, once. An uncommitted change in `recade/state.yaml` never blocks that move: the day is then left, with one notice line, for a later move to `done`. `/recade:status`, `recade state show` and the retro print "Started on X. First slice delivered on Y, N days later." or "N days since the start, no slice delivered yet." A state without `started:` counts from the day its first gate passed.

### What a phase will cost

- `recade cost estimate` prints, for each phase not passed yet, a range in dollars and the number of agent runs, then the total. `--phase intake|team|docs|bible|slices|harness` gives one phase, `--slice standard|sensitive` the delivery of one slice with the models of `harness/models.yaml`, and `--json` the runs of each kind with their model. It is an estimate at API prices, never a measure; on a Claude subscription the work counts against the usage limits instead.
- The prices live in `src/pricing.js` (prices of 2026-11-03, Anthropic API, per million tokens: input, output, cache write and cache read) for Opus 5.5, Sonnet 5.5, Haiku 5.5 and Fable 5.2, and the aliases `opus`, `sonnet`, `haiku` and `fable`. Every assumption of the estimate is a named constant of `src/estimate.js`. The short track is estimated with its own runs: spikes from none to the full number, one stack opinion, a revise only for a blocker, two art directions, the core team.
- `/recade:new`, `/recade:team`, `/recade:docs`, `/recade:bible`, `/recade:slices` and `/recade:harness` show the estimate in one line when the phase starts, and say nothing when it fails.
- The mechanical stages run on Sonnet at medium effort instead of the writing model: a translation, the glossary, the owner's decisions applied to D1, D2, D3, the PLAN or the BIBLE, and a fix for a style, index or render finding. `recade models mechanical [--effort]` prints the model and the effort. Drafting, contributing, reviewing and revising after a review stay on the writing model.

### Trust the team

- A project setting `decisions: ask|trust` in `recade/state.yaml`. `ask` is the default, and a project without the key stays `ask`. `/recade:new` asks it during the intake, `recade state set decisions trust` changes it, and `recade state show` and `/recade:status` show it.
- In trust mode, `/recade:docs` and `/recade:bible` sort each open DEC before they ask it. It goes to the owner when it costs money, binds the client or cannot be undone cheaply. Otherwise the team takes the recommended option and records it as a team decision. The rule lives in one place, the new skill `decision-sorting`.
- `recade decision close <DEC-nn> --choice <letter> --by team --why <reason>` closes a DEC by the team: it adds a `TD-nn` line to `decisions/TEAM.md` and writes `By: team (TD-nn)` and the reason in the Decision box. `recade decision list` shows it, and its `--json` gains `by` and `td`. Older boxes read as the owner's.
- `recade decision team challenge <TD-nn> --reopen` reopens a DEC that the team closed: a new DEC, a copy with its box open, supersedes it and goes to the owner. `recade decision list` shows `supersedes DEC-nn` on the new DEC, and its `--json` gains `supersedes`, so the author drops the choice of the DEC it replaces.
- In trust mode a stack layer is asked only when its finalists differ in money or in lock-in (a layer with no spike compares its top 3 ranked options). The team takes rank 1 of any other layer. The owner still passes G2-stack.
- In trust mode the gate summary is short: what the team decided, one line each, what the owner must answer, and the details on request. Every gate stays.

### One source for shared rules

- The rules that many commands and agents repeat now have one source each, in `tools/shared/`, and `npm run sync-shared` copies them into place. The defaults the documents state are checked against the code.

### One command to publish

- `tools/release.sh <release-dir> -m "<message>" [--push]` publishes main to the release repository and stops at the first check that fails. It refuses a release repository with changes nobody committed, deletes there what main deleted, compares the two trees, and pushes only when the tests, the names check and publish-check on the history all pass. The private name list comes from `RECADE_PRIVATE_NAMES` or from a file in the user's config folder, never from the repository.

### Opus 5.5 instead of Fable

- The writing agents run on the latest Opus by default (`models.writer: opus`). Fable stays a choice: `/recade:start` offers Opus first, and `recade config set models.writer fable` switches.
- No agent runs on Fable by default any more: the second opinion of the harness runs on `claude-opus-5-5` in both lanes, and the fallback of the writer agents (`agents/models.json`) is `claude-opus-5-5`.
- `harness/models.yaml` takes `second_opinion.same_family` (`error`, the default, or `warn`). With `warn`, a second opinion in the reviewer's family is reported as a warning by `recade harness models` and `recade harness verify` instead of being refused.

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
- The second opinion of the harness does not follow this choice: it runs on Opus 5.5 (see "Opus 5.5 instead of Fable" above).

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
