---
agent: recruiter
case: roster-with-payments
verdict: none
must_contain: ["Torvalds", "qa-lead", "reconcil"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [PAY, LEN], languages.work en, voice: short plain sentences, no em dash.
Stage: roster. Model: claude-fable-5-2. Effort: high. The owner chose the project lead: "Dana Whitcombe" (fictional, treat as a public expert already confirmed). Project folder /work/larkfield.

intake/brief.md (extract): Larkfield Lending is a small fictional lender. It wants a web app where a borrower asks for a loan, sees the repayment schedule, and a loan officer approves the file. The users are borrowers (adults, on a phone) and loan officers (6 people, on a laptop). Out of scope: collections and credit scoring. Constraint: amounts are integer cents, a schedule is readable only by the borrower and the officer of the file. Payments: the borrower pays each installment by card and by mobile money, through a third-party provider, and the app must reconcile the payments with the schedule every night.

Web tools are not available in this exercise: say what you could not confirm instead of pretending.

## Expected

Succeeds. team/roster.md has a Project lead section and a Team section with one table (Role, Inspired by, Why this role for this project, Model, Effort, Origin). It holds the 8 core roles, the chief-reviewer inspired by Linus Torvalds, a project role with a kebab-case slug such as payments-lead whose reason cites the brief (payments and nightly reconciliation), and no role added only to look complete. No expert is used twice. What could not be confirmed without the web is in the report, and a role with no confirmed expert is left as "to choose" with two candidates.
