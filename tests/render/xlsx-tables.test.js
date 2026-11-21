import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parseDocument } from '../../src/render/parse.js';
import { loadTheme, loadLabels } from '../../src/render/theme.js';
import { renderTablesWorkbook, stackMatrixSheets } from '../../src/render/xlsx.js';

const theme = loadTheme(null);
const labels = loadLabels('en');

const STACK_FM = '---\ndoc_id: STACK\ntitle: Fernhill Lending, stack decision\nproject: Fernhill Lending\nversion: "1.0"\ndate: 2026-11-13\nstatus: Draft\n---\n\n';
const stackDoc = (body) => parseDocument(STACK_FM + body, 'docs/STACK.md');
const MATRIX = `## 4. Spikes

| Finalist | Task |
|---|---|
| Option one | A task |

## 5. Weighted matrix

| Criterion | Weight | Option one | Option two |
|---|---|---|---|
| Handles the load | 20 | 4, fast | 3, slower |
| Total | 100 | 0 | 0 |

## 6. Risks and exit cost

| Option | Risk |
|---|---|
| Option one | A risk |
`;

async function load(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}
const headerRow = (ws) => ws.getRow(4).values.slice(1);

test('stackMatrixSheets takes the tables of section 5 only, whatever its number', () => {
  const { sheets, warnings } = stackMatrixSheets(stackDoc(MATRIX));
  assert.deepEqual(warnings, []);
  assert.deepEqual(sheets.map((s) => s.name), ['Weighted matrix']);
  assert.deepEqual(sheets[0].columns, ['Criterion', 'Weight', 'Option one', 'Option two']);
  assert.deepEqual(sheets[0].rows, [['Handles the load', '20', '4, fast', '3, slower'], ['Total', '100', '0', '0']]);
  assert.equal(stackMatrixSheets(stackDoc(MATRIX.replace('5. Weighted matrix', 'Weighted matrix'))).sheets.length, 1);
});

test('stackMatrixSheets gives one sheet per table, named after the sub-heading that holds it', () => {
  const body = '## 5. Weighted matrix\n\n### Database\n\n| Criterion | Weight | A |\n|---|---|---|\n| x | 1 | 2 |\n\n### Web framework, with a very long title that goes past the limit\n\n| Criterion | Weight | B |\n|---|---|---|\n| y | 1 | 3 |\n\n| Criterion | Weight | C |\n|---|---|---|\n| z | 1 | 4 |\n';
  const { sheets } = stackMatrixSheets(stackDoc(body));
  assert.equal(sheets.length, 3);
  assert.equal(sheets[0].name, 'Database');
  assert.ok(sheets[1].name.length <= 31);
  assert.ok(sheets[1].name.startsWith('Web framework'));
  assert.equal(new Set(sheets.map((s) => s.name.toLowerCase())).size, 3);
});

test('stackMatrixSheets warns when section 5 holds no table, and sheet names never hold a forbidden character', () => {
  const none = stackMatrixSheets(stackDoc('## 5. Weighted matrix\n\nNot applicable, adopt mode.\n'));
  assert.deepEqual(none.sheets, []);
  assert.equal(none.warnings.length, 1);
  assert.equal(none.warnings[0].rule, 'stack-matrix');
  assert.equal(stackMatrixSheets(stackDoc('## Intro\n\ntext\n')).warnings.length, 1);
  const odd = stackMatrixSheets(stackDoc('## 5. Weighted matrix\n\n### a/b: [c]*?\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n\n### History\n\n| X | Y |\n|---|---|\n| 1 | 2 |\n'));
  assert.equal(odd.sheets.length, 2);
  for (const s of odd.sheets) assert.doesNotMatch(s.name, /[[\]:*?/\\]/);
});

test('renderTablesWorkbook styles each sheet like the plan workbook and keeps numbers typed', async () => {
  const doc = stackDoc(MATRIX);
  const { sheets } = stackMatrixSheets(doc);
  const buffer = await renderTablesWorkbook({ meta: doc.meta, source: 'STACK.md', sheets }, { theme, labels });
  const wb = await load(buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Weighted matrix']);
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell('A1').value, 'Fernhill Lending · Weighted matrix');
  assert.equal(ws.getCell('A1').font.size, 14);
  assert.ok(String(ws.getCell('A2').value).startsWith(labels.sourceOfTruth));
  assert.ok(String(ws.getCell('A2').value).includes('STACK.md'));
  assert.deepEqual(headerRow(ws), ['Criterion', 'Weight', 'Option one', 'Option two']);
  const head = ws.getCell('A4');
  assert.equal(head.fill.fgColor.argb, 'FF0F1A22');
  assert.equal(head.font.bold, true);
  assert.equal(ws.views[0].state, 'frozen');
  assert.equal(ws.views[0].ySplit, 4);
  assert.equal(ws.views[0].showGridLines, false);
  assert.equal(ws.getCell('B5').value, 20);
  assert.equal(ws.getCell('C5').value, '4, fast');
  assert.equal(ws.getCell('A6').value, 'Total');
  assert.ok(ws.autoFilter);
});

test('renderTablesWorkbook keeps an ID column as text, types a date, and never writes a formula', async () => {
  const buffer = await renderTablesWorkbook({
    meta: stackDoc(MATRIX).meta,
    source: 'decisions',
    sheets: [{ name: 'Decisions', columns: ['ID', 'Date', 'Note'], rows: [['007', '2026-11-18', '=1+1'], ['DEC-01', '', '']] }],
  }, { theme, labels });
  const ws = (await load(buffer)).worksheets[0];
  assert.equal(ws.getCell('A5').value, '007');
  assert.ok(ws.getCell('B5').value instanceof Date);
  assert.equal(ws.getCell('C5').value, '=1+1');
  assert.equal(ws.getCell('B6').value, null);
});

test('renderTablesWorkbook with no sheet still gives a valid workbook with one empty sheet', async () => {
  const buffer = await renderTablesWorkbook({ meta: stackDoc(MATRIX).meta, source: 'x', sheets: [] }, { theme, labels });
  assert.equal((await load(buffer)).worksheets.length, 1);
});
