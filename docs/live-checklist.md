# Live checklist

These checks cannot be made by a test. They need a real Claude Code session, a real machine or a real GitHub account. Walk them with the owner before each release. Record the date, the result and the Recade version next to each one. A check that fails is fixed through a normal change and review, then run again.

Nothing here pushes, creates a repository or calls GitHub without the owner saying yes first. Checks 9, 10, 11 and 13 touch GitHub.

Setup for all checks: a clean checkout of Recade at the commit to release, `npm ci` done, and a scratch folder outside the checkout. Use made-up names only. A project is a workspace (`<name>-workspace`, a git repository) with its code repositories under `repos/`: in the checks below, "the project" is the workspace, and a check that needs the harness of a code repository says so.

## 1. Install from a local marketplace

Steps:
1. In a scratch folder, start Claude Code: `claude`.
2. Run `/plugin marketplace add <path of the Recade checkout>`.
3. Run `/plugin install recade@recade`.
4. Restart the session, then run `/recade:start`.

Expected:
- The marketplace lists exactly one plugin, `recade`, at the version in `.claude-plugin/plugin.json`.
- The install ends without an error.
- `/recade:start` prints the two-sentence introduction, shows the machine check as a table, asks the language question, and ends with the command map and a next step that fits the folder.
- A second run of `/recade:start` skips the preferences.
- A new session prints the one-line reminder only while `/recade:start` has not run.

Result: ______ (date, version, who)

## 2. `${CLAUDE_PLUGIN_ROOT}` is filled in commands

Steps:
1. Run `/recade:help`.
2. Run `/recade:setup`.
3. Watch the command that Claude runs in each case.

Expected:
- The commands run `node "<an absolute path>/bin/recade.js" ...`. No literal `${CLAUDE_PLUGIN_ROOT}` is left in what runs.
- `/recade:help` shows the command map as text: the plugin commands, the commands the harness installs, and the terminal commands.
- `/recade:setup` shows one line for each check with `ok`, `warn` or `missing`.

Result: ______

## 3. The guard blocks a push to `main` and a write outside an agent's paths, from the root of the workspace

Setup: a scratch workspace with two code repositories under `repos/`, `api` and `web`, and the harness installed (`/recade:harness`). Two sheets: `S-01` with `touches: [api:src/**]` and `S-02` with `touches: [api:src/**]`, both `todo`. Start the session at the root of the workspace.

Steps:
1. Type `/slice S-01`. Stop it after Step 1, once `recade slices open` has run.
2. Ask Claude to run `git push origin main`, then `git -C worktrees/api/S-01 push origin main`.
3. Ask the `implementer` agent to write `worktrees/api/S-01/src/hello.js`, then `repos/api/src/hello.js`, then `worktrees/web/S-01/src/hello.js`.
4. Run `recade slices open S-02 --no-session` from a terminal. Ask the `implementer` agent to write `worktrees/api/S-02/src/hello.js`.
5. Ask the `test-runner` agent to write `worktrees/api/S-01/src/hello.js`, and the `reviewer` agent to run `git -C worktrees/api/S-01 commit --no-verify -m x`.
6. In a code repository, open a second session by hand and type `/slice S-01`.

Expected:
- Step 1: the worktree `worktrees/api/S-01` exists on the branch of the sheet, `git status` of the workspace does not show it, and `.recade/sessions/` of the workspace holds one file that says `S-01`. No folder was asked for.
- Step 2: the PreToolUse hook refuses both commands before they run, with a message that names the rule. Nothing is pushed.
- Step 3: the first write is allowed. The second is refused as the main checkout, the third as a repository the slice does not touch.
- Step 4: the write is refused: it is the worktree of another slice.
- Step 5: both are refused, and each message names the agent and the rule.
- Step 6: the pointer command answers: it names the workspace and says to type `/slice S-01` there. No agent runs, no file is written.
- `git log` and `git status` show that nothing else changed.

Result: ______

## 4. The guard fails closed when the plugin root is stale

Steps:
1. In the code repository, edit `.recade/plugin-root` so it points to a folder that does not exist. This file is yours and is ignored by git. Make sure no copy of the plugin sits in the project, in the folders above it or in the main checkout.
2. In a new session, ask Claude to write any file with the Write tool, then to run any Bash command.
3. Ask Claude to run `node "<path of the Recade checkout>/bin/recade.js" harness install --target code --repo <name> --project "<the workspace>"`.
4. Put the right path back in `.recade/plugin-root` and ask for a write again.

Expected:
- Step 2: the guard cannot be found or cannot run, so the write and the Bash command are refused. The message says so. Nothing goes through.
- Step 3: this one command is allowed, because it is the repair. It rewrites `.recade/plugin-root`.
- Step 4: the write goes through where the agent's paths allow it.

Result: ______

## 5. `recade cases --run` on two agents

Steps:
1. Run `recade cases --plugin` and `recade cases --harness` to list the cases. Count two for each agent.
2. Run `recade cases --run --agent intake-analyst` and `recade cases --run --agent reviewer`, outside CI.
3. Run `CI=true recade cases --run`.

Expected:
- Step 1: every agent has at least two cases, one that must succeed and one that must be refused or report gaps.
- Step 2: each case prints its verdict and either passes or fails with the text it did not find. The intake analyst lists provisional values and does not invent facts. The reviewer gives `FIX` for a weakened test.
- Step 3: the command refuses to run and says why.

Result: ______

## 6. `/recade:new` from scratch on the example, to G1

Steps:
1. In an empty scratch folder, run `/recade:new fernhill-lending` and give that folder as the parent of the workspace. Use a parent folder whose name has a space and an accent.
2. Answer the questionnaire with the recorded answers in `example/scratch/answers.yaml`.
3. Pass G0 when asked.
4. Run `/recade:team`, pick a project lead, approve the roster, and pass G1.
5. Run `/recade:status`.

Expected:
- The workspace `fernhill-lending-workspace` is a git repository with one commit. It holds `recade/state.yaml`, `intake/brief.md`, `intake/questionnaire.md` and `intake/provisionals.md`, and its `.gitignore` lists `repos/`, `artifacts/`, `tmp/` and `.recade/`.
- Missing facts are logged as provisional values and are marked `PROVISIONAL`. Blocking gaps are asked, not invented.
- `recade state show` lists G0 and G1 as passed and says the next action is `/recade:docs`.
- `recade lint-style .` in the project exits 0.
- No gate was passed without a question to you.

Result: ______

## 7. The token reader on a real slice session

Setup: a scratch workspace with a code repository that has the harness, and one slice that you run with `/slice`.

Steps:
1. Run the slice up to the pull request, in a session started at the root of the workspace. Note the start time.
2. Run `recade cost record S-01 --minutes <n> --fix-loops <n> --transcript auto --session-dir <the workspace folder>`: the session started there.
3. Run it a second time right after, with the same arguments.
4. Run `recade retro INC-1`.

Expected:
- Step 2: the record prints a line such as `Recorded S-01: 12 min, 1 FIX loop, 48210 tokens (3 agents).` The token figure is a real count for the window, subagents included.
- Step 3: the second record holds only the tokens since the first one. The two add up and nothing is counted twice.
- If more than one session file was written in the window, or none, the line says `tokens: not recorded` with the reason, lists the candidates, and does not pick one. The minutes and the FIX loops are recorded anyway.
- Step 4: the retro lists the cost of each slice and the totals match the records.

Result: ______

## 8. `recade intake scan` on a real `docx`

Setup: a real Word file written in Word or LibreOffice, with a table and a comment, in `intake/attachments/` of a scratch project. Make a second copy of it with a zero-width space inserted in one paragraph.

Steps:
1. Run `recade intake scan` with the clean copy only.
2. Add the second copy and run it again.
3. Add a PDF and a PNG and run it again.

Expected:
- Step 1: no BLOCKING finding.
- Step 2: a finding that names the file, the part inside the archive, the line, the column and the code point, and the exit code is 1.
- Step 3: the PDF and the image are listed as not scanned, with exit code 1. `/recade:new` asks you whether to fix or to accept them, and does not accept for you.

Result: ______

## 9. The GitHub board calls on a throwaway repository

This is the only check that touches GitHub. Ask the owner for a yes before each part. Use a private repository created for the check and delete it afterwards.

Steps:
1. Sign in with `gh auth status`. The `project` scope must be present (`gh auth refresh -s project`).
2. In a scratch workspace at G3, run `/recade:slices` up to the GitHub step. Run `recade github init --dry-run` and read the plan.
3. With the owner's yes, run `recade github init`. Answer yes to the private workspace repository and no to the automatic push of the workspace.
4. Run it a second time.
5. For adopt: with a scratch repository that already has a Projects board and two open issues, run `recade adopt init --parent <dir> --repo <path>`, then, in the workspace, `recade adopt board`, pick the board with `--project <number>`, and accept one issue link with `--accept <repo>#<issue>=<slice>`.
6. Run `recade github init --dry-run`, then, with the owner's yes, `recade github init`.
7. Back in the scratch workspace of step 3: rename a lot in the `## Lots` table of the PLAN, change the goal of another, move one slice to a story of another lot, add a lot with one story and remove a lot. Run `recade github sync --dry-run`, then, with the owner's yes, `recade github sync`, then once more.
8. Mark every slice of one lot done (its pull requests merged and its Definition of Done ticked), then run `/board` and apply.

Expected:
- Step 2: the dry run lists what would be created and creates nothing.
- Step 3: one private repository for the workspace, one board on it with the fields `Status`, `Increment`, `Sprint`, `Lane`, `Points`, `Priority`, `Due`, `Owner` and `Epic`, one epic issue for each lot of the PLAN with the label `epic`, and one issue for each backlog story and each slice. On GitHub, open an epic: its body has the goal of the lot and its stories and slices, and its sub-issues panel lists the same issues (each story and slice has the epic as its parent). Open a story: its body has the text, the acceptance criteria and the estimate from the PLAN, and its `Points`, `Priority` and `Increment` on the board match. A table view grouped by `Epic` shows one group for each lot. Field IDs come from `gh project field-list`. No view is created: Recade does not make board views, they are made by hand (see `docs/design.md`, section 8.12).
- Step 4: nothing is duplicated. With the automatic push answered no, no `git push` runs: `recade workspace auto-push on` is the only way to turn it on later.
- Step 5: `recade adopt board` only reads and records the board and the link in `recade/state.yaml` (which it commits). No second board is created and no issue is changed. The original repository is untouched.
- Step 6: the dry run lists what it would do. The real run creates the private workspace repository, adds the linked issue of the adopted repository to the board without renaming or editing it, creates an issue, in the workspace repository, only for a slice that has none, and leaves the other existing issue untouched.
- Step 7: the dry run lists the edits and writes nothing. The real run renames the epic and changes its goal, moves the slice to the sub-issues of the epic of its new lot (it leaves the old one), creates the new epic with its story under it, and closes the epic of the removed lot with a comment, without deleting it. The `Epic` field of the moved slice follows. The second run changes nothing and no epic is duplicated. An issue you wrote yourself is never edited.
- Step 8: the epic of that lot is closed as completed, with a comment. Add a slice for that lot and run `/board` again: the epic reopens.
- A public repository is refused.

Result: ______

## 10. A real slice across two code repositories

Setup: a throwaway GitHub account area where you can create private repositories. Walk the owner through the yes for each one. A scratch workspace with two code repositories, `api` and `web`, each created with `recade repo add <name> --new`, then `recade github init --repo api --repo web` with the owner's yes, then the harness installed in each (`/recade:harness`). One slice sheet with `touches:` such as `api:src/items/**` and `web:src/items/**`.

Steps:
1. Start a session at the root of the workspace and type `/slice <S-nn>`. Look at the two worktrees it opens at `worktrees/api/<S-nn>` and `worktrees/web/<S-nn>` of the workspace.
2. Let it run. Watch where the agents write and where the gates run.
3. Ask an agent to write a file in `repos/web/` (the main checkout), one in `worktrees/web/<S-nn>/` outside the touches, and one in a third folder of the workspace, such as `slices/`.
4. Let the slice reach the pull requests. Open them on GitHub.
5. Merge the `api` pull request, then run `/board`. Merge the `web` pull request, then run `/board` again.
6. Look at the workspace history and at the issue of the slice.

Expected:
- Step 1: both worktrees exist, on the same branch name, `worktrees/` is ignored by the workspace, and the session never asked for a folder or an `/add-dir`.
- Step 2: the guard of the session allows writes in the two worktrees within their globs and refuses the rest. The gates run in each worktree with its own stamps, through `--project '<worktree>'`.
- Step 3: the three writes are refused, with a message that names the rule.
- Step 4: one pull request in each repository. Each body links the issue of the workspace by its full URL, and holds no text of the slice sheet.
- Step 5: after the first merge the slice stays `ready-to-merge` and `/board` says which pull request is missing. After the second it is `done`, the sheet holds `merged:` with one commit for each repository, the issue of the workspace is closed, and the worktrees under `worktrees/` and the branches of both repositories are removed.
- Step 6: the status moves and the tick of the definition of done are commits of the workspace, none of them holds a conflict, and the history is linear.

Result: ______

## 11. `recade repo sync` on a second clone

Setup: the workspace of check 10, with its GitHub repository and the two code repositories on GitHub, and the automatic push turned on once (`recade workspace auto-push on`). A second folder, or a second machine, signed in to GitHub.

Steps:
1. Clone the workspace repository in the second place. `repos/` is empty there: it is not tracked.
2. Open a session in the second clone and run `/recade:resume`.
3. Say yes when it offers the sync. Run `recade repo check` after.
4. Run `recade repo sync` a second time.
5. Move the whole second clone to another folder and run `recade repo check`, then `recade repo sync`.
6. In the first clone, make a workspace change that pushes, and pull it in the second.

Expected:
- Step 2: it names the missing repositories and offers `recade repo sync`. It does not run it without your yes.
- Step 3: both repositories are cloned into `repos/`, each has its `.recade/workspace` and `.recade/plugin-root`, and `recade repo check` says that every repository is present, linked and has its harness.
- Step 4: it clones nothing and changes nothing.
- Step 5: the check reports `link points elsewhere` and names `recade repo sync`; the sync rewrites the links and repairs the worktrees of the slices.
- Step 6: the workspace pushed on its default branch only, and no code repository was pushed by Recade.

Result: ______

## 12. A wildcard in `allowed-tools`

The commands `/parallel`, `/merge-order` and `/board` allow forms such as `Bash(git -C * worktree list*)`, because they look at `repos/<name>/` from the workspace. Whether Claude Code honours a `*` in the middle of a pattern can only be seen in a live session.

Steps:
1. In the scratch workspace of check 10, run `/parallel`, pick two slices, and watch each `recade slices open ... --no-session` call and each `git -C '<workspace>/repos/<name>' worktree list` call.
2. Run `/merge-order` with two open pull requests and watch the `git -C ... worktree add --detach '<workspace>/worktrees/<name>/merge-<n>'`, `git -C ... fetch` and `git -C ... rev-parse` calls.
3. In the same sessions, ask Claude to run `git -C repos/api push origin main` and `git -C repos/api checkout main`.

Expected:
- Steps 1 and 2: the allowed forms run without a permission prompt. `/parallel` ties no session to a slice: `.recade/sessions/` gets no file.
- Step 3: neither command is allowed by the pattern. Claude Code asks for permission, or the guard refuses the push, and nothing is pushed.
- If the wildcard is not honoured, the commands ask for permission at each call and do not fail. Write that down, and change the patterns before the release.

Result: ______

## 13. The second-opinion job with the token

Setup: the code repository `api` of check 10 on GitHub, a pull request open on it for a slice, and the file `.github/workflows/second-opinion.yml` installed by the harness. The owner sets, in the settings of `api`: the variable `RECADE_SECOND_OPINION` to `on`, the secret `ANTHROPIC_API_KEY`, the secret `RECADE_WORKSPACE_TOKEN` (a fine-grained personal access token with Contents read-only, on the workspace repository only) and the variable `RECADE_WORKSPACE_REPOSITORY` (`owner/name` of the workspace). The owner does it, not Recade.

Steps:
1. Open the pull request, or re-run the workflow, with the token and the variable set.
2. Open the log of the run.
3. Remove the secret `RECADE_WORKSPACE_TOKEN` and run the workflow again.
4. Open a pull request from a fork, or from a branch that no slice sheet names.

Expected:
- Step 1: the job clones the workspace, copies only the sheet of the slice, removes the clone and posts one comment with `CONCURS`, `CONCERNS` or `BLOCKING`, each point with a file and a line.
- Step 2: the token is masked, the sheet is not printed anywhere in the log, and no step runs with `set -x`.
- The comment does not quote the text of the sheet. This is a rule of the prompt and nothing else enforces it: if the comment quotes the sheet, the check fails and the owner decides whether to keep the job.
- Step 3: the job prints a notice that says what to set, and ends in success. The second opinion then runs locally with `/second-opinion`.
- Step 4: a fork gets no run. A branch that no sheet names gets the notice, not an error.

Result: ______

## 14. A slice on the local forge

No network. Use a scratch workspace at G3 on a machine where `gh` is not signed in (or rename it out of the `PATH` for the check).

Steps:
1. Run `/recade:slices` and answer `Local only` to "Where should the code live?". Approve G4.
2. Run `/recade:harness` and approve G5. Note the one line that says what was skipped.
3. Run `/slice S-01` at the root of the workspace, up to `ready-to-merge`.
4. From the workspace, run `/board`. Answer `Not yet` to the merge question, then run `/board` again and answer `Yes, merge it`.
5. From an agent in a slice session, ask it to run `recade slices merge S-01`, then `git -C <the main checkout> merge --no-ff <the branch>`.

Expected:
- Step 1: no `gh` call, the sheets and `slices/STATUS.md` are committed, `forge: local` is in `recade/state.yaml`, and each code repository has no remote.
- Step 2: no `conflicts.yml`, `second-opinion.yml` or `dependabot.yml` in a code repository, no branch protection offered, and `verify` passes.
- Step 3: `slices/reviews/S-01.md` holds one section for each repository and is committed in the workspace. Nothing is pushed.
- Step 4: the dry run shows `git -C '<repo>' merge --no-ff <branch>` for each repository, in the merge order. `Not yet` merges nothing. The yes makes one merge commit in each main checkout, then `/board` marks S-01 `done`, writes `merged:` in the sheet and removes the worktree and the branch.
- Step 5: the guard refuses both commands.

Result: ______

## 15. After the checks

- `npm test` is green and `npm run publish-check` is green on the release commit.
- `npm run publish-check -- --history` lists no commit, or the owner has chosen how to publish a clean history.
- The results above are filled in.
