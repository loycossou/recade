---
agent: ux-designer
case: journey-with-sensitive-action
verdict: none
must_contain: ["confirm", "mermaid"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: contribute. Language en.

docs/D1.md, outline of sections 4 and 6 (project lead):
- 4. Actors: borrower, loan officer, administrator.
- 6. Journeys: J-1 a borrower applies for a loan; J-2 an officer approves a file; J-3 an administrator revokes an officer's access.

intake/brief.md (extract): Larkfield Lending is a small fictional lender. It wants a web app where a borrower asks for a loan, sees the repayment schedule, and a loan officer approves the file. The users are borrowers (adults, on a phone) and loan officers (6 people, on a laptop). Out of scope: collections and credit scoring. Constraint: amounts are integer cents, a schedule is readable only by the borrower and the officer of the file. Surfaces: a phone web page for borrowers, a laptop back office for officers and administrators.

## Expected

Succeeds. Section 4 lists each actor, each surface and a roles by modules matrix. Section 6 has one H3 per journey with who, trigger, numbered steps and outcome, names the screens each journey touches, and a Mermaid figure where the order matters. The sensitive action (revoking access) has an explicit confirmation step. The Report has the Glossary terms slot with the terms used. Nothing outside sections 4 and 6 is written.
