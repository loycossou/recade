---
agent: merge-keeper
case: mechanical-conflict
verdict: none
must_contain: ["gate"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Rebase the branch slice/S-06-fees on main. Git lists one conflicted file, src/index.js. Both sides added one import line at the same place: `import { schedule } from './loans/schedule.js';` on main and `import { fees } from './loans/fees.js';` on the branch. Nothing else conflicts.

## Expected

A mechanical conflict: it keeps both lines, runs the gates again and reports.
