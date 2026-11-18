---
doc_id: INVENTORY
title: "Fernhill desk, inventory"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
---

# Fernhill desk, inventory

## Summary

- One package, the root, in JavaScript on Node, with no framework and no dependency.
- The CI runs `npm test` and nothing else: there is no lint, no build and no formatter.
- The ledger is in memory, and a TODO and a FIXME mark two open questions in the code.

## Package .

### Stack

JavaScript, Node 20 or later (`engines`), ES modules. Manifest: `package.json`. No dependency. The server uses `node:http`.

### Commands

Test: `npm test`. Lint: not found. Build: not found.

### Tests

`repos/fernhill-desk/test/loans.test.js` and `repos/fernhill-desk/test/members.test.js`, 5 tests in all, none skipped. There is no test for `repos/fernhill-desk/src/ledger.js`.

### Conventions

Plain modules, one file for each concern, named exports.

### Debt

1 TODO in `repos/fernhill-desk/src/loans.js` (the late fee has no cap) and 1 FIXME in `repos/fernhill-desk/src/members.js` (a member who joins twice replaces the first record).

### Documents

`README.md` and `docs/adr/0001-plain-node.md`.

## CI

`repos/fernhill-desk/.github/workflows/ci.yml`: one job, `test`, which runs `npm test` on Node 22.

## Conventions

Commits: conventional, 3 of 3. Branches: one, `main`. Formatter: not found.

## Debt

1 TODO, 1 FIXME, 0 skipped tests, 0 large files.

## Documents

- `README.md`: what the service is and how to run it.
- `docs/adr/0001-plain-node.md`: the choice of plain Node and no framework.

## Gaps

- No manifest failed to parse.
- No lint or build command is shown by any file.
