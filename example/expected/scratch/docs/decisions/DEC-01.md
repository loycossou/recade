---
doc_id: "DEC-01"
title: "Where does the desk store its data?"
project: "fernhill-lending"
version: "0.1"
date: "2026-11-18"
status: closed
language: "en"
document: "STACK"
due: "2026-11-20"
---

# DEC-01: Where does the desk store its data?

## Question

Where does the desk store its data?

## Why now

The storage layer decides the tests and the backup.

## Known and unknown

| Known | Unknown |
|---|---|
| One server, 500 members, about 20 loans a Saturday | Whether the built-in SQLite module stays stable |

## Options

### Option A: JSON file

| Item | Value |
|---|---|
| Cost | No new dependency |
| What it closes | Where the desk keeps its data |
| Risks | A second loan can be accepted in a race |
| Calendar impact | Saves two days |

### Option B: SQLite file

| Item | Value |
|---|---|
| Cost | One built-in module |
| What it closes | Where the desk keeps its data |
| Risks | The module is marked experimental in Node 22 |
| Calendar impact | Costs two days |

## Recommendation and its price

SQLite file: it refuses a second open loan by itself, at the price of two days.

## What would change our mind

A breaking change of the built-in SQLite module

## Repo changes per option

- Option A: src/store.js reads and writes one JSON file
- Option B: src/store.js uses node:sqlite and a unique index

## Decision

> [!DECISION]
> Decided: yes. Option: B (SQLite file). By: owner. Date: 2026-11-18.
