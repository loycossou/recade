import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { parseDocument } from '../../src/render/parse.js';
import { loadTheme, loadLabels, themeProblem } from '../../src/render/theme.js';
import { renderDocx } from '../../src/render/docx.js';
import { renderHtml } from '../../src/render/html.js';
import { figurePalette, mermaidSource, mermaidThemeVariables, FIGURE_KINDS } from '../../src/render/palette.js';
import { figureFindings } from '../../src/render/figurecheck.js';
import { defaultWidths, isIdHeader, keyColumn, planTerm, splitIds } from '../../src/render/look.js';

const theme = loadTheme(null);

const front = (id, language = 'en') => `---\ndoc_id: ${id}\ntitle: Fernhill Lending, product definition\nproject: Fernhill Lending\nversion: "1.2"\ndate: 2026-11-13\nstatus: Draft\nlanguage: ${language}\n---\n\n`;
const make = (body, id = 'D1', language = 'en') => parseDocument(front(id, language) + body, `docs/${id}.md`);
const html = (doc, language = 'en') => renderHtml(doc, { theme, labels: loadLabels(language), figures: new Map() });
async function docxXml(doc, language = 'en') {
  const zip = await JSZip.loadAsync(await renderDocx(doc, { theme, labels: loadLabels(language), figures: new Map() }));
  return zip.file('word/document.xml').async('string');
}
const lastTable = (xml) => xml.split('<w:tbl>').pop();

function projectWith(value) {
  const root = mkdtempSync(join(tmpdir(), 'recade-look-'));
  mkdirSync(join(root, 'design'));
  writeFileSync(join(root, 'design', 'theme.json'), JSON.stringify(value));
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// The default theme

test('the default theme is coloured: navy header, light grey zebra, light blue key cells, pastel callouts and tag', () => {
  const c = theme.color;
  assert.equal(c.headerFill, '1F3864');
  assert.equal(c.headerText, 'FFFFFF');
  assert.equal(c.zebra, 'F2F2F2');
  assert.equal(c.keyCell, 'DCE6F1');
  assert.equal(c.calloutNote, 'DCE6F1');
  assert.equal(c.calloutWarning, 'FBEBD7');
  assert.equal(c.provisional, 'FBEBD7');
  assert.equal(c.provisionalText, '8A5A1E');
  assert.deepEqual(Object.keys(theme.figure), ['info', 'ok', 'warm', 'error', 'system', 'line']);
  assert.equal(themeProblem(theme), null);
});

test('the colours of tables, callouts, the tag and the figures are 6 hex digits, refused in one line otherwise', () => {
  const cases = [
    [{ color: { keyCell: '#DCE6F1' } }, /color\.keyCell must be 6 hex digits/],
    [{ color: { headerFill: 'navy' } }, /color\.headerFill/],
    [{ color: { provisionalText: 'abc' } }, /color\.provisionalText/],
    [{ figure: [] }, /figure must be an object/],
    [{ figure: { ok: 'green' } }, /figure\.ok must be an object/],
    [{ figure: { ok: { fill: 'DFF1EA', stroke: '12' } } }, /figure\.ok\.stroke must be 6 hex digits/],
    [{ figure: { system: { text: '#fff' } } }, /figure\.system\.text/],
    [{ figure: { line: 'grey' } }, /figure\.line/],
  ];
  for (const [value, message] of cases) {
    const root = projectWith(value);
    try {
      assert.throws(() => loadTheme(root), (err) => {
        assert.match(err.message, /^design\/theme\.json: /);
        assert.match(err.message, message);
        assert.ok(!err.message.includes('\n'));
        return true;
      }, JSON.stringify(value));
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});

test('a project theme with brand colours and fonts only keeps the coloured tables, callouts and figures', () => {
  const root = projectWith({ font: { family: 'Source Serif 4' }, color: { accent: '2F6FD0' } });
  try {
    const t = loadTheme(root);
    assert.equal(t.color.accent, '2F6FD0');
    assert.equal(t.color.headerFill, '1F3864');
    assert.equal(t.color.zebra, 'F2F2F2');
    assert.deepEqual(t.figure, theme.figure);
  } finally {
    rmSync(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// The figure palette

test('the figure palette gives each node kind a fill, a stroke and a text colour', () => {
  const p = figurePalette(theme);
  for (const kind of FIGURE_KINDS) {
    assert.match(p[kind].fill, /^[0-9A-F]{6}$/);
    assert.match(p[kind].stroke, /^[0-9A-F]{6}$/);
    assert.match(p[kind].text, /^[0-9A-F]{6}$/);
  }
  assert.deepEqual([p.info.fill, p.ok.fill, p.warm.fill, p.error.fill, p.system.fill], ['DCE6F1', 'DFF1EA', 'FBEBD7', 'FBE3E1', '1F3864']);
  assert.equal(p.system.text, 'FFFFFF');
  assert.equal(p.info.text, '0F1A22');
});

test('a theme with no figure group still draws the pastel palette, and color.chartFill colours the plain node', () => {
  assert.equal(figurePalette({ color: {} }).ok.fill, 'DFF1EA');
  const p = figurePalette({ ...theme, color: { ...theme.color, chartFill: 'F4D35E' } });
  assert.equal(p.info.fill, 'F4D35E');
  assert.equal(p.info.stroke, '1F3864');
  assert.equal(figurePalette(theme).info.fill, 'DCE6F1');
});

test('Mermaid theme variables carry the palette, the line colour and the font', () => {
  const v = mermaidThemeVariables(theme, '"Inter Tight", Arial, sans-serif');
  assert.equal(v.primaryColor, '#DCE6F1');
  assert.equal(v.primaryBorderColor, '#1F3864');
  assert.equal(v.secondaryColor, '#DFF1EA');
  assert.equal(v.tertiaryColor, '#FBEBD7');
  assert.equal(v.lineColor, '#5A6672');
  assert.equal(v.fontFamily, '"Inter Tight", Arial, sans-serif');
  for (const [key, value] of Object.entries(v)) if (key !== 'fontFamily') assert.match(value, /^#[0-9A-F]{6}$/, key);
});

test('classDefs of the palette are added at the end of a flowchart, a graph and a state diagram, and nowhere else', () => {
  const flow = 'flowchart LR\n  A:::ok --> B:::system\n';
  const out = mermaidSource(flow, theme);
  assert.ok(out.startsWith(flow.trimEnd()));
  for (const kind of FIGURE_KINDS) assert.match(out, new RegExp(`classDef ${kind} fill:#[0-9A-F]{6},stroke:#[0-9A-F]{6},color:#[0-9A-F]{6}`));
  assert.match(out, /classDef error fill:#FBE3E1,stroke:#B5443C/);
  assert.match(out, /classDef system fill:#1F3864,stroke:#1F3864,color:#FFFFFF/);
  assert.match(mermaidSource('graph TD\n  A --> B', theme), /classDef ok /);
  assert.match(mermaidSource('stateDiagram-v2\n  [*] --> Draft', theme), /classDef warm /);
  assert.match(mermaidSource('%% a comment\n\nflowchart TD\n  A --> B', theme), /classDef info /);
  assert.match(mermaidSource('---\ntitle: x\n---\nflowchart TD\n  A --> B', theme), /classDef info /);
  for (const other of ['sequenceDiagram\n  A->>B: hi', 'gantt\n  title x', 'erDiagram\n  A ||--o{ B : has', 'pie\n  "a": 1']) {
    assert.equal(mermaidSource(other, theme), other);
  }
});

test('a class the author defines is kept as written; the others of the palette are still added', () => {
  const out = mermaidSource('flowchart LR\n  A:::ok --> B\n  classDef ok fill:#ABCDEF', theme);
  assert.equal(out.match(/classDef ok /g).length, 1);
  assert.match(out, /classDef error /);
});

test('a kind anywhere in a comma list of classDef is the author\'s, so the palette does not override it', () => {
  const out = mermaidSource('flowchart LR\n  A:::warm --> B:::ok\n  classDef info,warm,ok fill:#ABCDEF', theme);
  assert.deepEqual([...out.matchAll(/classDef (\S+)/g)].map((m) => m[1]), ['info,warm,ok', 'error', 'system']);
  const second = mermaidSource('flowchart LR\n  A --> B\n  classDef big,ok fill:#ABCDEF', theme);
  assert.ok(!/classDef ok /.test(second));
});

// ---------------------------------------------------------------------------------------------------------------
// Helpers

test('splitIds separates the IDs from the words', () => {
  assert.deepEqual(splitIds('Upload (FR-EX-01) and S-04.'), [
    { text: 'Upload (', id: false }, { text: 'FR-EX-01', id: true }, { text: ') and ', id: false }, { text: 'S-04', id: true }, { text: '.', id: false },
  ]);
  // The bare milestone form is a word and a number in a sentence: it is not muted there.
  assert.deepEqual(splitIds('Ship at M1 or the M2 build.'), [{ text: 'Ship at M1 or the M2 build.', id: false }]);
  // The backlog IDs of the project's lots are muted, as the index reads them.
  assert.deepEqual(splitIds('Do LOT-01 first.', ['LOT']), [{ text: 'Do ', id: false }, { text: 'LOT-01', id: true }, { text: ' first.', id: false }]);
  assert.deepEqual(splitIds('Do LOT-01 first.'), [{ text: 'Do LOT-01 first.', id: false }]);
  assert.deepEqual(splitIds('No identifier here'), [{ text: 'No identifier here', id: false }]);
});

test('an ID table has a narrow first column; the column that names the row is the key column', () => {
  const runs = (t) => [{ text: t }];
  assert.equal(isIdHeader([runs('ID'), runs('x')]), true);
  assert.equal(isIdHeader([runs('**ID**'), runs('x')]), true);
  assert.equal(isIdHeader([runs('Role'), runs('x')]), false);
  assert.equal(isIdHeader([runs('ID')]), false);
  assert.equal(keyColumn([runs('ID'), runs('x')], 2), 1);
  assert.equal(keyColumn([runs('Role'), runs('x')], 2), 0);
  assert.equal(keyColumn([runs('Role')], 1), -1);
  const widths = defaultWidths([runs('ID'), runs('a'), runs('b'), runs('c')], 4);
  assert.equal(Math.round(widths.reduce((a, b) => a + b, 0)), 100);
  assert.ok(widths[0] < widths[1]);
  // The columns that hold more text get more room.
  const long = 'x'.repeat(50);
  const weighted = defaultWidths([runs('ID'), runs('Requirement'), runs('Priority')], 3, [[runs('A-1'), runs(long), runs('MUST')]]);
  assert.ok(weighted[1] > weighted[2] * 2, weighted.join(','));
  assert.equal(defaultWidths([runs('Role'), runs('x')], 2), null);
});

test('planTerm gives the language word of a fixed term of the PLAN and leaves anything else', () => {
  const fr = loadLabels('fr');
  assert.equal(planTerm('Milestones', fr), 'Jalons');
  assert.equal(planTerm('depends on', fr), 'Dépend de');
  assert.equal(planTerm('Walking skeleton', fr), 'Walking skeleton');
  assert.equal(planTerm('Milestones', loadLabels('en')), 'Milestones');
});

// ---------------------------------------------------------------------------------------------------------------
// Figures: captions and the minimum set

test('a figure with no caption, and a D1 with too few figures, are warnings that say what is missing', () => {
  const doc = make('# One\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n<!-- caption: Actors -->\n```mermaid\nflowchart LR\n  C --> D\n```\n');
  const found = figureFindings(doc);
  const caption = found.filter((f) => f.rule === 'figure-caption');
  assert.equal(caption.length, 1);
  assert.match(caption[0].message, /^Figure 1 has no caption/);
  const min = found.filter((f) => f.rule === 'figures-min');
  assert.equal(min.length, 1);
  assert.match(min[0].message, /^D1 has 2 of the 3 figures it asks for at least: actors and system context, main journeys, states of the main object\.$/);
  assert.ok(found.every((f) => f.severity === 'warn' && f.file === 'docs/D1.md'));
});

test('D2, D3 and PLAN have their own minimum, and other documents have none', () => {
  const one = '<!-- caption: Flow -->\n```mermaid\nflowchart LR\n  A --> B\n```\n';
  assert.equal(figureFindings(make(one, 'D3')).length, 0);
  assert.equal(figureFindings(make(one, 'PLAN')).length, 0);
  assert.match(figureFindings(make(one, 'D2'))[0].message, /^D2 has 1 of the 3 figures.*containers, deployment, one key sequence/);
  assert.equal(figureFindings(make('# x\n', 'STACK')).length, 0);
  assert.match(figureFindings(make('# x\n', 'D3'))[0].message, /trust boundaries and data flows/);
});

// ---------------------------------------------------------------------------------------------------------------
// DOCX

const ID_TABLE = '| ID | Requirement | Priority |\n|---|---|---|\n| FR-LND-01 | Borrow a tool (PROVISIONAL) | MUST |\n| FR-LND-02 | Return a tool | MUST |\n';

test('DOCX: the ID column is narrow and muted, the requirement column is the key column', async () => {
  const table = lastTable(await docxXml(make(ID_TABLE)));
  const grid = [...table.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(grid.length, 3);
  assert.ok(grid[0] < grid[1] && grid[0] < 1500, grid.join(','));
  const rows = table.split('<w:tr>').slice(2);
  // Row 1: the ID cell is muted and smaller than the 8.5 pt body of the table.
  const idCell = rows[0].split('<w:tc>')[1];
  assert.match(idCell, /<w:color w:val="5A6672"\/>/);
  assert.match(idCell, /<w:sz w:val="16"\/>/);
  assert.ok(!idCell.includes('w:fill="DCE6F1"'));
  // The second column carries the key fill, not the bold: it holds sentences.
  assert.match(rows[0].split('<w:tc>')[2], /w:fill="DCE6F1"/);
  const keyCell = rows[1].split('<w:tc>')[2];
  assert.match(keyCell, /w:fill="DCE6F1"/);
  assert.ok(!keyCell.includes('<w:b/>'));
  // The third column is a plain cell.
  assert.ok(!rows[0].split('<w:tc>')[3].includes('w:fill="DCE6F1"'));
});

test('DOCX: a table with no ID column has its first column as the key column', async () => {
  const table = lastTable(await docxXml(make('| Actor | Goal |\n|---|---|\n| Member | Borrow |\n')));
  const cells = table.split('<w:tr>')[2].split('<w:tc>');
  assert.match(cells[1], /w:fill="DCE6F1"/);
  assert.match(cells[1], /<w:b\/>/);
  assert.ok(!cells[2].includes('w:fill="DCE6F1"'));
});

test('DOCX: PROVISIONAL is a small coloured tag in the document language, not a yellow highlight', async () => {
  const en = await docxXml(make('The fee is PROVISIONAL until the vote.\n'));
  assert.match(en, /<w:shd [^>]*w:fill="FBEBD7"/);
  assert.match(en, /<w:color w:val="8A5A1E"\/>/);
  assert.match(en, /<w:caps\/>/);
  assert.match(en, />Provisional</);
  assert.ok(!en.includes('FFF6C2'));
  assert.ok(!en.includes('>PROVISIONAL<'));
  const fr = await docxXml(make('Le tarif est PROVISIONAL jusqu au vote.\n', 'D1', 'fr'), 'fr');
  assert.match(fr, />Provisoire</);
});

test('DOCX: an ID in a sentence is small and muted, the words around it are not', async () => {
  const xml = await docxXml(make('Members upload a proof (FR-EX-01) before borrowing.\n'));
  const run = xml.split('<w:r>').find((r) => r.includes('>FR-EX-01<'));
  assert.match(run, /<w:color w:val="5A6672"\/>/);
  const word = xml.split('<w:r>').find((r) => r.includes('before borrowing'));
  assert.ok(!word.includes('5A6672'));
});

test('DOCX: a figure caption reads "Figure n" then the language separator', async () => {
  const doc = make('<!-- caption: Les acteurs -->\n```mermaid\nflowchart LR\n  A --> B\n```\n', 'D1', 'fr');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const zip = await JSZip.loadAsync(await renderDocx(doc, { theme, labels: loadLabels('fr'), figures: new Map([['fig-1', { png, width: 1, height: 1 }]]) }));
  const xml = await zip.file('word/document.xml').async('string');
  assert.ok(xml.includes('>Figure <'));
  assert.ok(xml.includes('> : <'));
  assert.ok(xml.includes('>Les acteurs<'));
});

test('DOCX: the PLAN shows its sheet and column titles in the document language, the Markdown keeps English', async () => {
  const plan = make('## Milestones\n\n| ID | Date | What is true that day | Criterion | Status |\n|---|---|---|---|---|\n| M1 | 2026-12-14 | Sign in works | Demo | planned |\n', 'PLAN', 'fr');
  const xml = await docxXml(plan, 'fr');
  assert.ok(xml.includes('>Jalons<'));
  assert.ok(xml.includes('>Ce qui est vrai ce jour-là<'));
  assert.ok(xml.includes('>Critère<'));
  assert.ok(!xml.includes('>Milestones<'));
  assert.equal(plan.blocks[0].runs[0].text, 'Milestones');
  const english = await docxXml(make('## Milestones\n\n| ID | Date |\n|---|---|\n| M1 | x |\n', 'PLAN'));
  assert.ok(english.includes('>Milestones<'));
});

// ---------------------------------------------------------------------------------------------------------------
// HTML and PDF

test('HTML: ID cells, key cells, ID spans and the PROVISIONAL tag', () => {
  const out = html(make(`${ID_TABLE}\nSee FR-LND-01 (borrow a tool). The fee is PROVISIONAL.\n`));
  assert.match(out, /<td class="idcol"><span class="id">FR-LND-01<\/span><\/td><td class="key plain">Borrow a tool \(<mark class="prv">Provisional<\/mark>\)<\/td><td>MUST<\/td>/);
  assert.match(out, /See <span class="id">FR-LND-01<\/span> \(borrow a tool\)\. The fee is <mark class="prv">Provisional<\/mark>\./);
  const cols = [...out.matchAll(/<col style="width:([\d.]+)%">/g)].map((m) => Number(m[1])).slice(-3);
  assert.equal(cols[0], 13);
  assert.ok(cols[1] > cols[2], `the requirement column is wider than the priority column: ${cols}`);
  assert.ok(Math.abs(cols.reduce((a, b) => a + b, 0) - 100) < 0.1);
  assert.match(out, /<th>ID<\/th>/);
  assert.match(out, /--key-cell:#DCE6F1/);
  assert.match(out, /--provisional-text:#8A5A1E/);
  assert.match(out, /--header-fill:#1F3864/);
});

test('HTML: no yellow highlight is left in the stylesheet, and the tag is small capitals', () => {
  const out = html(make('x\n'));
  assert.ok(!/FFF6C2/i.test(out.split('</style>')[0].replace(/--input-fill:#FFF6C2/, '')));
  assert.match(out, /mark\.prv \{[^}]*text-transform: uppercase/);
  assert.match(out, /\.id \{ color: var\(--muted\)/);
});

test('HTML, French: the tag, the figure label and the separator follow the language', () => {
  const doc = make('Le tarif est PROVISIONAL.\n\n<!-- caption: Les acteurs -->\n```mermaid\nflowchart LR\n  A --> B\n```\n', 'D1', 'fr');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const out = renderHtml(doc, { theme, labels: loadLabels('fr'), figures: new Map([['fig-1', { png, width: 1, height: 1 }]]) });
  assert.match(out, /<mark class="prv">Provisoire<\/mark>/);
  assert.match(out, /<figcaption><span class="fig-label">Figure 1<\/span> : Les acteurs<\/figcaption>/);
  assert.match(out, /<li><a href="#[^"]+">Figure 1 : Les acteurs<\/a><\/li>/);
});

test('HTML, French PLAN: the headings, the contents and the column titles use the French terms', () => {
  const plan = make('## Milestones\n\n| ID | Date | What is true that day | Criterion | Status |\n|---|---|---|---|---|\n| M1 | 2026-12-14 | x | y | planned |\n\n## Gantt\n\ntext\n', 'PLAN', 'fr');
  const out = html(plan, 'fr');
  assert.match(out, /<h2 id="[^"]+">Jalons<\/h2>/);
  assert.match(out, /<li class="l2"><a href="#[^"]+">Jalons<\/a><\/li>/);
  assert.match(out, /<th>Ce qui est vrai ce jour-là<\/th>/);
  assert.ok(!out.includes('<h2 id="milestones">'));
});

// ---------------------------------------------------------------------------------------------------------------
// The heading colour is its own key

test('color.heading defaults to dark navy, is validated, and does not follow a light table header', () => {
  assert.equal(theme.color.heading, '1F3864');
  const bad = projectWith({ color: { heading: 'blue' } });
  try {
    assert.throws(() => loadTheme(bad), /color\.heading must be 6 hex digits/);
  } finally {
    rmSync(bad, { recursive: true });
  }
  const root = projectWith({ color: { headerFill: 'FFE680', headerText: '222222' } });
  try {
    const t = loadTheme(root);
    assert.equal(t.color.heading, '1F3864');
    const out = renderHtml(make('# Vision\n'), { theme: t, labels: loadLabels('en'), figures: new Map() });
    assert.match(out, /--heading:#1F3864/);
    assert.match(out, /--header-fill:#FFE680/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test('the stylesheet colours headings, the cover title and the figure label with --heading, not --header-fill', async () => {
  const css = (await import('node:fs')).readFileSync(new URL('../../render/print.css', import.meta.url), 'utf8');
  for (const selector of [/^h1 \{[^}]*color: var\(--heading\)/m, /^h2 \{[^}]*color: var\(--heading\)/m, /\.fig-label \{[^}]*var\(--heading\)/, /\.cover \.title \{[^}]*var\(--heading\)/]) assert.match(css, selector);
  assert.equal([...css.matchAll(/var\(--header-fill\)/g)].length, 1, 'only the table header uses the header fill');
});

test('DOCX: headings, cover title and the Figure label use color.heading while the table header keeps headerFill', async () => {
  const light = { ...theme, color: { ...theme.color, headerFill: 'FFE680', headerText: '222222' } };
  const doc = make('# Vision\n\n| ID | Name |\n|---|---|\n| FR-LND-01 | Borrow |\n');
  const zip = await JSZip.loadAsync(await renderDocx(doc, { theme: light, labels: loadLabels('en'), figures: new Map() }));
  const styles = await zip.file('word/styles.xml').async('string');
  for (const id of ['Heading1', 'Heading2', 'Caption']) {
    const style = styles.match(new RegExp(`<w:style [^>]*w:styleId="${id}".*?</w:style>`, 's'))[0];
    assert.match(style, /<w:color w:val="1F3864"\/>/, id);
    assert.ok(!style.includes('FFE680'), id);
  }
  const body = await zip.file('word/document.xml').async('string');
  assert.match(lastTable(body), /w:fill="FFE680"/);
});

test('the render mutes the backlog IDs of the lots it is given, in HTML and in DOCX', async () => {
  const doc = make('See LOT-01 (the first lot) and M2.\n');
  const out = renderHtml(doc, { theme, labels: loadLabels('en'), figures: new Map(), lots: ['LOT'] });
  assert.match(out, /See <span class="id">LOT-01<\/span> \(the first lot\) and M2\./);
  const plain = renderHtml(doc, { theme, labels: loadLabels('en'), figures: new Map() });
  assert.ok(!plain.includes('<span class="id">LOT-01'));
  const zip = await JSZip.loadAsync(await renderDocx(doc, { theme, labels: loadLabels('en'), figures: new Map(), lots: ['LOT'] }));
  const xml = await zip.file('word/document.xml').async('string');
  assert.match(xml, /<w:color w:val="5A6672"\/>(?:(?!<\/w:r>)[^])*<w:t[^>]*>LOT-01<\/w:t>/);
  assert.ok(xml.includes('>LOT-01<') && xml.includes('and M2.'));
});

test('a milestone ID in an ID column stays muted by the column, while M2 in a sentence is plain', () => {
  const out = html(make('| ID | Date |\n|---|---|\n| M1 | 2026-12-14 |\n\nWe reach M1 soon.\n', 'PLAN'));
  assert.match(out, /<td class="idcol">M1<\/td>/);
  assert.match(out, /We reach M1 soon\./);
});
