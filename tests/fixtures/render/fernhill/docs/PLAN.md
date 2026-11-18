---
doc_id: PLAN
title: Fernhill Lending, delivery plan
project: Fernhill Lending
version: 1.0
date: 2026-11-13
status: Draft
author: Mara Quill
org: Fernhill Tool Library
language: en
---

# Delivery plan

## 1. Summary

| Item | Value |
|---|---|
| Goal | Open the tool library desk to members |
| Sprints | 3 |
| Sprint length | 2 weeks |
| Start | 2026-11-16 |
| Launch target | 2026-12-28 |
| Team | 1 lead, 2 developers, 4 volunteers |

## 2. Milestones

| ID | Date | What is true that day | Criterion | Status |
|---|---|---|---|---|
| M1 | 2026-11-27 | Members can borrow a tool end to end | One loan completed on the test desk | In progress |
| M2 | 2026-12-11 | The desk team runs a full shift without help | Volunteer shift report signed | Upcoming |
| M3 | 2026-12-28 | The library is open to the neighbourhood | First public opening day held | Upcoming |

## 3. Backlog

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| B-01 | Catalogue | Tool records | M | 2 | | S1 | Build | Done | |
| B-02 | Catalogue | Photo upload | S | 1 | B-01 | S1 | Build | Done | Photos kept under 2 MB |
| B-03 | Loans | Borrow flow | L | 3 | B-01 | S1 | Build | In progress | Café table pilot |
| B-04 | Loans | Return and condition check | M | 2 | B-03 | S2 | Build | Ready | |
| B-05 | Members | Sign-up and ID check | M | 2 | | S2 | Build | Ready | |
| B-06 | Loans | Late fee rule | S | 1 | B-04 | S2 | Build | Blocked | Waits on the board vote (PRV-03) |
| B-07 | Desk | Volunteer rota | M | 2 | B-05 | S3 | Build | Backlog | |
| B-08 | Reports | Monthly loan report | L | 3 | B-04 | S3 | Verify | Backlog | |
| B-09 | Members | Reminder messages | S | 1 | B-05 | S3 | Build | Backlog | Quotes & tone to review |

## 4. Sprints

| Sprint | Start | End | Theme | Planned points | Capacity | Margin | Milestone |
|---|---|---|---|---|---|---|---|
| S1 | 2026-11-16 | 2026-11-27 | Catalogue and first loan | 6 | 6 | 0 | M1 |
| S2 | 2026-11-30 | 2026-12-11 | Returns and members | 5 | 6 | 1 | M2 |
| S3 | 2026-12-14 | 2026-12-28 | Desk and reports | 6 | 5 | -1 | M3 |

## 5. External dependencies

| ID | What | From whom | Due | Blocks | Plan B | Status | Received |
|---|---|---|---|---|---|---|---|
| X-01 | Shelf barcode labels | Print shop | 2026-11-06 | B-01 | Handwritten labels | Late | |
| X-02 | Insurance certificate | Town council | 2026-12-04 | M3 | Delay the opening | Asked | |
| X-03 | Donated tablet for the desk | Local school | 2026-11-20 | B-03 | Use a volunteer laptop | Received | 2026-11-12 |

## 6. Decisions

| ID | Question | Option A | Option B | Recommendation | Due | Decision | Date |
|---|---|---|---|---|---|---|---|
| DEC-01 | Late fee amount | Flat 2 per day | Capped at 10 | Capped at 10 | 2026-11-25 | | |
| DEC-02 | Deposit for power tools | Yes | No | Yes | 2026-12-02 | | |

## 7. Risks

| ID | Risk | P | I | Score | Mitigation | Warning signal | Owner |
|---|---|---|---|---|---|---|---|
| R-01 | Too few volunteers for the desk | 3 | 3 | 9 | Recruit at the neighbourhood fair | Fewer than 3 sign-ups by S2 | Lead |
| R-02 | Tools damaged and not reported | 2 | 2 | 4 | Condition check on every return | Rising repair costs | Dev |
| R-03 | Board vote on fees slips | 2 | 3 | 6 | Ship with a neutral default | No agenda slot by 2026-11-25 | Lead |
| R-04 | Donated tablet fails | 1 | 2 | 2 | Keep a spare laptop | First crash during the pilot | Volunteer |

## 8. RACI

| Activity | Lead | Dev | Volunteer | Board |
|---|---|---|---|---|
| Catalogue upload | A | R | C | I |
| Borrow flow | A | R | C | I |
| Late fee rule | R | C | I | A |
| Desk rota | A | I | R | I |
| Public opening | R | C | C | A |

## 9. Gantt

| Item | First sprint | Last sprint |
|---|---|---|
| Catalogue | S1 | S1 |
| Loans | S1 | S2 |
| Members | S2 | S3 |
| Desk and reports | S3 | S3 |

## Notes

This section is ignored by the workbook.
