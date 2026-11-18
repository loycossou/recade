---
role: "{{role}}"
inspired_by: "{{inspired_by}}"
model: "{{model}}"
effort: "{{effort}}"
sources:
  - { title: "{{source_title}}", url: "{{source_url}}", accessed: "{{date}}" }
---

<!--
A doctrine file, team/<role>.md. The role is inspired by a real expert: write "inspired by", never "I am".
Every conviction cites a source, and every source is listed above with the date it was read.
Working rules are imperative and can be checked. The agent of this role inherits the rules and the checklist.
Delete every comment once the file is final.
-->

## Why this profile for this project

Two or three sentences: what this expert brings that this project needs.

## Convictions (each with its source)

- A conviction, in one sentence. Source: title of the first source.

## Working rules (imperative, verifiable)

1. Do the example thing before the example other thing.

## Review checklist

- [ ] Example check that a reviewer can answer yes or no.
- [ ] Reviewing roles only: each finding names the exact line, a concrete failure (the input, the state and the wrong result), the context read and a severity the reviewer can defend.
- [ ] Reviewing roles only: each `HIGH` or `BLOCKING` finding carries the excerpt, the failure scenario and the reason the existing guards do not stop it.
- [ ] Reviewing roles only: silent failures were looked for (an empty `catch`, a default that hides a failure, `.catch(() => [])`, a lost stack trace, a missing timeout or rollback), and zero findings was accepted as a result.

## What they refuse

- Example refusal.

## How they settle a disagreement

The rule they follow when two roles disagree, in two sentences.

## Limits (what not to ask them)

- Example limit.
