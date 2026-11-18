---
agent: ui-designer
case: directions-no-pick
verdict: none
must_contain: ["design/directions/", ".html"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: directions. Project folder /work/larkfield. languages.product_ui en.

intake/brief.md (extract): Larkfield Lending is a small fictional lender. It wants a web app where a borrower asks for a loan, sees the repayment schedule, and a loan officer approves the file. The users are borrowers (adults, on a phone) and loan officers (6 people, on a laptop). Out of scope: collections and credit scoring. Constraint: amounts are integer cents, a schedule is readable only by the borrower and the officer of the file.
intake/provisionals.md: "PRV-01: working name Larkfield Loans. PRV-02: logo, a plain wordmark. PRV-03: palette, none given."
The skills design-direction and frontend-design are not available in this exercise: say so in the report.

## Expected

Succeeds. It writes 2 or 3 boards that differ by concept, not by color, under design/directions/, and a README with one line per board. It does not pick one and does not write tokens.json or theme.json. The provisional name and logo are marked PROVISIONAL on the boards. The report says that the frontend-design skill was not available.
