import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parseDocument } from '../../src/render/parse.js';
import { loadTheme, loadLabels } from '../../src/render/theme.js';
import { renderPlanWorkbook, PLAN_SHEETS } from '../../src/render/xlsx.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/render/fernhill/docs/PLAN.md', import.meta.url));
const FM = '---\ndoc_id: PLAN\ntitle: Fernhill Lending, delivery plan\nproject: Fernhill Lending\nversion: "1.0"\ndate: 2026-11-13\nstatus: Draft\n---\n\n';
const theme = loadTheme(null);
const labels = loadLabels('en');

const NAMES = ['Summary', 'Backlog', 'Sprints', 'Milestones', 'External dependencies', 'Decisions', 'Risks', 'RACI', 'Gantt'];

async function build(doc) {
  const { buffer, warnings } = await renderPlanWorkbook(doc, { theme, labels });
  assert.ok(Buffer.isBuffer(buffer));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return { wb, warnings, buffer };
}
const fromText = (body) => parseDocument(FM + body, 'docs/PLAN.md');
const fixtureDoc = () => parseDocument(readFileSync(FIXTURE, 'utf8'), 'docs/PLAN.md');
const headerRow = (ws) => ws.getRow(4).values.slice(1);
const cfRules = (ws) => ws.conditionalFormattings.flatMap((cf) => cf.rules.map((r) => ({ ref: cf.ref, ...r })));
const fillOf = (rule) => rule.style.fill.bgColor.argb;

test('PLAN_SHEETS lists the nine sheets in order', () => {
  assert.deepEqual(PLAN_SHEETS.map((s) => s.name), NAMES);
  assert.deepEqual(PLAN_SHEETS.find((s) => s.name === 'Sprints').columns,
    ['Sprint', 'Start', 'End', 'Theme', 'Planned points', 'Capacity', 'Margin', 'Milestone']);
});

test('the fixture gives nine sheets in order, no warning, fullCalcOnLoad', async () => {
  const { wb, warnings, buffer } = await build(fixtureDoc());
  assert.deepEqual(wb.worksheets.map((w) => w.name), NAMES);
  assert.deepEqual(warnings, []);
  const zip = await JSZip.loadAsync(buffer);
  assert.match(await zip.file('xl/workbook.xml').async('string'), /<calcPr[^>]*fullCalcOnLoad="1"/);
});

test('every sheet has the title, source line, header row, frozen panes, filter, no gridlines, font', async () => {
  const { wb } = await build(fixtureDoc());
  for (const ws of wb.worksheets) {
    assert.equal(ws.getCell('A1').value, `Fernhill Lending · ${ws.name}`, ws.name);
    assert.equal(ws.getCell('A1').font.bold, true);
    assert.equal(ws.getCell('A1').font.size, 14);
    assert.equal(ws.getCell('A1').font.name, 'Inter Tight');
    assert.ok(String(ws.getCell('A2').value).startsWith(labels.sourceOfTruth), ws.name);
    assert.ok(String(ws.getCell('A2').value).includes('PLAN.md'), ws.name);
    const view = ws.views[0];
    assert.equal(view.state, 'frozen');
    assert.equal(view.xSplit, 1);
    assert.equal(view.ySplit, 4);
    assert.equal(view.showGridLines, false);
    const head = ws.getCell('A4');
    assert.equal(head.fill.fgColor.argb, 'FF1F3864');
    assert.equal(head.font.color.argb, 'FFFFFFFF');
    assert.equal(head.font.bold, true);
    assert.equal(head.font.name, 'Inter Tight');
    assert.equal(head.font.size, 10);
    assert.ok(ws.autoFilter, ws.name);
    for (let c = 1; c <= ws.columnCount; c += 1) {
      const w = ws.getColumn(c).width;
      assert.ok(w >= 8 && w <= 60, `${ws.name} col ${c} width ${w}`);
    }
  }
});

test('the header rows follow the expected columns', async () => {
  const { wb } = await build(fixtureDoc());
  for (const sheet of PLAN_SHEETS.filter((s) => !['RACI', 'Gantt'].includes(s.name))) {
    assert.deepEqual(headerRow(wb.getWorksheet(sheet.name)), sheet.columns, sheet.name);
  }
  assert.deepEqual(headerRow(wb.getWorksheet('RACI')), ['Activity', 'Lead', 'Dev', 'Volunteer', 'Board']);
  assert.deepEqual(headerRow(wb.getWorksheet('Gantt')), ['Item', 'First sprint', 'Last sprint', 'S1', 'S2', 'S3']);
});

test('Backlog Points hold the formula, other cells keep their value', async () => {
  const { wb } = await build(fixtureDoc());
  const ws = wb.getWorksheet('Backlog');
  const cell = ws.getCell('E5');
  assert.equal(cell.value.formula, 'IF(D5="S",1,IF(D5="M",2,IF(D5="L",3,0)))');
  assert.equal(ws.getCell('E7').value.formula, 'IF(D7="S",1,IF(D7="M",2,IF(D7="L",3,0)))');
  assert.equal(ws.getCell('A5').value, 'B-01');
  assert.equal(ws.getCell('C5').value, 'Tool records');
  assert.equal(ws.rowCount, 13);
});

const validations = async (buffer, n) => {
  const xml = await (await JSZip.loadAsync(buffer)).file(`xl/worksheets/sheet${n}.xml`).async('string');
  return [...xml.matchAll(/<dataValidation\b[^>]*>/g)].map((m) => m[0]);
};

test('Backlog and Milestones carry one enforced Status list each, over the data and 50 spare rows', async () => {
  const { buffer } = await build(fixtureDoc());
  const backlog = await validations(buffer, 2);
  assert.equal(backlog.length, 1);
  assert.match(backlog[0], /sqref="I5:I63"/);
  assert.match(backlog[0], /type="list"/);
  assert.match(backlog[0], /showErrorMessage="1"/);
  assert.match(backlog[0], /error="Pick a value from the list\."/);
  assert.match(backlog[0], /errorTitle="[^"]+"/);
  const ms = await validations(buffer, 4);
  assert.equal(ms.length, 1);
  assert.match(ms[0], /sqref="E5:E57"/);
  assert.match(ms[0], /showErrorMessage="1"/);
  for (const n of [1, 3, 5, 6, 7, 8, 9]) assert.equal((await validations(buffer, n)).length, 0, `sheet ${n}`);
});

test('the Status lists hold the expected values', async () => {
  const { wb } = await build(fixtureDoc());
  const backlog = wb.getWorksheet('Backlog').getCell('I5').dataValidation;
  assert.equal(backlog.type, 'list');
  assert.deepEqual(backlog.formulae, ['"Backlog,Ready,In progress,Review,Done,Blocked"']);
  assert.equal(backlog.showErrorMessage, true);
  const spare = wb.getWorksheet('Backlog').getCell('I60').dataValidation;
  assert.equal(spare.type, 'list');
  const ms = wb.getWorksheet('Milestones').getCell('E5').dataValidation;
  assert.deepEqual(ms.formulae, ['"Upcoming,In progress,Reached,Slipped"']);
});

test('Sprints: SUMIF planned points, margin formula, negative margin is filled', async () => {
  const { wb } = await build(fixtureDoc());
  const ws = wb.getWorksheet('Sprints');
  assert.equal(ws.getCell('E5').value.formula, 'SUMIF(Backlog!G:G,A5,Backlog!E:E)');
  assert.equal(ws.getCell('E7').value.formula, 'SUMIF(Backlog!G:G,A7,Backlog!E:E)');
  assert.equal(ws.getCell('G5').value.formula, 'F5-E5');
  assert.equal(ws.getCell('G7').value.result, -1);
  const rules = cfRules(ws);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].ref, 'G5:G57');
  assert.equal(rules[0].type, 'cellIs');
  assert.equal(rules[0].operator, 'lessThan');
  assert.deepEqual(rules[0].formulae.map(String), ['0']);
  assert.equal(fillOf(rules[0]), 'FFF9D2D2');
});

test('dates become date cells, numbers numbers, the rest text', async () => {
  const { wb } = await build(fixtureDoc());
  const ws = wb.getWorksheet('Sprints');
  const start = ws.getCell('B5');
  assert.ok(start.value instanceof Date);
  assert.equal(start.numFmt, 'yyyy-mm-dd');
  assert.equal(start.value.toISOString().slice(0, 10), '2026-11-16');
  assert.equal(ws.getCell('F5').value, 6);
  assert.equal(typeof ws.getCell('D5').value, 'string');
});

test('Risks: Score formula and the three colour bands', async () => {
  const { wb } = await build(fixtureDoc());
  const ws = wb.getWorksheet('Risks');
  assert.equal(ws.getCell('E5').value.formula, 'C5*D5');
  assert.equal(ws.getCell('E5').value.result, 9);
  const rules = cfRules(ws);
  assert.equal(rules.length, 3);
  assert.ok(rules.every((r) => r.ref === 'E5:E58'));
  assert.deepEqual(rules.map(fillOf).sort(), ['FFCEEAD6', 'FFF28B82', 'FFFDD663']);
  // Blank spare rows must not be coloured: every band is guarded by ISNUMBER.
  assert.ok(rules.every((r) => /^AND\(ISNUMBER\(E5\)/.test(r.formulae[0])));
});

test('External dependencies: overdue and not received rows are filled', async () => {
  const { wb } = await build(fixtureDoc());
  const rules = cfRules(wb.getWorksheet('External dependencies'));
  assert.equal(rules.length, 1);
  assert.equal(rules[0].ref, 'A5:H57');
  assert.equal(rules[0].type, 'expression');
  assert.match(rules[0].formulae[0], /\$D5<TODAY\(\)/);
  assert.match(rules[0].formulae[0], /\$H5=""/);
  assert.equal(fillOf(rules[0]), 'FFF9D2D2');
});

test('Decisions: Decision and Date cells use the input fill', async () => {
  const { wb } = await build(fixtureDoc());
  const ws = wb.getWorksheet('Decisions');
  for (const addr of ['G5', 'H5', 'G6', 'H6', 'G56', 'H56']) {
    assert.equal(ws.getCell(addr).fill.fgColor.argb, 'FFFFF6C2', addr);
  }
  assert.ok(!ws.getCell('G57').fill || !ws.getCell('G57').fill.fgColor);
  assert.ok(!ws.getCell('F5').fill || !ws.getCell('F5').fill.fgColor || ws.getCell('F5').fill.fgColor.argb !== 'FFFFF6C2');
});

test('RACI: letters are coloured by conditional formats', async () => {
  const { wb } = await build(fixtureDoc());
  const rules = cfRules(wb.getWorksheet('RACI'));
  assert.equal(rules.length, 4);
  assert.ok(rules.every((r) => r.ref === 'B5:E59'));
  assert.deepEqual(rules.map(fillOf).sort(), ['FFCEEAD6', 'FFEEF0FD', 'FFF9D2D2', 'FFFDD663']);
  const byLetter = Object.fromEntries(rules.map((r) => [r.formulae[0].match(/"(\w)"/)[1], fillOf(r)]));
  assert.deepEqual(byLetter, { R: 'FFF9D2D2', A: 'FFFDD663', C: 'FFCEEAD6', I: 'FFEEF0FD' });
});

test('Gantt: one column per sprint, fill by conditional format with the accent', async () => {
  const { wb } = await build(fixtureDoc());
  const ws = wb.getWorksheet('Gantt');
  assert.equal(ws.getCell('A5').value, 'Catalogue');
  const rules = cfRules(ws);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].ref, 'D5:F58');
  assert.equal(rules[0].type, 'expression');
  assert.equal(fillOf(rules[0]), 'FF1F3864');
  assert.match(rules[0].formulae[0], /MATCH\(\$B5,\$D\$4:\$F\$4,0\)/);
  assert.match(rules[0].formulae[0], /MATCH\(\$C5,\$D\$4:\$F\$4,0\)/);
});

test('a cell with & and accents round-trips; a leading = stays text', async () => {
  const doc = fromText('## Summary\n\n| Item | Value |\n|---|---|\n| Café & co | =SUM(A1) |\n| Ratio | +5 and -x |\n');
  const { wb } = await build(doc);
  const ws = wb.getWorksheet('Summary');
  assert.equal(ws.getCell('A5').value, 'Café & co');
  assert.equal(ws.getCell('B5').value, '=SUM(A1)');
  assert.equal(ws.getCell('B5').type, ExcelJS.ValueType.String);
  assert.equal(ws.getCell('B6').value, '+5 and -x');
});

test('only canonical numbers become numbers', async () => {
  const doc = fromText('## Summary\n\n| Item | Value |\n|---|---|\n| A | 1.0 |\n| B | 2.50 |\n| C | 007 |\n| D | 2.5 |\n| E | -3 |\n| F | 0 |\n');
  const { wb } = await build(doc);
  const ws = wb.getWorksheet('Summary');
  assert.deepEqual(['B5', 'B6', 'B7'].map((a) => ws.getCell(a).value), ['1.0', '2.50', '007']);
  assert.deepEqual(['B8', 'B9', 'B10'].map((a) => ws.getCell(a).value), [2.5, -3, 0]);
});

test('leading zeros and invalid dates stay text', async () => {
  const doc = fromText('## Summary\n\n| Item | Value |\n|---|---|\n| Code | 007 |\n| Day | 2026-02-31 |\n| Count | 12 |\n');
  const { wb } = await build(doc);
  const ws = wb.getWorksheet('Summary');
  assert.equal(ws.getCell('B5').value, '007');
  assert.equal(ws.getCell('B6').value, '2026-02-31');
  assert.equal(ws.getCell('B7').value, 12);
});

test('a missing section gives a header-only sheet and no warning', async () => {
  const doc = fromText('## Summary\n\n| Item | Value |\n|---|---|\n| Goal | Open |\n');
  const { wb, warnings } = await build(doc);
  assert.deepEqual(wb.worksheets.map((w) => w.name), NAMES);
  const risks = wb.getWorksheet('Risks');
  assert.deepEqual(headerRow(risks), PLAN_SHEETS.find((s) => s.name === 'Risks').columns);
  assert.equal(risks.rowCount, 4);
  assert.equal(risks.getCell('A1').value, 'Fernhill Lending · Risks');
  assert.equal(risks.views[0].xSplit, 1);
  assert.deepEqual(warnings, []);
});

test('section names ignore case and a leading number; unknown sections are ignored', async () => {
  const doc = fromText('## 12) BACKLOG\n\n| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |\n|---|---|---|---|---|---|---|---|---|---|\n| B-1 | L | Thing | M | | | S1 | Build | Ready | |\n\n## Elsewhere\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
  const { wb, warnings } = await build(doc);
  assert.equal(wb.getWorksheet('Backlog').getCell('A5').value, 'B-1');
  assert.deepEqual(warnings, []);
  assert.equal(wb.worksheets.length, 9);
});

test('only the first table of a section is used', async () => {
  const doc = fromText('## Summary\n\n| Item | Value |\n|---|---|\n| One | 1 |\n\nText.\n\n| Item | Value |\n|---|---|\n| Two | 2 |\n');
  const { wb } = await build(doc);
  const ws = wb.getWorksheet('Summary');
  assert.equal(ws.getCell('A5').value, 'One');
  assert.equal(ws.getCell('A6').value, null);
});

test('a renamed column gives a plan-columns warning and keeps the table columns', async () => {
  const doc = fromText('## Risks\n\n| ID | Risk | Probability | I | Score | Mitigation | Warning signal | Owner |\n|---|---|---|---|---|---|---|---|\n| R-1 | Late | 2 | 3 | 6 | Plan | Sign | Lead |\n');
  const { wb, warnings } = await build(doc);
  assert.equal(warnings.length, 1);
  const w = warnings[0];
  assert.equal(w.rule, 'plan-columns');
  assert.equal(w.severity, 'warn');
  assert.equal(w.file, 'docs/PLAN.md');
  assert.equal(w.column, 1);
  assert.equal(typeof w.line, 'number');
  assert.match(w.message, /Risks/);
  const ws = wb.getWorksheet('Risks');
  assert.equal(headerRow(ws)[2], 'Probability');
  // P is absent, so the Score formula is skipped and the written value stays.
  assert.equal(ws.getCell('E5').value, 6);
});

test('a table with extra columns warns and still gets the formulas whose columns exist', async () => {
  const doc = fromText('## Backlog\n\n| ID | Item | Size | Points | Owner |\n|---|---|---|---|---|\n| B-1 | Thing | L | | Mara |\n');
  const { wb, warnings } = await build(doc);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Backlog/);
  assert.equal(wb.getWorksheet('Backlog').getCell('D5').value.formula, 'IF(C5="S",1,IF(C5="M",2,IF(C5="L",3,0)))');
});

test('a renamed RACI role column does not warn', async () => {
  const doc = fromText('## RACI\n\n| Activity | Chair | Treasurer |\n|---|---|---|\n| Vote | A | R |\n');
  const { wb, warnings } = await build(doc);
  assert.deepEqual(warnings, []);
  assert.deepEqual(headerRow(wb.getWorksheet('RACI')), ['Activity', 'Chair', 'Treasurer']);
});

test('Gantt resolves sprint names to their position, whatever they are called', async () => {
  const doc = fromText('## Sprints\n\n| Sprint | Start | End | Theme | Planned points | Capacity | Margin | Milestone |\n|---|---|---|---|---|---|---|---|\n| Alpha | 2026-01-05 | 2026-01-16 | x | | 3 | | |\n| Beta | 2026-01-19 | 2026-01-30 | y | | 3 | | |\n\n## Gantt\n\n| Item | First sprint | Last sprint |\n|---|---|---|\n| Work | Beta | Beta |\n');
  const { wb } = await build(doc);
  assert.deepEqual(headerRow(wb.getWorksheet('Gantt')), ['Item', 'First sprint', 'Last sprint', 'Alpha', 'Beta']);
  assert.equal(cfRules(wb.getWorksheet('Gantt'))[0].ref, 'D5:E55');
});
