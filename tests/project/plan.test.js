import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { findPlan, planFile, readPlan } from '../../src/project/plan.js';
import { checkSlices } from '../../src/project/slices.js';

const plan = (id) => `---\ndoc_id: PLAN\n---\n\n# Plan\n\n## Backlog\n\n| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |\n|---|---|---|---|---|---|---|---|---|---|\n| ${id} | Core | An item | S | 1 | | 1 | Build | todo | |\n`;

function repo(mode) {
  const root = mkdtempSync(join(tmpdir(), 'recade-plan-'));
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode, lots: ['LOAN'] }));
  return root;
}

test('a project of scratch or from mode reads docs/PLAN.md', () => {
  const root = repo('scratch');
  assert.equal(findPlan(root), null);
  writeFileSync(join(root, 'docs', 'PLAN.md'), plan('LOAN-01'));
  assert.equal(findPlan(root).file, 'docs/PLAN.md');
  assert.match(readPlan(root), /LOAN-01/);
});

test('in adopt mode the workspace PLAN is docs/PLAN.md, with no docs/recade/ fallback', () => {
  const root = repo('adopt');
  assert.equal(findPlan(root), null);
  assert.equal(planFile(root), 'docs/PLAN.md');
  writeFileSync(join(root, 'docs', 'PLAN.md'), plan('LOAN-01'));
  assert.equal(findPlan(root).file, 'docs/PLAN.md');
  assert.match(readPlan(root), /LOAN-01/);
  mkdirSync(join(root, 'docs', 'recade'));
  writeFileSync(join(root, 'docs', 'recade', 'PLAN.md'), plan('PAY-09'));
  assert.equal(findPlan(root).file, 'docs/PLAN.md', 'docs/recade/ no longer exists: it is never read');
  assert.doesNotMatch(readPlan(root), /PAY-09/);
});

test('a PLAN in an adopted workspace needs no record in .recade/created.json', () => {
  const root = repo('adopt');
  writeFileSync(join(root, 'docs', 'PLAN.md'), plan('LOAN-01'));
  assert.equal(findPlan(root).file, 'docs/PLAN.md');
});

test('a folder or a link named PLAN.md is not a PLAN', () => {
  const root = repo('scratch');
  mkdirSync(join(root, 'docs', 'PLAN.md'));
  assert.equal(findPlan(root), null);
});

test('slices check reads docs/PLAN.md and names that file in its findings', () => {
  const root = repo('adopt');
  assert.deepEqual(checkSlices(root).findings.map((f) => [f.rule, f.file]), [['plan-missing', 'docs/PLAN.md']], 'no PLAN yet');
  writeFileSync(join(root, 'docs', 'PLAN.md'), plan('LOAN-01'));
  const r = checkSlices(root);
  assert.deepEqual(r.findings.map((f) => [f.rule, f.file]), [['story-uncovered', 'docs/PLAN.md']]);
  assert.match(r.findings[0].message, /LOAN-01/);
});
