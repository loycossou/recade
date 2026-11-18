import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { parseDocument } from '../../src/render/parse.js';
import { loadTheme, loadLabels } from '../../src/render/theme.js';
import { collectFigures } from '../../src/render/figures.js';
import { bookmarkName } from '../../src/render/bookmarks.js';
import * as docxModule from '../../src/render/docx.js';

const { renderDocx } = docxModule;

const FIXTURE = fileURLToPath(new URL('../fixtures/render/fernhill/docs/D1.md', import.meta.url));
const FM = '---\ndoc_id: D1\ntitle: Fernhill Lending, product definition\nproject: Fernhill Lending\nversion: "1.2"\ndate: 2026-11-13\nstatus: Draft\n';
const theme = loadTheme(null);
// A 1x1 PNG: the docx tests never need a browser.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const png = (width = 800, height = 400) => ({ png: PNG, width, height });

const make = (body, { head = '', file = 'docs/D1.md' } = {}) => parseDocument(`${FM}${head}---\n\n${body}`, file);

async function render(doc, figures = new Map()) {
  const labels = loadLabels(doc.meta.language);
  const buffer = await renderDocx(doc, { theme, labels, figures });
  assert.ok(Buffer.isBuffer(buffer));
  return JSZip.loadAsync(buffer);
}
const part = (zip, name) => zip.file(name).async('string');
const partNames = (zip, re) => Object.keys(zip.files).filter((n) => re.test(n));
async function allParts(zip, re) {
  return (await Promise.all(partNames(zip, re).map((n) => part(zip, n)))).join('\n');
}

test('the cover carries the org, project and title', async () => {
  const doc = make('# Vision\n\nText.\n', { head: 'org: Fernhill Tool Library\n' });
  const xml = await part(await render(doc), 'word/document.xml');
  assert.match(xml, /Fernhill Tool Library/);
  assert.match(xml, /<w:smallCaps/);
  assert.match(xml, /Fernhill Lending, product definition/);
  assert.match(xml, />Fernhill Lending</);
  // The title is h1 x 1.6 = 27.2 pt, i.e. 54 or 55 half-points, bold.
  assert.match(xml, /<w:sz w:val="5[45]"\/>/);
});

test('the cover has the metadata table with the zebra label column, the revision and approval tables', async () => {
  const doc = make('# Vision\n', {
    head: 'author: Mara Quill\ncompanions: [D2, STACK]\nrevisions:\n  - {version: "0.1", date: 2026-11-01, author: Mara Quill, change: First draft}\napprovals:\n  - {role: Sponsor, name: Ines Calloway, date: 2026-11-13}\n',
  });
  const xml = await part(await render(doc), 'word/document.xml');
  for (const text of ['Document', 'Project', 'Version', 'Status', 'Author', 'Companion documents', 'D2, STACK']) {
    assert.ok(xml.includes(`>${text}<`), `cover has ${text}`);
  }
  assert.match(xml, /w:fill="F7F9FA"/);
  for (const text of ['Revision history', 'First draft', 'Approval', 'Sponsor', 'Ines Calloway']) {
    assert.ok(xml.includes(`>${text}<`), `cover has ${text}`);
  }
  assert.match(xml, /Markdown is the source of truth/);
});

test('no revision or approval table without revisions or approvals', async () => {
  const xml = await part(await render(make('# Vision\n')), 'word/document.xml');
  assert.ok(!xml.includes('Revision history'));
  assert.ok(!xml.includes('>Approval<'));
});

test('labels follow the document language', async () => {
  const doc = make('# Vision\n', { head: 'language: fr\nauthor: Mara Quill\n' });
  const zip = await render(doc);
  const xml = await part(zip, 'word/document.xml');
  assert.ok(xml.includes('>Projet<'));
  assert.ok(xml.includes('>Statut<'));
  assert.ok(xml.includes('>Auteur<'));
  assert.ok(xml.includes('>Sommaire<'));
  assert.ok(!xml.includes('>Contents<'));
  const footer = await allParts(zip, /^word\/footer\d*\.xml$/);
  assert.ok(footer.includes('Page'));
  assert.ok(footer.includes('sur'));
});

test('a TOC field over heading levels 1 to 2 is present and fields update on open', async () => {
  const zip = await render(make('# One\n\n## Two\n\n### Three\n'));
  const xml = await part(zip, 'word/document.xml');
  assert.match(xml, /TOC [^<]*\\o &quot;1-2&quot;/);
  assert.ok(xml.includes('>Contents<'));
  assert.match(await part(zip, 'word/settings.xml'), /<w:updateFields\/>/);
});

test('the cover and the content are two sections', async () => {
  const xml = await part(await render(make('# One\n')), 'word/document.xml');
  assert.equal(xml.match(/<w:sectPr/g).length, 2);
  assert.match(xml, /w:w="11906" w:h="16838"/);
  // marginCm 2 = 1134 twips.
  assert.match(xml, /w:top="1134"/);
  assert.match(xml, /w:left="1134"/);
});

test('headings carry bookmarks named from their anchor, with the heading styles', async () => {
  const doc = make('# Vision and goals\n\n## Scope\n\n### Détails\n\n#### Deep\n');
  const xml = await part(await render(doc), 'word/document.xml');
  for (const name of ['h_vision_and_goals', 'h_scope', 'h_details']) {
    assert.ok(xml.includes(`w:name="${name}"`), `bookmark ${name}`);
  }
  assert.match(xml, /w:pStyle w:val="Heading1"/);
  assert.match(xml, /w:pStyle w:val="Heading4"/);
  const styles = await part(await render(doc), 'word/styles.xml');
  // H1: 17 pt = 34 half-points, bold, accent bottom border, new page.
  const h1 = styles.match(/<w:style [^>]*w:styleId="Heading1".*?<\/w:style>/s)[0];
  assert.match(h1, /<w:sz w:val="34"\/>/);
  assert.match(h1, /<w:pageBreakBefore/);
  assert.match(h1, /w:color="17C79A"/);
  const h3 = styles.match(/<w:style [^>]*w:styleId="Heading3".*?<\/w:style>/s)[0];
  assert.match(h3, /w:val="5A6672"/);
});

test('bookmark names are valid for Word, deterministic and unique', () => {
  const valid = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
  const inputs = [
    'vision', 'a-b-c', 'fr-lnd-01', '3d-secure', 'x'.repeat(80), `${'y'.repeat(60)}-1`, `${'y'.repeat(60)}-2`,
    'FR-LND-01', 'PRV-03', '1A-1', 'détails', '',
  ];
  const names = inputs.map(bookmarkName);
  for (const n of names) assert.match(n, valid, n);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(inputs.map(bookmarkName), names);
  assert.equal(bookmarkName('FR-LND-01'), 'FR_LND_01');
  assert.equal(bookmarkName('scope-2'), 'h_scope_2');
});

test('an ID table row has a bookmark named by its ID', async () => {
  const doc = make('## Requirements\n\n| ID | Title |\n|---|---|\n| FR-LND-01 | Borrow a tool |\n| FR-LND-02 | Return a tool |\n');
  assert.equal(doc.blocks[1].rowAnchors[0], 'FR-LND-01');
  const xml = await part(await render(doc), 'word/document.xml');
  assert.ok(xml.includes(`w:name="${bookmarkName('FR-LND-01')}"`));
  assert.ok(xml.includes('w:name="FR_LND_01"'));
  assert.ok(xml.includes('w:name="FR_LND_02"'));
});

test('a repeated ID gets one bookmark only', async () => {
  const doc = make('| ID | T |\n|---|---|\n| FR-LND-01 | a |\n| FR-LND-01 | b |\n');
  const xml = await part(await render(doc), 'word/document.xml');
  assert.equal(xml.match(/w:name="FR_LND_01"/g).length, 1);
});

test('tables: header fill, repeated header, zebra, widths, borders, rows that do not split', async () => {
  const doc = make('<!-- widths: 20,50,30 -->\n| Role | Duty | Note |\n|---|---|---|\n| Member | Borrows | Card |\n| Volunteer | Desk | None |\n| Admin | Keys | Board |\n');
  const xml = await part(await render(doc), 'word/document.xml');
  const table = xml.split('<w:tbl>').pop();
  assert.match(table, /<w:tcPr>.*?w:fill="0F1A22"/s);
  assert.match(table, /<w:color w:val="FFFFFF"\/>/);
  assert.match(table, /<w:tblHeader/);
  assert.match(table, /<w:cantSplit/);
  assert.match(table, /w:fill="F7F9FA"/);
  // 8.5 pt body text.
  assert.match(table, /<w:sz w:val="17"\/>/);
  // 1/2 pt borders in the rule colour.
  assert.match(table, /w:sz="4"[^>]*w:color="D9DFE4"|w:color="D9DFE4"[^>]*w:sz="4"/);
  // Column widths 20/50/30 of the 17 cm text width (9638 twips).
  const grid = [...table.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(grid.length, 3);
  assert.equal(grid.reduce((a, b) => a + b, 0), 9638);
  assert.ok(Math.abs(grid[1] / 9638 - 0.5) < 0.002);
  assert.match(table, /<w:tblW w:type="dxa" w:w="9638"\/>/);
});

test('a table without widths gets equal columns, and ragged rows do not crash', async () => {
  const doc = make('| A | B | C |\n|---|---|---|\n| 1 | 2 |\n| 1 | 2 | 3 | 4 |\n');
  const xml = await part(await render(doc), 'word/document.xml');
  const table = xml.split('<w:tbl>').pop();
  const grid = [...table.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(grid.length, 3);
  assert.ok(Math.max(...grid) - Math.min(...grid) <= 1);
});

test('a hand-built ragged table is padded and cut to the header width', async () => {
  const run = (text) => [{ text }];
  const doc = { meta: parseDocument(`${FM}---\n\nx\n`, 'x.md').meta, file: 'x.md', warnings: [], blocks: [
    { type: 'table', header: [run('A'), run('B')], rows: [[run('1')], [run('1'), run('2'), run('3')]], widths: [10, 90, 5], rowAnchors: [null, null], line: 1 },
  ] };
  const table = (await part(await render(doc), 'word/document.xml')).split('<w:tbl>').pop();
  assert.equal([...table.matchAll(/<w:gridCol /g)].length, 2);
  assert.ok(!table.includes('>3<'));
});

test('a theme with another font family still declares the fallback, without embedding', async () => {
  const other = { ...theme, font: { family: 'Acme Sans', fallback: 'Arial' } };
  const doc = make('# One\n');
  const zip = await JSZip.loadAsync(await renderDocx(doc, { theme: other, labels: loadLabels('en'), figures: new Map() }));
  const table = await part(zip, 'word/fontTable.xml');
  assert.match(table, /<w:font w:name="Acme Sans"><w:altName w:val="Arial"\/><w:family w:val="swiss"\/><\/w:font>/);
  assert.equal(partNames(zip, /^word\/fonts\//).length, 0);
});

test('a 400-character cell renders', async () => {
  const long = 'wordy '.repeat(67).trim();
  assert.ok(long.length >= 400);
  const doc = make(`| A | B |\n|---|---|\n| ${long} | ok |\n`);
  const xml = await part(await render(doc), 'word/document.xml');
  assert.ok(xml.includes(long));
});

test('markup characters and accents are escaped', async () => {
  const doc = make('Fish & chips, a < b, café "quoted" \\<tag\\>.\n');
  const xml = await part(await render(doc), 'word/document.xml');
  assert.ok(xml.includes('Fish &amp; chips'));
  assert.ok(xml.includes('a &lt; b'));
  assert.ok(xml.includes('café'));
  assert.ok(!/ & /.test(xml.replace(/&amp;/g, '')));
});

test('the font table declares Inter Tight with Arial as alternate and embeds the faces', async () => {
  const zip = await render(make('# One\n'));
  const table = await part(zip, 'word/fontTable.xml');
  const font = table.match(/<w:font w:name="Inter Tight">.*?<\/w:font>/s)[0];
  assert.match(font, /<w:altName w:val="Arial"\/>/);
  assert.match(font, /<w:family w:val="swiss"\/>/);
  assert.match(font, /<w:embedRegular /);
  assert.match(font, /<w:embedBold /);
  assert.ok(partNames(zip, /^word\/fonts\/.*\.odttf$/).length >= 2);
  // The patched package has no directory entries.
  assert.equal(partNames(zip, /\/$/).length, 0);
  const rels = await part(zip, 'word/_rels/fontTable.xml.rels');
  assert.match(rels, /relationships\/font"/);
  // Schema order inside w:font: altName, family, pitch, sig, embed*.
  assert.ok(font.indexOf('altName') < font.indexOf('family'));
  assert.ok(font.indexOf('family') < font.indexOf('embedRegular'));
  const styles = await part(zip, 'word/styles.xml');
  assert.match(styles, /w:ascii="Inter Tight"/);
  assert.match(styles, /<w:sz w:val="20"\/>/);
  assert.match(styles, /w:val="0F1A22"/);
});

test('the header has project, title, version and status and a rule; the footer has PAGE and NUMPAGES', async () => {
  const zip = await render(make('# One\n'));
  const header = await allParts(zip, /^word\/header\d*\.xml$/);
  assert.ok(header.includes('Fernhill Lending · Fernhill Lending, product definition'));
  assert.ok(header.includes('v1.2 · Draft'));
  assert.match(header, /<w:pBdr>.*<w:bottom [^>]*w:color="D9DFE4"/s);
  assert.match(header, /<w:tab w:val="right"/);
  const footer = await allParts(zip, /^word\/footer\d*\.xml$/);
  assert.match(footer, /PAGE/);
  assert.match(footer, /NUMPAGES/);
  assert.match(footer, /<w:jc w:val="center"\/>/);
  assert.ok(footer.includes('Page'));
  assert.ok(footer.includes('of'));
});

test('provisional runs are shaded', async () => {
  const xml = await part(await render(make('The fee is PROVISIONAL until the vote (PRV-03).\n')), 'word/document.xml');
  assert.match(xml, /<w:shd [^>]*w:fill="FFF6C2"/);
});

test('callouts are single-cell tables with a 3 pt accent left border, a fill by kind and a bold label', async () => {
  const doc = make('> [!NOTE]\n> Members need no account.\n\n> [!WARNING]\n> Never lend a saw.\n\n> [!DECISION]\n> The desk is volunteer-run.\n');
  const xml = await part(await render(doc), 'word/document.xml');
  const tables = xml.split('<w:tbl>').slice(1);
  const callouts = tables.slice(-3);
  assert.equal(callouts.length, 3);
  const fills = ['EEF7F4', 'FDF3E1', 'EEF0FD'];
  const labels = ['Note', 'Warning', 'Decision'];
  callouts.forEach((t, i) => {
    assert.equal(t.match(/<w:tc>/g).length, 1);
    assert.ok(t.includes(`w:fill="${fills[i]}"`));
    assert.match(t, /<w:left [^>]*w:sz="24"[^>]*w:color="17C79A"|<w:left [^>]*w:color="17C79A"[^>]*w:sz="24"/);
    assert.match(t, new RegExp(`<w:b/>.{0,200}>${labels[i]}<`, 's'));
  });
});

test('code blocks are single-cell tables with the zebra fill in Consolas at the code size', async () => {
  const xml = await part(await render(make('```js\nconst a = 1 < 2;\n\n  indented();\n```\n')), 'word/document.xml');
  const t = xml.split('<w:tbl>').pop();
  assert.equal(t.match(/<w:tc>/g).length, 1);
  assert.match(t, /w:fill="F7F9FA"/);
  assert.match(t, /w:ascii="Consolas"/);
  assert.match(t, /<w:sz w:val="16"\/>/);
  assert.ok(t.includes('const a = 1 &lt; 2;'));
  assert.ok(t.includes('  indented();'));
});

test('lists, inline code and links render', async () => {
  const doc = make('- one\n  - nested\n- two\n\n1. Join\n2. Borrow\n\nSee [the rules](https://example.org/rules) and `code`.\n');
  const zip = await render(doc);
  const xml = await part(zip, 'word/document.xml');
  assert.match(xml, /<w:numPr>/);
  assert.match(xml, /<w:ilvl w:val="1"\/>/);
  assert.ok(xml.includes('>nested<'));
  assert.match(xml, /<w:hyperlink [^>]*r:id="/);
  const rels = await part(zip, 'word/_rels/document.xml.rels');
  assert.ok(rels.includes('https://example.org/rules'));
  assert.match(xml, /w:ascii="Consolas"/);
});

test('a figure is centred, scaled to the text width, kept with its caption, listed in the list of figures', async () => {
  const doc = make('<!-- caption: Loan flow -->\n```mermaid\ngraph TD\n  A-->B\n```\n');
  assert.equal(doc.blocks[0].id, 'fig-1');
  const zip = await render(doc, new Map([['fig-1', png(2400, 1200)]]));
  const xml = await part(zip, 'word/document.xml');
  const ext = xml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
  // 17 cm text width = 6120000 EMU, ratio 2:1 kept.
  assert.ok(Math.abs(Number(ext[1]) - 6120000) <= 10000);
  assert.ok(Math.abs(Number(ext[1]) / Number(ext[2]) - 2) < 0.01);
  assert.ok(partNames(zip, /^word\/media\//).length >= 1);
  assert.match(xml, /<w:keepNext\/>/);
  assert.ok(xml.includes('Figure '));
  assert.ok(xml.includes('Loan flow'));
  assert.match(xml, /<w:i\/>/);
  assert.match(xml, /<w:sz w:val="17"\/>/);
  // The list of figures is a TOC field over the Figure sequence, under its own title.
  assert.ok(xml.includes('>List of figures<'));
  assert.match(xml, /TOC [^<]*\\c &quot;Figure&quot;/);
  assert.match(xml, /SEQ Figure/);
});

test('a very tall figure is scaled down to fit the page, ratio kept', async () => {
  const doc = make('![Tall](figures/tall.png)\n');
  const zip = await render(doc, new Map([['fig-1', png(400, 4000)]]));
  const ext = (await part(zip, 'word/document.xml')).match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
  assert.ok(Number(ext[2]) <= 25 * 360000);
  assert.ok(Math.abs(Number(ext[1]) / Number(ext[2]) - 0.1) < 0.002);
});

test('no list of figures without figures', async () => {
  const xml = await part(await render(make('# One\n')), 'word/document.xml');
  assert.ok(!xml.includes('List of figures'));
});

test('a missing figure throws with file and line', async () => {
  const doc = make('Intro.\n\n![Desk](figures/desk.svg)\n', { file: 'docs/D1.md' });
  const figure = doc.blocks.find((b) => b.type === 'figure');
  await assert.rejects(
    () => renderDocx(doc, { theme, labels: loadLabels('en'), figures: new Map() }),
    new RegExp(`^Error: docs/D1\\.md:${figure.line}: figure fig-1 was not rendered$`),
  );
});

test('a page break block becomes a page break', async () => {
  const xml = await part(await render(make('One.\n\n<!-- pagebreak -->\n\nTwo.\n')), 'word/document.xml');
  assert.match(xml, /<w:br w:type="page"\/>/);
});

test('the Fernhill D1 fixture renders to a well-formed package', async () => {
  const doc = parseDocument(readFileSync(FIXTURE, 'utf8'), 'docs/D1.md');
  const figures = new Map();
  for (const b of collectFigures(doc.blocks)) figures.set(b.id, png(1032, 600));
  const zip = await render(doc, figures);
  for (const name of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/fontTable.xml']) {
    assert.ok(zip.file(name), name);
  }
  const names = [];
  for (const name of Object.keys(zip.files).filter((n) => n.endsWith('.xml') || n.endsWith('.rels'))) {
    const text = await part(zip, name);
    assert.ok(text.startsWith('<?xml'), name);
    // _Toc<n> bookmarks are the hidden ones docx writes for the table of contents.
    names.push(...[...text.matchAll(/<w:bookmarkStart [^>]*w:name="([^"]+)"/g)].map((m) => m[1]).filter((n) => !n.startsWith('_Toc')));
  }
  assert.ok(names.length > 3);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'bookmark names are unique');
  for (const n of names) assert.match(n, /^[A-Za-z][A-Za-z0-9_]{0,39}$/);
});

test('the cover has a title page with an empty first-page header and footer; the content section keeps the running ones', async () => {
  const zip = await render(make('# One\n'));
  const xml = await part(zip, 'word/document.xml');
  const [cover, content] = xml.match(/<w:sectPr[ >].*?<\/w:sectPr>/gs);
  assert.match(cover, /<w:titlePg\/>/);
  assert.ok(!content.includes('titlePg'));
  const rels = await part(zip, 'word/_rels/document.xml.rels');
  const target = (id) => rels.match(new RegExp(`<Relationship [^>]*Id="${id}"[^>]*Target="([^"]+)"|<Relationship [^>]*Target="([^"]+)"[^>]*Id="${id}"`))?.slice(1).find(Boolean);
  const ref = (section, kind, type) => section.match(new RegExp(`<w:${kind}Reference [^>]*w:type="${type}"[^>]*r:id="([^"]+)"|<w:${kind}Reference [^>]*r:id="([^"]+)"[^>]*w:type="${type}"`)).slice(1).find(Boolean);
  for (const kind of ['header', 'footer']) {
    const first = await part(zip, `word/${target(ref(cover, kind, 'first'))}`);
    assert.ok(!first.includes('<w:t'), `${kind} of the cover is empty`);
    assert.ok(!first.includes('PAGE'));
    const running = await part(zip, `word/${target(ref(content, kind, 'default'))}`);
    assert.match(running, kind === 'header' ? /Fernhill Lending/ : /NUMPAGES/);
  }
});

test('the default run language follows the document language', async () => {
  const lang = async (code) => (await part(await render(make('# One\n', { head: code ? `language: ${code}\n` : '' })), 'word/styles.xml')).match(/<w:lang w:val="([^"]+)"/)?.[1];
  assert.equal(await lang(), 'en-GB');
  assert.equal(await lang('en'), 'en-GB');
  assert.equal(await lang('fr'), 'fr-FR');
  assert.equal(await lang('de'), 'de');
});

test('a small figure keeps its natural size, a large one is capped at the text width', async () => {
  const doc = make('![Small](figures/a.png)\n\n![Large](figures/b.png)\n');
  // 600 px wide at device scale 2 is 300 CSS px, 300 * 9525 EMU = 2857500; 2400 px is 1200 CSS px, wider than the page.
  const zip = await render(doc, new Map([['fig-1', png(600, 300)], ['fig-2', png(2400, 1200)]]));
  const sizes = [...(await part(zip, 'word/document.xml')).matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(sizes.length, 2);
  assert.ok(Math.abs(sizes[0][0] - 2857500) <= 10000);
  assert.ok(Math.abs(sizes[0][0] / sizes[0][1] - 2) < 0.01);
  assert.ok(Math.abs(sizes[1][0] - 6120000) <= 10000);
});

test('docx.js re-exports bookmarkName from the dependency-free bookmarks module', () => {
  assert.equal(docxModule.bookmarkName, bookmarkName);
});

test('FR and fr-CA render French labels and the French proofing language', async () => {
  for (const code of ['FR', 'fr-CA']) {
    const zip = await render(make('# Vision\n', { head: `language: ${code}\n` }));
    const xml = await part(zip, 'word/document.xml');
    assert.ok(xml.includes('>Sommaire<'), code);
    assert.ok(!xml.includes('>Contents<'), code);
    assert.match(await part(zip, 'word/styles.xml'), /<w:lang w:val="fr-FR"/, code);
  }
});

test('a javascript: link becomes plain text, with no hyperlink and no underline', async () => {
  const zip = await render(make('See [bad](javascript:alert(1)) and [good](https://example.org/x) and [up](#vision).\n\n# Vision\n'));
  const xml = await part(zip, 'word/document.xml');
  assert.ok(!xml.includes('javascript:'));
  assert.ok(xml.includes('>bad<'));
  assert.equal((xml.match(/<w:hyperlink [^>]*r:id=/g) ?? []).length, 1);
  assert.doesNotMatch(xml, /<w:hyperlink [^>]*>(?:(?!<\/w:hyperlink>)[\s\S])*>bad</);
  const rels = await part(zip, 'word/_rels/document.xml.rels');
  assert.ok(rels.includes('https://example.org/x'));
  assert.ok(!rels.includes('javascript'));
  const bad = xml.slice(xml.lastIndexOf('<w:r>', xml.indexOf('>bad<')), xml.indexOf('>bad<'));
  assert.ok(!bad.includes('w:u '));
});
