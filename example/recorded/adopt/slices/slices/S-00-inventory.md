---
doc_id: S-00
title: "Inventory"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
language: "en"
repos: [app]
branch: slice/s-00-inventory
format: small
lane: no-code
implementer: implementer
increment: INC-1
depends_on: []
blocks: []
external_prerequisite: none
provisionals_used: []
size: S
touches: []
---

# S-00: Inventory

## Goal

The repository is described: its packages, its stack, its rules and its deviations.

## Scope

- The inventory in `docs/inventory.md`, the stack in place in `docs/STACK.md` and the documents of `docs/recade/`.

## Out of scope

- Any change to the code.

## Sources

- `docs/inventory.md`, the register of deviations.

## Frozen decisions

1. The inventory is done: this slice records it and changes no code.

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
| 1 | `recade slices check` | No error | yes | [ ] |

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
