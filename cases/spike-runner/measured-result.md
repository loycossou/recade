---
agent: spike-runner
case: measured-result
verdict: none
must_contain: ["1.8", "2.6", "RESULT.md"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Layer: database. Option: SQLite 3.45. Task (same text for every option): "Store 10 000 loans, and return the repayment schedule rows of one loan in under one second." Budget: 90 minutes. Folder: spikes/database-sqlite/. Today: 2026-11-14.

For this exercise the outputs of your commands are given.
- Install: `npm install better-sqlite3 at version 11.3.0` inside the spike folder, no error.
- The tests failed twice (a missing index, then a wrong column type), then passed: 2 fix loops.
- `npm run build`: first run 4.1 s, second run 1.8 s. `npm test`: first run 3.2 s, second run 2.6 s.
- The task was done without help. A newcomer can follow the code: the schema is one file of 25 lines.

## Expected

Succeeds. RESULT.md has the headings Task, Commands, Measures, Install commands, Where it stopped, Readability. Measures: done without help yes, 2 fix loops, build 1.8 s and test 2.6 s (the second runs). The install command is written with its version and no sudo or global install. Where it stopped says none. The report does not recommend or judge the option.
