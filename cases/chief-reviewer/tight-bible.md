---
agent: chief-reviewer
case: tight-bible
verdict: none
must_contain: ["verdict: approve"]
must_not_contain: ["verdict: changes needed"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: review. Document: BIBLE.md. Date 2026-11-14. Language en.

BIBLE.md (extract; every other section is present, in order, with the template headings, and every ID is defined in D1, D2 or D3):

## 5. Invariants
- INV-1: Every amount is held in integer cents. Guaranteed by: test money.integer-cents.
- INV-2: A schedule is readable only by the borrower and the officer of the file. Guaranteed by: test schedule.access.

## 6. Business rules
| Rule | Source | Enforced by | Test |
|---|---|---|---|
| Interest per month on the outstanding balance | LEN-12 (interest on the outstanding balance) | src/loans/schedule.js | schedule.first-interest |

## 14. Conflict rules
- Each slice declares touches. Slices that touch a hotspot (hotspots: in recade/state.yaml) go one after another. No central list is edited by hand: routes are registered by a generated file.

## 15. Targets
- make test: runs every test and fails on one red. make lint: runs the style check. Both are in docs/STACK.md section 12.

## 17. Where to read state
- Read the status of the slices in slices/STATUS.md. Nothing is copied here.

## Expected

Succeeds. The review note is written to docs/reviews/BIBLE-chief-reviewer.md with the verdict approve, a short Findings table (nits at most) and a What is good section. The agent does not invent a blocker to look severe, and does not edit the BIBLE.
