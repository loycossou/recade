import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from '../../src/render/parse.js';
import { loadTheme, loadLabels } from '../../src/render/theme.js';
import { chromiumStatus, withBrowser } from '../../src/render/browser.js';
import { collectFigures, renderFigures } from '../../src/render/figures.js';
import { bookmarkName } from '../../src/render/bookmarks.js';
import { renderHtml } from '../../src/render/html.js';
import { renderPdf } from '../../src/render/pdf.js';

const DOC_DIR = fileURLToPath(new URL('../fixtures/render/fernhill/docs/', import.meta.url));
const FIXTURE = join(DOC_DIR, 'D1.md');
const FM = '---\ndoc_id: D1\ntitle: Fernhill Lending, product definition\nproject: Fernhill Lending\nversion: "1.2"\ndate: 2026-11-13\nstatus: Draft\n';
const theme = loadTheme(null);
const status = chromiumStatus();
const skip = status.ok ? false : `Chromium is not installed (${status.fix})`;
if (skip) console.log(`# pdf tests needing Chromium are skipped: ${skip}`);

// A 1x1 PNG: the HTML tests never need a browser.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const png = (width = 800, height = 400) => ({ png: PNG, width, height });

const make = (body, { head = '', file = 'docs/D1.md' } = {}) => parseDocument(`${FM}${head}---\n\n${body}`, file);
const html = (doc, figures = new Map()) => renderHtml(doc, { theme, labels: loadLabels(doc.meta.language), figures });

// ---------------------------------------------------------------------------------------------------------------
// HTML (no browser needed)

test('text is escaped: ampersands, angle brackets and quotes never reach the markup raw', () => {
  const doc = make('# A & B\n\nSay "hi" if a < b > c, it\'s fine.\n\n| H "q" | x < y |\n|---|---|\n| x & y | `a<b>` |\n');
  const out = html(doc);
  assert.match(out, /<h1 id="[^"]+">A &amp; B<\/h1>/);
  assert.match(out, /Say &quot;hi&quot; if a &lt; b &gt; c, it&#39;s fine\./);
  assert.match(out, /<th>H &quot;q&quot;<\/th><th>x &lt; y<\/th>/);
  assert.match(out, /<td>x &amp; y<\/td><td><code>a&lt;b&gt;<\/code><\/td>/);
  // A hostile title and project cannot open a tag either.
  const hostile = parseDocument(`${FM.replace('Fernhill Lending, product definition', 'T"><img src=x onerror=alert(1)>')}---\n\n# One\n`.replace('project: Fernhill Lending', 'project: "<b>P</b>"'), 'docs/D1.md');
  const bad = html(hostile);
  assert.ok(!bad.includes('<img src=x'));
  assert.ok(!bad.includes('<b>P</b>'));
});

test('the document language is on the root element and picks the labels', () => {
  assert.match(html(make('# One\n')), /^<!doctype html>\s*<html lang="en">/i);
  const fr = html(make('# Un\n', { head: 'language: fr\n' }));
  assert.match(fr, /<html lang="fr">/);
  assert.match(fr, />Sommaire</);
});

test('every heading carries a bookmark-style id and the contents link to it', () => {
  const doc = make('# Vision\n\n## Scope\n\n### Deep\n\n# Détails: accents\n');
  const out = html(doc);
  for (const h of doc.blocks.filter((b) => b.type === 'heading')) {
    const id = bookmarkName(h.anchor);
    assert.ok(out.includes(`id="${id}"`), `heading id ${id}`);
    if (h.level <= 2) assert.ok(out.includes(`href="#${id}"`), `contents link ${id}`);
  }
  assert.ok(!out.includes(`href="#${bookmarkName(doc.blocks[2].anchor)}"`), 'level 3 is not in the contents');
  assert.match(out, /<h1 id="h_vision">/);
  // The contents list has no page numbers.
  const contents = out.match(/<nav class="contents">.*?<\/nav>/s)[0];
  assert.ok(!contents.includes('class="page"'));
});

test('duplicate headings get one id only, internal links use the same names, unsafe links are dropped', () => {
  const doc = make('# Scope\n\n# Scope\n\nSee [up](#scope), [out](https://example.org/x), [bad](javascript:alert(1)).\n');
  const out = html(doc);
  assert.equal(out.match(/id="h_scope"/g).length, 1);
  assert.match(out, /<a href="#h_scope">up<\/a>/);
  assert.match(out, /<a href="https:\/\/example\.org\/x">out<\/a>/);
  assert.ok(!out.includes('javascript:'));
});

test('the cover has the org, project, title, metadata, revision and approval tables', () => {
  const doc = make('# Vision\n', {
    head: 'org: Fernhill Tool Library\nauthor: Mara Quill\ncompanions: [D2, STACK]\nrevisions:\n  - {version: "0.1", date: 2026-11-01, author: Mara Quill, change: First draft}\napprovals:\n  - {role: Sponsor, name: Ines Calloway, date: 2026-11-13}\n',
  });
  const out = html(doc);
  const cover = out.match(/<section class="cover">.*?<\/section>/s)[0];
  for (const text of ['Fernhill Tool Library', 'Fernhill Lending, product definition', 'Document', 'Project', 'Version', 'Status', 'Author', 'Companion documents', 'D2, STACK', 'Revision history', 'First draft', 'Approval', 'Sponsor', 'Ines Calloway', 'Markdown is the source of truth']) {
    assert.ok(cover.includes(`>${text}`) || cover.includes(text), `cover has ${text}`);
  }
  const bare = html(make('# Vision\n'));
  assert.ok(!bare.includes('Revision history'));
  assert.ok(!bare.includes('>Approval<'));
});

test('the list of figures appears only with figures and links to them', () => {
  assert.ok(!html(make('# One\n')).includes('List of figures'));
  const doc = make('# One\n\n<!-- caption: Loan flow -->\n![Desk](figures/a.png)\n');
  const out = html(doc, new Map([['fig-1', png()]]));
  const list = out.match(/<nav class="figures">.*?<\/nav>/s)[0];
  assert.match(list, /List of figures/);
  assert.match(list, /Figure 1: Loan flow|Figure 1: Desk/);
  const id = list.match(/href="#([^"]+)"/)[1];
  assert.ok(out.includes(`<figure id="${id}"`));
});

test('ID rows get an anchor, tables get header, zebra data and column widths', () => {
  const out = html(make('# R\n\n<!-- widths: 30,70 -->\n| ID | Title |\n|---|---|\n| FR-LND-01 | Borrow |\n| FR-LND-02 | Return |\n'));
  assert.ok(out.includes('id="FR_LND_01"'));
  assert.ok(out.includes('id="FR_LND_02"'));
  assert.match(out, /<thead>.*<th[^>]*>ID<\/th>/s);
  assert.match(out, /<col style="width:30%">/);
  assert.match(out, /<col style="width:70%">/);
});

test('callouts, code, provisional marks, lists and page breaks', () => {
  const out = html(make('# R\n\n> [!WARNING]\n> Careful.\n\n```js\nconst a = 1 < 2;\n```\n\nThe fee is PROVISIONAL (PRV-03).\n\n- one\n  - nested\n\n1. a\n\n<!-- pagebreak -->\n\nAfter.\n'));
  assert.match(out, /<aside class="callout warning"><p><strong>Warning<\/strong> Careful\.<\/p><\/aside>/);
  assert.match(out, /<pre><code[^>]*>const a = 1 &lt; 2;/);
  assert.match(out, /<mark class="prv">PROVISIONAL<\/mark>/);
  assert.match(out, /<mark class="prv">PRV-03<\/mark>/);
  assert.match(out, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
  assert.match(out, /<ol><li>a<\/li><\/ol>/);
  assert.match(out, /<div class="pagebreak"><\/div>/);
  // A page break right before an H1 is dropped: the H1 starts a page anyway.
  assert.ok(!html(make('Text.\n\n<!-- pagebreak -->\n\n# Next\n')).includes('class="pagebreak"'));
});

test('figures are data: PNGs, not upscaled beyond their natural width, capped at the text width', () => {
  const doc = make('![Small](figures/a.png)\n\n![Large](figures/b.png)\n');
  const out = html(doc, new Map([['fig-1', png(600, 300)], ['fig-2', png(2400, 1200)]]));
  const imgs = [...out.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 2);
  for (const img of imgs) assert.match(img, /src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
  assert.match(imgs[0], /width="300"/);
  assert.match(imgs[0], /height="150"/);
  // A4 with 2 cm margins: 17 cm of text, 642.5 CSS px.
  const wide = Number(imgs[1].match(/width="(\d+)"/)[1]);
  assert.ok(wide <= 643 && wide >= 640, `large figure is ${wide}px`);
  assert.match(imgs[1], /alt="Large"/);
  assert.match(out, /<figcaption>Figure 1: Small<\/figcaption>/);
});

test('a missing figure image is an error naming file and line', () => {
  const doc = make('Intro.\n\n![Desk](figures/desk.svg)\n');
  assert.throws(() => html(doc), /^Error: docs\/D1\.md:\d+: figure fig-1 was not rendered$/);
});

test('theme tokens are CSS variables, the stylesheet comes from print.css, fonts are data: URLs', () => {
  const out = html(make('# One\n'));
  assert.match(out, /:root\{[^}]*--accent:#17C79A/);
  assert.match(out, /font-family:\s*"Inter Tight",\s*Arial,\s*sans-serif/);
  assert.match(out, /break-before:\s*page/);
  assert.match(out, /break-inside:\s*avoid/);
  assert.match(out, /display:\s*table-header-group/);
  assert.match(out, /@page\s*\{[^}]*size:\s*A4/);
  const srcs = [...out.matchAll(/src:\s*url\(([^)]*)\)/g)].map((m) => m[1]);
  assert.equal(srcs.length, 4);
  for (const s of srcs) assert.match(s, /^data:font\/ttf;base64,/);
});

test('the running header and footer are page-margin boxes with the DOCX texts, emptied on the cover, and safe against hostile titles', () => {
  const out = html(make('# One\n'));
  assert.match(out, /@top-left\{content:"Fernhill Lending \u00b7 Fernhill Lending, product definition"/);
  assert.match(out, /@top-right\{content:"v1\.2 \u00b7 Draft"/);
  assert.match(out, /@bottom-center\{content:"Page " counter\(page\) " of " counter\(pages\)/);
  assert.match(out, /@page :first\{[^}]*@top-left\{content:none/);
  const hostile = parseDocument(`${FM.replace('Fernhill Lending, product definition', 'T</style><script>alert(1)</script>')}---\n\n# One\n`.replace('status: Draft', 'status: "say \\"hi\\""'), 'docs/D1.md');
  const bad = html(hostile);
  assert.ok(!bad.includes('</style><script>'));
  assert.ok(!bad.includes('<script>'));
  const fr = html(make('# Un\n', { head: 'language: fr\n' }));
  assert.match(fr, /counter\(page\) " sur " counter\(pages\)/);
});

test('the page size and margin come from the theme', () => {
  const doc = make('# One\n');
  const out = renderHtml(doc, { theme: { ...theme, page: { size: 'Letter', marginCm: 3 } }, labels: loadLabels('en'), figures: new Map() });
  assert.match(out, /@page\{size:Letter;margin:3cm;/);
});

test('the HTML is self-contained: every loaded resource is a data: URL, links stay links', () => {
  const doc = parseDocument(readFileSync(FIXTURE, 'utf8'), 'docs/D1.md');
  const figures = new Map(collectFigures(doc.blocks).map((b) => [b.id, png(1032, 600)]));
  const out = html(doc, figures);
  const srcs = [...out.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]);
  const urls = [...out.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1].replace(/^["']|["']$/g, ''));
  assert.ok(srcs.length >= 3, 'the figures are images');
  assert.ok(urls.length >= 4, 'the four font faces');
  for (const value of [...srcs, ...urls]) assert.ok(value.startsWith('data:'), `loaded resource is a data: URL: ${value.slice(0, 40)}`);
  assert.ok(![...out.matchAll(/href="([^"]*)"/g)].some((m) => m[1].startsWith('file:')), 'no file: link');
  assert.ok(out.includes('<a href="https://example.org/rules">rules</a>'), 'the external link is a plain link');
});

test('form feeds and line separators cannot break a margin-box string', () => {
  const doc = parseDocument(`${FM.replace('Fernhill Lending, product definition', 'Two\\fpart')}---\n\n# One\n`.replace('\\f', '\f'), 'docs/D1.md');
  assert.ok(doc.meta.title.includes('\f'));
  const out = html(doc);
  assert.match(out, /@top-left\{content:"Fernhill Lending \u00b7 Two part"/);
});

test('contents and list of figures entries are plain text even when the heading or caption has a link', () => {
  const doc = make('# See [the rules](https://example.org/r)\n\n![A [link](https://example.org/c) here](figures/a.png)\n');
  const out = html(doc, new Map([['fig-1', png()]]));
  const toc = out.match(/<nav class="contents">.*?<\/nav>/s)[0];
  assert.match(toc, /<li class="l1"><a href="#h_[^"]+">See the rules<\/a><\/li>/);
  assert.ok(!toc.includes('example.org'));
  const figs = out.match(/<nav class="figures">.*?<\/nav>/s)[0];
  assert.ok(!figs.includes('example.org'));
  assert.match(figs, /A link here/);
  // The heading itself keeps its link.
  assert.match(out, /<h1 id="[^"]+">See <a href="https:\/\/example\.org\/r">the rules<\/a><\/h1>/);
});

// ---------------------------------------------------------------------------------------------------------------
// PDF (Chromium)

const pageCount = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

function pdftext(pdf) {
  const dir = mkdtempSync(join(tmpdir(), 'recade-pdf-'));
  try {
    const file = join(dir, 'a.pdf');
    writeFileSync(file, pdf);
    return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' }).split('\f');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const hasPdftotext = (() => {
  try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

test('renderPdf returns an A4 PDF in Inter Tight, several pages for several sections', { skip }, async () => {
  const doc = make('# One\n\nFirst.\n\n# Two\n\nSecond.\n');
  const pdf = await withBrowser((browser) => renderPdf(doc, { theme, labels: loadLabels('en'), figures: new Map(), browser }));
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.match(pdf.toString('latin1'), /\/BaseFont\s*\/[A-Z]{6}\+InterTight/);
  // Cover, contents, two H1 sections: at least four pages.
  assert.ok(pageCount(pdf) >= 4, `pages: ${pageCount(pdf)}`);
  // A4 is 595.28 x 841.89 pt; Chromium rounds the page to its device units.
  assert.match(pdf.toString('latin1'), /\/MediaBox\s*\[\s*0\s+0\s+59[45]\.\d+\s+84[12]\.\d+\s*\]/);
});

test('renderPdf launches its own browser when none is given', { skip }, async () => {
  const pdf = await renderPdf(make('# One\n'), { theme, labels: loadLabels('en'), figures: new Map() });
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('running header and footer carry the DOCX texts and Chromium page numbers; the cover has none', { skip: skip || (!hasPdftotext && 'pdftotext is not installed') }, async () => {
  const doc = make('# One\n\nFirst.\n\n# Two\n\nSecond.\n');
  const pdf = await withBrowser((browser) => renderPdf(doc, { theme, labels: loadLabels('en'), figures: new Map(), browser }));
  const pages = pdftext(pdf);
  const total = pageCount(pdf);
  assert.ok(!/Page 1 of/.test(pages[0]), 'no footer on the cover');
  assert.ok(!pages[0].includes('v1.2'), 'no header on the cover');
  assert.match(pages[1], /Fernhill Lending · Fernhill Lending, product definition/);
  assert.match(pages[1], /v1\.2 · Draft/);
  assert.match(pages[1], new RegExp(`Page 2 of ${total}`));
  assert.match(pages[total - 1], new RegExp(`Page ${total} of ${total}`));
});

test('the Fernhill D1 fixture renders to a PDF with its figures', { skip }, async () => {
  const doc = parseDocument(readFileSync(FIXTURE, 'utf8'), 'docs/D1.md');
  const cacheDir = mkdtempSync(join(tmpdir(), 'recade-pdf-cache-'));
  try {
    const pdf = await withBrowser(async (browser) => {
      const figures = await renderFigures(doc, { browser, cacheDir, docDir: DOC_DIR, theme });
      return renderPdf(doc, { theme, labels: loadLabels(doc.meta.language), figures, browser });
    });
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(pageCount(pdf) >= 5, `pages: ${pageCount(pdf)}`);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('FR and fr-CA give a French root element and French labels', () => {
  for (const code of ['FR', 'fr-CA']) {
    const out = html(make('# Un\n', { head: `language: ${code}\n` }));
    assert.match(out, /<html lang="fr">/, code);
    assert.match(out, />Sommaire</, code);
  }
});
