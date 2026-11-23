import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { run } from '../../src/cli.js';
import { chromiumStatus } from '../../src/render/browser.js';
import { RenderError } from '../../src/render/pipeline.js';
import { decisionRegisterMarkdown, readDecisions, readReviews, renderExtras, reviewRegisterMarkdown } from '../../src/render/extras.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/render/fernhill/', import.meta.url));
const skip = chromiumStatus().ok ? false : 'Chromium is not installed';
if (skip) console.log(`# extras tests needing Chromium are skipped: ${skip}`);
const NO_CHROMIUM = () => ({ ok: false, path: null, fix: 'npx --prefix "/plug in" playwright install chromium', detail: 'No Chromium executable reported' });
const EM = String.fromCharCode(0x2014);

const STACK = `---
doc_id: STACK
title: Fernhill Lending, stack decision
project: Fernhill Lending
version: "0.1"
date: 2026-11-18
status: draft
---

## 1. Criteria and weights

| Criterion | Source | Weight |
|---|---|---|
| One volunteer can restart it | Intake | 60 |
| Few dependencies | Intake | 40 |

## 5. Weighted matrix

| Criterion | Weight | Node built-in | Web framework |
|---|---|---|---|
| One volunteer can restart it | 60 | 5, nothing to upgrade | 3, more moving parts |
| Few dependencies | 40 | 5, none | 2, many |
| Total | 100 | 5 | 2.6 |

## 6. Risks and exit cost

The built-in module is marked experimental.
`;

const DEC = (n, { status, question, decided }) => `---
doc_id: "DEC-0${n}"
title: "${question}"
project: "fernhill-lending"
version: "0.1"
date: "2026-11-18"
status: ${status}
language: "en"
document: "STACK"
due: "2026-11-20"
---

# DEC-0${n}: ${question}

## Question

${question}

## Why now

The layer decides the tests.

## Options

### Option A: JSON file

| Item | Value |
|---|---|
| Cost | No new dependency |
| Risks | A race on two loans \\| maybe more |

### Option B: SQLite file

| Item | Value |
|---|---|
| Cost | One built-in module |
| Calendar impact | Costs two days |

## Recommendation and its price

SQLite file, at the price of two days.

## Decision

> [!DECISION]
> ${decided}
`;

const REVIEW = (name, title, body) => `---
doc_id: REVIEW-${name}
title: "${title}"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-18"
status: final
language: "en"
---

# ${title}

${body}
`;

const BOARD = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>body{background:#faf6ee;color:#1d2b4a;font:18px Georgia,serif}</style></head><body><h1>${name}</h1><p>Saturday desk</p></body></html>\n`;

/** A temp copy of the Fernhill project with a STACK, two DECs, two review notes and two boards. */
function project(t, { stack = true, decisions = true, reviews = true, boards = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'recade extras '));
  const root = join(base, 'fern hill');
  cpSync(FIXTURE, root, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  if (stack) put('docs/STACK.md', STACK);
  if (decisions) {
    put('decisions/DEC-01.md', DEC(1, { status: 'closed', question: 'Where does the desk store its data?', decided: 'Decided: yes. Option: B (SQLite file). By: owner. Date: 2026-11-18.' }));
    put('decisions/DEC-02.md', DEC(2, { status: 'open', question: 'Which server runs the desk?', decided: 'Decided: not yet. Option: none. By: nobody. Date: none.' }));
  }
  if (reviews) {
    put('docs/reviews/D1-architect.md', REVIEW('D1-ARCHITECT', 'Review of D1 by the architect', '## Findings\n\n| Severity | Finding |\n|---|---|\n| nit | Keep NFR-01 provisional. |\n'));
    put('docs/reviews/D1-security-lead.md', REVIEW('D1-SECURITY-LEAD', 'Review of D1 by the security lead', '## Findings\n\nNo blocker.\n'));
  }
  if (boards) {
    put('design/directions/ledger-paper.html', BOARD('Ledger paper'));
    put('design/directions/night-shift.html', BOARD('Night shift'));
    put('design/directions/README.md', '# Directions\n');
  }
  return root;
}

function configDir(t, extras) {
  const dir = mkdtempSync(join(tmpdir(), 'recade extras cfg '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (extras !== undefined) writeFileSync(join(dir, 'config.yaml'), `deliverables:\n  extras: [${extras.join(', ')}]\n`);
  return dir;
}

async function cli(root, extras, { args = [], ...io } = {}, t) {
  const out = [];
  const err = [];
  const cfg = configDir(t, extras);
  const code = await run(['render', 'extras', '--project', root, ...args], {
    stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
    cwd: tmpdir(), env: { ...process.env, RECADE_CONFIG_DIR: cfg }, ...io,
  });
  return { code, out: out.join(''), err: err.join('') };
}

const deliverables = (root) => join(root, 'docs', 'deliverables');
const listDeliverables = (root) => (existsSync(deliverables(root)) ? readdirSync(deliverables(root)).sort() : []);
const isZip = (file) => readFileSync(file).subarray(0, 2).toString() === 'PK';
const isPdf = (file) => readFileSync(file).subarray(0, 5).toString() === '%PDF-';
const docxText = async (file) => (await (await JSZip.loadAsync(readFileSync(file))).file('word/document.xml').async('string')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sheetsOf = async (file) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(readFileSync(file));
  return wb;
};
const everyFile = (root) => readdirSync(root, { recursive: true }).map(String);

// ---------------------------------------------------------------------------------------------------------------
// The registers, in memory

test('readDecisions reads every DEC in number order with its options, its choice and its date', (t) => {
  const root = project(t);
  const { entries, warnings } = readDecisions(root);
  assert.deepEqual(warnings, []);
  assert.deepEqual(entries.map((e) => e.id), ['DEC-01', 'DEC-02']);
  const [one, two] = entries;
  assert.equal(one.question, 'Where does the desk store its data?');
  assert.equal(one.status, 'closed');
  assert.equal(one.document, 'STACK');
  assert.equal(one.chosen, 'B (SQLite file)');
  assert.equal(one.decidedBy, 'owner');
  assert.equal(one.date, '2026-11-18');
  assert.equal(one.due, '2026-11-20');
  assert.deepEqual(one.options.map((o) => o.letter), ['A', 'B']);
  assert.equal(one.options[0].label, 'JSON file');
  assert.deepEqual(one.options[0].items, [['Cost', 'No new dependency'], ['Risks', 'A race on two loans | maybe more']]);
  assert.equal(one.recommendation, 'SQLite file, at the price of two days.');
  assert.equal(two.status, 'open');
  assert.equal(two.chosen, 'none yet');
  assert.equal(two.date, '');
});

test('readDecisions skips a file it cannot read with one warning, and ignores other files', (t) => {
  const root = project(t);
  writeFileSync(join(root, 'decisions', 'DEC-03.md'), '# no front matter\n');
  writeFileSync(join(root, 'decisions', 'notes.md'), 'not a decision\n');
  writeFileSync(join(root, 'decisions', 'DEC-1.md'), 'too short a number\n');
  const { entries, warnings } = readDecisions(root);
  assert.deepEqual(entries.map((e) => e.id), ['DEC-01', 'DEC-02']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /decisions\/DEC-03\.md/);
});

test('the decision register is one Markdown document with a summary table and one section per DEC', (t) => {
  const root = project(t);
  const { entries } = readDecisions(root);
  const md = decisionRegisterMarkdown(entries, { project: 'Fernhill Lending', date: '2026-11-21', language: 'en' });
  assert.match(md, /^---\ndoc_id: DECISIONS\n/);
  assert.match(md, /title: Fernhill Lending, decision register/);
  assert.match(md, /\| DEC-01 \| Where does the desk store its data\? \| STACK \| closed \| B \(SQLite file\) \| 2026-11-18 \|/);
  assert.match(md, /^## DEC-01: Where does the desk store its data\?$/m);
  assert.match(md, /^## DEC-02: Which server runs the desk\?$/m);
  assert.match(md, /\| Option \| Cost \| Risks \| Calendar impact \|/);
  assert.match(md, /\| A: JSON file \| No new dependency \| A race on two loans \\\| maybe more \| {2}\|/);
  assert.equal(md.includes(EM), false);
});

test('readReviews gathers every note in name order and the register has one section for each', (t) => {
  const root = project(t);
  writeFileSync(join(root, 'docs', 'reviews', 'broken.md'), 'no front matter\n');
  writeFileSync(join(root, 'docs', 'reviews', 'zz.txt'), 'ignored\n');
  const { notes, warnings } = readReviews(root);
  assert.deepEqual(notes.map((n) => n.title), ['Review of D1 by the architect', 'Review of D1 by the security lead']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /docs\/reviews\/broken\.md/);
  const md = reviewRegisterMarkdown(notes, { project: 'Fernhill Lending', date: '2026-11-21', language: 'en' });
  assert.match(md, /doc_id: REVIEWS/);
  assert.match(md, /^## Review of D1 by the architect$/m);
  assert.match(md, /^## Review of D1 by the security lead$/m);
  assert.match(md, /^### Findings$/m);
  assert.equal(md.match(/^# /gm), null);
});

test('a heading inside a code fence of a review note is not moved down', () => {
  const note = { title: 'T', date: '2026-11-18', status: 'final', body: '# T\n\n```\n# not a heading\n```\n\n## Real\n' };
  const md = reviewRegisterMarkdown([note], { project: 'P', date: '2026-11-21', language: 'en' });
  assert.match(md, /^# not a heading$/m);
  assert.match(md, /^### Real$/m);
});

// ---------------------------------------------------------------------------------------------------------------
// The command

test('with no extra chosen and no deck, render extras prints one line for each, writes nothing and exits 0', async (t) => {
  const root = project(t);
  for (const extras of [undefined, []]) {
    const { code, out, err } = await cli(root, extras, {}, t);
    assert.equal(code, 0, err);
    assert.equal(out.trim().split('\n').length, 2);
    assert.match(out, /No extra deliverables chosen/);
    assert.match(out, /^No deck: deliverables\.deck is ask/m);
    assert.match(out, /recade config set deliverables\.extras/);
    assert.equal(err, '');
  }
  assert.deepEqual(listDeliverables(root), []);
});

test('stack: STACK_Stack-Decision.docx and the matrix workbook of the same name, one sheet for the weighted matrix', { skip }, async (t) => {
  const root = project(t);
  const { code, out, err } = await cli(root, ['stack'], {}, t);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['STACK_Stack-Decision.docx', 'STACK_Stack-Decision.xlsx']);
  assert.ok(isZip(join(deliverables(root), 'STACK_Stack-Decision.docx')));
  for (const name of ['STACK_Stack-Decision.docx', 'STACK_Stack-Decision.xlsx']) assert.ok(out.includes(`Wrote ${join(deliverables(root), name)}`), name);
  const wb = await sheetsOf(join(deliverables(root), 'STACK_Stack-Decision.xlsx'));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Weighted matrix']);
  const ws = wb.worksheets[0];
  assert.deepEqual(ws.getRow(4).values.slice(1), ['Criterion', 'Weight', 'Node built-in', 'Web framework']);
  assert.equal(ws.getCell('B5').value, 60);
  assert.equal(ws.getCell('C6').value, '5, none');
  assert.equal(ws.getCell('D7').value, 2.6);
});

test('stack: no docs/STACK.md is one warning on stderr, exit 0 and no file', async (t) => {
  const root = project(t, { stack: false });
  const { code, out, err } = await cli(root, ['stack'], {}, t);
  assert.equal(code, 0);
  assert.match(err, /^Warning: no docs\/STACK\.md, nothing to render for stack\.\n$/);
  assert.equal(out.includes('Wrote'), false);
  assert.deepEqual(listDeliverables(root), []);
});

test('stack: a STACK with no table in section 5 still gives the docx, and warns about the matrix', { skip }, async (t) => {
  const root = project(t, { stack: false });
  writeFileSync(join(root, 'docs', 'STACK.md'), STACK.replace(/## 5\. Weighted matrix[^]*?## 6/, '## 5. Weighted matrix\n\nNot applicable, adopt mode.\n\n## 6'));
  const { code, out, err } = await cli(root, ['stack'], {}, t);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['STACK_Stack-Decision.docx']);
  assert.match(out, /stack-matrix/);
});

test('stack: a failing check stops everything, and --no-check lets it through', { skip }, async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'docs', 'STACK.md'), STACK.replace('Few dependencies | Intake', `Few dependencies ${EM} really | Intake`));
  const failed = await cli(root, ['stack', 'reviews'], {}, t);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /Not rendered: 1 check failed/);
  assert.deepEqual(listDeliverables(root), []);
  const forced = await cli(root, ['stack'], { args: ['--no-check'] }, t);
  assert.equal(forced.code, 0, forced.err);
  assert.deepEqual(listDeliverables(root), ['STACK_Stack-Decision.docx', 'STACK_Stack-Decision.xlsx']);
});

test('decisions: DECISIONS_Decision-Register.docx and .xlsx, one row per DEC, and no register file anywhere in the project', { skip }, async (t) => {
  const root = project(t);
  const before = new Set(everyFile(root));
  const { code, err } = await cli(root, ['decisions'], {}, t);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['DECISIONS_Decision-Register.docx', 'DECISIONS_Decision-Register.xlsx']);
  const text = await docxText(join(deliverables(root), 'DECISIONS_Decision-Register.docx'));
  for (const part of ['DEC-01', 'Where does the desk store its data?', 'B (SQLite file)', 'DEC-02', 'Which server runs the desk?', 'none yet', 'JSON file', '2026-11-18']) assert.ok(text.includes(part), part);
  const ws = (await sheetsOf(join(deliverables(root), 'DECISIONS_Decision-Register.xlsx'))).worksheets[0];
  assert.equal(ws.name, 'Decisions');
  const header = ws.getRow(4).values.slice(1);
  assert.deepEqual(header.slice(0, 6), ['ID', 'Question', 'Document', 'Status', 'Options', 'Chosen option']);
  assert.equal(ws.getCell('A5').value, 'DEC-01');
  assert.equal(ws.getCell('A6').value, 'DEC-02');
  assert.equal(ws.getCell('A7').value, null);
  const col = (name) => header.indexOf(name) + 1;
  assert.equal(ws.getCell(5, col('Status')).value, 'closed');
  assert.equal(ws.getCell(5, col('Chosen option')).value, 'B (SQLite file)');
  assert.equal(ws.getCell(5, col('Options')).value, 'A: JSON file; B: SQLite file');
  assert.equal(ws.getCell(6, col('Status')).value, 'open');
  assert.equal(ws.getCell(6, col('Chosen option')).value, 'none yet');
  const added = everyFile(root).filter((f) => !before.has(f));
  assert.equal(added.some((f) => /DECISIONS\.md$/.test(f)), false, 'no register Markdown on disk');
  assert.equal(existsSync(join(root, 'docs', 'DECISIONS.md')), false);
});

test('decisions: no DEC file is one warning, exit 0 and no file', async (t) => {
  const root = project(t, { decisions: false });
  const { code, err } = await cli(root, ['decisions'], {}, t);
  assert.equal(code, 0);
  assert.match(err, /^Warning: no decisions\/DEC-\*\.md, nothing to render for decisions\.\n$/);
  assert.deepEqual(listDeliverables(root), []);
});

test('design: one PDF for each board, named after it, and nothing for the README', { skip }, async (t) => {
  const root = project(t);
  const { code, out, err } = await cli(root, ['design'], {}, t);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['DESIGN_Ledger-Paper.pdf', 'DESIGN_Night-Shift.pdf']);
  for (const f of listDeliverables(root)) assert.ok(isPdf(join(deliverables(root), f)), f);
  assert.match(out, /DESIGN_Ledger-Paper\.pdf/);
});

const REFERENCES = `---
doc_id: REFERENCES
title: "Fernhill Lending, design references"
project: "Fernhill Lending"
version: "1.0"
date: "2026-11-18"
status: Register
language: "en"
---

## Mode and criteria

Mode: I give my criteria. Platform: web. Product type: finance.

## Picks

| Source | App | Screen | Why | Link |
|---|---|---|---|---|
| mobbin | Ledgerly | Dashboard | Dense table with a quiet header | https://example.com/ledgerly/dashboard |
`;

test('design: references.md is rendered to DESIGN_Design-References.docx next to the boards, and its absence is not a warning', { skip }, async (t) => {
  const root = project(t);
  mkdirSync(join(root, 'design'), { recursive: true });
  writeFileSync(join(root, 'design', 'references.md'), REFERENCES);
  const { code, out, err } = await cli(root, ['design'], {}, t);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['DESIGN_Design-References.docx', 'DESIGN_Ledger-Paper.pdf', 'DESIGN_Night-Shift.pdf']);
  assert.ok(isZip(join(deliverables(root), 'DESIGN_Design-References.docx')));
  assert.match(out, /DESIGN_Design-References\.docx/);
  const plain = await cli(project(t), ['design'], {}, t);
  assert.equal(plain.code, 0);
  assert.equal(plain.err, '');
});

test('design: references.md alone renders, with the missing-boards warning', { skip }, async (t) => {
  const root = project(t, { boards: false });
  mkdirSync(join(root, 'design'), { recursive: true });
  writeFileSync(join(root, 'design', 'references.md'), REFERENCES);
  const { code, err } = await cli(root, ['design'], {}, t);
  assert.equal(code, 0);
  assert.match(err, /^Warning: no design\/directions\/\*\.html, nothing to render for design\.\n$/);
  assert.deepEqual(listDeliverables(root), ['DESIGN_Design-References.docx']);
});

test('design: a references.md that breaks the style rules is refused like any source, and nothing is written', async (t) => {
  const root = project(t);
  mkdirSync(join(root, 'design'), { recursive: true });
  writeFileSync(join(root, 'design', 'references.md'), REFERENCES.replace('quiet header', `quiet ${EM} header`));
  const { code, err } = await cli(root, ['design'], {}, t);
  assert.equal(code, 1);
  assert.match(err, /Not rendered: 1 check failed/);
  assert.deepEqual(listDeliverables(root), []);
});

test('design: no board is one warning, exit 0 and no file; a linked board outside the folder is not printed', async (t) => {
  const root = project(t, { boards: false });
  mkdirSync(join(root, 'design', 'directions'), { recursive: true });
  writeFileSync(join(root, 'design', 'secret.html'), BOARD('Secret'));
  symlinkSync(join(root, 'design', 'secret.html'), join(root, 'design', 'directions', 'linked.html'));
  const { code, err } = await cli(root, ['design'], {}, t);
  assert.equal(code, 0);
  assert.match(err, /^Warning: no design\/directions\/\*\.html, nothing to render for design\.\n$/);
  assert.deepEqual(listDeliverables(root), []);
});

test('reviews: REVIEWS_Review-Notes.docx holds every note, one section each', { skip }, async (t) => {
  const root = project(t);
  const { code, err } = await cli(root, ['reviews'], {}, t);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['REVIEWS_Review-Notes.docx']);
  const text = await docxText(join(deliverables(root), 'REVIEWS_Review-Notes.docx'));
  for (const part of ['Review of D1 by the architect', 'Review of D1 by the security lead', 'Keep NFR-01 provisional.', 'No blocker.']) assert.ok(text.includes(part), part);
  assert.equal(existsSync(join(root, 'docs', 'reviews', 'REVIEWS.md')), false);
});

test('reviews: no note is one warning, exit 0 and no file', async (t) => {
  const root = project(t, { reviews: false });
  const { code, err } = await cli(root, ['reviews'], {}, t);
  assert.equal(code, 0);
  assert.match(err, /^Warning: no docs\/reviews\/\*\.md, nothing to render for reviews\.\n$/);
  assert.deepEqual(listDeliverables(root), []);
});

test('every extra together, D1 and the other defaults left alone', { skip }, async (t) => {
  const root = project(t);
  mkdirSync(deliverables(root), { recursive: true });
  writeFileSync(join(deliverables(root), 'D1.docx'), 'old D1');
  const { code, out, err } = await cli(root, ['reviews', 'design', 'decisions', 'stack'], {}, t);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), [
    'D1.docx', 'DECISIONS_Decision-Register.docx', 'DECISIONS_Decision-Register.xlsx', 'REVIEWS_Review-Notes.docx',
    'STACK_Stack-Decision.docx', 'STACK_Stack-Decision.xlsx', 'DESIGN_Ledger-Paper.pdf', 'DESIGN_Night-Shift.pdf',
  ].sort());
  assert.equal(readFileSync(join(deliverables(root), 'D1.docx'), 'utf8'), 'old D1');
  assert.equal(out.split('\n').filter((l) => l.startsWith('Wrote ')).length, 7);
  assert.equal(err, '');
});

test('a missing source of one extra does not stop the others', { skip }, async (t) => {
  const root = project(t, { decisions: false });
  const { code, err } = await cli(root, ['decisions', 'reviews'], {}, t);
  assert.equal(code, 0);
  assert.match(err, /Warning: no decisions\/DEC-\*\.md/);
  assert.deepEqual(listDeliverables(root), ['REVIEWS_Review-Notes.docx']);
});

test('Chromium missing: exit 1, the same message as render, /recade:setup named, nothing written', async (t) => {
  const root = project(t);
  const { code, err } = await cli(root, ['decisions', 'design'], { chromiumStatus: NO_CHROMIUM }, t);
  assert.equal(code, 1);
  assert.match(err, /Chromium is not installed, it is needed to build the PDF\. Run: npx --prefix "\/plug in" playwright install chromium/);
  assert.match(err, /\/recade:setup/);
  assert.deepEqual(listDeliverables(root), []);
});

test('Chromium missing with no source to print is not an error', async (t) => {
  const root = project(t, { stack: false, decisions: false, reviews: false, boards: false });
  const { code, err } = await cli(root, ['stack', 'decisions', 'design', 'reviews'], { chromiumStatus: NO_CHROMIUM }, t);
  assert.equal(code, 0);
  assert.equal(err.trim().split('\n').length, 4);
});

test('all or nothing: a failure while writing puts every file back', { skip }, async (t) => {
  const root = project(t);
  let calls = 0;
  const rename = (from, to) => {
    calls += 1;
    if (calls === 4) throw new Error('disk full');
    return renameSync(from, to);
  };
  await assert.rejects(
    renderExtras(root, ['stack', 'decisions'], { rename }),
    (err) => err instanceof RenderError && /Cannot write the outputs: disk full/.test(err.message),
  );
  assert.deepEqual(listDeliverables(root), []);
  assert.equal(existsSync(deliverables(root)), false);
});

test('an unknown extra is a usage error in the library, and a bad config file is named by the command', async (t) => {
  const root = project(t);
  await assert.rejects(renderExtras(root, ['slides']), (err) => err instanceof RenderError && err.exitCode === 2 && /Unknown extra deliverable: slides/.test(err.message));
  const bad = await cli(root, ['slides'], {}, t);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /deliverables\.extras .*config\.yaml.* Unknown extra deliverable: slides/);
  const notList = configDir(t);
  writeFileSync(join(notList, 'config.yaml'), 'deliverables:\n  extras: stack\n');
  const t2 = { out: [], err: [] };
  const code = await run(['render', 'extras', '--project', root], {
    stdout: { write: (s) => t2.out.push(s) }, stderr: { write: (s) => t2.err.push(s) }, cwd: tmpdir(), env: { ...process.env, RECADE_CONFIG_DIR: notList },
  });
  assert.equal(code, 1);
  assert.match(t2.err.join(''), /must be a list/);
});

test('render extras refuses stray arguments, and a folder that is not a Recade project', async (t) => {
  const root = project(t);
  const stray = await cli(root, ['stack'], { args: ['docs/D1.md'] }, t);
  assert.equal(stray.code, 2);
  assert.match(stray.err, /Usage: recade render extras \[--project <dir>\] \[--no-check\]/);
  const lost = mkdtempSync(join(tmpdir(), 'recade not a project '));
  t.after(() => rmSync(lost, { recursive: true, force: true }));
  const none = await cli(lost, ['stack'], {}, t);
  assert.equal(none.code, 2);
  assert.match(none.err, /is not a Recade project/);
});

test('the registers take their title in the deliverable language: a French project gets French names', async (t) => {
  const root = project(t, { stack: false, boards: false });
  const state = join(root, 'recade', 'state.yaml');
  writeFileSync(state, readFileSync(state, 'utf8').replace('deliverables: [en]', 'deliverables: [fr]'));
  const { code, err } = await cli(root, ['decisions', 'reviews'], {}, t);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['DECISIONS_Registre-des-Decisions.docx', 'DECISIONS_Registre-des-Decisions.xlsx', 'REVIEWS_Notes-de-Revue.docx']);
});

test('extras: the old names are left as they were and named once; deliverables.pdf adds the PDF', { skip }, async (t) => {
  const root = project(t, { stack: false, decisions: false, boards: false });
  mkdirSync(deliverables(root), { recursive: true });
  for (const name of ['REVIEWS.docx', 'REVIEWS.pdf', 'STACK-matrix.xlsx']) writeFileSync(join(deliverables(root), name), 'old');
  const first = await cli(root, ['reviews'], {}, t);
  assert.equal(first.code, 0, first.err);
  for (const name of ['REVIEWS.docx', 'REVIEWS.pdf']) {
    assert.ok(first.out.includes(`Left as it was: ${join(deliverables(root), name)}.`), name);
    assert.equal(readFileSync(join(deliverables(root), name), 'utf8'), 'old');
  }
  assert.equal(first.out.includes('STACK-matrix'), false, 'an extra not chosen is not looked at');
  const cfg = configDir(t);
  writeFileSync(join(cfg, 'config.yaml'), 'deliverables:\n  extras: [reviews]\n  pdf: true\n');
  const out = [];
  const code = await run(['render', 'extras', '--project', root], {
    stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, cwd: tmpdir(), env: { ...process.env, RECADE_CONFIG_DIR: cfg },
  });
  assert.equal(code, 0);
  assert.ok(isPdf(join(deliverables(root), 'REVIEWS_Review-Notes.pdf')));
  assert.match(out.join(''), /Wrote .*REVIEWS_Review-Notes\.pdf/);
});

test('recade help lists render extras', async () => {
  const out = [];
  const code = await run(['help'], { stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, cwd: tmpdir(), env: process.env });
  assert.equal(code, 0);
  assert.match(out.join(''), /^recade render\s+.*recade render extras --project <dir>/m);
});

test('design: an app name that looks like an ID in references.md does not block the render', { skip }, async (t) => {
  const root = project(t);
  mkdirSync(join(root, 'design'), { recursive: true });
  writeFileSync(join(root, 'design', 'references.md'), REFERENCES.replace('Ledgerly', 'M1 Finance').replace('Dense table', 'Like Q-12, a dense table'));
  const { code, err } = await cli(root, ['design'], {}, t);
  assert.equal(code, 0, err);
  assert.ok(listDeliverables(root).includes('DESIGN_Design-References.docx'));
});
