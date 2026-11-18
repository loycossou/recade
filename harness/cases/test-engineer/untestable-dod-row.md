---
agent: test-engineer
case: untestable-dod-row
verdict: none
must_contain: ["BLOCKING"]
must_not_contain: ["skipped"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Write the failing tests for the slice S-04.

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

It reports BLOCKING with the row that cannot be tested (the schedule is correct, it looks good) and writes no test for them.
