---
doc_id: PLAN
title: "Fernhill Lending, delivery plan"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
author: "Project lead, Recade team"
approver: "Ines Calloway"
companions: [D1, D2, D3]
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
| INC-1 | Desk loop | A volunteer registers a loan and a return on the test desk | M1 |
| INC-2 | Full shift | The desk runs a Saturday shift with the late fee and the report | M2 |

## Summary

| Item | Value |
|---|---|
| Project | Fernhill Lending |
| Start | 2026-11-23 |
| First delivery | 2026-12-04 |
| Sprint length | 2 weeks |
| Team capacity per sprint | 8 points (PROVISIONAL) |

## Backlog

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| CAT-01 | Catalogue | Tool records | M | 2 | | 1 | Build | Backlog | Loads the spreadsheet |
| CAT-02 | Catalogue | Tool in repair | S | 1 | CAT-01 | 2 | Build | Backlog | |
| MEM-01 | Members | Member list | S | 1 | | 1 | Build | Backlog | |
| LOAN-01 | Loans | Register a loan | M | 2 | CAT-01, MEM-01 | 1 | Build | Backlog | |
| LOAN-02 | Loans | Register a return | S | 1 | LOAN-01 | 1 | Build | Backlog | |
| LOAN-03 | Loans | Late fee | S | 1 | LOAN-02 | 2 | Build | Backlog | Waits on DEC-02 |
| REP-01 | Reports | Overdue report | M | 2 | LOAN-02 | 2 | Build | Backlog | |

## Sprints

| Sprint | Start | End | Theme | Planned points | Capacity | Margin | Milestone |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-23 | 2026-12-04 | Desk loop | 7 | 8 | 1 | M1 |
| 2 | 2026-12-07 | 2026-12-18 | Full shift | 5 | 8 | 3 | M2 |

## Milestones

| ID | Date | What is true that day | Criterion | Status |
|---|---|---|---|---|
| M1 | 2026-12-04 | A volunteer registers a loan and a return on the test desk | Demo on the test desk | Upcoming |
| M2 | 2026-12-18 | The desk runs a Saturday shift without help | Shift report signed | Upcoming |

## External dependencies

| ID | What | From whom | Due | Blocks | Plan B | Status | Received |
|---|---|---|---|---|---|---|---|
| EXT-01 | The spreadsheet of tools | Ines Calloway | 2026-11-20 | CAT-01 | Type the first 20 tools by hand | Received | 2026-11-18 |

## Decisions

<!-- mirror -->

| ID | Question | Option A | Option B | Recommendation | Due | Decision | Date |
|---|---|---|---|---|---|---|---|
| DEC-02 | Cap on the late fee | Cap at 10 | No cap | Cap at 10 | 2026-11-25 | | |

## Risks

<!-- mirror -->

| ID | Risk | P | I | Score | Mitigation | Warning signal | Owner |
|---|---|---|---|---|---|---|---|
| RSK-01 | Too few volunteers to test the desk | 3 | 3 | 9 | Ask at the Saturday meeting | Fewer than 2 testers by sprint 1 | Ines Calloway |
| RSK-02 | The late fee stays undecided | 2 | 2 | 4 | Ship with the provisional fee PRV-01 | No board vote by 2026-11-25 | Project lead |
| RSK-03 | The single server stops during a shift | 2 | 3 | 6 | A volunteer restarts it from a written page | Two restarts in one month | Developer |

## RACI

| Activity | Project lead | Developer | Volunteer | Chair |
|---|---|---|---|---|
| Catalogue | A | R | C | I |
| Loans | A | R | C | I |
| Late fee rule | R | C | I | A |
| Opening day | R | C | C | A |

## Gantt

| Item | First sprint | Last sprint |
|---|---|---|
| Catalogue | 1 | 2 |
| Loans | 1 | 2 |
| Reports | 2 | 2 |
