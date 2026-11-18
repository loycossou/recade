import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { lintText } from '../../src/style/lint.js';
import {
  CAPS, REQUIRED_KEYS, STATUSES, allowedNext, checkSlices, globsOverlap, parseBacklog, renderGraph, renderStatus,
} from '../../src/project/slices.js';
import { run } from '../../src/cli.js';

const PLAN = `---
doc_id: PLAN
---

# Fernhill Lending, delivery plan

## Backlog

<!-- comment -->

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| LOAN-01 | Core | Apply for a loan | M | 2 | | 1 | Build | todo | |
| LOAN-02 | Core | Review an application | M | 2 | LOAN-01 | 1 | Build | todo | |
| PAY-01 | Payments | Schedule a payout | S | 1 | | 2 | Build | todo | |

## Sprints

| Sprint | Start |
|---|---|
| 1 | 2026-12-01 |
`;

/** One sheet. `front` overrides header keys (undefined removes one), `body` replaces the sections after the header. */
function sheet({ id = 'S-01', front = {}, body, scope = ['LOAN-01'], extra = '' } = {}) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['app'], branch: `slice/${id.toLowerCase()}`, format: 'small',
    lane: 'standard', implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [],
    external_prerequisite: 'none', provisionals_used: [], size: 'M', touches: [`src/${id.toLowerCase()}/**`], ...front,
  };
  for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
  const text = body ?? `# ${id}: Slice ${id}

## Goal

One sentence.

## Scope

${scope.map((s) => `- ${s} (the gist)`).join('\n')}

## Frozen decisions

1. One.

## Design

None.

## Definition of Done

| # | Command (counts tests) | Expected | Seen red first? |
|---|---|---|---|
| 1 | \`make test\` (3 tests) | green | yes |
${extra}`;
  return `---\n${stringify(meta)}---\n\n${text}`;
}

function project({ sheets = {}, plan = PLAN, state = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade-slices-'));
  mkdirSync(join(root, 'recade'));
  mkdirSync(join(root, 'docs'));
  mkdirSync(join(root, 'slices'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', lots: ['LOAN', 'PAY'], ...state }));
  if (plan !== null) writeFileSync(join(root, 'docs', 'PLAN.md'), plan);
  for (const [name, text] of Object.entries(sheets)) writeFileSync(join(root, 'slices', name), text);
  return root;
}

/** A clean project: two small slices and a third one that depends on the first. */
const clean = () => ({
  'S-01-apply.md': sheet({ id: 'S-01', scope: ['LOAN-01'] }),
  'S-02-review.md': sheet({ id: 'S-02', scope: ['LOAN-02'], front: { depends_on: ['S-01'] } }),
  'S-03-payout.md': sheet({ id: 'S-03', scope: ['PAY-01'] }),
});

const rules = (r) => r.findings.map((f) => f.rule);
const find = (r, rule) => r.findings.filter((f) => f.rule === rule);

test('the caps are those of spec 9.1', () => {
  assert.deepEqual({ ...CAPS }, { lines: 300, decisions: 10, dod: 15, screens: 6, tasks: 12 });
});

test('a clean project has no finding, a graph and a status row for each slice', () => {
  const r = checkSlices(project({ sheets: clean() }));
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.graph.nodes.map((n) => n.id), ['S-01', 'S-02', 'S-03']);
  assert.deepEqual(r.graph.edges, [{ from: 'S-01', to: 'S-02' }]);
  assert.deepEqual(r.status.map((s) => s.id), ['S-01', 'S-02', 'S-03']);
  assert.equal(r.status[1].title, 'Slice S-02');
});

test('parseBacklog returns the ID rows of the Backlog table with their lot and item', () => {
  assert.deepEqual(parseBacklog(PLAN), [
    { id: 'LOAN-01', title: 'Apply for a loan', lot: 'LOAN' },
    { id: 'LOAN-02', title: 'Review an application', lot: 'LOAN' },
    { id: 'PAY-01', title: 'Schedule a payout', lot: 'PAY' },
  ]);
  assert.deepEqual(parseBacklog('# Plan\n\n## Sprints\n\n| ID | Item |\n|---|---|\n| LOAN-01 | x |\n'), []);
  assert.deepEqual(parseBacklog('## Backlog\n\n| ID | Lot | Item |\n|---|---|---|\n| **LOAN-07** | Core | A \\| B |\n| note | x | y |\n'), [
    { id: 'LOAN-07', title: 'A | B', lot: 'LOAN' },
  ]);
});

test('glob overlap: segment by segment, a wildcard segment matches anything after it', () => {
  assert.equal(globsOverlap('src/api/**', 'src/api/users/**'), true);
  assert.equal(globsOverlap('src/api/users/**', 'src/api/**'), true);
  assert.equal(globsOverlap('src/api/users/**', 'src/api/orders/**'), false);
  assert.equal(globsOverlap('db/schema.sql', 'db/schema.sql'), true);
  assert.equal(globsOverlap('docs/**', 'src/**'), false);
  assert.equal(globsOverlap('**/*.md', 'src/**'), true);
  assert.equal(globsOverlap('src/api', 'src/apiary/**'), false);
  assert.equal(globsOverlap('src/apiary/**', 'src/api'), false);
  assert.equal(globsOverlap('src/api*', 'src/apiary/**'), true);
  assert.equal(globsOverlap('src/api', 'src/api/users.ts'), true);
  assert.equal(globsOverlap('./src/api/', 'src/api/**'), true);
  assert.equal(globsOverlap('src/*.ts', 'src/api/**'), true);
});

test('duplicate-branch: two sheets that name the same branch are an error on the second, naming the first', () => {
  const sheets = clean();
  sheets['S-01-apply.md'] = sheet({ id: 'S-01', scope: ['LOAN-01'], front: { branch: 'slice/s-01-shared' } });
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { branch: 'slice/s-01-shared' } });
  const r = checkSlices(project({ sheets }));
  const found = find(r, 'duplicate-branch');
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, 'error');
  assert.equal(found[0].file, 'slices/S-03-payout.md');
  assert.match(found[0].message, /S-03 names the branch slice\/s-01-shared, which S-01 names too/);
  assert.match(found[0].message, /one branch is one slice/);
  // The same branch in a different letter case is the same branch for the guard, so it counts.
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { branch: 'slice/S-01-SHARED' } });
  assert.equal(find(checkSlices(project({ sheets })), 'duplicate-branch').length, 1);
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { branch: 'slice/s-03-payout' } });
  assert.equal(find(checkSlices(project({ sheets })), 'duplicate-branch').length, 0);
});

test('slice-overlap: src/api and src/apiary/** are different folders', () => {
  const sheets = clean();
  sheets['S-01-apply.md'] = sheet({ id: 'S-01', scope: ['LOAN-01'], front: { touches: ['src/api'] } });
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { touches: ['src/apiary/**'] } });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), []);
});

test('slice-overlap: parallel slices with overlapping touches are an error that names both', () => {
  const sheets = clean();
  sheets['S-01-apply.md'] = sheet({ id: 'S-01', scope: ['LOAN-01'], front: { touches: ['src/api/**'] } });
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { touches: ['src/api/users/**'] } });
  const r = checkSlices(project({ sheets }));
  const [f] = find(r, 'slice-overlap');
  assert.equal(r.findings.length, 1);
  assert.equal(f.severity, 'error');
  assert.equal(f.file, 'slices/S-01-apply.md');
  assert.match(f.message, /S-01 and S-03/);
  assert.match(f.message, /src\/api\/\*\*/);
  assert.match(f.message, /src\/api\/users\/\*\*/);
});

test('slice-overlap: no finding when one slice depends on the other, even through a third', () => {
  const sheets = clean();
  sheets['S-01-apply.md'] = sheet({ id: 'S-01', scope: ['LOAN-01'], front: { touches: ['src/api/**'] } });
  sheets['S-02-review.md'] = sheet({ id: 'S-02', scope: ['LOAN-02'], front: { depends_on: ['S-01'], touches: ['src/review/**'] } });
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { depends_on: ['S-02'], touches: ['src/api/users/**'] } });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), []);
});

test('slice-cycle: S-02 to S-03 to S-02 names the cycle once', () => {
  const sheets = clean();
  sheets['S-02-review.md'] = sheet({ id: 'S-02', scope: ['LOAN-02'], front: { depends_on: ['S-03'] } });
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { depends_on: ['S-02'] } });
  const r = checkSlices(project({ sheets }));
  const cycles = find(r, 'slice-cycle');
  assert.equal(cycles.length, 1);
  assert.match(cycles[0].message, /S-02 -> S-03 -> S-02/);
  assert.equal(cycles[0].severity, 'error');
});

test('slice-cycle: a slice that depends on itself is a cycle', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { depends_on: ['S-03'] } });
  assert.match(find(checkSlices(project({ sheets })), 'slice-cycle')[0].message, /S-03 -> S-03/);
});

test('slice-unknown-dependency: depends_on must name a sheet', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { depends_on: ['S-09'] } });
  const f = find(checkSlices(project({ sheets })), 'slice-unknown-dependency');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /S-09/);
});

test('slice-too-long: a small sheet over 300 lines', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], extra: `${'A line of notes.\n'.repeat(300)}` });
  const f = find(checkSlices(project({ sheets })), 'slice-too-long');
  assert.equal(f.length, 1);
  assert.equal(f[0].file, 'slices/S-03-payout.md');
  assert.match(f[0].message, /At most 300/);
});

test('a small sheet of exactly 300 lines passes', () => {
  const base = sheet({ id: 'S-03', scope: ['PAY-01'] });
  const have = base.split('\n').length - 1;
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], extra: 'x\n'.repeat(300 - have).replace(/x\n/g, 'Note.\n') });
  assert.equal(sheets['S-03-payout.md'].split('\n').length - 1, 300);
  assert.deepEqual(find(checkSlices(project({ sheets })), 'slice-too-long'), []);
});

test('caps of a small sheet: 10 decisions, 15 DoD rows, 6 screens', () => {
  const decisions = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. Decision ${i + 1}.`).join('\n');
  const rows = (n) => Array.from({ length: n }, (_, i) => `| ${i + 1} | \`make test\` | green | yes |`).join('\n');
  const screens = (n) => Array.from({ length: n }, (_, i) => `- Screen ${i + 1}`).join('\n');
  const body = (d, r, s) => `# S-03: Slice\n\n## Scope\n\n- PAY-01 (gist)\n\n## Frozen decisions\n\n<!-- 1. commented out -->\n${decisions(d)}\n\n## Design\n\n${screens(s)}\n\n## Definition of Done\n\n| # | Command | Expected | Red? |\n|---|---|---|---|\n${rows(r)}\n`;
  const at = (d, r, s) => {
    const sheets = clean();
    sheets['S-03-payout.md'] = sheet({ id: 'S-03', body: body(d, r, s) });
    return rules(checkSlices(project({ sheets })));
  };
  assert.deepEqual(at(10, 15, 6), []);
  assert.deepEqual(at(11, 15, 6), ['slice-too-many-decisions']);
  assert.deepEqual(at(10, 16, 6), ['slice-too-many-dod']);
  assert.deepEqual(at(10, 15, 7), ['slice-too-many-screens']);
});

test('large slice: 12 tasks pass, 13 tasks is slice-too-many-tasks', () => {
  const tasks = (n) => Array.from({ length: n }, (_, i) => `## Task ${i + 1}: Part ${i + 1}\n\n### Frozen decisions\n\n1. One.\n`).join('\n');
  const body = (n) => `# S-03: Slice\n\n## Scope\n\n- PAY-01 (gist)\n\n${tasks(n)}`;
  const at = (n) => {
    const sheets = clean();
    sheets['S-03-payout.md'] = sheet({ id: 'S-03', front: { format: 'large' }, body: body(n) });
    return checkSlices(project({ sheets }));
  };
  assert.deepEqual(at(12).findings, []);
  const r = at(13);
  assert.deepEqual(rules(r), ['slice-too-many-tasks']);
  assert.match(r.findings[0].message, /13 tasks/);
});

test('large slice: the caps apply to each task, not to the whole sheet', () => {
  const decisions = (n) => Array.from({ length: n }, (_, i) => `${i + 1}. D${i + 1}.`).join('\n');
  const task = (i, d, extra = '') => `## Task ${i}: Part\n\n### Frozen decisions\n\n${decisions(d)}\n${extra}\n`;
  const sheets = clean();
  // Three tasks of 8 decisions: 24 in total, within the cap of each task.
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', front: { format: 'large' }, body: `# S\n\n## Scope\n\n- PAY-01 (g)\n\n${task(1, 8)}${task(2, 8)}${task(3, 8)}` });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), []);
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', front: { format: 'large' }, body: `# S\n\n## Scope\n\n- PAY-01 (g)\n\n${task(1, 8)}${task(2, 11)}` });
  const r = checkSlices(project({ sheets }));
  assert.deepEqual(rules(r), ['slice-too-many-decisions']);
  assert.match(r.findings[0].message, /Task 2/);
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', front: { format: 'large' }, body: `# S\n\n## Scope\n\n- PAY-01 (g)\n\n${task(1, 1, 'Line.\n'.repeat(300))}` });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), ['slice-too-long']);
});

test('large slice without any task is an error', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', front: { format: 'large' }, body: '# S\n\n## Scope\n\n- PAY-01 (g)\n' });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), ['slice-no-tasks']);
});

test('slice-header-missing names each missing key, and touches, format and implementer are required', () => {
  assert.ok(REQUIRED_KEYS.includes('implementer') && !REQUIRED_KEYS.includes('model') && !REQUIRED_KEYS.includes('effort'));
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { touches: undefined, format: undefined, implementer: undefined } });
  const f = find(checkSlices(project({ sheets })), 'slice-header-missing');
  assert.deepEqual(f.map((x) => /`(\w+):`/.exec(x.message)[1]).sort(), ['format', 'implementer', 'touches']);
});

test('slice-implementer: implementer or implementer-critical, nothing else', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { implementer: 'implementer-critical' } });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), []);
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { implementer: 'opus' } });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), ['slice-implementer']);
});

test('invalid format and lane, empty touches, and a header that is not a list', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { format: 'huge', lane: 'fast', touches: [] } });
  assert.deepEqual(rules(checkSlices(project({ sheets }))).sort(), ['slice-format', 'slice-lane', 'slice-touches-empty']);
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { lane: 'no-code', touches: [] } });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), []);
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { depends_on: 'S-01' } });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), ['slice-header-type']);
});

test('a sheet without front matter, with bad YAML, a bad name or a repeated id', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = '# S-03\n\n## Scope\n\n- PAY-01\n';
  assert.ok(rules(checkSlices(project({ sheets }))).includes('slice-front-matter'));
  sheets['S-03-payout.md'] = '---\nkey: [unclosed\n---\n\n# S\n';
  assert.ok(rules(checkSlices(project({ sheets }))).includes('slice-front-matter'));
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'] });
  sheets['S-4-oops.md'] = sheet({ id: 'S-04' });
  sheets['S-03-other.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { touches: ['elsewhere/**'] } });
  const r = checkSlices(project({ sheets }));
  assert.deepEqual(rules(r).sort(), ['slice-duplicate-id', 'slice-name']);
});

test('slice-hotspot: a slice touching a hotspot glob gets a warning, not an error', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { touches: ['db/migrations/**'] } });
  const r = checkSlices(project({ sheets, state: { hotspots: ['db/migrations/**', 'src/routes.ts'] } }));
  assert.deepEqual(rules(r), ['slice-hotspot']);
  assert.equal(r.findings[0].severity, 'warn');
  assert.match(r.findings[0].message, /S-03/);
  assert.match(r.findings[0].message, /db\/migrations\/\*\*/);
});

test('slice-hotspot: one warning for each slice and hotspot, even when several globs hit it', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { touches: ['db/migrations/a/**', 'db/migrations/b/**'] } });
  const r = checkSlices(project({ sheets, state: { hotspots: ['db/migrations/**', 'src/routes.ts'] } }));
  assert.deepEqual(rules(r), ['slice-hotspot']);
  const two = checkSlices(project({ sheets, state: { hotspots: ['db/migrations/**', 'db/migrations/a/**'] } }));
  assert.deepEqual(rules(two), ['slice-hotspot', 'slice-hotspot']);
});

test('story-uncovered: a backlog story that no slice cites in its Scope', () => {
  const sheets = clean();
  delete sheets['S-03-payout.md'];
  const r = checkSlices(project({ sheets }));
  const [f] = find(r, 'story-uncovered');
  assert.equal(r.findings.length, 1);
  assert.equal(f.file, 'docs/PLAN.md');
  assert.match(f.message, /PAY-01/);
  assert.equal(PLAN.split('\n')[f.line - 1].startsWith('| PAY-01'), true);
});

test('story-twice: a backlog story cited in the Scope of two slices names both', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01', 'LOAN-01'] });
  const r = checkSlices(project({ sheets }));
  const [f] = find(r, 'story-twice');
  assert.equal(r.findings.length, 1);
  assert.match(f.message, /LOAN-01/);
  assert.match(f.message, /S-01, S-03/);
});

test('a story cited outside the Scope does not count, and neither does an id in a comment', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', body: '# S\n\n## Goal\n\nPAY-01 is mentioned here.\n\n## Scope\n\n<!-- PAY-01 -->\n\nNothing.\n' });
  assert.deepEqual(rules(checkSlices(project({ sheets }))), ['story-uncovered']);
});

test('a PLAN without a Backlog section is plan-no-backlog, not a silent pass', () => {
  const r = checkSlices(project({ sheets: clean(), plan: '# Plan\n\n## Sprints\n\n| Sprint |\n|---|\n| 1 |\n' }));
  assert.deepEqual(rules(r), ['plan-no-backlog']);
  assert.equal(r.findings[0].severity, 'error');
  assert.deepEqual(parseBacklog('# Plan\n'), []);
});

test('without PLAN, the check says so', () => {
  const r = checkSlices(project({ sheets: clean(), plan: null }));
  assert.deepEqual(rules(r), ['plan-missing']);
});

test('a project with no slices folder gives one story-uncovered per story', () => {
  const root = project({ sheets: {} });
  const r = checkSlices(root);
  assert.deepEqual(rules(r), ['story-uncovered', 'story-uncovered', 'story-uncovered']);
});

test('renderGraph draws a Mermaid flowchart with the dependency arrows', () => {
  const r = checkSlices(project({ sheets: { ...clean(), 'S-04-big.md': sheet({ id: 'S-04', scope: [], front: { format: 'large', depends_on: ['S-01', 'S-03'] } }) } }));
  const text = renderGraph(r.graph);
  assert.match(text, /```mermaid\nflowchart LR\n/);
  assert.match(text, /S_01\["S-01: Slice S-01"\]/);
  assert.match(text, /S_04\[\["S-04: Slice S-04"\]\]/);
  assert.match(text, /S_01 --> S_02/);
  assert.match(text, /S_03 --> S_04/);
  assert.match(renderGraph({ nodes: [], edges: [] }), /No slices yet/);
});

test('renderStatus is a table with one row per slice, then the external prerequisites and the slices in progress', () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { external_prerequisite: 'Sandbox keys from the bank' } });
  const root = project({ sheets });
  writeFileSync(join(root, 'slices', 'STATUS.md'), '| Slice | Title | State | Note |\n|---|---|---|---|\n| S-03 | x | in-progress | Waits for keys |\n');
  const text = renderStatus(checkSlices(root).status);
  assert.match(text, /^<!-- Generated by recade slices status\. Do not edit\. -->/);
  assert.match(text, /\| Slice \| Title \| Format \| Lane \| Increment \| State \| Depends on \| Size \| Note \|/);
  assert.match(text, /\| S-02 \| Slice S-02 \| small \| standard \| INC-1 \| todo \| S-01 \| M \| {2}\|/);
  assert.match(text, /\| S-03 \|.*in-progress.*Waits for keys \|/);
  assert.match(text, /## External prerequisites\n\n\| Slice \| Prerequisite \|\n\|---\|---\|\n\| S-03 \| Sandbox keys from the bank \|/);
  assert.match(text, /## In progress\n\n- S-03: Slice S-03\n/);
  const none = renderStatus(checkSlices(project({ sheets: clean() })).status);
  assert.match(none, /## External prerequisites\n\nNone\.\n/);
  assert.match(none, /## In progress\n\nNone\.\n/);
});

test('STATUS.md is the only home of the state: a sheet status key is ignored, states survive a new run, new slices are todo', async () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { status: 'done' } });
  const root = project({ sheets });
  assert.equal(checkSlices(root).status.find((s) => s.id === 'S-03').status, 'todo');
  assert.equal((await cli(['slices', 'status'], root)).code, 0);
  const path = join(root, 'slices', 'STATUS.md');
  const first = readFileSync(path, 'utf8');
  assert.equal(first.split('\n').filter((l) => /\| todo \|/.test(l)).length, 3);
  writeFileSync(path, first.replace(/(\| S-01 \|.*?\| )todo( \|.*?\| )( *)\|/, '$1done$2Shipped \\| fine |').replace(/(\| S-02 \|.*?\| )todo/, '$1in-progress'));
  sheets['S-04-new.md'] = sheet({ id: 'S-04', scope: [], front: { touches: ['src/new/**'] } });
  for (const [name, text] of Object.entries(sheets)) writeFileSync(join(root, 'slices', name), text);
  assert.equal((await cli(['slices', 'status'], root)).code, 0);
  const rows = Object.fromEntries(checkSlices(root).status.map((s) => [s.id, s]));
  assert.equal(rows['S-01'].status, 'done');
  assert.equal(rows['S-01'].note, 'Shipped | fine');
  assert.equal(rows['S-02'].status, 'in-progress');
  assert.equal(rows['S-03'].status, 'todo');
  assert.equal(rows['S-04'].status, 'todo');
  const text = readFileSync(path, 'utf8');
  assert.match(text, /\| S-01 \|.*\| done \|.*Shipped \\\| fine \|/);
  assert.match(text, /## In progress\n\n- S-02: /);
});

test('generated files pass lint-style', () => {
  const r = checkSlices(project({ sheets: clean() }));
  for (const text of [renderGraph(r.graph), renderStatus(r.status)]) {
    assert.deepEqual(lintText(text, 'slices/x.md').filter((f) => f.severity === 'error'), []);
  }
});

function cli(args, cwd) {
  const out = [];
  const err = [];
  return run(args, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {} })
    .then((code) => ({ code, out: out.join(''), err: err.join('') }));
}

test('recade slices check: exit 0 when clean, exit 1 with findings, exit 2 with bad usage, exit 1 outside a project', async () => {
  const good = project({ sheets: clean() });
  const ok = await cli(['slices', 'check'], good);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /Slices check passed: 3 slices\./);
  const sheets = clean();
  delete sheets['S-03-payout.md'];
  const bad = await cli(['slices', 'check', '--project', project({ sheets })], tmpdir());
  assert.equal(bad.code, 1);
  assert.match(bad.out, /^docs\/PLAN\.md:\d+:1 error story-uncovered /m);
  assert.equal((await cli(['slices'], good)).code, 2);
  assert.equal((await cli(['slices', 'nope'], good)).code, 2);
  assert.equal((await cli(['slices', 'check', 'extra'], good)).code, 2);
  const lone = mkdtempSync(join(tmpdir(), 'recade-none-'));
  const none = await cli(['slices', 'check'], lone);
  assert.equal(none.code, 1);
  assert.match(none.err, /No Recade project here/);
});

test('recade slices check prints warnings but exits 0 when there are only warnings', async () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { touches: ['db/migrations/**'] } });
  const root = project({ sheets, state: { hotspots: ['db/migrations/**'] } });
  const r = await cli(['slices', 'check'], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /warn slice-hotspot/);
});

test('recade slices graph and status write slices/graph.md and slices/STATUS.md', async () => {
  const root = project({ sheets: clean() });
  const g = await cli(['slices', 'graph'], root);
  assert.equal(g.code, 0);
  assert.match(g.out, /Wrote slices\/graph\.md with 3 slices\./);
  assert.match(readFileSync(join(root, 'slices', 'graph.md'), 'utf8'), /S_01 --> S_02/);
  const s = await cli(['slices', 'status', '--project', root], tmpdir());
  assert.equal(s.code, 0);
  assert.match(readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8'), /\| S-01 \| Slice S-01 \|/);
  // The generated files are not sheets: the check still passes.
  assert.equal((await cli(['slices', 'check'], root)).code, 0);
});

// ---- recade slices status --set <S-nn> <status>

const setCli = (root, ...args) => cli(['slices', 'status', '--set', ...args], root);
const rowOf = (root, id) => checkSlices(root).status.find((s) => s.id === id);

test('STATUSES is exactly the eleven statuses of the protocol', () => {
  assert.deepEqual([...STATUSES], ['todo', 'design', 'spec', 'gate-1', 'tests', 'implementation', 'audit', 'gate-2', 'ready-to-merge', 'done', 'blocked']);
});

test('allowedNext follows the table of the protocol, lane by lane', () => {
  assert.deepEqual(allowedNext('todo', 'sensitive'), ['design', 'spec', 'blocked']);
  assert.deepEqual(allowedNext('todo', 'standard'), ['spec', 'blocked']);
  assert.deepEqual(allowedNext('todo', 'no-code'), ['blocked', 'done']);
  assert.deepEqual(allowedNext('spec', 'sensitive'), ['gate-1', 'blocked']);
  assert.deepEqual(allowedNext('spec', 'standard'), ['tests', 'blocked']);
  assert.deepEqual(allowedNext('gate-1', 'sensitive'), ['tests', 'spec', 'blocked']);
  assert.deepEqual(allowedNext('audit', 'sensitive'), ['gate-2', 'implementation', 'spec', 'blocked']);
  assert.deepEqual(allowedNext('audit', 'standard'), ['ready-to-merge', 'implementation', 'spec', 'blocked']);
  assert.deepEqual(allowedNext('gate-2', 'sensitive'), ['ready-to-merge', 'implementation', 'spec', 'blocked']);
  assert.deepEqual(allowedNext('ready-to-merge', 'standard'), ['done', 'implementation', 'blocked']);
  assert.deepEqual(allowedNext('done', 'standard'), []);
  assert.deepEqual(allowedNext('blocked', 'standard', 'implementation'), ['implementation']);
  assert.deepEqual(allowedNext('nope', 'standard'), null);
});

test('--set moves a slice along the standard lane and keeps the other rows and notes', async () => {
  const root = project({ sheets: clean() });
  assert.equal((await cli(['slices', 'status'], root)).code, 0);
  for (const next of ['spec', 'tests', 'implementation', 'audit', 'ready-to-merge', 'done']) {
    const r = await setCli(root, 'S-01', next);
    assert.equal(r.code, 0, r.err);
  }
  assert.equal(rowOf(root, 'S-01').status, 'done');
  assert.equal(rowOf(root, 'S-02').status, 'todo');
  const last = await setCli(root, 'S-03', 'spec');
  assert.match(last.out, /^S-03: todo -> spec\n$/);
  assert.match(readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8'), /\| S-03 \|.*\| spec \|/);
});

test('--set works when STATUS.md does not exist yet, and reads the lane from the sheet', async () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { lane: 'sensitive' } });
  const root = project({ sheets });
  assert.equal((await setCli(root, 'S-03', 'design')).code, 0);
  assert.equal((await setCli(root, 'S-03', 'spec')).code, 0);
  const bad = await setCli(root, 'S-03', 'tests');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /gate-1, blocked/);
  assert.equal((await setCli(root, 'S-03', 'gate-1')).code, 0);
});

test('--set refuses an invalid transition with exit 1 and the allowed next statuses, and writes nothing', async () => {
  const root = project({ sheets: clean() });
  const r = await setCli(root, 'S-01', 'implementation');
  assert.equal(r.code, 1);
  assert.match(r.err, /S-01 is todo: it cannot move to implementation\. Allowed next: spec, blocked\./);
  assert.equal(rowOf(root, 'S-01').status, 'todo');
  const skip = await setCli(root, 'S-01', 'design');
  assert.equal(skip.code, 1, 'design is for the sensitive lane');
  const same = await setCli(root, 'S-01', 'todo');
  assert.equal(same.code, 1);
});

test('--set refuses a status outside the eleven, an unknown slice and a missing project', async () => {
  const root = project({ sheets: clean() });
  const odd = await setCli(root, 'S-01', 'in-progress');
  assert.equal(odd.code, 1);
  assert.match(odd.err, /not a status/);
  assert.match(odd.err, /todo, design, spec, gate-1, tests, implementation, audit, gate-2, ready-to-merge, done, blocked/);
  const ghost = await setCli(root, 'S-09', 'spec');
  assert.equal(ghost.code, 1);
  assert.match(ghost.err, /No slice S-09/);
  const lone = mkdtempSync(join(tmpdir(), 'recade-none-'));
  const none = await setCli(lone, 'S-01', 'spec');
  assert.equal(none.code, 1);
  assert.match(none.err, /No Recade project here/);
});

test('--set refuses a current status that is not one of the eleven', async () => {
  const root = project({ sheets: clean() });
  await cli(['slices', 'status'], root);
  const path = join(root, 'slices', 'STATUS.md');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/(\| S-01 \|.*?\| )todo/, '$1in-progress'));
  const r = await setCli(root, 'S-01', 'spec');
  assert.equal(r.code, 1);
  assert.match(r.err, /in-progress is not a status/);
});

test('--set usage errors exit 2', async () => {
  const root = project({ sheets: clean() });
  assert.equal((await cli(['slices', 'status', '--set'], root)).code, 2);
  assert.equal((await cli(['slices', 'status', '--set', 'S-01'], root)).code, 2);
  assert.equal((await cli(['slices', 'status', '--set', 'S-01', 'spec', 'extra'], root)).code, 2);
  assert.equal((await cli(['slices', 'status', '--set', 'S-1', 'spec'], root)).code, 2);
  assert.equal((await cli(['slices', 'check', '--set', 'S-01', 'spec'], root)).code, 2);
  assert.equal((await cli(['slices', 'status', '--set', 'S-01', 'spec', '--note'], root)).code, 2);
});

test('blocked needs a cause, keeps it in the note, and only goes back to the status it left', async () => {
  const root = project({ sheets: clean() });
  await setCli(root, 'S-01', 'spec');
  await setCli(root, 'S-01', 'tests');
  const noCause = await setCli(root, 'S-01', 'blocked');
  assert.equal(noCause.code, 1);
  assert.match(noCause.err, /--note/);
  const blocked = await setCli(root, 'S-01', 'blocked', '--note', 'Waits for the sandbox keys | PRV-02');
  assert.equal(blocked.code, 0, blocked.err);
  assert.equal(rowOf(root, 'S-01').note, 'Blocked from tests: Waits for the sandbox keys | PRV-02');
  const wrong = await setCli(root, 'S-01', 'spec');
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /Allowed next: tests\./);
  const back = await setCli(root, 'S-01', 'tests');
  assert.equal(back.code, 0, back.err);
  assert.equal(rowOf(root, 'S-01').note, '');
});

test('--note replaces the note of a row without touching the others', async () => {
  const root = project({ sheets: clean() });
  await setCli(root, 'S-02', 'spec', '--note', 'Short spec written');
  assert.equal(rowOf(root, 'S-02').note, 'Short spec written');
  assert.equal(rowOf(root, 'S-01').note, '');
});

test('no-code slices use only todo, blocked and done', async () => {
  const sheets = clean();
  sheets['S-03-payout.md'] = sheet({ id: 'S-03', scope: ['PAY-01'], front: { lane: 'no-code' } });
  const root = project({ sheets });
  assert.equal((await setCli(root, 'S-03', 'spec')).code, 1);
  assert.equal((await setCli(root, 'S-03', 'done')).code, 0);
});

test('REOPEN and a late fix are legal moves of the table', async () => {
  const root = project({ sheets: clean() });
  for (const s of ['spec', 'tests', 'implementation', 'audit']) await setCli(root, 'S-01', s);
  assert.equal((await setCli(root, 'S-01', 'spec')).code, 0, 'audit to spec (REOPEN)');
  for (const s of ['tests', 'implementation', 'audit', 'ready-to-merge']) await setCli(root, 'S-01', s);
  assert.equal((await setCli(root, 'S-01', 'implementation')).code, 0, 'late fix');
  assert.equal(rowOf(root, 'S-01').status, 'implementation');
});

test('--note on an ordinary move keeps the existing note unless a new one is given', async () => {
  const root = project({ sheets: clean() });
  await setCli(root, 'S-02', 'spec', '--note', 'Short spec written');
  await setCli(root, 'S-02', 'tests');
  assert.equal(rowOf(root, 'S-02').note, 'Short spec written');
  await setCli(root, 'S-02', 'implementation', '--note', 'Tests red');
  assert.equal(rowOf(root, 'S-02').note, 'Tests red');
});
