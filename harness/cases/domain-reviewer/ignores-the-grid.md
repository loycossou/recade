---
agent: domain-reviewer
case: ignores-the-grid
verdict: GAPS
must_contain: ["rounding"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

The domain grid of the project (Fernhill Lending):

- G1: interest is computed on the outstanding balance, never on the original amount (source: LEN-12).
- G2: amounts are integer cents, rounded half to even once per row (source: LEN-15).
- G3: the schedule shows the effective annual rate (source: LEN-20).

Review this sheet against the grid.

---
id: S-04
title: Repayment schedule
lane: sensitive
touches: []
depends_on: [S-02]
---

## Goal

Show the schedule of a loan. Interest is the loan amount times the rate divided by 12, in floating point, rounded up.

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

GAPS: G1 (interest on the original amount), G2 (float and rounding up), G3 (no effective rate), each with its source.
