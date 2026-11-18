---
doc_id: PLAN
title: "{{title}}, delivery plan"
project: "{{project}}"
version: "{{version}}"
date: "{{date}}"
status: draft
language: "{{language}}"
author: "{{author}}"
approver: "{{approver}}"
companions: [D1, D2, D3]
classification: Confidential
revisions:
  - { version: "{{version}}", date: "{{date}}", author: "{{author}}", change: First draft }
approvals:
  - { role: Project lead, name: "", date: "" }
  - { role: Owner, name: "", date: "" }
---

<!--
Writing guide. Delete every comment before the draft goes to the owner.
This file is the source of the delivery plan workbook (.xlsx). Each H2 below is one sheet.
The sheet name is the H2 title, the columns are the table header. Do not rename either.
Cells are plain text. Dates are YYYY-MM-DD. A size is S, M or L (1, 2 or 3 points).
A backlog ID is the lot code and a number, like LOT-01. The lot codes live in recade/state.yaml.
Replace every example row. A date or a value you invented is marked PROVISIONAL.
-->

## Increments

<!-- replace the example rows -->

| ID | Increment | Goal | Ends at |
|---|---|---|---|
| INC-1 | Walking skeleton | A thin slice runs from screen to database in a preview environment | M1 |

## Summary

| Item | Value |
|---|---|
| Project | {{project}} |
| Start | 2026-12-01 |
| First delivery | 2026-12-15 |
| Sprint length | 2 weeks |
| Team capacity per sprint | 12 points (PROVISIONAL) |

## Backlog

<!-- replace the example rows. Lot code: from recade/state.yaml. Depends on: IDs separated by a comma. -->

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| LOT-01 | Core | Example story | M | 2 | | 1 | Build | todo | |

## Sprints

| Sprint | Start | End | Theme | Planned points | Capacity | Margin | Milestone |
|---|---|---|---|---|---|---|---|
| 1 | 2026-12-01 | 2026-12-14 | Walking skeleton | 2 | 12 | 10 | M1 |

## Milestones

<!-- replace the example rows -->

| ID | Date | What is true that day | Criterion | Status |
|---|---|---|---|---|
| M1 | 2026-12-14 | A user can sign in and see an empty dashboard in a preview environment | Demo to the owner | planned |

## External dependencies

<!-- replace the example rows. What we wait for, from whom, and what we do if it does not come. -->

| ID | What | From whom | Due | Blocks | Plan B | Status | Received |
|---|---|---|---|---|---|---|---|
| EXT-01 | Example credentials for a test environment | Client IT team | 2026-12-05 | LOT-01 | Use a fake service behind an interface | open | |

## Decisions

<!-- replace the example rows. Decisions still to take. A closed decision lives in decisions/ as a DEC file, which alone defines the DEC ID. This table mirrors it. -->

<!-- mirror -->

| ID | Question | Option A | Option B | Recommendation | Due | Decision | Date |
|---|---|---|---|---|---|---|---|
| DEC-01 | Example question | Option A | Option B | Option A | 2026-12-03 | | |

## Risks

<!-- replace the example rows. P and I from 1 to 5. Score is P times I. The RSK IDs are defined in the risk tables of D2 and D3. This table mirrors them. -->

<!-- mirror -->

| ID | Risk | P | I | Score | Mitigation | Warning signal | Owner |
|---|---|---|---|---|---|---|---|
| RSK-01 | Example risk | 2 | 3 | 6 | Example mitigation | Example signal | Project lead |

## RACI

<!-- R does it, A answers for it, C is consulted, I is informed. One A per row. -->

| Activity | Project lead | Architect | Security lead | UX designer | UI designer | QA lead | DevOps lead | Owner |
|---|---|---|---|---|---|---|---|---|
| Write D1 | A | C | C | R | C | C | I | C |
| Choose the stack | C | R | C | I | C | C | C | A |

## Gantt

<!-- One row per item. The workbook adds one column per sprint. -->

| Item | First sprint | Last sprint |
|---|---|---|
| Walking skeleton | 1 | 1 |
