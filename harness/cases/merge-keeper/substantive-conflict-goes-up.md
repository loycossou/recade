---
agent: merge-keeper
case: substantive-conflict-goes-up
verdict: none
must_contain: ["BLOCKING"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Rebase the branch slice/S-06-fees on main. Git lists one conflicted file, src/loans/schedule.js. Both sides changed the interest formula: main has `balance * rate / 12` (slice S-04), the branch has `principal * rate / 12` (slice S-06). They mean different things.

## Expected

A conflict of substance: it reports BLOCKING for the owner and does not pick a side.
