---
doc_id: PLAN
title: "Fernhill desk, delivery plan"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
author: "Project lead, Recade team"
approver: "Ines Calloway"
companions: [BIBLE]
classification: Confidential
revisions:
  - { version: "0.1", date: "2026-11-18", author: "Project lead, Recade team", change: First draft }
approvals:
  - { role: Project lead, name: "", date: "" }
  - { role: Owner, name: "Ines Calloway", date: "" }
---

## Increments

| ID | Increment | Goal | Ends at |
|---|---|---|---|
| INC-1 | Make the desk safe | The late fee has a cap and the ledger survives a restart | M1 |
| INC-2 | See what is late | The chair gets the overdue report | M2 |

## Summary

| Item | Value |
|---|---|
| Project | Fernhill desk |
| Start | 2026-11-23 |
| First delivery | 2026-12-04 |
| Sprint length | 2 weeks |
| Team capacity per sprint | 6 points (PROVISIONAL) |

## Backlog

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| FEE-01 | Fee | Cap the late fee | S | 1 | | 1 | Build | Backlog | Closes DEV-02 |
| LED-01 | Ledger | Keep the ledger across restarts | M | 2 | | 1 | Build | Backlog | Closes DEV-01 |
| RPT-01 | Report | Overdue report | M | 2 | LED-01 | 2 | Build | Backlog | |

## Sprints

| Sprint | Start | End | Theme | Planned points | Capacity | Margin | Milestone |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-23 | 2026-12-04 | Make the desk safe | 3 | 6 | 3 | M1 |
| 2 | 2026-12-07 | 2026-12-18 | See what is late | 2 | 6 | 4 | M2 |

## Milestones

| ID | Date | What is true that day | Criterion | Status |
|---|---|---|---|---|
| M1 | 2026-12-04 | The fee is capped and no loan is lost at a restart | Tests green on the CI | Upcoming |
| M2 | 2026-12-18 | The chair receives the overdue report | One report sent | Upcoming |

## External dependencies

| ID | What | From whom | Due | Blocks | Plan B | Status | Received |
|---|---|---|---|---|---|---|---|
| EXT-01 | The cap the board votes | Ines Calloway | 2026-11-25 | FEE-01 | Use a cap of 10 | Asked | |

## Decisions

None.

## Risks

None.

## RACI

| Activity | Project lead | Developer | Chair |
|---|---|---|---|
| Fee cap | R | C | A |
| Ledger | A | R | I |

## Gantt

| Item | First sprint | Last sprint |
|---|---|---|
| Fee | 1 | 1 |
| Ledger | 1 | 2 |
| Report | 2 | 2 |
