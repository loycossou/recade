---
doc_id: S-01
title: "Catalogue and members"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
language: "en"
repos: [api, web]
branch: slice/s-01-catalogue-members
format: small
lane: standard
implementer: implementer
increment: INC-1
depends_on: []
blocks: []
external_prerequisite: none
provisionals_used: []
size: M
touches:
  - "api:src/store/**"
  - "api:src/catalogue/**"
  - "api:src/members/**"
  - "api:test/catalogue/**"
  - "api:test/members/**"
  - "web:src/catalogue/**"
  - "web:src/members/**"
merge_order: [api, web]
---

# S-01: Catalogue and members

## Goal

A volunteer can add and find a tool and a member, and the desk loads the spreadsheet of tools.

## Scope

- CAT-01 (tool records)
- CAT-02 (tool in repair)
- MEM-01 (member list)

## Out of scope

- Loans, returns, the late fee and the report.

## Sources

- D1, section 7, modules CAT and MEM.
- STACK, section 9, the storage layer (ADR-02).

## Frozen decisions

1. One SQLite file holds tools, members, loans and settings (DEC-01, where the desk stores its data).
2. Only the name and the phone number of a member are stored (PRI-02, personal data stays local).

## Interfaces

| Interface | Direction | Contract |
|---|---|---|
| None | offers | none |

## Expected tree

```text
src/store/
  schema.js
src/catalogue/
  index.js
src/members/
  index.js
```

## Design

None.

## Definition of Done

| # | Command (counts tests) | Expected | Seen red first? | Done |
|---|---|---|---|---|
| 1 | `npm test` (6 tests) | All green | yes | [ ] |
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
