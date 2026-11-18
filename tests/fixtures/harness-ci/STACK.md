---
doc_id: STACK
title: "Harbour Notes, stack decision"
---

## 11. Conditions for re-examination

- The chosen framework ends its long-term support.

## 12. Harness technical sheet

| Item | Value |
|---|---|
| Build | `npm run build` |
| Test | `npm test` |
| Lint | `npm run lint` |
| Format | `npm run format` |
| Conventions | one file per route |
| Runtime | `node 22` |
| Install | `npm ci` |
| Typecheck | `npm run typecheck` |
| Contract tests | `npm run test:contract` |
| E2E setup | `npx playwright install --with-deps chromium` |
| E2E tests | `npx playwright test` |
| Confirmation tests | `npx playwright test --grep @confirmation` |
| Accessibility tests | `npx playwright test --grep @a11y` |
| Performance budget | `npm run perf:budget` |
| SAST | `semgrep scan --config auto --error` |
| Dependency audit | `npm audit --audit-level=high \| tee audit.txt` |
| SBOM | `npx @cyclonedx/cyclonedx-npm --output-file sbom/sbom.json` |
| Secret scan | `gitleaks detect --no-banner` |
| Quarantine tests | `npx playwright test --grep "$(node "$RECADE_BIN" quarantine list --names \| paste -sd'\|' -)"` |

## 13. Notes

| Item | Value |
|---|---|
| Lint | `not this one` |
