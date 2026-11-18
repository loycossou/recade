---
doc_id: S-02
title: "Loans and returns"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
language: "en"
repos: [api]
branch: slice/s-02-loans-returns
format: small
lane: standard
implementer: implementer-critical
increment: INC-1
depends_on: ["S-01"]
blocks: ["S-03", "S-04"]
external_prerequisite: none
provisionals_used: []
size: M
touches:
  - "api:src/loans/**"
  - "api:test/loans/**"
---

# S-02: Loans and returns

## Goal

A volunteer registers a loan and a return, and a tool that is out is never lent again.

## Scope

- LOAN-01 (register a loan)
- LOAN-02 (register a return)

## Out of scope

- The late fee and the overdue report.

## Sources

- D1, section 7, module LND (PRI-01, a tool is never lent twice).
- D2, section 5.2, the integrity rules.

## Frozen decisions

1. A tool has at most one open loan, enforced by a unique index (PRI-01, a tool is never lent twice).
2. A loan lasts PAR-01 (loan length) days.

## Interfaces

| Interface | Direction | Contract |
|---|---|---|
| POST /loans | offers | `docs/contracts/loans.md` |
| DELETE /loans/:tool | offers | `docs/contracts/loans.md` |

## Expected tree

```text
src/loans/
  index.js
test/loans/
  index.test.js
```

## Design

None.

## Definition of Done

| # | Command (counts tests) | Expected | Seen red first? | Done |
|---|---|---|---|---|
| 1 | `npm test` (8 tests, day 7 and day 8 included) | All green | yes | [ ] |
| 2 | `npm run lint` | No finding | yes | [ ] |

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
