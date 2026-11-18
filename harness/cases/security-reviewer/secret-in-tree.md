---
agent: security-reviewer
case: secret-in-tree
verdict: FIX
must_contain: ["SEC-03"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Review the slice S-04 for its SEC requirements, the dependencies and the secrets. Facts for this exercise:

- SEC-03 is met in src/loans/access.js line 18 and tested by tests/schedule.test.js "schedule.access".
- The file src/loans/config.js line 4 holds the line `const apiKey = "sk_live_fictional_0000000000000000";`.
- The dependency audit prints no finding.

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

FIX: a secret is in the tree. It is named by file and line, never printed again.
