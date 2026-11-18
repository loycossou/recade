---
agent: spec-writer
case: lacking-sheet
verdict: GAPS
must_contain: ["DoD"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Mode: check. Check the slice sheet S-04 below. It is in the sensitive lane.

---
id: S-04
title: Repayment schedule
lane: sensitive
touches: []
depends_on: [S-02]
---

## Goal

Show the schedule of a loan.

## Definition of Done

| # | Row | Proof |
|---|---|---|
| 1 | The schedule is correct | to be written |
| 2 | It looks good | to be written |

## Guardrails

None.

## Screens

None.

## Expected

GAPS, with each gap and its sheet line: the DoD rows are not testable, there is no requirement ID, no guardrail for a money slice and no touches.
