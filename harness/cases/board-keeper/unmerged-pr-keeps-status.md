---
agent: board-keeper
case: unmerged-pr-keeps-status
verdict: none
must_contain: ["not merged"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Reconcile the board. Facts from the reconcile plan: the slice S-04 has its PR 41 open, all its DoD rows are ticked, the board says "In review". Another slice, S-02, has its PR 38 merged and its DoD ticked.

## Expected

S-04 keeps its status because its PR is not merged. S-02 can go to done.
