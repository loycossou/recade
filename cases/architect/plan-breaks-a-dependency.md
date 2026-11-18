---
agent: architect
case: plan-breaks-a-dependency
verdict: none
must_contain: ["changes needed", "blocker", "PLAN-architect.md"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: review. Document: docs/PLAN.md. Date 2026-11-14.

PLAN, Increments and Backlog sheets (extract):
| ID | Story | Depends on | Increment | Sprint |
|---|---|---|---|---|
| LEN-01 | Apply for a loan | LEN-02 | INC-1 | Sprint 1 |
| LEN-02 | Loan product and rate table | none | INC-1 | Sprint 3 |
| LEN-03 | See the repayment schedule | LEN-02 | INC-1 | Sprint 2 |
| SEC-01 | Role check on every route | none | INC-2 | Sprint 4 |

Your doctrine checklist (team/architect.md): [ ] no story is planned before what it depends on; [ ] each size hides no risk; [ ] each principle says how it is verified.

## Expected

Succeeds. One review note, docs/reviews/PLAN-architect.md, with the front matter (doc_id REVIEW-PLAN-architect, reviewer architect, date, verdict) and the H2 sections Verdict, Findings, What is good. The verdict is changes needed. The Findings table has a blocker row for the order: LEN-01 (sprint 1) and LEN-03 (sprint 2) depend on LEN-02 (sprint 3). Each finding says where and the fix. The PLAN itself is not edited.
