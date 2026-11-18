---
doc_id: STACK
title: "Fernhill Lending, stack decision"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
author: "Stack analyst, Recade team"
approver: "Ines Calloway"
companions: [D1, D2, D3]
existing: false
classification: Confidential
revisions:
  - { version: "0.1", date: "2026-11-18", author: "Stack analyst, Recade team", change: First draft }
approvals:
  - { role: Architect, name: "", date: "" }
  - { role: Owner, name: "Ines Calloway", date: "" }
---

## 1. Criteria and weights

| Criterion | Source | Weight |
|---|---|---|
| One volunteer can restart and fix it | Intake: one volunteer maintains it | 30 |
| Runs on one small server under the budget | PRV-03 (hosting budget) | 25 |
| Fit for development by agents: fast tests, clear errors | Measured in section 4 | 25 |
| Few dependencies to keep up to date | Intake: no paid staff | 20 |

## 2. Candidates per layer

| Layer | Candidate | Why it is on the list |
|---|---|---|
| Runtime and server | Node 22 with the built-in HTTP server | No framework to upgrade |
| Runtime and server | A small web framework on Node | Common, more helpers |
| Storage | SQLite through the built-in module | One file, easy backup |
| Storage | A JSON file | Simplest of all |

## 3. Research

The versions, the support dates and the licences below were read from the project pages on 2026-11-18.

## 4. Spikes

| Layer | Option | Result |
|---|---|---|
| Storage | SQLite, built-in module | Unique index refused a second open loan; 20 ms for 1000 loans |
| Storage | JSON file | Needed hand-written locking; the second loan was accepted in a race |

## 5. Weighted matrix

| Option | Score out of 100 |
|---|---|
| Node 22, built-in server | 88 |
| Web framework on Node | 74 |
| SQLite, built-in module | 91 |
| JSON file | 62 |

## 6. Risks and exit cost

The built-in SQLite module is marked experimental in Node 22. Exit cost: one afternoon to move to a driver package.

## 7. Recommendation and contributor opinions

We recommend Node 22 with the built-in server and SQLite.

| Contributor | Opinion | Disagrees with |
|---|---|---|
| devops-lead | Agrees: a copy and a restart | none |
| security-lead | Agrees: no extra surface | none |
| ui-designer | Agrees: plain pages are enough | none |
| qa-lead | Agrees, asks for a test of the unique index | none |

## 8. Decision

| ID | Layer | Choice | Date |
|---|---|---|---|
| ADR-01 | Runtime and server | Node 22 with the built-in HTTP server | 2026-11-18 |
| ADR-02 | Storage | SQLite through the built-in module (DEC-01, where the desk stores its data) | 2026-11-18 |

> [!DECISION]
> Settled by the owner on the date above, for each layer listed.

## 9. Selected stack

| Layer | Name | Pinned version | Licence | Support until |
|---|---|---|---|---|
| Runtime and server | Node | 22.12 | MIT | 2027-04-30 |
| Storage | SQLite (node:sqlite) | 3.46 | Public domain | 2027-04-30 |

## 10. Rejected options

| Option | Why it lost |
|---|---|
| Web framework on Node | One more dependency to update for no gain |
| JSON file | Allowed a second loan in a race |

## 11. Conditions for re-examination

- Node ends the long-term support of version 22.
- The built-in SQLite module is removed or changed in a breaking way.

## 12. Harness technical sheet

### api

| Item | Value |
|---|---|
| Install | `npm ci` |
| Build | Not applicable, plain Node modules, nothing is built |
| Test | `npm test` |
| Lint | `npm run lint` |
| Format | `npm run format` |
| Conventions | one test file for each rule, plain Node modules |
| Runtime | `node 22` |
| Typecheck | Not applicable, plain JavaScript |
| Contract tests | Not applicable, no external contract in phase 1 |
| E2E setup | Not applicable, no browser tests in phase 1 |
| E2E tests | Not applicable, no browser tests in phase 1 |
| Confirmation tests | Not applicable, no destructive action in phase 1 |
| Accessibility tests | Not applicable, one plain desk page in phase 1 |
| Performance budget | Not applicable, the desk serves one volunteer at a time |
| SAST | Not applicable, no dependency and no framework |
| Dependency audit | Not applicable, no dependency |
| SBOM | Not applicable, no dependency |
| Secret scan | `gitleaks detect --no-banner` |

### web

| Item | Value |
|---|---|
| Install | `npm ci` |
| Build | `npm run build` |
| Test | `npm test` |
| Lint | `npm run lint` |
| Format | `npm run format` |
| Conventions | one test file for each rule, plain Node modules |
| Runtime | `node 22` |
| Typecheck | Not applicable, plain JavaScript |
| Contract tests | Not applicable, no external contract in phase 1 |
| E2E setup | Not applicable, no browser tests in phase 1 |
| E2E tests | Not applicable, no browser tests in phase 1 |
| Confirmation tests | Not applicable, no destructive action in phase 1 |
| Accessibility tests | Not applicable, one plain desk page in phase 1 |
| Performance budget | Not applicable, the desk serves one volunteer at a time |
| SAST | Not applicable, no dependency and no framework |
| Dependency audit | Not applicable, no dependency |
| SBOM | Not applicable, no dependency |
| Secret scan | `gitleaks detect --no-banner` |
