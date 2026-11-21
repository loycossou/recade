---
doc_id: STACK
title: "{{title}}, stack decision"
project: "{{project}}"
version: "{{version}}"
date: "{{date}}"
status: draft
language: "{{language}}"
author: "{{author}}"
approver: "{{approver}}"
companions: [D1, D2, D3]
existing: false
classification: Confidential
revisions:
  - { version: "{{version}}", date: "{{date}}", author: "{{author}}", change: First draft }
approvals:
  - { role: Architect, name: "", date: "" }
  - { role: Owner, name: "", date: "" }
---

<!--
Writing guide. Delete every comment before the draft goes to the owner.
Size: the dispatcher gives the word budget of STACK (code blocks excluded). Write for a busy client, say each idea once, use a table only for real tabular data, and cite other documents instead of restating them.
This is an architecture decision, argued like one and settled by the owner (gate G2-stack).
It comes after D1 (we know what to build) and before D2 (which describes it).
Criteria come from the project, not from habit: each one cites its source and carries a weight.
Declare three biases and fight them: fashion, the comfort of the writer, and the LLM habit of
proposing the same stack for every project.
In adopt mode, describe the stack that exists instead of choosing one: fill sections 1, 8 ("Adopted as found, imposed by the source") and 9 to 12, and write "Not applicable, adopt mode" in sections 2 to 7.
Nothing rests on the model's memory alone: every version, date and licence below was looked up.
Front matter key `existing`: `true` when this file describes a stack already in place (adopt mode), `false` for a stack chosen here. When it is `true`, fill the section "Stack in place" from the inventory scan, one row per package, and delete the section otherwise.
-->

## Stack in place

<!-- Only when `existing: true`: what the repository holds today, from its manifests and nothing else. One row per package. Say "not found" for a command the manifests do not give. Delete this section when `existing` is `false`. -->

| Package | Path | Language | Framework | Test | Lint | Build |
|---|---|---|---|---|---|---|
| Example package | `services/api` | Example language | Example framework | `(cd services/api && npm test)` | not found | not found |

## 1. Criteria and weights

<!-- One row per criterion. Source: an NFR, a PAR, an intake constraint, or a human fact. Weights sum to 100. -->

| Criterion | Source | Weight |
|---|---|---|
| Example: handles the expected load | NFR-01 (page answers within a stated time) | 20 |
| Example: people who will maintain it know it | Intake: team on the client side | 15 |
| Example: fit for development by agents (typing, conventions, fast tests, usable errors) | Measured in section 4 | 20 |
| Example: total cost | Intake: budget | 15 |

Families to cover: non-functional needs, constraints (hosting, regulation, budget, deadline, existing stack), people (skills, local hiring), lifespan (maturity, long-term support, breaking changes, licence, community), security (history, supply chain, D3), fitness for agents, total cost.

## 2. Candidates per layer

<!-- The finalists of each layer: two or three genuinely different options, the ones that get a spike. At least one outside the reflex choices. The full ranked top 5 of a layer sits in a sub-section 2.n below, so the section numbers 3 to 12 never move. -->

| Layer | Candidate | Why it is on the list |
|---|---|---|
| Example layer | Option one | Example reason |
| Example layer | Option two | Example reason |

Biases declared: fashion, the comfort of the writer, the LLM habit of one stack for everything. What was done against each: example.

### 2.1 Top 5 for Example layer

<!-- One sub-section 2.n for each layer with a real choice, in the order of the layer loop (language, framework, database, data access, hosting, then the rest). Five rows, ranked, the recommended one first. Fewer than five only when fewer real options exist: say so under the table, with the reason. At least one option outside the reflex choices. A layer imposed by the owner or by a source has no sub-section. Why: two plain lines at most, tied to D1 and to the criteria of section 1, for THIS project. Spike: yes for the top 2 or 3 (they are the finalists above), "research only" for the others. The dated sources of every option are rows of section 3. When the owner has chosen the layers before it, re-rank this table against those choices: an option that no longer fits drops out, with the reason under the table, and the next one comes in. Delete this example. -->

| Rank | Option and version | Why it is in this place for this project | Main drawback | Spike |
|---|---|---|---|---|
| 1 | Option one 1.2.3 | Example reason, tied to D1 and to a criterion | Example drawback | yes |
| 2 | Option two 4.5.6 | Example reason | Example drawback | yes |
| 3 | Option three 7.8.9 | Example reason | Example drawback | research only |
| 4 | Option four 2.0.1 | Example reason | Example drawback | research only |
| 5 | Option five 0.9.4 | Example reason | Example drawback | research only |

## 3. Research

<!-- Dated. Versions, support calendar, licences, recent flaws, field reports at the project's scale. -->

| Subject | Finding | Source | Accessed |
|---|---|---|---|
| Example candidate | Current version and support end date | Example source | 2026-11-13 |

## 4. Spikes

<!-- For each finalist, the same real task of this project, done by an agent in each option. -->

| Finalist | Task | Done without help? | Fix loops | Build and test time | Readability |
|---|---|---|---|---|---|
| Option one | Example real task | yes | 1 | 40 s | Example note |

## 5. Weighted matrix

<!-- Scores from 1 to 5, each with a one-line justification. -->

| Criterion | Weight | Option one | Option two |
|---|---|---|---|
| Example criterion | 20 | 4, example reason | 3, example reason |
| Total | 100 | 0 | 0 |

## 6. Risks and exit cost

| Option | Main risk | Cost to leave later |
|---|---|---|
| Option one | Example risk | Example cost |

## 7. Recommendation and contributor opinions

**Recommendation of the architect.** One paragraph, with its price.

| Contributor | Opinion | Disagrees with |
|---|---|---|
| devops-lead | Example opinion | none |
| security-lead | Example opinion | none |
| ui-designer | Example opinion | none |
| qa-lead | Example opinion | none |
| domain-expert | Example opinion | none |

## 8. Decision

<!-- One row per layer. Each choice is an ADR. The owner answers in a multiple-choice question. -->

<!-- replace the example rows -->

| ID | Layer | Choice | Date |
|---|---|---|---|
| ADR-01 | Example layer | Option one | 2026-11-13 |

> [!DECISION]
> Settled by the owner on the date above, for each layer listed.

## 9. Selected stack

| Layer | Name | Pinned version | Licence | Support until |
|---|---|---|---|---|
| Example layer | Option one | 1.2.3 | MIT | 2028-01-01 |

## 10. Rejected options

| Option | Why it lost |
|---|---|
| Option two | Example reason |

## 11. Conditions for re-examination

<!-- Facts that would reopen this decision. Reviewed at each retro. A change goes through /recade:amend. -->

- Example condition: the chosen framework ends its long-term support.

## 12. Harness technical sheet

<!-- Read by the harness agents. Keep every command exact and runnable from the repository root. -->

<!-- With several code repositories, give each one its own table (one table per code repository), under a sub-heading `### <repo>` that is the name of the repository in the registry, such as `### api` and `### web`, with the same rows. A repository with no table of its own reads the table right under this heading. The commands are run from the root of that repository. -->

| Item | Value |
|---|---|
| Build | `make build` |
| Test | `make test` |
| Lint | `make lint` |
| Format | `make format` |
| Local run | `make dev` |
| Stop | Example: `docker compose down` (stops the services of a worktree before /board removes it; leave it out when nothing keeps running) |
| Conventions | Example: one file per route, tests next to code |
| Quality and security tools | Example: type checker, dependency audit, secret scan |
| Runtime | Example: `node 22` (one of node, python, go, java, then the version) |
| Dependency ecosystem | Example: `npm` (optional, deduced from the runtime when left out) |
| Install | Example: `npm ci` |
| Typecheck | Example: `npm run typecheck` |
| Contract tests | Example: `npm run test:contract` |
| E2E setup | Example: `npx playwright install --with-deps chromium` |
| E2E tests | Example: `npx playwright test` |
| Confirmation tests | Example: `npx playwright test --grep @confirmation` (one test per sensitive action) |
| Accessibility tests | Example: `npx playwright test --grep @a11y` (axe, WCAG 2.2 AA) |
| Performance budget | Example: `npm run perf:budget` |
| SAST | Example: `semgrep scan --config auto --error` |
| Dependency audit | Example: `npm audit --audit-level=high` |
| SBOM | Example: `npx @cyclonedx/cyclonedx-npm --output-file sbom/sbom.json` (writes into `sbom/`) |
| Secret scan | Example: `gitleaks detect --no-banner` |
| Quarantine tests | Example: `npx playwright test --grep "$(node "$RECADE_BIN" quarantine list --names \| paste -sd'\|' -)"` (runs only the tests listed in tests/quarantine.json; optional) |
| Useful skills | Example: the skills that fit the stack |

The blocking rows (Test, Contract tests, E2E tests, Confirmation tests and Accessibility tests) must skip the tests listed by `recade quarantine list --names`, so a flaky test never turns the build red. The Quarantine tests row runs only those tests, in a job that never blocks.
