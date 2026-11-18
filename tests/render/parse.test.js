import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { splitFrontMatter, validateMeta } from '../../src/render/frontmatter.js';
import { parseDocument } from '../../src/render/parse.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/render/fernhill/docs/D1.md', import.meta.url));
const FM = '---\ndoc_id: D1\ntitle: T\nproject: P\nversion: "1"\ndate: 2026-11-13\nstatus: Draft\n---\n';
const parse = (body, file = 'x.md') => parseDocument(FM + body, file);
const runsText = (runs) => runs.map((r) => r.text).join('');

test('splitFrontMatter returns meta, body and the 1-based body line', () => {
  const { meta, body, bodyLine } = splitFrontMatter('---\na: 1\nb: x\n---\n# Hi\n', 'f.md');
  assert.deepEqual(meta, { a: 1, b: 'x' });
  assert.equal(body, '# Hi\n');
  assert.equal(bodyLine, 5);
});

test('splitFrontMatter throws when front matter is missing or unclosed', () => {
  assert.throws(() => splitFrontMatter('# Hi\n', 'f.md'), /f\.md: missing front matter/);
  assert.throws(() => splitFrontMatter('---\na: 1\n', 'f.md'), /f\.md: missing front matter/);
});

test('splitFrontMatter keeps a version such as 1.0 as written', () => {
  const { meta } = splitFrontMatter('---\nversion: 1.0\ndate: 2026-11-13\n---\n', 'f.md');
  assert.equal(meta.version, '1.0');
  assert.equal(meta.date, '2026-11-13');
});

test('splitFrontMatter keeps unquoted versions inside revisions as written', () => {
  const { meta } = splitFrontMatter(
    '---\nversion: 2.0\nrevisions:\n  - {version: 1.0, date: 2026-11-01, author: A, change: First}\n  - {version: "1.1", date: 2026-11-02, author: A, change: Next}\n---\n',
    'f.md',
  );
  assert.equal(meta.revisions[0].version, '1.0');
  assert.equal(meta.revisions[1].version, '1.1');
  const out = validateMeta({ doc_id: 'D1', title: 'T', project: 'P', date: '2026-11-13', status: 'S', ...meta }, 'f.md');
  assert.equal(out.version, '2.0');
  assert.equal(out.revisions[0].version, '1.0');
});

test('validateMeta fills defaults and normalises lists', () => {
  const meta = validateMeta({ doc_id: 'D1', title: 'T', project: 'P', version: '1', date: '2026-11-13', status: 'Draft' }, 'f.md');
  assert.equal(meta.language, 'en');
  assert.deepEqual(meta.companions, []);
  assert.deepEqual(meta.revisions, []);
  assert.deepEqual(meta.approvals, []);
});

test('validateMeta names the missing key', () => {
  const ok = { doc_id: 'D1', title: 'T', project: 'P', version: '1', date: '2026-11-13', status: 'Draft' };
  for (const key of Object.keys(ok)) {
    const meta = { ...ok };
    delete meta[key];
    assert.throws(() => validateMeta(meta, 'f.md'), new RegExp(`f\\.md: front matter needs ${key}$`));
  }
});

test('validateMeta rejects a bad date and a bad doc_id', () => {
  const ok = { doc_id: 'D1', title: 'T', project: 'P', version: '1', date: '2026-11-13', status: 'Draft' };
  assert.throws(() => validateMeta({ ...ok, date: '13/11/2026' }, 'f.md'), /f\.md: .*date/);
  assert.throws(() => validateMeta({ ...ok, date: '2026-02-30' }, 'f.md'), /f\.md: .*date/);
  assert.throws(() => validateMeta({ ...ok, doc_id: 'd one' }, 'f.md'), /f\.md: .*doc_id/);
});

test('validateMeta keeps revisions, approvals, companions and language', () => {
  const meta = validateMeta(
    {
      doc_id: 'D2', title: 'T', project: 'P', version: '2', date: '2026-11-13', status: 'Draft', language: 'fr',
      companions: ['D1'],
      revisions: [{ version: '1', date: '2026-11-01', author: 'A', change: 'First' }],
      approvals: [{ role: 'Sponsor', name: 'N', date: '2026-11-13' }],
    },
    'f.md',
  );
  assert.equal(meta.language, 'fr');
  assert.deepEqual(meta.companions, ['D1']);
  assert.equal(meta.revisions[0].change, 'First');
  assert.equal(meta.approvals[0].role, 'Sponsor');
});

test('headings: levels 1 to 4, anchors without accents, duplicates numbered', () => {
  const { blocks } = parse('# Vision\n\n## Détails & Écarts\n\n## Vision\n\n### Vision\n\n#### Vision\n');
  const h = blocks.filter((b) => b.type === 'heading');
  assert.deepEqual(h.map((b) => b.level), [1, 2, 2, 3, 4]);
  assert.deepEqual(h.map((b) => b.anchor), ['vision', 'details-ecarts', 'vision-2', 'vision-3', 'vision-4']);
});

test('anchors stay unique when a heading already reads like a suffixed one', () => {
  const { blocks } = parse('# Vision\n\n## Vision 2\n\n## Vision\n\n## Vision\n');
  assert.deepEqual(blocks.map((b) => b.anchor), ['vision', 'vision-2', 'vision-3', 'vision-4']);
});

test('anchors transliterate oe, ae and ss ligatures before stripping accents', () => {
  const { blocks } = parse('# \u0152uvre\n\n## \u0153uf \u00c6ther\n\n## Stra\u00dfe\n\n## \u00c9t\u00e9\n');
  assert.deepEqual(blocks.map((b) => b.anchor), ['oeuvre', 'oeuf-aether', 'strasse', 'ete']);
});

test('entities stay literal in inline code and fenced code', () => {
  const { blocks } = parse('Use `&amp; <b> a&b` here and &amp; there\n\n```html\n<p>&amp; a&b</p>\n```\n');
  assert.deepEqual(blocks[0].runs, [
    { text: 'Use ' },
    { text: '&amp; <b> a&b', code: true },
    { text: ' here and & there' },
  ]);
  assert.equal(blocks[1].text, '<p>&amp; a&b</p>');
});

test('headings deeper than 4 become bold paragraphs', () => {
  const { blocks } = parse('##### Deep\n\n###### Deeper\n');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'paragraph']);
  assert.deepEqual(blocks[0].runs, [{ text: 'Deep', bold: true }]);
});

test('inline: bold, italic, code, link and literal characters', () => {
  const { blocks } = parse('Plain **b** *i* _j_ `c` [t](https://e.org) & < > " é\n');
  assert.deepEqual(blocks[0].runs, [
    { text: 'Plain ' },
    { text: 'b', bold: true },
    { text: ' ' },
    { text: 'i', italic: true },
    { text: ' ' },
    { text: 'j', italic: true },
    { text: ' ' },
    { text: 'c', code: true },
    { text: ' ' },
    { text: 't', link: 'https://e.org' },
    { text: ' & < > " é' },
  ]);
});

test('inline: entities are decoded and nesting combines flags', () => {
  const { blocks } = parse('a &amp; b &lt;x&gt; **bold *both***\n');
  assert.deepEqual(blocks[0].runs, [
    { text: 'a & b <x> ' },
    { text: 'bold ', bold: true },
    { text: 'both', bold: true, italic: true },
  ]);
});

test('inline: PROVISIONAL and PRV citations are flagged', () => {
  const { blocks } = parse('Fee is PROVISIONAL (PRV-03) until then. See FR-LND-01.\n');
  const flagged = blocks[0].runs.filter((r) => r.provisional);
  assert.deepEqual(flagged.map((r) => r.text), ['PROVISIONAL', 'PRV-03']);
  assert.equal(runsText(blocks[0].runs), 'Fee is PROVISIONAL (PRV-03) until then. See FR-LND-01.');
});

test('lists: ordered flag, items and nested children', () => {
  const { blocks } = parse('- one\n  - inner\n- two\n\n1. a\n2. b\n');
  assert.equal(blocks[0].type, 'list');
  assert.equal(blocks[0].ordered, false);
  assert.equal(runsText(blocks[0].items[0].runs), 'one');
  assert.equal(blocks[0].items[0].children[0].type, 'list');
  assert.equal(runsText(blocks[0].items[0].children[0].items[0].runs), 'inner');
  assert.equal(blocks[1].ordered, true);
  assert.equal(blocks[1].items.length, 2);
});

test('table: plain table has null widths and null row anchors', () => {
  const { blocks, warnings } = parse('| a | b |\n|---|---|\n| 1 | **2** |\n');
  const t = blocks[0];
  assert.equal(t.type, 'table');
  assert.equal(t.widths, null);
  assert.deepEqual(t.rowAnchors, [null]);
  assert.equal(runsText(t.header[0]), 'a');
  assert.deepEqual(t.rows[0][1], [{ text: '2', bold: true }]);
  assert.deepEqual(warnings, []);
});

test('table: widths hint is normalised to sum 100', () => {
  const { blocks, warnings } = parse('<!-- widths: 1,1,2 -->\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n');
  assert.deepEqual(blocks[0].widths, [25, 25, 50]);
  assert.deepEqual(warnings, []);
  const sums = parse('<!-- widths: 1,1,1 -->\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 |\n').blocks[0].widths;
  assert.equal(sums.reduce((a, b) => a + b, 0), 100);
});

test('table: widths with the wrong count is ignored with a table-widths warning', () => {
  const { blocks, warnings } = parse('<!-- widths: 20,50,30 -->\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.equal(blocks[0].widths, null);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].rule, 'table-widths');
  assert.equal(warnings[0].severity, 'warn');
  assert.equal(warnings[0].file, 'x.md');
  assert.equal(warnings[0].line, 9);
  assert.equal(blocks.length, 1);
});

test('table: ragged rows are padded or truncated with a table-ragged warning', () => {
  const { blocks, warnings } = parse('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |\n| 1 | 2 |\n');
  const t = blocks[0];
  assert.equal(t.rows.length, 3);
  assert.deepEqual(t.rows.map((r) => r.length), [2, 2, 2]);
  assert.deepEqual(t.rows[0][1], []);
  assert.deepEqual(warnings.map((w) => w.rule), ['table-ragged', 'table-ragged']);
  assert.deepEqual(warnings.map((w) => w.line), [11, 12]);
});

test('table: an escaped pipe stays inside its cell', () => {
  const { blocks, warnings } = parse('| a | b |\n|---|---|\n| x \\| y | z |\n');
  assert.equal(runsText(blocks[0].rows[0][0]), 'x | y');
  assert.deepEqual(warnings, []);
});

test('table: an ID table anchors each row on its ID, other tables do not', () => {
  const { blocks } = parse(
    '| ID | Title |\n|---|---|\n| FR-LND-01 | Borrow |\n| **FR-LND-02** | Return |\n| n/a | Other |\n\n| Name | ID |\n|---|---|\n| x | FR-LND-01 |\n\n| **id** | Title |\n|---|---|\n| `NFR-01` | Fast |\n',
  );
  assert.deepEqual(blocks[0].rowAnchors, ['FR-LND-01', 'FR-LND-02', null]);
  assert.deepEqual(blocks[1].rowAnchors, [null]);
  assert.deepEqual(blocks[2].rowAnchors, ['NFR-01']);
});

test('callouts: kinds from the first line, other quotes are notes', () => {
  const { blocks } = parse(
    '> [!NOTE]\n> Hello **there**\n\n> [!WARNING]\n> Careful\n\n> [!DECISION]\n> Chosen\n\n> Just a quote\n',
  );
  assert.deepEqual(blocks.map((b) => b.type), ['callout', 'callout', 'callout', 'callout']);
  assert.deepEqual(blocks.map((b) => b.kind), ['note', 'warning', 'decision', 'note']);
  assert.equal(blocks[0].blocks[0].type, 'paragraph');
  assert.deepEqual(blocks[0].blocks[0].runs, [{ text: 'Hello ' }, { text: 'there', bold: true }]);
  assert.equal(runsText(blocks[3].blocks[0].runs), 'Just a quote');
});

test('code blocks keep language and text', () => {
  const { blocks } = parse('```js\nconst a = 1;\n```\n');
  assert.deepEqual(blocks[0], { type: 'code', lang: 'js', text: 'const a = 1;', line: 9 });
});

test('mermaid fence becomes a figure with the caption from the comment above', () => {
  const { blocks } = parse('<!-- caption: Loan *flow* -->\n```mermaid\ngraph TD\n  A-->B\n```\n\n```mermaid\ngraph LR\n```\n');
  const [a, b] = blocks;
  assert.equal(a.type, 'figure');
  assert.equal(a.id, 'fig-1');
  assert.equal(a.number, 1);
  assert.deepEqual(a.source, { kind: 'mermaid', text: 'graph TD\n  A-->B' });
  assert.deepEqual(a.caption, [{ text: 'Loan ' }, { text: 'flow', italic: true }]);
  assert.equal(a.line, 10);
  assert.equal(b.id, 'fig-2');
  assert.deepEqual(b.caption, []);
});

test('image alone in its paragraph becomes a numbered figure by extension', () => {
  const { blocks } = parse('![Desk **layout**](figures/desk.svg)\n\n![Card](figures/card.HTML)\n\n![Shot](shot.png)\n\nInline ![x](y.png) image\n');
  assert.deepEqual(blocks.slice(0, 3).map((b) => [b.type, b.id, b.number, b.source.kind, b.source.path]), [
    ['figure', 'fig-1', 1, 'svg', 'figures/desk.svg'],
    ['figure', 'fig-2', 2, 'html', 'figures/card.HTML'],
    ['figure', 'fig-3', 3, 'png', 'shot.png'],
  ]);
  assert.deepEqual(blocks[0].caption, [{ text: 'Desk ' }, { text: 'layout', bold: true }]);
  assert.equal(blocks[3].type, 'paragraph');
});

test('mermaid and image figures share one numbering in document order', () => {
  const { blocks } = parse('![A](a.png)\n\n```mermaid\ngraph TD\n```\n\n> ![B](b.svg)\n');
  assert.equal(blocks[0].number, 1);
  assert.equal(blocks[1].number, 2);
  assert.equal(blocks[2].blocks[0].number, 3);
  assert.equal(blocks[2].blocks[0].id, 'fig-3');
});

test('unsupported image extension is an error naming the file and line', () => {
  assert.throws(() => parse('Intro\n\n![Bad](pic.gif)\n', 'docs/D1.md'), /docs\/D1\.md:11: .*pic\.gif/);
  assert.throws(() => parse('![Bad](noext)\n', 'docs/D1.md'), /docs\/D1\.md:9: /);
});

test('pagebreak comment becomes a block, other comments are dropped', () => {
  const { blocks } = parse('One\n\n<!-- pagebreak -->\n\n<!-- just a note -->\n\nTwo\n');
  assert.deepEqual(blocks.map((b) => b.type), ['paragraph', 'pagebreak', 'paragraph']);
  assert.equal(blocks[1].line, 11);
});

test('line numbers are 1-based in the original file, front matter included', () => {
  const { blocks } = parse('# One\n\nText\n\n- a\n- b\n');
  assert.deepEqual(blocks.map((b) => b.line), [9, 11, 13]);
});

test('parseDocument returns meta, blocks, file and warnings', () => {
  const doc = parse('# One\n');
  assert.equal(doc.file, 'x.md');
  assert.equal(doc.meta.doc_id, 'D1');
  assert.deepEqual(doc.warnings, []);
  assert.equal(doc.blocks.length, 1);
});

test('the Fernhill D1 fixture exercises every feature', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const doc = parseDocument(text, 'docs/D1.md');
  const lineOf = (needle) => text.slice(0, text.indexOf(needle)).split('\n').length;
  assert.equal(doc.meta.version, '1.0');
  assert.equal(doc.meta.revisions.length, 2);
  assert.equal(doc.meta.language, 'en');
  const types = new Set(doc.blocks.map((b) => b.type));
  for (const t of ['heading', 'paragraph', 'list', 'table', 'callout', 'code', 'figure', 'pagebreak']) {
    assert.ok(types.has(t), `missing ${t}`);
  }
  const anchors = doc.blocks.filter((b) => b.type === 'heading').map((b) => b.anchor);
  assert.ok(anchors.includes('scope') && anchors.includes('scope-2') && anchors.includes('details-accents'));
  assert.equal(doc.blocks.find((b) => b.type === 'heading' && b.anchor === 'closing').line, lineOf('## Closing'));
  const tables = doc.blocks.filter((b) => b.type === 'table');
  assert.deepEqual(tables[0].widths, [20, 50, 30]);
  assert.equal(tables[0].rows[1].length, 3);
  assert.deepEqual(tables[1].rowAnchors, ['FR-LND-01', 'FR-LND-02']);
  assert.equal(runsText(tables[1].header[2]), 'Rule | note');
  assert.deepEqual(doc.warnings.map((w) => w.rule), ['table-ragged']);
  assert.equal(doc.warnings[0].line, lineOf('| Volunteer | Runs the desk |'));
  assert.deepEqual(
    doc.blocks.filter((b) => b.type === 'callout').map((b) => b.kind),
    ['note', 'warning', 'decision', 'note'],
  );
  const figures = doc.blocks.filter((b) => b.type === 'figure');
  assert.deepEqual(figures.map((f) => f.source.kind), ['mermaid', 'svg', 'html']);
  assert.deepEqual(runsText(figures[0].caption), 'Loan flow');
  assert.ok(doc.blocks.some((b) => b.type === 'paragraph' && b.runs.some((r) => r.provisional)));
});

test('validateMeta normalises the language once: FR and fr-CA become fr, junk becomes en', () => {
  const base = { doc_id: 'D2', title: 'T', project: 'P', version: '2', date: '2026-11-13', status: 'Draft' };
  assert.equal(validateMeta({ ...base, language: 'FR' }, 'a.md').language, 'fr');
  assert.equal(validateMeta({ ...base, language: 'fr-CA' }, 'a.md').language, 'fr');
  assert.equal(validateMeta({ ...base, language: 'klingon!' }, 'a.md').language, 'en');
  assert.equal(validateMeta(base, 'a.md').language, 'en');
});
