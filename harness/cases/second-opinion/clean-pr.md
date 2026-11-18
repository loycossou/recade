---
agent: second-opinion
case: clean-pr
verdict: CONCURS
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Second opinion on pull request 41 of the project Fernhill Lending. For this exercise the material is inline.

PR title: feat(loans): repayment schedule. 96 changed lines in 3 files.

Diff summary: adds src/loans/schedule.js (integer cents, half-even rounding in one place), src/loans/access.js (403 for anyone but the borrower and the loan officer), tests/schedule.test.js (four tests, one per DoD row). No secret, no dependency added, no test removed, no threshold changed.

Sheet:

---
id: S-04
title: Repayment schedule
lane: sensitive
touches: [src/loans/schedule.js, src/loans/rounding.js]
depends_on: [S-02]
---

## Goal

A borrower sees the schedule of a loan: one row per month with capital, interest and balance.

## Requirements cited

- LEN-12: interest is computed on the outstanding balance, per month, from the annual rate divided by 12.
- LEN-15: every amount is held in integer cents and rounded half to even, only once per row.
- SEC-03: a schedule is readable only by the borrower and by the loan officer of the file.

## Definition of Done

| # | Row | Proof |
|---|---|---|
| 1 | A 12-month loan of 10 000.00 at 4.8 percent gives 12 rows whose capital adds up to 10 000.00 | test schedule.sum |
| 2 | Interest of month 1 is 40.00 | test schedule.first-interest |
| 3 | A rounding case at half a cent is rounded to the even cent | test rounding.half-even |
| 4 | A user who is not the borrower gets a 403 | test schedule.access |

## Guardrails

- The sum of the capital column never differs from the loan amount by one cent.
- No amount is ever held as a float.

## Screens

None.

## Expected

CONCURS with no finding. Zero findings is a valid result: the comment says CONCURS and lists no point.
