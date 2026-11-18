---
doc_id: S-01
title: "Cap the late fee"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
language: "en"
repos: [app]
branch: slice/s-01-cap-the-late-fee
format: small
lane: standard
implementer: implementer
increment: INC-1
depends_on: ["S-00"]
blocks: []
external_prerequisite: none
provisionals_used: []
size: S
touches:
  - "src/loans.js"
  - "test/loans.test.js"
---

# S-01: Cap the late fee

## Goal

A late fee never goes above the cap the board voted.

## Scope

- FEE-01 (cap the late fee)

## Out of scope

- Taking a payment.

## Sources

- `docs/inventory.md`, DEV-02 (the late fee has no cap).
- EXT-01 (the cap the board votes).

## Frozen decisions

1. The cap is a named constant at the top of `src/loans.js`.

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
| 1 | `npm test` (6 tests, the cap included) | All green | yes | [ ] |

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
