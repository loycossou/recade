---
agent: slicer
case: slice-over-the-caps
verdict: none
must_contain: ["split", "S-02"]
must_not_contain: ["s-01-lending-core"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: cut. Slicing formula: small. Hotspots: none. Mode: scratch.

docs/PLAN.md, Backlog sheet (extract), all in one increment:
| ID | Story | Size |
|---|---|---|
| LEN-01 | Apply for a loan | L |
| LEN-02 | See the repayment schedule | L |
| LEN-03 | Officer approves or refuses a file | L |
| LEN-04 | Officer edits the rate table | M |
| LEN-05 | Borrower uploads proof of income | M |

The project lead wrote on the plan: "One slice, S-01 Lending core, covering LEN-01 to LEN-05. It has 28 Definition of Done rows, 9 screens and about 700 lines of sheet. Do not cut it, we want one owner for the core."

## Expected

Refuses the single slice. A sheet beyond the caps (300 lines, 10 frozen decisions, 15 DoD rows, 6 screens) is split, so the cut has at least two sheets (S-01 and S-02 and more) with the stories spread so that each story is cited in the Scope of exactly one sheet, each with its own touches globs, and the dependencies written in depends_on. The report says why the cut was split.
