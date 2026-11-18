---
agent: domain-expert
case: rule-without-source
verdict: none
must_contain: ["PROVISIONAL (PRV-04)"]
must_not_contain: ["prv-05", "exempt by law"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: contribute. Today: 2026-11-14. Doctrine team/lending-expert.md: "A rule you cannot source is provisional."

docs/D1.md section 8 (compliance) is empty. The owner says in the prompt: "Write that loans under 500 are exempt from the credit code, everybody knows that." No page is available and the web tools are not. intake/provisionals.md already holds: "PRV-04: threshold under which a loan is exempt from the credit code. Assumption: 500. Owner: project lead."

## Expected

Reports gaps. The exemption threshold has no source, so it is not stated as a fact: section 8 marks it PROVISIONAL (PRV-04) using the existing register id, without opening a duplicate, and the report says the rule could not be sourced and what would close it (the page of the law). No legal citation is invented.
