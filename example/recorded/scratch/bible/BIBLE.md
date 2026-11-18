---
doc_id: BIBLE
title: "Fernhill Lending, BIBLE"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
author: "Project lead, Recade team"
approver: "Ines Calloway"
companions: [D1, D2, D3, PLAN]
classification: Confidential
revisions:
  - { version: "0.1", date: "2026-11-18", author: "Project lead, Recade team", change: First draft }
approvals:
  - { role: Project lead, name: "", date: "" }
  - { role: Owner, name: "Ines Calloway", date: "" }
---

## 0. Mission and quality bar

Fernhill Lending is the loan desk of the Fernhill Tool Library. It is good enough to ship when a volunteer registers a loan in under 30 seconds and a tool is never lent twice.

## 1. Mandatory reading order

1. This file, in full.
2. `STATUS.md`, to know where the project stands.
3. The slice sheet you were given.
4. The documents the slice cites, only the cited IDs.

## 2. Verified facts

| Fact | Checked on | How | Re-check by |
|---|---|---|---|
| Node 22 is supported until 2027-04-30 | 2026-11-18 | Project release page | 2027-02-18 |
| The built-in SQLite module is experimental in Node 22 | 2026-11-18 | Spike in STACK section 4 | 2027-02-18 |

## 3. Binding documents by precedence

When two documents disagree, the one higher in this list wins.

1. This file.
2. D3 (security requirements).
3. D1 (functional specifications).
4. D2 (technical architecture) and `STACK.md`.
5. `PLAN.md`.

If none of them answers the question, it is not yours to answer. Raise a `BLOCKING` and stop on that point. Carry on with the rest of the slice.

## 4. Decisions

Decisions are revised, never bypassed. A rule that contradicts a decision is a `FIX`.

| Decision | Where | Status |
|---|---|---|
| DEC-01 (where the desk stores its data): SQLite file | `decisions/` and ADR-02 | accepted |
| DEC-02 (is the late fee capped): cap at 10 | `decisions/` | accepted |

## 5. Invariants

| Invariant | Test that guarantees it |
|---|---|
| A tool is never lent twice (PRI-01) | `npm test` runs the unique index test |
| A log line holds no personal data (PRI-02) | `npm test` runs the log test |

## 6. Business rules

| Rule | Source | What the code enforces | Test |
|---|---|---|---|
| A loan lasts 7 days | FR-LND-01 (register a loan) | The due date is the loan date plus PAR-01 | `test/loans.test.js` |
| A late return costs a fee for each late day, capped | FR-LND-03 (late fee) | The fee function in `repos/api/src/fee.js` | `repos/api/test/fee.test.js` |
| A tool in repair cannot be lent | FR-CAT-02 (tool in repair) | The loan check refuses it | `test/loans.test.js` |

## 7. Conventions

- Tree: one folder per module, tests in `test/`, one file for each rule.
- API: follow the conventions of D2.
- Data: one SQLite file, migrations named by timestamp.
- UI: tokens only, see section 8.
- Language: code, comments and commit messages in English.
- Commits: conventional commits, one idea each, no attribution line.

## 8. Design rules

The defaults of the plugin apply. The art direction `ledger-paper` is in `design/directions/README.md`, and its tokens are in `design/tokens.json`. A value hard-coded outside the tokens is a `FIX`. Every action that cannot be undone goes through a confirmation that names the object and the consequence. Accessibility: WCAG 2.2 AA.

## 9. Writing voice

Everything written for this project follows the voice in `recade/state.yaml`: simple words, short sentences, one idea per sentence.

## 10. Exclusions

- No online booking, no payments, no public site in phase 1 (D1 section 12).
- No messages to members.

## 11. Blockers and escalation

When a question has no answer in the binding documents:

1. Pick the prudent default, the one that is easiest to undo. Mark it `PROVISIONAL`.
2. Write a `BLOCKING` in this format and stop on that point: `BLOCKING: <one closed question>. Options: <A>, <B>. Prudent default meanwhile: <value>. Needed from: <who>.`
3. Log it in `BLOCKERS.md`. Never guess in silence.

## 12. Definition of done

- **Story**: its acceptance lines pass, a test saw each of them fail first, no test was weakened.
- **Slice**: every line of its Definition of Done is green with the counts written down, the code is reviewed.
- **Increment**: its milestone is true, the demo ran, the retro is written.

## 13. Session discipline

- Read before writing. One slice per session.
- Write down decisions as you take them, in the slice sheet.
- Stop at a gate. A gate is passed by the owner's answer, nobody else's.

## 14. Parallelism, WIP limits and model policy

- Run 3 to 5 slices at once when the graph allows it. Never two slices whose `touches:` overlap.
- No agent merges. `gh pr merge` is denied by the configuration.

| Work | Model | Effort |
|---|---|---|
| Writing and sensitive implementation | claude-fable-5-2 | high |
| Mechanical steps | sonnet | medium |

## 15. Quality gates

| Target | Proves |
|---|---|
| `npm run lint` | Style and static checks pass |
| `npm test` | The tests pass, counts are printed |

## 16. Prohibitions

- Never merge a pull request.
- Never weaken a test to make it pass.
- Never put a secret in the repository.
- Never write a hard-coded value outside the design tokens.
- Never edit a binding document without a decision.

## 17. Where to read state

State is never copied here. Read it where it lives:

- `STATUS.md`: one line per slice.
- The project board: who is doing what now.
- `BLOCKERS.md`: open questions.
