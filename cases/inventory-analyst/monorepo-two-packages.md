---
agent: inventory-analyst
case: monorepo-two-packages
verdict: none
must_contain: ["existing: true", "Not applicable, adopt mode", "ADR-01"]
---

## Input

This is a test case. Everything below is fictional. No file exists and no tool is available in this exercise: the material is given inline. Do not run any command and do not call any tool. Answer with what you would write in your files (the key parts only), then your usual Report block.

recade/state.yaml (extract): mode adopt, languages.work en, voice: short plain sentences, no em dash. Project folder /work/larkfield-mono. Documents folder: the repository holds no docs/inventory.md yet.

Output of the scan (inventory scan --json, shortened):
- packages: { path: "packages/api", name: "@larkfield/api", manifest: "packages/api/package.json", language: "TypeScript", framework: "Fastify", testCommand: "(cd packages/api && npm test)", lintCommand: null, buildCommand: "(cd packages/api && npm run build)" }; { path: "packages/web", name: "@larkfield/web", manifest: "packages/web/package.json", language: "JavaScript", framework: "React", testCommand: "(cd packages/web && npm test)", lintCommand: "(cd packages/web && npm run lint)", buildCommand: null }.
- workspaces: root ".", manager npm, globs ["packages/*"], members ["packages/api", "packages/web"]. The root package.json is not a package.
- ci: .github/workflows/ci.yml with jobs lint and test.
- conventions: commits conventional (18 of 20), branches prefixed (feat, fix), formatter prettier.
- debt: todo 4, fixme 1, skippedTests 2, largeFiles none.
- docs: README.md, packages/web/README.md.
- problems: none.
packages/api/package.json pins engines.node ">=20". Neither package pins another runtime.

Write docs/inventory.md and docs/STACK.md as your rules say.

## Expected

Succeeds. docs/inventory.md has a front matter, a "Summary" and exactly two package sections, "Package packages/api" and "Package packages/web", not one section for the whole repository, and the workspace root is named in the Summary with its members. Each package section holds its stack, its commands (the lint of the API and the build of the web app are "not found"), its tests, conventions, debt and documents. docs/STACK.md has `existing: true` in its front matter, a "Stack in place" table with one row per package, section 8 with one ADR row per layer saying "Adopted as found, imposed by" a source, sections 2 to 7 each one line "Not applicable, adopt mode", and a section 12 whose Test row chains the two subshell commands with ` && `. The Runtime row says node 20 or is left out, nothing more. No DEC is opened, no spike is run, and both files are written through the `recade adopt write` command.
