---
agent: bible-writer
case: hotspots-in-report
verdict: none
must_contain: ["db/migrations/**", "touches"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: draft. Project folder /work/larkfield.

docs/STACK.md, section 9 and section 12 (extract): Node 20, Express 4 (every route is registered in src/routes/index.js), PostgreSQL 16 (migrations in db/migrations/, named by timestamp), dependencies pinned in package.json and package-lock.json, make targets: make test, make lint, make build. BIBLE section 14 must cite hotspots: in recade/state.yaml.

Do not print the whole BIBLE: print its sections 14 and 15 and the Report.

## Expected

Succeeds. Section 14 cites hotspots: in recade/state.yaml and does not copy the list; each slice declares touches, slices on a hotspot go one after another, migrations are named by timestamp. Section 15 lists the make targets of STACK section 12 and what each proves. The Report item 4 lists the hot path globs, one each, no comma inside a glob: src/routes/index.js, db/migrations/**, package.json and package-lock.json. The agent does not edit recade/state.yaml.
