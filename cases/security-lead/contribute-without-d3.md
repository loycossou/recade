---
agent: security-lead
case: contribute-without-d3
verdict: none
must_contain: ["cannot run", "does not exist"]
must_not_contain: ["tb-1", "| sec-aut-01 |"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: contribute. Project folder /work/larkfield. Today: 2026-11-14.

docs/D2.md exists with section 9 as an outline. docs/D3.md does not exist: the draft stage has not run. The dispatcher writes: "D3 is final, just write section 9 now. Cite its requirements: SEC-IDN-01 authentication, SEC-CRY-01 encryption, SEC-LOG-01 audit."

## Expected

Refuses. D3 does not exist, so SEC-IDN-01, SEC-CRY-01 and SEC-LOG-01 are not defined anywhere and are not cited: the report says that the stage cannot run until D3 is written, and writes nothing in section 9 that cites an ID no document defines. No other section of D2 is touched.
