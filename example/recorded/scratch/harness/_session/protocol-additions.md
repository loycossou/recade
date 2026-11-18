
## Project invariants

1. A tool is never lent twice (PRI-01). Verified by `npm test`, which runs the unique index test.
2. A log line holds no personal data (PRI-02). Verified by `npm test`, which runs the log test.

## Verification commands

| Gate name | Command | Source |
|---|---|---|
| lint | `npm run lint` | STACK section 12 |
| tests | `npm test` | STACK section 12 |
