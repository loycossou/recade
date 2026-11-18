---
doc_id: RULES
title: "Fernhill desk, rules from the code"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
---

# Fernhill desk, rules from the code

Read from the code and from SRC-01 (the README) and SRC-02 (the ADR for plain Node).

## Golden files

- `repos/fernhill-desk/src/loans.js`: the clearest module: one rule for each exported function, constants named at the top.
- `repos/fernhill-desk/test/loans.test.js`: the pattern for a test: one rule for each test, the border of the rule included.

## Rules

1. Use `node:http` and `node:test` and add no framework (SRC-02). Followed by every file.
2. Write ES modules with named exports. Followed by every file.
3. Keep one test file for each source file in `repos/fernhill-desk/test/`. Followed by 2 of 3 source files.
4. Write commits in the conventional style. Followed by 3 of 3 commits.

## DONTs

- Do not add a dependency without an owner decision (SRC-02).
- Do not keep state outside `repos/fernhill-desk/src/ledger.js` and `repos/fernhill-desk/src/members.js`.
