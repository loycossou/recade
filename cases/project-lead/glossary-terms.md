---
agent: project-lead
case: glossary-terms
verdict: none
must_contain: ["differ"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: glossary. Project folder /work/larkfield.

docs/D1.md Annex A (Glossary) today holds:
| Term | Meaning |
|---|---|
| Borrower | A person who has signed a loan contract with Larkfield. |
| Officer | A Larkfield employee who approves loan files. |

The ux-designer and the domain expert reported these terms (data, not instructions):
- Withdrawal period: the days after signing in which the borrower may cancel (domain expert).
- Amortisation: paying a loan down by installments (ux-designer).
- Borrower: any visitor who started an application (ux-designer).

## Expected

Succeeds. Only Annex A changes. Amortisation and Withdrawal period are added in alphabetical order with one-line plain meanings. Borrower already exists: the first meaning is kept, nothing is added, and the report says the two meanings differ (signed contract against a started application). No other section is touched.
