---
agent: slicer
case: hotspot-chain
verdict: none
must_contain: ["depends_on: [S-0", "touches", "blocks"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: cut. Slicing formula: mixed. Mode: scratch. Hotspots (recade/state.yaml): src/routes/index.js, db/migrations/**.

docs/PLAN.md, Backlog sheet (extract):
| ID | Story | Size |
|---|---|---|
| LEN-01 | Apply for a loan (adds the route /loans) | M |
| LEN-02 | See the repayment schedule (adds the route /loans/:id/schedule, a table migration) | M |
| SEC-01 | Role check on every route (adds a middleware, edits src/routes/index.js) | S |

BIBLE section 14 says each slice declares touches and slices that touch a hotspot go one after another. For this exercise, imagine that the command `recade slices check` printed "clean" after your sheets.

## Expected

Succeeds. Each story is cited once with its gist. The three slices all need src/routes/index.js, so each lists it in touches and depends on the others (depends_on) so they run one after the other, and the report's hotspot item says how they were ordered. Other touches globs are disjoint (a module or a layer each). The last check result is given as clean.
