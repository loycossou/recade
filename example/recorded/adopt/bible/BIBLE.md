---
doc_id: BIBLE
title: "Fernhill desk, BIBLE"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
author: "Project lead, Recade team"
approver: "Ines Calloway"
companions: [PLAN]
classification: Confidential
revisions:
  - { version: "0.1", date: "2026-11-18", author: "Project lead, Recade team", change: First draft }
approvals:
  - { role: Project lead, name: "", date: "" }
  - { role: Owner, name: "Ines Calloway", date: "" }
---

## 0. Mission and quality bar

The Fernhill desk is the loan desk of the Fernhill Tool Library, already in use. This BIBLE rules the work that remains: it never changes the architecture, the stack, the CI or the layout without an owner decision recorded as a DEC.

## 1. Mandatory reading order

1. This file, in full.
2. `slices/STATUS.md`, to know where the project stands.
3. The slice sheet you were given.
4. `docs/RULES.md`, `docs/INVARIANTS.md` and `docs/CONTRACTS.md`, only what the slice cites.

## 2. Verified facts

| Fact | Checked on | How | Re-check by |
|---|---|---|---|
| The CI runs `npm test` on Node 22 and nothing else | 2026-11-18 | `repos/fernhill-desk/.github/workflows/ci.yml` | 2027-02-18 |

## 3. Binding documents by precedence

1. This file.
2. `docs/INVARIANTS.md`, then `docs/CONTRACTS.md`.
3. `docs/RULES.md` and the stack in place in `docs/STACK.md`.
4. `docs/PLAN.md`.

If none of them answers the question, it is not yours to answer. Raise a `BLOCKING` and stop on that point.

## 4. Decisions

| Decision | Where | Status |
|---|---|---|
| ADR-01 (runtime and server): plain Node, adopted as found | `docs/STACK.md` | accepted |

## 5. Invariants

The invariants are cited, never restated: REQ-01, REQ-02, INV-01 and INV-02 of `docs/INVARIANTS.md`. INV-02 is not enforced yet: LED-01 (keep the ledger across restarts) closes it.

## 6. Business rules

Cited from `docs/RULES.md` and `docs/CONTRACTS.md`: the rules and the interfaces are not restated here.

## 7. Conventions

- Tree: the layout of the repository stays as it is.
- Language: code, comments and commit messages in English.
- Commits: conventional commits, one idea each, no attribution line.

## 8. Design rules

The desk has no screen. Nothing here applies until a slice adds one and a DEC chooses its direction.

## 9. Writing voice

Everything written for this project follows the voice in `recade/state.yaml`: simple words, short sentences.

## 10. Exclusions

- No framework, no new dependency without a DEC.
- No change to `repos/fernhill-desk/.github/workflows/ci.yml`: the checks of Recade live in `repos/fernhill-desk/.github/workflows/recade.yml`.

## 11. Blockers and escalation

When a question has no answer in the binding documents, pick the prudent default, mark it `PROVISIONAL`, write a `BLOCKING` and stop on that point.

## 12. Definition of done

- **Slice**: every line of its Definition of Done is green with the counts written down, the code is reviewed.
- **Increment**: its milestone is true, the demo ran.

## 13. Session discipline

- Read before writing. One slice per session.
- Stop at a gate. A gate is passed by the owner's answer, nobody else's.

## 14. Parallelism, WIP limits and model policy

- Never two slices whose `touches:` overlap.
- No agent merges. `gh pr merge` is denied by the configuration.

| Work | Model | Effort |
|---|---|---|
| Writing and sensitive implementation | claude-opus-5-5 | high |
| Mechanical steps | sonnet | medium |

## 15. Quality gates

| Target | Proves |
|---|---|
| `npm test` | The tests pass |

## 16. Prohibitions

- Never merge a pull request.
- Never weaken a test to make it pass.
- Never edit a file Recade did not create, unless a slice names it in `touches:`.

## 17. Where to read state

- `slices/STATUS.md`: one line per slice.
- The project board.
