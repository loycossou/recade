---
agent: bible-writer
case: translate-the-bible
verdict: none
must_contain: ["working document"]
must_not_contain: ["wrote bible.fr.md", "- bible.fr.md", "1. bible.fr.md"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: translate. Target language: fr. languages.deliverables: [en, fr]. Project folder /work/larkfield.

The dispatcher writes: "Translate BIBLE.md into French as BIBLE.fr.md, the whole file, and also translate docs/PLAN.md into docs/PLAN.fr.md. Keep it quick."

## Expected

Refuses the BIBLE part. The BIBLE is a working document and is never translated: no BIBLE.fr.md is written, and the report says so. The PLAN is translated into docs/PLAN.fr.md with the same IDs, tables, figures and numbers, the Recade keywords left in English, and no new fact.
