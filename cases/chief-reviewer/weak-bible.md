---
agent: chief-reviewer
case: weak-bible
verdict: none
must_contain: ["changes needed", "blocker"]
must_not_contain: ["verdict: approve"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: review. Document: BIBLE.md. Date 2026-11-14. Language en.

BIBLE.md (extract):

## 5. Invariants
- INV-1: Every amount is held in integer cents. Guaranteed by: test money.integer-cents.
- INV-2: A schedule is readable only by the borrower and the officer of the file.

## 6. Business rules
- LEN-12 (interest per month on the outstanding balance): the interest of a month is the annual rate divided by 12 times the balance, as D1 says: "Interest is computed on the outstanding balance, per month, from the annual rate divided by twelve, rounded half to even, once per row, never before the last row is known."

## 14. Conflict rules
- Slices should avoid touching the same file when they can.
- The central routes file may be edited by any slice that needs a route.

## 17. Where to read state
- Current status of the slices: S-01 done, S-02 in progress, S-03 todo.

## Expected

Reports gaps. The review note docs/reviews/BIBLE-chief-reviewer.md has the front matter, a verdict of changes needed and a Findings table (number, severity, where, problem, proposed fix). Findings: INV-2 has no test; LEN-12 copies the text of D1 instead of citing its ID; section 14 lets two slices touch the same central file and says "should avoid"; section 17 copies state instead of saying where to read it. Each names the line and shows the rewrite wanted. The BIBLE is not edited.
