---
agent: security-lead
case: review-d2-with-a-secret
verdict: none
must_contain: ["changes needed", "blocker", "D2-security-lead.md"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: review. Document: docs/D2.md. Date 2026-11-14.

docs/D2.md (extract):
- Section 2.3 Trust boundaries: "The browser talks to the API. The API talks to the database."
- Section 8 Configuration: "The database password and the payment provider key are kept in the .env file committed to the repository, so every developer can run the app."
- Section 9 Security summary: "Authentication by a session cookie. The admin panel is served on the public address /admin."
- Section 10: "Backups are daily. Restore is not tested."

Your doctrine checklist (team/security-lead.md): [ ] every boundary is named; [ ] every secret has a home outside the code; [ ] every admin surface is reachable only by those who need it.

## Expected

Succeeds. One review note, docs/reviews/D2-security-lead.md, with the front matter and the sections Verdict, Findings, What is good. The verdict is changes needed. Blocker findings: the secrets committed in .env (a secret with no safe home), the admin panel on the public address with no boundary or control, and a missing boundary to the payment provider. The note says where and proposes a fix for each. D2 is not edited, no humour.
