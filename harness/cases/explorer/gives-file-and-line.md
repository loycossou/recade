---
agent: explorer
case: gives-file-and-line
verdict: none
must_contain: ["src/loans/schedule.js"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Where is the interest computed? For this exercise the search shows: src/loans/schedule.js line 14 `const interest = round(balance * rate / 12)`. Answer the question.

## Expected

It answers with the file and the line.
