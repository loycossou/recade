---
doc_id: "{{doc_id}}"
title: "{{title}}"
project: "{{project}}"
version: "{{version}}"
date: "{{date}}"
language: "{{language}}"
repos: [app]
branch: slice/s-01-example
format: small # large | small
lane: standard # sensitive | standard | no-code
implementer: implementer # implementer | implementer-critical
increment: INC-1
depends_on: []
blocks: []
external_prerequisite: none
provisionals_used: []
size: M # S | M | L
touches:
  - "src/example/**"
---

<!--
Slice sheet. Written by the spec-writer, read by every agent of the chain. Keep it under about 300 lines.
The state of the slice lives in STATUS.md, never in this sheet. Delete every comment once the sheet is final.
A slice is the biggest unit one session can finish with a green test gate and an end-to-end demo.
Limits: 10 frozen decisions, 15 lines of Definition of Done, 6 screens. Beyond that, split.
Front matter: `format` is large (one slice cut into tasks, each by a fresh sub-agent, 12 tasks at most,
limits apply to each task) or small (one pull request, one agent that writes). `touches` lists the path
patterns this slice may change: two slices with overlapping patterns never run together. `implementer` is
implementer-critical when the slice touches an invariant, money, crypto, offline state or a transaction
boundary, and implementer otherwise.
With several code repositories, each `touches` entry starts with the repository (`api:src/**`) and a slice has one
pull request per repository. Optional `merge_order: [api, web]` lists those repositories in the order their pull
requests merge; without it the order of the prefixes in `touches` is used. `merged:` (a map from repository to the
commit that merged it) is written by /board once every pull request is merged: never write it by hand.
-->

# {{doc_id}}: {{title}}

## Goal

One sentence: what is true when this slice is done, that was not true before.

## Scope

<!-- IDs with their gist. Each story is covered by exactly one slice. -->

- the user can do the example thing (FR-EX-01)

## Out of scope

- Example: anything outside the IDs above.

## Sources

<!-- The documents and decisions this slice rests on. Cite IDs, never line numbers. -->

- D1, section 7, module EX.
- DEC-01 (example decision), once it is closed.

## Frozen decisions

<!-- At most 10. Each one settled, not open. Change one only through the proposed spec changes below. -->

1. Example decision, with the reason in a few words.

## Interfaces

<!-- Contracts this slice offers and uses: endpoints, events, types. Versioned. -->

| Interface | Direction | Contract |
|---|---|---|
| Example endpoint | offers | `docs/contracts/example.md` |

## Expected tree

```text
src/example/
  index.ts
  index.test.ts
```

## Design

<!-- Screens to approve before the build, at most 6. Say "none" for a slice without screens. -->

None.

## Definition of Done

<!-- At most 15 lines. Each line is a command, the number of tests it counts, what it shows, and whether it failed first. The Done column starts as [ ]. The owner ticks it ([x]) at gate-2, before the merge, for each line seen green. /board marks the slice done only when every line is ticked and the pull request is merged. -->

| # | Command (counts tests) | Expected | Seen red first? | Done |
|---|---|---|---|---|
| 1 | `make test` (3 tests) | All green | yes | [ ] |

## Work order

1. Write the failing tests, one per line of the Definition of Done.
2. Make them pass without changing them.
3. Run the quality gates.
4. Update the documents that changed.

## Human actions after

<!-- What a person must do after the merge: set a secret, approve a screen, run a migration. Say "none" if nothing. -->

None.

## Implementer prompt

<!-- The message the implementer reads first: goal, sheet, rules to follow, what to report. Short. -->

Read the BIBLE and this sheet. Build only what the scope lists. Report the Definition of Done table with real counts.

## Decided while building

<!-- Decisions taken during the build, back-ported into the sources before the merge. -->

None yet.

## Proposed spec changes

<!-- Changes to D1, D2, D3 or the BIBLE that this slice shows are needed. They go through /recade:amend. -->

None yet.
