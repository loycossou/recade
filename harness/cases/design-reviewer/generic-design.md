---
agent: design-reviewer
case: generic-design
verdict: FIX
must_contain: ["token"]
---

## Input

This is a test case. Everything below is fictional. Answer with your usual report block, and where your agent file asks for a verdict, end with it alone on its own line.

Review the screen of the slice S-05 against the art direction.

Art direction: "Harbour ledger": warm paper background (token color.paper), ink text (token color.ink), one accent, copper (token color.copper), serif numerals, no gradients, no card shadows.

Screenshot description (stands for the image): a white page, a purple to blue gradient header, three identical rounded cards with soft shadows, sans-serif numbers, a blue button. Colours are written as hex values in the CSS.

## Expected

FIX: gradient, shadows and hex values instead of tokens, none of it in the direction.
