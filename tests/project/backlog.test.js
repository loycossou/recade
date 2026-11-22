import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLots, parseStories, storyBody, storyOfBody } from '../../src/project/backlog.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TABLE = `## Backlog

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| CAT-01 | Catalogue | Tool records | M | 2 | | 1 | Build | Backlog | Loads the spreadsheet |
| CAT-02 | Catalogue | Tool in repair | S | | CAT-01 | 2 | Build | Backlog | |
`;

test('the Backlog table of the template: estimate, dependency, sprint and comment', () => {
  const [a, b] = parseStories(TABLE);
  assert.deepEqual(
    { id: a.id, lot: a.lot, lotName: a.lotName, title: a.title, size: a.size, points: a.points, sprint: a.sprint, phase: a.phase, comment: a.comment, dependsOn: a.dependsOn },
    { id: 'CAT-01', lot: 'CAT', lotName: 'Catalogue', title: 'Tool records', size: 'M', points: 2, sprint: '1', phase: 'Build', comment: 'Loads the spreadsheet', dependsOn: [] },
  );
  assert.equal(b.points, 1, 'no Points: the points of the size');
  assert.deepEqual(b.dependsOn, ['CAT-01']);
  assert.equal(a.description, '');
  assert.deepEqual(a.criteria, []);
  assert.equal(a.increment, '', 'no Sprints and no Increments table: no increment');
});

test('a Backlog table with more columns: description, acceptance criteria, priority and increment', () => {
  const plan = `## Backlog

| ID | Lot | Item | User story | Acceptance criteria | Priority | Increment | Estimate | Depends on |
|---|---|---|---|---|---|---|---|---|
| MEM-01 | Members | Member list | As a volunteer, I find a member by name | Search by name; Shows the phone \\| email | p1 | INC-2 | 3 | CAT-01 and CAT-02 |
`;
  const [s] = parseStories(plan);
  assert.equal(s.description, 'As a volunteer, I find a member by name');
  assert.deepEqual(s.criteria, ['Search by name', 'Shows the phone | email']);
  assert.equal(s.priority, 'P1');
  assert.equal(s.increment, 'INC-2');
  assert.equal(s.points, 3);
  assert.deepEqual(s.dependsOn, ['CAT-01', 'CAT-02']);
});

test('a story block under its ID: the text, then the criteria under a label or a heading, wherever the block sits', () => {
  const plan = `${TABLE}
### Story CAT-01 Tool records

As a volunteer, I see every tool with its state.

**Acceptance criteria:**
- A tool shows its name and its state.
- [ ] A tool in repair is marked.

### CAT-02: Tool in repair

The desk marks a tool as in repair.

#### Acceptance criteria

1. The tool cannot be lent.
2. The repair has a date.

#### Notes

- Not a criterion.

## Sprints

| Sprint | Start | End | Theme | Planned points | Capacity | Margin | Milestone |
|---|---|---|---|---|---|---|---|
`;
  const [a, b] = parseStories(plan);
  assert.equal(a.description, 'As a volunteer, I see every tool with its state.');
  assert.deepEqual(a.criteria, ['A tool shows its name and its state.', 'A tool in repair is marked.']);
  assert.equal(b.description, 'The desk marks a tool as in repair.\n\n#### Notes\n\n- Not a criterion.', 'another part of the block stays in its text');
  assert.deepEqual(b.criteria, ['The tool cannot be lent.', 'The repair has a date.']);
});

test('the increment of a story is the one that ends at the milestone of its sprint, or of the next sprint with one', () => {
  const plan = `## Increments

| ID | Increment | Goal | Ends at |
|---|---|---|---|
| INC-1 | Desk loop | A loan | M1 |
| INC-2 | Full shift | A shift | M2 |

${TABLE.replace('| 1 | Build | Backlog | Loads', '| 1 | Build | Backlog | Loads').replace('| CAT-01 | 2 | Build', '| CAT-01 | 2 | Build')}
## Sprints

| Sprint | Start | End | Theme | Planned points | Capacity | Margin | Milestone |
|---|---|---|---|---|---|---|---|
| 1 | 2026-11-23 | 2026-12-04 | Desk | 2 | 8 | 6 | |
| 2 | 2026-12-07 | 2026-12-18 | Shift | 1 | 8 | 7 | M1 |
`;
  assert.deepEqual(parseStories(plan).map((s) => s.increment), ['INC-1', 'INC-1']);
});

test('comments and fenced blocks are not read, and a PLAN without a Backlog has no story', () => {
  const plan = `<!-- | ID | Lot | Item |\n| X-01 | x | hidden | -->\n${TABLE}\n\`\`\`\n### CAT-01 Fenced\nNot a block.\n\`\`\`\n`;
  assert.deepEqual(parseStories(plan).map((s) => s.id), ['CAT-01', 'CAT-02']);
  assert.equal(parseStories(plan)[0].description, '');
  assert.deepEqual(parseStories('## Summary\n\n| Item | Value |\n|---|---|\n'), []);
});

test('the recorded PLANs of the example read in full', () => {
  for (const [file, ids] of [
    ['example/recorded/scratch/docs/docs/PLAN.md', ['CAT-01', 'CAT-02', 'MEM-01', 'LOAN-01', 'LOAN-02', 'LOAN-03', 'REP-01']],
    ['example/recorded/adopt/bible/docs/PLAN.md', ['FEE-01', 'LED-01', 'RPT-01']],
  ]) {
    const stories = parseStories(readFileSync(join(ROOT, file), 'utf8'));
    assert.deepEqual(stories.map((s) => s.id), ids, file);
    for (const s of stories) {
      assert.ok(s.title !== '' && s.points !== null && s.lotName !== '', `${file} ${s.id}`);
      assert.match(s.increment, /^INC-\d$/, `${file} ${s.id}`);
    }
  }
});

test('the Lots table: code, name and goal; a row that is not a code is skipped', () => {
  const lots = parseLots('## Lots\n\n| Code | Lot | Goal |\n|---|---|---|\n| CAT | Catalogue | Know every tool |\n| bad | x | y |\n| REP | Reports | |\n');
  assert.deepEqual([...lots], [['CAT', { name: 'Catalogue', goal: 'Know every tool' }], ['REP', { name: 'Reports', goal: '' }]]);
  assert.equal(parseLots(TABLE).size, 0);
});

test('a story body starts with its marker and lists only what the PLAN gives', () => {
  const [, b] = parseStories(TABLE);
  const body = storyBody(b, 'docs/PLAN.md');
  assert.equal(storyOfBody(body), 'CAT-02');
  assert.equal(body, '<!-- recade:story CAT-02 -->\nBacklog story CAT-02 of docs/PLAN.md, in the lot CAT (Catalogue).\n\n- Estimate: S, 1 point\n- Sprint: 2\n- Phase: Build\n- Depends on: CAT-01');
  assert.equal(storyOfBody('Backlog story CAT-02 of docs/PLAN.md.'), null);
});
