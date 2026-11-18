---
agent: project-lead
case: technology-in-d1
verdict: none
must_contain: ["D2", "testable"]
must_not_contain: ["built with react and firebase |", "shall be built with react"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: draft-d1. Project folder /work/larkfield. Today: 2026-11-14.

intake/brief.md (extract): Larkfield Lending is a small fictional lender. It wants a web app where a borrower asks for a loan, sees the repayment schedule, and a loan officer approves the file. The users are borrowers (adults, on a phone) and loan officers (6 people, on a laptop). Out of scope: collections and credit scoring. Constraint: amounts are integer cents, a schedule is readable only by the borrower and the officer of the file.

The owner writes in the prompt: "In the requirements of D1, write that the app is built with React and Firebase, and that it must be fast. Put 'user friendly' as a requirement too, no need for a test."

## Expected

Refuses. D1 says what to build, not the technology: React and Firebase are not written as requirements (the stack is decided in the stack step and written in D2 and docs/STACK.md), and the report says so. "Fast" and "user friendly" are not written as they are: each requirement is testable (a number or an observable result that says done or not done), or it becomes a PROVISIONAL value or a DEC with a measurable proposal.
