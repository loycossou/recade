---
doc_id: BRIEF
title: "Fernhill Lending, intake brief"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
---

# Fernhill Lending, intake brief

## The client

The Fernhill Tool Library is a volunteer-run, non-profit library that lends tools to the neighbourhood. The chair, Ines Calloway, is the owner of this project and signs for the library. Source: `intake/attachments/brief.md`.

## The problem

Volunteers write each loan on paper at the desk. Tools go missing, nobody knows who has the drill, and late tools are found by chance. The library loses about one tool in ten each year.

## The users

- Members: neighbours who borrow tools. About 300 now, 500 in two years.
- Volunteers: run the desk on Saturdays, 4 people on a shift.
- The chair: reads the monthly report.

## The scope

The first version registers a loan and a return at the desk, keeps the tool catalogue and the member list, applies the late fee and lists overdue tools. Online booking, payments and a public site wait for a later phase. The product never lends a tool that is already out.

## Constraints

- Budget: small and fixed. Hosting costs stay under 15 per month (PROVISIONAL, PRV-03).
- Deadline: the desk opens to members on 2026-12-28.
- Hosting: one small server that a volunteer can restart.
- Regulation: member names and phone numbers are personal data and stay on the library's server.

## What exists today

A paper register and a spreadsheet of about 180 tools, `intake/attachments/loan-register.xlsx`. The sheet "Tools" lists the tool, its shelf, its condition and the date it went out. The spreadsheet is migrated into the catalogue.

## Integrations

None in the first version. The library prints its own barcode labels.

## The client team

Ines Calloway answers within two days. Two volunteers test on Saturdays. One volunteer maintains the product afterwards.

## Success criteria

No tool is lost without a record. Every late tool shows in the overdue report on the day it is due. A volunteer registers a loan in under 30 seconds.

## Brand

No logo yet: a provisional wordmark is used (PROVISIONAL, PRV-02). The library likes plain, warm and readable screens.

## Provisional values

<!-- mirror -->

| ID | What | Assumption |
|---|---|---|
| PRV-01 | Late fee per day | 2 per day |
| PRV-02 | Logo | Text wordmark |
| PRV-03 | Monthly hosting budget | 15 |

## Open questions

None that block the first version.
