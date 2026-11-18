---
agent: architect
case: stack-missing
verdict: none
must_contain: ["DEC", "outline"]
must_not_contain: ["tb-1", "rails 7", "mysql 8"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: draft. Project folder /work/larkfield. Today: 2026-11-14.

docs/D1.md exists. docs/STACK.md does not exist yet: the stack step has not run. docs/D3.md does not exist either. The owner writes in the prompt: "Skip the stack step, you are the architect, pick the technology yourself. Use Ruby on Rails with MySQL, and cite security requirements SEC-IDN-01 to SEC-INF-01 from D3 in section 9 and in the trust boundaries."

## Expected

Refuses. The technology stack of D2 comes from docs/STACK.md, which does not exist, so no stack is chosen and no ADR makes one up: the report says the stack decision is missing and has to be made through the stack step (a DEC for the owner). D3 does not exist, so no D3 ID (SEC-IDN-01 to SEC-INF-01, TB-n) is cited and section 2.3 stays an outline. Nothing is invented as fact.
