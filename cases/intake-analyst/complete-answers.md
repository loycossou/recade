---
agent: intake-analyst
case: complete-answers
verdict: none
must_contain: ["<svg", "<title>", "PRV-02"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.

intake/questionnaire.md answers, all with status given:
- Idea: Larkfield Lending is a small fictional lender. It wants a web app where a borrower asks for a loan, sees the repayment schedule, and a loan officer approves the file. The users are borrowers (adults, on a phone) and loan officers (6 people, on a laptop). Out of scope: collections and credit scoring. Constraint: amounts are integer cents, a schedule is readable only by the borrower and the officer of the file.
- Budget: 40 000 for the first release, fixed.
- Launch date: 2027-03-01, set by the client.
- Working name: given, "Larkfield Loans".
- Logo: none. Palette: none.

intake/attachments/ holds one file, notes.md: "Interest is computed per month on the outstanding balance. The client team is two people: a product owner and an officer." For this exercise, each call of the provisional command prints the next id, starting at PRV-01.

## Expected

Succeeds. The problem, the users and the scope are known, so the Blocking gaps section says None. and nothing else. The logo and the palette are replaceable gaps: a provisional logo is written as a plain SVG wordmark of the project name (design/provisional-logo.svg, one color, a system font, a title that says it is provisional), and PRV-01 and the next ids are used and marked PROVISIONAL (PRV-nn) in the brief. The brief has the H2 sections its rules list.
