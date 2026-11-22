---
doc_id: QUESTIONNAIRE
title: "{{project}}, intake questionnaire"
project: "{{project}}"
version: "{{version}}"
date: "{{date}}"
status: open
language: "{{language}}"
---

<!--
The intake questionnaire. Ask in the chat language, a few questions at a time, each as a multiple choice:
2 or 3 likely answers, the most likely first, plus Not known yet. Ask it open only when the answer is free
text by nature (a name, a date). Write each answer in the table. Rate each unanswered question:
blocking means we would build the wrong thing without it (the problem, the users, the scope): ask the owner
and wait. replaceable means we generate a provisional value and go on: log it in intake/provisionals.md.
-->

Status values: `given`, `blocking`, `provisional`.

## The client and their business

| Question | Answer | Status |
|---|---|---|
| Who is the client, and what do they sell or do? | | |
| How do they make money, and who are their competitors? | | |
| Who is the owner for this project, and who signs? | | |

## The problem

| Question | Answer | Status |
|---|---|---|
| What goes wrong today, in plain words? | | |
| Who feels it, how often, and what does it cost? | | |
| What happens if nothing is built? | | |

## The users

| Question | Answer | Status |
|---|---|---|
| Who will use the product, and in what situations? | | |
| What can each kind of user do, and what must they never do? | | |
| How many users, now and in two years? | | |

## The scope

| Question | Answer | Status |
|---|---|---|
| What must the first version do? | | |
| What can wait for a later phase? | | |
| What must it never do? | | |

## Constraints

| Question | Answer | Status |
|---|---|---|
| Budget: how much, and is it fixed? | | |
| Deadline: which date, and why that date? | | |
| Hosting: where must it run, and who runs it? | | |
| Regulation: which laws or standards apply (privacy, payments, sector rules)? | | |

## What exists today

| Question | Answer | Status |
|---|---|---|
| Is there a system, a spreadsheet or a process to replace or keep? | | |
| Is there code, data or documentation we can read? | | |
| What must be migrated? | | |

## Integrations

| Question | Answer | Status |
|---|---|---|
| Which other systems must the product talk to? | | |
| For each one: who owns it, is there an API, is there a test environment? | | |

## The team on the client side

| Question | Answer | Status |
|---|---|---|
| Who answers our questions, and how fast? | | |
| Who tests and approves? | | |
| Who will run and maintain the product afterwards? | | |

## Success criteria

| Question | Answer | Status |
|---|---|---|
| How will the client know it worked? | | |
| Which numbers should move, and by how much? | | |

## Brand

| Question | Answer | Status |
|---|---|---|
| Is there a logo? Send the files. | | |
| Which colors does the brand use? | | |
| What tone of voice does the brand have? | | |
| Which products, sites or apps do they love, and why? | | |
| Which ones do they hate, and why? | | |

## Attachments

Files the client gave us go in `intake/attachments/`. List each one here with what it is.

| File | What it is |
|---|---|
| | |
