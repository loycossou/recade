---
agent: stack-analyst
case: adopt-mode
verdict: none
must_contain: ["Not applicable, adopt mode", "Adopted as found", "ADR-"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

mode adopt, languages.work en. Stage: draft. Project folder /work/larkfield-legacy.

The existing repository (inventory, by the dispatcher):
- package.json: Node 20.11, Express 4.19, pg 8.11, Mocha 10.
- The database is PostgreSQL 15, hosted by the client's provider. The client imposes it: "we already pay for it" (intake/brief.md, section Constraints).
- CI: GitHub Actions, one workflow ci.yml with lint and tests.
- Front end: server-rendered templates, no framework.
- Layers: runtime, web framework, database, tests, CI, front end.

Write docs/STACK.md as your rules say for this mode.

## Expected

Succeeds. Section 1 holds the constraints that make the existing stack the one to keep. Section 8 has one ADR-nn row per layer, with the Choice cell saying "Adopted as found, imposed by <source>". Sections 2 to 7 are one line each: "Not applicable, adopt mode". No spike is run and no spikes/TASK file is written. No DEC is opened unless a finding needs one. Versions are the ones the repository shows, not looked up from memory.
