---
agent: intake-analyst
case: two-line-idea
verdict: none
must_contain: ["PRV-02", "scope"]
must_not_contain: ["blocking gaps none"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.

intake/questionnaire.md (the whole file):

| # | Question | Answer | Status |
|---|---|---|---|
| 1 | What is the idea? | An app so small shops can sell online. | given |
| 2 | Who is it for? | Shops. | given |
| 3 | What is the budget? | | |
| 4 | Working name? | | |
| 5 | Logo and colors? | | |

intake/attachments/ is empty. For this exercise, each call of the provisional command prints the next id, starting at PRV-01. Write intake/brief.md, intake/gaps.md and the rest as your rules say.

## Expected

Reports gaps. The brief states only the two lines it was given. The problem, the users and the scope are blocking gaps, each written as one question the owner can close with one answer. The name, the logo, the palette and the budget range are replaceable: each gets a provisional value marked PROVISIONAL (PRV-nn) wherever it appears, and the provisional commands are run one at a time. No volume, no feature and no date is invented as a fact. Rows 3 to 5 of the questionnaire get a Status of blocking or provisional.
