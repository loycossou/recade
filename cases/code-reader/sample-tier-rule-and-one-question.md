---
agent: code-reader
case: sample-tier-rule-and-one-question
verdict: none
must_contain: ["Golden files", "DONTs", "DEV-01", "SRC-01", "enforced: no"]
must_not_contain: ["read all", "enforced: test repos/ledger/src/ledger"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode adopt, full false, languages.work en, voice: short plain sentences, no em dash. Project folder /work/larkfield-ledger-workspace, with one code repository, ledger, at repos/ledger. Today is 2026-11-18.

Output of `recade adopt from-code --json` (shortened):
- reading: { tier: "sample", files: 120, maxFilesPerCapability: null }.
- targets: docs/RULES.md, docs/INVARIANTS.md, docs/CONTRACTS.md, none written yet.
- sources: { id: "SRC-01", path: "repos/ledger/docs/architecture.md", copy: "docs/source/ledger/docs/architecture.md" }.
- gaps: none.

What you read (a sample of the 120 files, the rest not opened):
- 118 of the 120 files under repos/ledger/src/handlers/ return `{ ok: false, error }` on failure and never throw. The two that throw are repos/ledger/src/legacy/payout.js:44 and repos/ledger/src/legacy/refund.js:61.
- repos/ledger/src/handlers/loan-create.js is the cleanest handler: validation, one service call, one result object. Its test is repos/ledger/tests/handlers/loan-create.test.js.
- Named exports against default exports: 58 modules use named exports (for example repos/ledger/src/lib/money.js:3), 62 use a default export (for example repos/ledger/src/lib/dates.js:7). Nothing in the repository says which one is wanted.
- repos/ledger/src/ledger/balance.js:18 has a comment: "a balance must never go below zero". No test and no check enforces it; repos/ledger/src/ledger/balance.js:40 subtracts without a guard.
- repos/ledger/docs/architecture.md says all money values are integers in cents. repos/ledger/src/ledger/fees.js:22 computes a fee with a floating point number.
- repos/ledger/docs/architecture.md says handlers are the only place that talk to the database. repos/ledger/src/reports/monthly.js:30 queries the database directly.

Write docs/RULES.md, docs/INVARIANTS.md, and the deviations section of docs/inventory.md as your rules say.

## Expected

Succeeds. docs/RULES.md has the three sections "Golden files", "Rules" and "DONTs", in that order. The golden files list repos/ledger/src/handlers/loan-create.js with one line on why. The handler pattern (118 of 120, more than 95 percent) is written as a rule, with its check, without asking the owner, and the two throwing files are DONTs with their `path:line`. The named against default export split is not written as a rule: the report holds exactly one closed question with the file:line evidence of both sides (repos/ledger/src/lib/money.js:3 and repos/ledger/src/lib/dates.js:7), a recommended option and a safe default. The tier is "sample" and the files not read are listed as deferred. docs/INVARIANTS.md has the balance invariant with `enforced: no`, and the register has a row for it. The register rows have a `path:line`, an axis, a severity and an effort: the floating point fee, the direct query and the unenforced balance each get a row. The documents cite SRC-01 by its ID. Files are written through `recade adopt write` only, and the original docs/architecture.md is not touched.
