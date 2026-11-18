---
doc_id: STACK
title: "Fernhill desk, stack in place"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
author: "Inventory analyst, Recade team"
approver: "Ines Calloway"
companions: [D1, D2, D3]
existing: true
classification: Confidential
revisions:
  - { version: "0.1", date: "2026-11-18", author: "Inventory analyst, Recade team", change: First draft }
approvals:
  - { role: Architect, name: "", date: "" }
  - { role: Owner, name: "Ines Calloway", date: "" }
---

## Stack in place

| Package | Path | Language | Framework | Test | Lint | Build |
|---|---|---|---|---|---|---|
| fernhill-desk | `.` | JavaScript | none | `npm test` | not found | not found |

## 1. Criteria and weights

The existing stack is the one to keep. The repository shows it: `package.json`, `docs/adr/0001-plain-node.md` and the CI file.

| Criterion | Source | Weight |
|---|---|---|
| Keep the stack that is in place | `docs/adr/0001-plain-node.md` | 100 |

## 2. Candidates per layer

Not applicable, adopt mode.

## 3. Research

Not applicable, adopt mode.

## 4. Spikes

Not applicable, adopt mode.

## 5. Weighted matrix

Not applicable, adopt mode.

## 6. Risks and exit cost

Not applicable, adopt mode.

## 7. Recommendation and contributor opinions

Not applicable, adopt mode.

## 8. Decision

| ID | Layer | Choice | Date |
|---|---|---|---|
| ADR-01 | Runtime and server | Adopted as found, imposed by `docs/adr/0001-plain-node.md` | 2026-11-18 |

> [!DECISION]
> Settled by the owner on the date above, for each layer listed.

## 9. Selected stack

| Layer | Name | Pinned version | Licence | Support until |
|---|---|---|---|---|
| Runtime and server | Node | not found | not found | not found |

## 10. Rejected options

None, adopt mode.

## 11. Conditions for re-examination

- The README or the ADR is replaced by a decision to add a framework.

## 12. Harness technical sheet

| Item | Value |
|---|---|
| Install | `npm ci` |
| Test | `npm test` |
| Conventions | plain modules, one file for each concern |
| Runtime | `node 20` |
