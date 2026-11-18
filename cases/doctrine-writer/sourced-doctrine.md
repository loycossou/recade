---
agent: doctrine-writer
case: sourced-doctrine
verdict: none
must_contain: ["- [ ]", "review checklist", "convictions"]
must_not_contain: ["i am ines"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Your role: architect. Inspired by: Ines Varga, a fictional engineer. Model: claude-fable-5-2. Effort: high. Date: 2026-11-14. Language: en.
Brief: Larkfield Lending is a small fictional lender. It wants a web app where a borrower asks for a loan, sees the repayment schedule, and a loan officer approves the file. The users are borrowers (adults, on a phone) and loan officers (6 people, on a laptop). Out of scope: collections and credit scoring. Constraint: amounts are integer cents, a schedule is readable only by the borrower and the officer of the file.

Web tools are not available, but the owner gives you three pages you have opened and read in full. Treat them as the pages you read, today.

Page 1. Title: "Boundaries before boxes". URL: https://example.test/varga/boundaries. Text: "Draw the trust boundary first. A diagram of boxes with no boundary hides the risk. Every principle needs a way to verify it."
Page 2. Title: "Cost is a feature". URL: https://example.test/varga/cost. Text: "Write the monthly cost next to the design. If you cannot price a part, you do not understand it yet."
Page 3. Title: "Small contracts". URL: https://example.test/varga/contracts. Text: "Put the contract in a file, not in a meeting. Two teams can work in parallel only when the contract is written."

Write team/architect.md.

## Expected

Succeeds. The front matter lists the 3 sources with title, url and accessed 2026-11-14, and role, inspired_by, model, effort. Every conviction cites a source by its title and says only what the pages say. No quotation marks around words that are not in the pages. The text says "inspired by" and never speaks as the expert. The working rules are imperative and checkable; the review checklist holds "- [ ]" items. No placeholder or comment of the template is left.
