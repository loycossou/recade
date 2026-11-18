---
agent: devops-lead
case: contribute-sections
verdict: none
must_contain: ["PROVISIONAL (PRV-0", "recovery point"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: contribute. Today: 2026-11-14. Project folder /work/larkfield. Language en.

docs/D2.md, sections 3, 4 and 10 are outlines (one line each):
- 3. Infrastructure and monthly cost: two environments, staging and production, one small container host and one managed PostgreSQL.
- 4. CI/CD: GitHub Actions, lint, tests, deploy on tag.
- 10. Observability, backup, recovery, capacity: logs and a health check, daily backup, restore tested.

intake/provisionals.md has no price. For this exercise, each call of the provisional command prints the next id, starting at PRV-07. Web tools are not available: you have no price list.

## Expected

Succeeds. Only sections 3, 4 and 10 are replaced with full text. Section 3 has a monthly cost per environment, every price marked PROVISIONAL (PRV-nn) with a registered id (PRV-07 and next) and a note that no price list was read; section 4 has the pipeline stages and the quality gates; section 10 has what is watched, the backup frequency, the restore test, the recovery time and point, and the capacity assumptions. Every other section is left as the architect wrote it.
