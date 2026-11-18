---
doc_id: QUESTIONNAIRE
title: "Fernhill Lending, intake questionnaire"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
status: open
language: "en"
---

<!--
The intake questionnaire. Ask in the chat language, a few questions at a time, as multiple choice when
the answers are few. Write each answer in the table. Rate each unanswered question:
blocking means we would build the wrong thing without it (the problem, the users, the scope): ask the owner
and wait. replaceable means we generate a provisional value and go on: log it in intake/provisionals.md.
-->

Status values: `given`, `blocking`, `provisional`.

## The client and their business

| Question | Answer | Status |
|---|---|---|
| Who is the client, and what do they sell or do? | The Fernhill Tool Library, a volunteer-run non-profit that lends tools to the neighbourhood. | given |
| How do they make money, and who are their competitors? | It earns nothing. Members pay a small yearly fee. There is no competitor nearby. | given |
| Who is the owner for this project, and who signs? | Ines Calloway, the chair, owns the project and signs. | given |

## The problem

| Question | Answer | Status |
|---|---|---|
| What goes wrong today, in plain words? | Loans are written on paper, so tools go missing and late tools are found by chance. | given |
| Who feels it, how often, and what does it cost? | Volunteers and the chair, every Saturday. The library loses about one tool in ten each year. | given |
| What happens if nothing is built? | Tools keep going missing and the library cannot afford to replace them. | given |

## The users

| Question | Answer | Status |
|---|---|---|
| Who will use the product, and in what situations? | Members who borrow tools, and the volunteers who run the desk on Saturdays. | given |
| What can each kind of user do, and what must they never do? | Volunteers register loans and returns. Members never use the desk screen. | given |
| How many users, now and in two years? | About 300 members now, 500 in two years. 4 volunteers on a shift. | given |

## The scope

| Question | Answer | Status |
|---|---|---|
| What must the first version do? | Register a loan and a return, keep the catalogue and the members, apply the late fee, list overdue tools. | given |
| What can wait for a later phase? | Online booking, payments and a public site. | given |
| What must it never do? | Never lend a tool that is already out. | given |

## Constraints

| Question | Answer | Status |
|---|---|---|
| Budget: how much, and is it fixed? | Small and fixed. | given |
| Deadline: which date, and why that date? | The desk opens to members on 2026-12-28. | given |
| Hosting: where must it run, and who runs it? | One small server that a volunteer can restart. | given |
| Regulation: which laws or standards apply (privacy, payments, sector rules)? | Member names and phone numbers stay on the library's own server. | given |

## What exists today

| Question | Answer | Status |
|---|---|---|
| Is there a system, a spreadsheet or a process to replace or keep? | A paper register and a spreadsheet of about 180 tools. | given |
| Is there code, data or documentation we can read? | The spreadsheet can be read. | given |
| What must be migrated? | The spreadsheet is migrated into the catalogue. | given |

## Integrations

| Question | Answer | Status |
|---|---|---|
| Which other systems must the product talk to? | None. | given |
| For each one: who owns it, is there an API, is there a test environment? | | |

## The team on the client side

| Question | Answer | Status |
|---|---|---|
| Who answers our questions, and how fast? | Ines Calloway, within two days. | given |
| Who tests and approves? | Two volunteers test on Saturdays. Ines Calloway approves. | given |
| Who will run and maintain the product afterwards? | One volunteer. | given |

## Success criteria

| Question | Answer | Status |
|---|---|---|
| How will the client know it worked? | No tool is lost without a record. | given |
| Which numbers should move, and by how much? | Overdue tools are listed on the day they are due. A loan is registered in under 30 seconds. | given |

## Brand

| Question | Answer | Status |
|---|---|---|
| Is there a logo? Send the files. | No logo yet. | given |
| Which colors does the brand use? | | |
| What tone of voice does the brand have? | Plain, warm and readable. | given |
| Which products, sites or apps do they love, and why? | A neighbourhood bakery site, for its clear opening hours. | given |
| Which ones do they hate, and why? | Apps full of pop-ups. | given |

## Attachments

Files the client gave us go in `intake/attachments/`. List each one here with what it is.

| File | What it is |
|---|---|
| | |
