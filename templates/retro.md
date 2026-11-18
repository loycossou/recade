---
doc_id: "{{doc_id}}"
title: "{{title}}"
project: "{{project}}"
version: "{{version}}"
date: "{{date}}"
status: draft
language: "{{language}}"
---

<!--
Lives at retros/INC-<n>.md. Written at the end of an increment, from the board and the journals.
Numbers come from the repository and the board, not from memory. Keep it honest and short.
Delete every comment once the file is final.
-->

# Retrospective

## Demo

What was shown, to whom, on what date, and what the owner said.

## Delivered

| Slice | What shipped | Merged on |
|---|---|---|
| Example slice | Example outcome | 2026-12-14 |

## Decisions

| Decision | Outcome |
|---|---|
| Example decision | Example outcome |

## Carry-over

| Item | Why it moved | New home |
|---|---|---|
| Example item | Example reason | Next increment |

## Provisionals still open

<!-- Copy the open rows of intake/provisionals.md, with their due dates. -->

| What | Who gives the real one | Due |
|---|---|---|
| Example provisional | Client | 2026-12-20 |

## Quarantined tests

<!-- Filled from the tests/quarantine.json of each code repository. An increment cannot close with a quarantined test of its own slices: fix it, then run recade quarantine remove. -->

| Test | Slice | Since | Reason |
|---|---|---|---|
| Example test | S-01 | 2026-12-01 | Example reason |

## DORA metrics

| Metric | Value | Compared with last increment |
|---|---|---|
| Deployment frequency | Example | Example |
| Lead time for changes | Example | Example |
| Change failure rate | Example | Example |
| Time to restore service | Example | Example |

## Cost per slice

| Slice | Elapsed time | FIX loops | Tokens |
|---|---|---|---|
| Example slice | Example | Example | Example |

Elapsed time is the wall clock from the start of the slice to its end, gate waits included.

## Recalibrated dates

| Milestone | Old date | New date | Why |
|---|---|---|---|
| Example milestone | 2027-01-15 | 2027-01-22 | Example reason |

## Spec back-ports done

<!-- Changes made to D1, D2, D3 or the BIBLE because of what the build taught us. -->

- Example back-port.

## How to open the next increment

1. Review the stack's conditions for re-examination.
2. Close or carry the provisionals above.
3. Slice the next increment and pass the gate.
