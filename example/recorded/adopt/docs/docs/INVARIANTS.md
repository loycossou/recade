---
doc_id: INVARIANTS
title: "Fernhill desk, invariants from the code"
project: "Fernhill desk"
version: "0.1"
date: "2026-11-18"
status: draft
language: "en"
---

# Fernhill desk, invariants from the code

From the code and from SRC-01 (the README).

## Requirements

### REQ-01: Lending a tool that is out

WHEN a volunteer lends a tool that is already out THEN the ledger refuses with the message "Tool <id> is already out".

enforced: code repos/fernhill-desk/src/ledger.js:5

### REQ-02: A late return

WHEN a tool comes back late THEN the fee is 2 for each late day.

enforced: test repos/fernhill-desk/test/loans.test.js

## Invariants

### INV-01: One open loan for each tool

A tool has at most one open loan.

enforced: code repos/fernhill-desk/src/ledger.js:5

### INV-02: The ledger survives a restart

A loan recorded before a restart is still there after it.

enforced: no
