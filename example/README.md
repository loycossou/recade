# The example project

One fictional product, used in all three entry modes: the loan desk of the Fernhill Tool Library (members borrow tools for 7 days, volunteers register loans and returns). Every name here is fictional.

`npm run e2e` plays the CLI path of every phase of a Recade project with no model and no network. The project is a workspace, created under a parent folder with a space and an accent in its name (`Projets Clients Été`). The scratch and from modes create two code repositories, `api` and `web`; the adopt mode clones the repository that `adopt/build.js` makes. The last phase, `delivery`, takes the slice S-01 from `todo` to `done` with a fake pull request in each repository it touches. `npm test` runs the same driver (`tests/e2e.test.js`). `npm run e2e -- --mode adopt` runs one mode, `--keep` keeps the project folder, `--update` records the generated files again.

## What is in this folder

| Path | What it is |
|---|---|
| `scratch/answers.yaml` | The owner's recorded answers: the questionnaire, the decisions, the gates, the slicing formula, the code repositories (`api`, `web`), the yes to the automatic push |
| `from/` | What the client gives in the `--from` mode: a brief and a spreadsheet of tools |
| `adopt/build.js` | Builds the repository of the adopt mode in a temp folder: a tiny Node service with tests, a CI file, an ADR and a short history, all pushed to a remote that exists only as a name |
| `adopt/answers.yaml` | The owner's recorded answers for adopt: gates, the board and the issue links (`<repo>#<issue>`), the rows of the stack sheet |
| `recorded/<mode>/<phase>/` | The outputs of the agents, recorded once. The path under the phase folder is the path in the project |
| `recorded/<mode>/<phase>/agent.json` | The commands the agents ran in that phase (`provisional open`, `decision new`, `state set`) |
| `expected/<mode>/<phase>/` | The files Recade generates (state, INDEX, STATUS, graph, DEC files), compared line by line |

A phase with no folder of its own in a mode uses the one of `scratch`: the `from` mode differs only in its intake, and `adopt` shares the team and the harness phase. So the documents of the three modes describe one product.

## When the run fails

The driver prints the phase, the file and the line: `FAIL scratch, phase team: team/architect.md:12 ...`. Either a command of Recade refused a recorded file (a lint finding, a doctrine without its sections, an ID that nothing defines), or a file Recade generated no longer reads as recorded. If the change is wanted, fix the recorded agent output (the agent files in `agents/` should produce it) or run `npm run e2e -- --update` and read the diff of `example/expected/`.
