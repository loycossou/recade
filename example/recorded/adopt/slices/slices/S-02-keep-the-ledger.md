---
doc_id: S-02
title: "Keep the ledger across restarts"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
language: "en"
repos: [app]
branch: slice/s-02-keep-the-ledger
format: small
lane: standard
implementer: implementer-critical
increment: INC-1
depends_on: ["S-00"]
blocks: []
external_prerequisite: none
provisionals_used: []
size: M
touches:
  - "src/ledger.js"
  - "test/ledger.test.js"
---

# S-02: Keep the ledger across restarts

## Goal

A loan recorded before a restart is still there after it.

## Scope

- LED-01 (keep the ledger across restarts)

## Out of scope

- Changing the HTTP routes.

## Sources

- `docs/inventory.md`, DEV-01 (the ledger lives in memory).
- `docs/recade/INVARIANTS.md`, INV-02.

## Frozen decisions

1. The ledger keeps its three exported functions and their messages (REQ-01).

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
| 1 | `npm test` (5 tests, a restart included) | All green | yes | [ ] |

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
