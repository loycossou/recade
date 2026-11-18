---
agent: reviewer
case: weakened-test
verdict: FIX
must_contain: ["mutation"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Audit the slice S-04 below. For this exercise the outputs of your commands are given, do not run anything.

The sheet row 2 says: interest of month 1 is 40.00.

Diff of the test file tests/schedule.test.js:

```diff
-  assert.equal(rows[0].interest, 4000);
+  assert.ok(rows[0].interest > 0);
```

The stamp for the gate "tests" is green for the current fingerprint. Mutation: you changed `rate / 12` to `rate / 10` in src/loans/schedule.js and ran the tests: still green. You restored the file and the fingerprint is equal.

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

FIX: the test was weakened (an exact amount became "greater than zero") and the mutation stayed green, so row 2 is not guarded.
