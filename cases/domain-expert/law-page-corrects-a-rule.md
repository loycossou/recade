---
agent: domain-expert
case: law-page-corrects-a-rule
verdict: none
must_contain: ["withdrawal period", "14 calendar days"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode scratch, lots [LEN, SEC], languages.work en, voice: short plain sentences, no em dash.
Stage: contribute. Today: 2026-11-14. Doctrine team/lending-expert.md: "Cite the law with the page and the day you read it."

docs/D1.md section 7 (extract): "BR-04: A borrower may withdraw from a loan contract within 7 days of signing, at no cost."

Web tools are not available, but you have read this page today (2026-11-14), which is the fictional "Valdoria Consumer Credit Code, article 31", at https://example.test/valdoria/credit-code: "The borrower may withdraw from the contract within fourteen calendar days of signing, without giving a reason. The lender may keep only the interest accrued for the days the loan was drawn."

## Expected

Succeeds. The rule BR-04 in section 7 is corrected to 14 calendar days, with the interest accrued for the days drawn, citing the Valdoria Consumer Credit Code article 31, the page and the date 2026-11-14. The change is testable. Only sections 3 and 8 and the domain rules of section 7 are touched. The report lists glossary terms (for example withdrawal period).
