import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { parseDocument } from '../../src/render/parse.js';
import { loadTheme, loadLabels, themeStyle, themeProblem, chartFill, STYLE_DEFAULTS } from '../../src/render/theme.js';
import { renderDocx } from '../../src/render/docx.js';
import { renderHtml } from '../../src/render/html.js';
import { renderPlanWorkbook } from '../../src/render/xlsx.js';

const base = loadTheme(null);
const plain = {
  ...base,
  color: { ...base.color, chartFill: '5A6672' },
  style: { h1Rule: 0, calloutBar: 0, headerSeparator: ' / ', tableRules: 'horizontal' },
};

const FM = '---\ndoc_id: D1\ntitle: Fernhill Lending, product definition\nproject: Fernhill Lending\nversion: "1.2"\ndate: 2026-11-13\nstatus: Draft\n---\n\n';
const BODY = '# One\n\nText.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> Members need no account.\n';
const doc = () => parseDocument(FM + BODY, 'docs/D1.md');

function projectWith(theme) {
  const root = mkdtempSync(join(tmpdir(), 'recade-theme-style-'));
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design', 'theme.json'), JSON.stringify(theme));
  return root;
}

async function docxParts(theme) {
  const zip = await JSZip.loadAsync(await renderDocx(doc(), { theme, labels: loadLabels('en'), figures: new Map() }));
  const read = (re) => Promise.all(Object.keys(zip.files).filter((n) => re.test(n)).map((n) => zip.file(n).async('string')));
  return {
    document: (await read(/^word\/document\.xml$/)).join('\n'),
    styles: (await read(/^word\/styles\.xml$/)).join('\n'),
    header: (await read(/^word\/header\d*\.xml$/)).join('\n'),
  };
}

const heading1Style = (styles) => styles.split('<w:style ').find((s) => /w:styleId="Heading1"/.test(s));
const lastTable = (xml) => xml.split('<w:tbl>').pop();
const dataTableXml = (xml) => xml.split('<w:tbl>').slice(1).find((t) => t.includes('w:color="D9DFE4"') && t.includes('<w:tblHeader'));

test('the default theme carries the style keys with the look of before', () => {
  assert.deepEqual(base.style, { h1Rule: 1.5, calloutBar: 3, headerSeparator: ' · ', tableRules: 'grid' });
  assert.deepEqual(themeStyle(base), STYLE_DEFAULTS);
  assert.deepEqual(themeStyle({}), STYLE_DEFAULTS);
  assert.equal(base.color.chartFill, undefined);
});

test('chartFill falls back to the accent', () => {
  assert.equal(chartFill(base), '1F3864');
  assert.equal(chartFill(plain), '5A6672');
  assert.equal(chartFill({ color: { accent: 'F4F5F7' } }), 'F4F5F7');
});

test('a project theme with the style keys loads, and keeps the defaults it does not set', () => {
  const root = projectWith({ style: { h1Rule: 0 }, color: { chartFill: '2F6FD0' } });
  try {
    const t = loadTheme(root);
    assert.deepEqual(t.style, { ...STYLE_DEFAULTS, h1Rule: 0 });
    assert.equal(t.color.chartFill, '2F6FD0');
    assert.equal(t.color.accent, base.color.accent);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('invalid style values are refused in one line that names the key', () => {
  const cases = [
    [{ style: { h1Rule: -1 } }, /style\.h1Rule/],
    [{ style: { h1Rule: '1.5' } }, /style\.h1Rule/],
    [{ style: { h1Rule: 7 } }, /style\.h1Rule/],
    [{ style: { calloutBar: 13 } }, /style\.calloutBar/],
    [{ style: { headerSeparator: 3 } }, /style\.headerSeparator/],
    [{ style: { headerSeparator: 'a\nb' } }, /style\.headerSeparator/],
    [{ style: { headerSeparator: 'much too long' } }, /style\.headerSeparator/],
    [{ style: { tableRules: 'none' } }, /style\.tableRules must be one of grid, horizontal/],
    [{ style: [] }, /style must be an object/],
    [{ color: { chartFill: '#2F6FD0' } }, /color\.chartFill/],
  ];
  for (const [theme, message] of cases) {
    const root = projectWith(theme);
    try {
      assert.throws(() => loadTheme(root), (err) => {
        assert.match(err.message, /^design\/theme\.json: /);
        assert.match(err.message, message);
        assert.ok(!err.message.includes('\n'));
        return true;
      }, JSON.stringify(theme));
    } finally {
      rmSync(root, { recursive: true });
    }
  }
  assert.equal(themeProblem(base), null);
  assert.throws(() => themeStyle({ style: { tableRules: 'none' } }), /^Error: theme: style\.tableRules/);
});

test('DOCX, default theme: H1 rule of 1.5 pt, callout bar of 3 pt, grid tables, middle dot in the header', async () => {
  const { document, styles, header } = await docxParts(base);
  assert.match(heading1Style(styles), /<w:bottom [^>]*w:sz="12"[^>]*w:color="1F3864"|<w:bottom [^>]*w:color="1F3864"[^>]*w:sz="12"/);
  assert.match(lastTable(document), /<w:left [^>]*w:sz="24"/);
  assert.match(dataTableXml(document), /<w:insideV [^>]*w:val="single"/);
  assert.ok(header.includes('Fernhill Lending · Fernhill Lending, product definition'));
  assert.ok(header.includes('v1.2 · Draft'));
});

test('DOCX, plain theme: no H1 rule, no callout bar, rules between rows only, the chosen separator', async () => {
  const { document, styles, header } = await docxParts(plain);
  assert.doesNotMatch(heading1Style(styles), /<w:pBdr>/);
  assert.doesNotMatch(lastTable(document), /<w:left [^>]*w:val="single"/);
  const table = dataTableXml(document);
  assert.match(table, /<w:insideH [^>]*w:val="single"/);
  assert.match(table, /<w:insideV [^>]*w:val="none"/);
  assert.match(table, /<w:left [^>]*w:val="none"/);
  assert.match(table, /<w:right [^>]*w:val="none"/);
  assert.ok(header.includes('Fernhill Lending / Fernhill Lending, product definition'));
  assert.ok(header.includes('v1.2 / Draft'));
  assert.ok(!header.includes('·'));
});

test('DOCX: a fractional width rounds to eighths of a point', async () => {
  const { styles } = await docxParts({ ...base, style: { h1Rule: 0.75 } });
  assert.match(heading1Style(styles), /<w:bottom [^>]*w:sz="6"/);
});

test('HTML: the widths become CSS variables, the separator goes in the running header, horizontal drops side rules', () => {
  const labels = loadLabels('en');
  const before = renderHtml(doc(), { theme: base, labels, figures: new Map() });
  assert.match(before, /--h1-rule:1\.5pt;--callout-bar:3pt/);
  assert.match(before, /border-bottom: var\(--h1-rule, 1\.5pt\) solid var\(--accent\)/);
  assert.match(before, /border-left: var\(--callout-bar, 3pt\) solid var\(--accent\)/);
  assert.ok(before.includes('"Fernhill Lending · Fernhill Lending, product definition"'));
  assert.ok(!before.includes('border-left:0;border-right:0'));

  const after = renderHtml(doc(), { theme: plain, labels, figures: new Map() });
  assert.match(after, /--h1-rule:0pt;--callout-bar:0pt/);
  assert.ok(after.includes('"Fernhill Lending / Fernhill Lending, product definition"'));
  assert.ok(after.includes('"v1.2 / Draft"'));
  assert.ok(after.includes('th,td{border-left:0;border-right:0}'));
  assert.match(after, /--chart-fill:#5A6672/);
});

test('PLAN workbook: the Gantt bars use chartFill, the sheet titles use the separator', async () => {
  const plan = parseDocument('---\ndoc_id: PLAN\ntitle: Plan\nproject: Fernhill\nversion: "1.0"\ndate: 2026-11-13\nstatus: Draft\n---\n\n'
    + '## Sprints\n\n| Sprint | Start | End | Theme | Planned points | Capacity | Margin | Milestone |\n|---|---|---|---|---|---|---|---|\n| S1 | 2026-01-05 | 2026-01-16 | x | | 3 | | |\n\n'
    + '## Gantt\n\n| Item | First sprint | Last sprint |\n|---|---|---|\n| Work | S1 | S1 |\n', 'docs/PLAN.md');
  const fills = async (theme) => {
    const { buffer } = await renderPlanWorkbook(plan, { theme, labels: loadLabels('en') });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.getWorksheet('Gantt');
    return { title: ws.getCell('A1').value, fill: ws.conditionalFormattings[0].rules[0].style.fill.bgColor.argb };
  };
  assert.deepEqual(await fills(base), { title: 'Fernhill · Gantt', fill: 'FF1F3864' });
  assert.deepEqual(await fills({ ...base, color: { ...base.color, accent: 'F4F5F7' } }), { title: 'Fernhill · Gantt', fill: 'FFF4F5F7' });
  assert.deepEqual(await fills(plain), { title: 'Fernhill / Gantt', fill: 'FF5A6672' });
});
