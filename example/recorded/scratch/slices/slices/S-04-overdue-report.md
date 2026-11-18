---
doc_id: S-04
title: "Overdue report"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
language: "en"
repos: [web]
branch: slice/s-04-overdue-report
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
  - "web:src/report/**"
  - "web:test/report/**"
---

# S-04: Overdue report

## Goal

The chair and the volunteers see every tool past its due date, with its member.

## Scope

- REP-01 (overdue report)

## Out of scope

- Contacting the member.

## Sources

- D1, section 7, module REP (FR-REP-01, the overdue list).

## Frozen decisions

1. The report is built from the loans table, never from a copy.

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
