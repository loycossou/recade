---
agent: product-reviewer
case: no-way-to-confirm
verdict: FIX
must_contain: ["confirm"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

The job of the user: pay off a loan early and be sure it worked.

Screens (descriptions stand for the images):
1. Loan page: a "Pay off now" button.
2. After a click: the page reloads on the loan page. The balance shows 0.00. Nothing says that a payment was made, for how much or when.

Give your verdict.

## Expected

FIX: the user cannot tell that the payment happened. A confirmation screen is needed.
