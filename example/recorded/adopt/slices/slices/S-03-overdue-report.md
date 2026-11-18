---
doc_id: S-03
title: "Overdue report"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
language: "en"
repos: [app]
branch: slice/s-03-overdue-report
format: small
lane: standard
implementer: implementer
increment: INC-2
depends_on: ["S-02"]
blocks: []
external_prerequisite: none
provisionals_used: []
size: M
touches:
  - "src/report.js"
  - "test/report.test.js"
---

# S-03: Overdue report

## Goal

The chair gets the list of tools past their due date.

## Scope

- RPT-01 (overdue report)

## Out of scope

- Contacting the member.

## Sources

- `docs/recade/CONTRACTS.md`, the loan shape.

## Frozen decisions

1. The report reads the ledger and keeps no copy.

## Interfaces

| Interface | Direction | Contract |
|---|---|---|
| None | offers | none |

## Expected tree

```text
src/
  index.js
test/
  index.test.js
```

## Design

None.

## Definition of Done

| # | Command (counts tests) | Expected | Seen red first? | Done |
|---|---|---|---|---|
| 1 | `npm test` (4 tests) | All green | yes | [ ] |

## Work order

1. Write the failing tests, one per line of the Definition of Done.
2. Make them pass without changing them.
3. Run the quality gates.
4. Update the documents that changed.

## Human actions after

None.

## Implementer prompt

Read the BIBLE and this sheet. Build only what the scope lists. Report the Definition of Done table with real counts.

## Decided while building

None yet.

## Proposed spec changes

None yet.
