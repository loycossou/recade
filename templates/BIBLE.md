---
doc_id: BIBLE
title: "{{title}}, BIBLE"
project: "{{project}}"
version: "{{version}}"
date: "{{date}}"
status: draft
language: "{{language}}"
author: "{{author}}"
approver: "{{approver}}"
companions: [D1, D2, D3, PLAN]
classification: Confidential
revisions:
  - { version: "{{version}}", date: "{{date}}", author: "{{author}}", change: First draft }
approvals:
  - { role: Project lead, name: "", date: "" }
  - { role: Owner, name: "", date: "" }
---

<!--
Writing guide. Delete every comment before the draft goes to the owner.
The BIBLE holds the rules. Agents apply them without interpreting, so each rule is short,
imperative and checkable. It cites D1, D2 and D3 by ID with the gist, and never copies them.
It never copies state either: section 17 says where to read it.
A rule with no way to check it is a wish: rewrite it or drop it.
Sections 8, 9 and 14 hold defaults from the plugin. Keep them unless the owner decided otherwise
in a DEC, and cite that DEC.
-->

## 0. Mission and quality bar

<!-- Two sentences: what the product is, and what "good enough to ship" means here. -->

## 1. Mandatory reading order

1. This file, in full.
2. `STATUS.md`, to know where the project stands.
3. The slice sheet you were given.
4. The documents the slice cites, only the cited IDs.

## 2. Verified facts

<!-- Facts the work depends on, each with the date it was checked and how. A fact older than its re-check date is not a fact. -->

| Fact | Checked on | How | Re-check by |
|---|---|---|---|
| Example fact | 2026-11-13 | Example source | 2027-02-13 |

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
| Example decision | `decisions/` or `STACK.md` | accepted |

## 5. Invariants

<!-- Things that must stay true in every state of the system. Each has the test that guarantees it. -->

| Invariant | Test that guarantees it |
|---|---|
| Example: a balance never goes below zero | `make test` runs the ledger property tests |

## 6. Business rules

<!-- One row per rule. Source: the ID with its gist. Enforced by: where the code holds the rule. -->

| Rule | Source | What the code enforces | Test |
|---|---|---|---|
| Example rule | FR-EX-01 (the user can do the example thing) | Example check in the service layer | Example test file |

## 7. Conventions

<!-- Short and exact. One bullet per convention. -->

- Tree: one folder per module, tests next to the code.
- API: follow the conventions of D2.
- Data: example convention.
- UI: tokens only, see section 8.
- Language: code, comments and commit messages in the project code language.
- Commits: conventional commits, one idea each, no attribution line.

## 8. Design rules

**Against generic design.** These are forbidden unless the art direction decides otherwise in writing:

- purple-blue gradients, glassmorphism, soft shadows everywhere;
- a centred hero, three icon cards and a pill button as the default layout;
- emojis used as icons, "blob" illustrations;
- one common UI font as the only font;
- every corner at 12 px, neutral greys with no point of view, dashboards made of identical cards;
- filler copy such as "Welcome back!".

**Tokens.** The art direction becomes tokens: colours, type, spacing, radii, shadows, motion. A value hard-coded outside the tokens is a `FIX`. Screen variants differ by concept, not by colour.

**Confirmation before a sensitive action.** Every destructive or irreversible action (delete, bulk archive, revoke, refund, publish, bulk send, reset) goes through a confirmation that:

- names the object and the consequence ("Delete 3 invoices. This cannot be undone.");
- keeps the confirm button away from the cancel button, with a verb label ("Delete invoices", never "OK");
- asks to type the name for irreversible, high-impact actions;
- offers undo when the action allows it.

One end-to-end test per sensitive action proves it does not happen without confirmation. A `destructive` button with no confirmation dialog is a lint failure.

**Drawer, modal or page.**

| Use | When |
|---|---|
| Drawer | Detail or edit of an item without leaving the list, advanced filters, secondary forms, side panels |
| Modal | A confirmation or a short decision that blocks |
| Page | A long or multi-step task, or one that deserves a shareable URL |

A drawer has a URL (state restored on reload), closes on Escape, manages focus and back navigation.

**Accessibility.** WCAG 2.2 AA, full keyboard navigation, contrast checked in CI.

## 9. Writing voice

Everything written for this project follows the voice in `recade/state.yaml` (`voice:`): simple words, short sentences, one idea per sentence, quiet precision. At most one touch of humour per section, never in warnings, security requirements, error messages or contract clauses. No em dash, no emoji, no exclamation mark of enthusiasm, none of the banned words checked by `recade lint-style`.

## 10. Exclusions

<!-- What not to build. Copy the exclusions of D1 as a short list, with the IDs. -->

- Example exclusion.

## 11. Blockers and escalation

When a question has no answer in the binding documents:

1. Pick the prudent default, the one that is easiest to undo. Mark it `PROVISIONAL`.
2. Write a `BLOCKING` in this format and stop on that point:

   `BLOCKING: <one closed question>. Options: <A>, <B>. Prudent default meanwhile: <value>. Needed from: <who>.`

3. Log it in `BLOCKERS.md`. Never guess in silence.

The human answers with a closed question. The answer is logged, and the log line is closed.

## 12. Definition of done

- **Story**: its acceptance lines pass, a test saw each of them fail first, no test was weakened.
- **Slice**: every line of its Definition of Done is green with the counts written down, the code is reviewed, the documents that changed are updated.
- **Increment**: its milestone is true, the demo ran, the retro is written.

A slice that is "built, not proven" is not done. Say which part is proven and which is not.

## 13. Session discipline

- Read before writing. One slice per session.
- Write down decisions as you take them, in the slice sheet, not in memory.
- After a cut or a compaction, reread the slice sheet and the tracking file before continuing.
- Stop at a gate. A gate is passed by the owner's answer, nobody else's.

## 14. Parallelism, WIP limits and model policy

- Run 3 to 5 slices at once when the graph allows it. Never two slices whose `touches:` overlap.
- Slices that touch a hotspot (`hotspots:` in `recade/state.yaml`) go one after another.
- No central list edited by hand: routes, modules, migrations and translations are discovered by code, one file per item.
- Migrations are named by timestamp, never numbered by hand.
- `STATUS.md`, `INDEX.md` and the changelog are never edited in a slice branch. They are regenerated on main.
- Dependency updates go in a dedicated slice, never mixed with functional work.
- Rebase on main at the start, before the audit, and just before opening the PR.
- No agent merges. `gh pr merge` is denied by the configuration.

| Work | Model | Effort |
|---|---|---|
| Example: sensitive implementation | Example model | high |
| Example: review | Example model | high |
| Example: mechanical step | Example model | medium |

## 15. Quality gates

<!-- The make targets and what each one proves. They come from STACK.md, section 12. -->

| Target | Proves |
|---|---|
| `make lint` | Style and static checks pass |
| `make test` | The tests pass, counts are printed |
| `make verify` | Lint, tests and the index check together |

## 16. Prohibitions

<!-- One list, no repeats of earlier sections. Each line starts with Never. -->

- Never merge a pull request.
- Never weaken a test to make it pass.
- Never put a secret in the repository.
- Never write a hard-coded value outside the design tokens.
- Never edit a binding document without a decision.

## 17. Where to read state

State is never copied here. Read it where it lives:

- `STATUS.md`: one line per slice.
- The project board: who is doing what now.
- The journals of the running slices.
- `BLOCKERS.md`: open questions.
