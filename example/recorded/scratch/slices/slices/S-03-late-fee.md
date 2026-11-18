---
doc_id: S-03
title: "Late fee"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
language: "en"
repos: [api]
branch: slice/s-03-late-fee
format: small
lane: standard
implementer: implementer-critical
increment: INC-2
depends_on: ["S-02"]
blocks: []
external_prerequisite: none
provisionals_used: ["PRV-01"]
size: S
touches:
  - "api:src/fee/**"
  - "api:test/fee/**"
---

# S-03: Late fee

## Goal

A late return adds the late fee for each late day, up to the cap.

## Scope

- LOAN-03 (late fee)

## Out of scope

- Taking a payment.

## Sources

- D1, section 10, PAR-02 (late fee for each late day).
- DEC-02 (is the late fee capped), once it is closed.

## Frozen decisions

1. The fee is a pure function of the due date, the return date, PAR-02 and the cap.

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
| 1 | `npm test` (5 tests, the cap included) | All green | yes | [ ] |

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
