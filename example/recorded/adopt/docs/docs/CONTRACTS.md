---
doc_id: CONTRACTS
title: "Fernhill desk, contracts from the code"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
---

# Fernhill desk, contracts from the code

From `repos/fernhill-desk/src/server.js` and SRC-01 (the README).

## Interfaces

| Interface | Method and path | Answer |
|---|---|---|
| Add a member | `POST /members/<id>` | the member record |
| Lend a tool | `POST /loans/<tool>` with the header `x-member` | the loan and its due date |
| Return a tool | `DELETE /loans/<tool>` | the tool and the fee |

An error answers 409 with `{"error": "<message>"}`. An unknown route answers 404.

## Data shapes

- Loan: `{toolId, memberId, since, dueOn}`.
- Member: `{id, name}`.

## Integrations

None.
