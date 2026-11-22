---
name: slicing
description: How to cut the PLAN of a Recade project into slices, and how to write the slice sheets. Sizes and caps, cutting rules, the three slicing formulae (mixed, small, large), the shape of a large slice, the scope globs and hotspots, and what `recade slices check` verifies. Load it before any slicing work.
---

# Slicing

A slice is the biggest unit one session can finish with a green test gate and an end-to-end demo. The PLAN lists the stories. Slicing turns them into sheets that agents can build in parallel without touching the same files. Use this with `writing-voice` for every text, and with `templates/slice.md` for the shape of a sheet.

## Sizes and caps

| | Cap |
|---|---|
| Sheet | 300 lines |
| Frozen decisions | 10 |
| Definition of Done rows | 15 |
| Screens | 6 |
| Target duration | 1 day of agent work |

Beyond a cap, split the slice. Aim for 3 to 5 slices that can run at the same time once the graph allows it.

## Cutting rules

1. **S-00 inventory** when code already exists (adopt mode, or code the owner brought). It reads the code and writes down what is there. It writes no feature, so its header says `lane: no-code`: `/inventory` closes it from `todo` to `done`, a move only that lane allows.
2. **Walking skeleton first.** The first slices cross the whole chain: API, data, a minimal screen in the chosen art direction, CI, a deployment to a preview environment. Widen only after that. In the short track (`track: short` in `recade/state.yaml`), S-01 is that skeleton alone: the thinnest end-to-end path through the real stack, deployed where the owner can see it, with at most one business rule. Its header says `skeleton: true`, and `recade slices check` warns when it does not.
3. **Contract first.** No integration between two modules without a versioned contract. The slice that defines the contract comes before the slices that use it, and they depend on it.
4. **One module, one agent that writes.** Slices that can run at the same time have disjoint `touches:`.
5. **Every story in exactly one slice.** The Scope of the slice cites the story IDs of the PLAN Backlog, each with its gist.
6. **Backend apart from the screens** when a screen waits for a design approval: the backend slice does not wait.
7. **Hardware and external services go behind an interface.** The real wiring is a slice of its own.
8. **A slice for dependency updates**, never mixed with feature work.

## The three formulae

The owner chooses one at the start of the slicing, and it is kept in `recade/state.yaml` as `slicing`.

| Formula | How | For whom |
|---|---|---|
| `small` | 3 to 5 slices at a time, the caps above, one pull request for each slice | several reviewers, raw speed |
| `large` | one slice for each feature, cut into tasks. A fresh sub-agent runs each task and it is reviewed before the next one (`superpowers:subagent-driven-development`), then the whole slice is reviewed. One pull request, one human gate | one person reviews and wants fewer interruptions |
| `mixed` (default) | `large` for the business core and whatever touches an invariant, `small` for what stands alone (screens, integrations, infrastructure) | most projects |

Each sheet states its own format in the header: `format: large` or `format: small`.

## A large slice

A large slice keeps the context of its orchestrator small because the work lives in sub-agents and in files, not in the conversation.

- The sheet has the usual header, and the sections Goal, Scope, Out of scope, Sources, Interfaces, Expected tree, Human actions after, Implementer prompt, Decided while building and Proposed spec changes. Then one `## Task <n>: <title>` section for each task, in the order they run.
- Each task has its own H3 sections: `### Goal`, `### Frozen decisions`, `### Design`, `### Definition of Done`, `### Work order`. The caps apply to each task, not to the whole sheet: 300 lines, 10 frozen decisions, 15 Definition of Done rows, 6 screens.
- At most 12 tasks. Beyond that, split the slice.
- The sheet names a tracking register, `slices/registers/S-nn-<name>.md`: tasks done, commits, rulings. The orchestrator creates it and reads it again after any break or compaction. Do not write it yourself.
- One review for each task, then one review of the whole slice by the most capable model. One pull request, with one readable commit for each task.
- Tasks of one slice run one after the other. Parallelism happens between slices.

## What `recade slices check` verifies

Run it after every change. A line with `error` must be fixed.

| Rule | Meaning |
|---|---|
| `slice-too-long`, `slice-too-many-decisions`, `slice-too-many-dod`, `slice-too-many-screens`, `slice-too-many-tasks`, `slice-no-tasks` | The caps. For a large slice they are counted in each `## Task` section. |
| `slice-header-missing`, `slice-header-type`, `slice-format`, `slice-lane`, `slice-implementer`, `slice-touches-empty`, `slice-front-matter` | The header of `templates/slice.md`: every key is present, `format` is `large` or `small`, `lane` is `sensitive`, `standard` or `no-code`, and `touches:` lists at least one pattern unless the lane is `no-code`. |
| `slice-name`, `slice-duplicate-id` | A sheet is `slices/S-nn-<name>.md` and each id is used once. |
| `slice-unknown-dependency`, `slice-cycle` | `depends_on` names existing sheets and never loops. |
| `touch-prefix`, `touch-repo`, `touch-empty` | The repository prefix of each `touches:` glob and of each hotspot of `recade/state.yaml`. `touch-prefix`: a glob with no prefix while the registry holds two repositories or more. `touch-repo`: a prefix that is not a repository of the registry. `workspace:` is refused in `touches:`: it is valid only in the `## Writes` of an agent. `touch-empty`: a prefix with no glob after it (`api:`). `/parallel` does not start a slice that has one of these errors. |
| `slice-overlap` | Two slices with no dependency path between them, in either direction, touch overlapping paths. Fix it by making one depend on the other, or by narrowing `touches:`. |
| `slice-hotspot` (warning) | A slice touches a hotspot of `recade/state.yaml` (one warning for each slice and hotspot). Slices that touch the same hotspot run one after the other: chain them with `depends_on`. |
| `slice-skeleton` (warning) | In the short track, S-01 is missing or its header has no `skeleton: true`. |
| `story-uncovered`, `story-twice`, `plan-no-backlog`, `plan-missing` | Each story of the PLAN Backlog is cited in the Scope of exactly one slice. A PLAN with no Backlog section cannot be checked. |

How the counts are read, so that a sheet counts true:

- Frozen decisions: numbered items (`1.`, `2.`) under `## Frozen decisions`.
- Definition of Done: the rows of the table under `## Definition of Done`, header excluded.
- Screens: one list item for each screen under `## Design`. "None." counts for zero.
- Stories: the story IDs found under `## Scope`. An ID cited in another section does not cover a story.

### Scope globs

`touches:` holds path globs. They are compared one path segment at a time. Two literal segments must be equal. A segment with a wildcard (`*`, `?`, `[` or `{`) matches anything, and so does everything after it. A path that ends first sits above the other, so the two overlap. `src/api/**` and `src/api/users/**` overlap. `src/api/users/**` and `src/api/orders/**` do not. `src/api` and `src/apiary/**` do not. A glob that starts with a wildcard (`**/*.md`) overlaps everything, so avoid it. The check is deliberately simple and errs on the side of caution: when it flags two slices that cannot really collide, narrow the globs.

Each glob starts with the name of the code repository it is in: `api:src/orders/**`, `web:src/pages/orders/**`. The prefix is the text before the first colon, when that text is a lower-case kebab name (letters, digits and single hyphens, no slash, no capital); it must name a repository of the registry, or the sheet gets `touch-repo`. Text that does not look like a name before the colon is part of the glob: `src/a:b/**` has no prefix. A drive path such as `c:/x` reads as the prefix `c` and is refused by `touch-repo`: write paths relative to the repository root. Globs of different repositories never overlap: `api:src/**` and `web:src/**` do not, `api:src/a/**` and `api:src/**` do. The prefix is required once the project has two repositories. With one repository it is optional and an unprefixed glob belongs to it. When a second repository is added, `recade repo add` prefixes the unprefixed globs of the slices that are not done with the first repository, and shows the changes. A slice that touches several repositories gets one worktree in each (`repos/<name>/.claude/worktrees/<S-nn>`), on the same branch.

### Slices across repositories

A slice that touches several repositories has one pull request per repository and one status. The pull requests merge in the order of the prefixes in `touches:`, or in the order of the optional `merge_order: [api, web]` of the sheet (it must list exactly the repositories of the slice, each once: rule `merge-order`). `/board` moves the slice to `ready-to-merge` when every pull request is green and approved, and to `done` when every one is merged. It then writes `merged: {api: <commit>}` in the sheet (rule `merged-record` checks it) and closes the issue of the workspace. One merged pull request with a failing one keeps the slice `ready-to-merge`, and `/board` names the failing one.

### Hotspots

The hotspots are the files every slice is tempted to edit: routes, menus, migrations, dependency files. They come from the BIBLE and live in `hotspots:` of `recade/state.yaml`. Hotspots use the same syntax and the same checks: `api:src/routes.ts`. They are chained repository by repository: an `api:` hotspot and a `web:` hotspot do not make two slices wait for each other. A slice that needs one lists it in `touches:` and runs after, never beside, the other slices that need it.

## A sheet, section by section

Follow `templates/slice.md` exactly and delete every comment. The header: `repos`, `branch` (`slice/s-nn-<name>`), `format`, `lane`, `implementer`, `increment`, `depends_on`, `blocks`, `external_prerequisite`, `provisionals_used`, `size`, `touches`.

`implementer` names the agent that builds the slice: `implementer-critical` when the slice touches an invariant of the BIBLE, money, cryptography, offline state or a transaction boundary, and `implementer` for everything else. Do not write a model name in a sheet: the harness maps each agent to its model.

The sheet never holds the state of the slice, and it has no `status:` key. The state lives in `slices/STATUS.md`, which `recade slices status` writes: it keeps the states and the notes already there, and adds a new slice as `todo`.
