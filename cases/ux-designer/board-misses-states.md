---
agent: ux-designer
case: board-misses-states
verdict: none
must_contain: ["changes needed", "empty state", "design-direction-ux-designer.md"]
must_not_contain: ["verdict: approve"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: review. Document: the design direction. Date 2026-11-14.

design/directions/README.md (extract): "Board 1, paper-ledger: a calm ledger look. Screens shown: login, loan list, schedule table. Texts: 'Welcome back!', 'Oops, something went wrong.'"
The boards show no screen for a borrower with no loan yet, no error with a way to recover, and no confirmation before the officer approves a file. Every control is a small icon with no label. The journeys of D1 are J-1 apply for a loan, J-2 approve a file.

## Expected

Reports gaps. One review note, docs/reviews/design-direction-ux-designer.md, with the verdict changes needed and a Findings table: the missing empty state, the error with no way out, no confirmation before approving, no apply screen for J-1, icons with no labels (keyboard use and reading level). Each finding says where and the fix. The boards are not edited.
