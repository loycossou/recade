import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { parseDocument } from '../../src/render/parse.js';
import { loadLabels, loadTheme } from '../../src/render/theme.js';
import { headingParts, matchSections, parseStory, storyFileOf } from '../../src/render/story.js';
import { dossierEntry, renderDossier, renderIndex } from '../../src/render/dossier.js';
import { renderDocx } from '../../src/render/docx.js';
import { renderFiles } from '../../src/render/pipeline.js';

const theme = loadTheme(null);
const EM = String.fromCharCode(0x2014);
const DOC = `---
doc_id: D1
title: Fernhill Lending, Functional Specifications
project: Fernhill Lending
version: "0.1"
date: 2026-11-18
status: draft
language: en
---

## 1. Purpose

This document says what the loan desk does.

## 2. Loans

Loans are on paper today.

| ID | Requirement |
|---|---|
| FR-LND-01 | A volunteer can register a loan |

## Annex A. Glossary

Desk: the counter.
`;

const STORY = `kicker: Functional specifications
lede: A desk screen that says which tool is where.
facts:
  - { label: Members, value: about 300 }
  - { label: Phase 1, value: 2026-12-28 }
recap:
  - "**Lost tools.** One tool in ten disappears each year."
  - "**One screen.** Volunteers use it on Saturdays."
  - "**Never lent twice.** A loan has one tool (FR-LND-01)."
decisions:
  - { decision: No online booking, why: The desk comes first. }
sections:
  - section: 2
    image: "A cloakroom ticket: one coat, one hook."
    stats:
      - { value: "1", label: requirement }
    before_after:
      - { before: Paper sheet, after: Loan record }
`;

const doc = () => parseDocument(DOC, 'docs/D1.md');
const labels = loadLabels('en');

// ---------------------------------------------------------------------------------------------------------------
// The companion parser

test('the companion sits next to its document', () => {
  assert.equal(storyFileOf(join('w', 'docs', 'D1.md')), join('w', 'docs', 'D1.story.yaml'));
  assert.equal(storyFileOf(join('w', 'docs', 'D1.fr.md')), join('w', 'docs', 'D1.fr.story.yaml'));
});

test('a companion is parsed into runs, with no warning when it fits', () => {
  const { story, warnings } = parseStory(STORY, 'docs/D1.story.yaml');
  assert.deepEqual(warnings, []);
  assert.equal(story.recap.length, 3);
  assert.equal(story.facts[1].value[0].text, '2026-12-28');
  assert.ok(story.recap[0].some((r) => r.bold && r.text === 'Lost tools.'));
  assert.equal(story.sections[0].key, '2');
  assert.equal(story.sections[0].stats.length, 1);
  assert.equal(story.decisions.length, 1);
});

test('a companion that is not YAML is a warning, never an error', () => {
  const { story, warnings } = parseStory('kicker: [unclosed', 'docs/D1.story.yaml');
  assert.equal(story, null);
  assert.equal(warnings[0].rule, 'story-invalid');
  assert.equal(warnings[0].severity, 'warn');
});

test('unknown keys, wrong types and sizes over the limits are warnings', () => {
  const long = Array.from({ length: 50 }, () => 'word').join(' ');
  const { story, warnings } = parseStory(`kicker: Hello\ncolour: red\nrecap: [one]\nlede: ${long}\nfacts: nope\n`, 'x.yaml');
  const rules = warnings.map((w) => w.rule).sort();
  assert.ok(rules.includes('story-unknown-key'));
  assert.ok(rules.includes('story-invalid'));
  assert.ok(rules.filter((r) => r === 'story-size').length >= 2, 'the lede is too long and the recap too short');
  assert.equal(story.facts.length, 0);
  assert.ok(story.lede, 'a long lede is kept, with its warning');
});

test('a section key matches the number or the text of a main heading', () => {
  assert.deepEqual(headingParts('2. Context'), { number: '2', title: 'Context' });
  assert.deepEqual(headingParts('Annex A. Glossary'), { number: 'A', title: 'Glossary' });
  assert.deepEqual(headingParts('Backlog'), { number: null, title: 'Backlog' });
  const { story } = parseStory('sections:\n  - { section: Loans, image: one }\n  - { section: "A", image: two }\n  - { section: 9, image: three }\n', 'x.yaml');
  const { bySection, warnings } = matchSections(story, [{ text: '1. Purpose' }, { text: '2. Loans' }, { text: 'Annex A. Glossary' }], 'x.yaml');
  assert.equal(bySection[0], null);
  assert.equal(bySection[1].key, 'Loans');
  assert.equal(bySection[2].key, 'A');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].rule, 'story-section');
});

// ---------------------------------------------------------------------------------------------------------------
// The dossier

test('with a companion, the dossier has the kicker, the lede, the facts, the recap, the image and the tiles', () => {
  const { story } = parseStory(STORY, 'docs/D1.story.yaml');
  const { html, warnings } = renderDossier(doc(), { theme, labels, story });
  assert.deepEqual(warnings, []);
  assert.match(html, /<p class="kicker">Functional specifications<\/p>/);
  assert.match(html, /<h1 class="title">Fernhill Lending, Functional Specifications<\/h1>/);
  assert.match(html, /<p class="lede">A desk screen/);
  assert.match(html, /Members <b>about 300<\/b>/);
  assert.match(html, /The recap in 3 sentences/);
  assert.match(html, /<ol class="recap">/);
  assert.match(html, /The decisions that matter/);
  assert.match(html, /<div class="image"><span class="tag">The image<\/span><p>A cloakroom ticket/);
  assert.match(html, /The real thing/);
  assert.match(html, /<div class="stats">/);
  assert.match(html, /<table class="ba">/);
  assert.match(html, /How to read\./);
  // The image comes before the real text of its section, numbered 02.
  const sec = html.slice(html.indexOf('<span class="num">02</span>'));
  assert.ok(sec.indexOf('class="image"') < sec.indexOf('Loans are on paper'));
  assert.match(html, /<span class="id">FR-LND-01<\/span>/);
});

test('without a companion, the dossier still renders, with a plainer header and no recap', () => {
  const { html } = renderDossier(doc(), { theme, labels, story: null });
  assert.match(html, /<p class="kicker">D1 · Fernhill Lending<\/p>/);
  assert.match(html, /Version <b>0\.1<\/b>/);
  assert.doesNotMatch(html, /class="lede"/);
  assert.doesNotMatch(html, /class="recap"/);
  assert.doesNotMatch(html, /class="image"/);
  assert.match(html, /<span class="num">01<\/span><h2>Purpose<\/h2>/);
  assert.match(html, /<span class="num">A<\/span><h2>Glossary<\/h2>/);
  assert.match(html, /<details class="about">/);
});

test('the dossier fetches nothing from the network and has a light and a dark theme', () => {
  const { story } = parseStory(STORY, 'x.yaml');
  const { html } = renderDossier(doc(), { theme, labels, story });
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /(src|href)="https?:/i);
  assert.doesNotMatch(html, /url\(\s*["']?https?:/i);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /\[data-theme="dark"\]/);
  assert.match(html, /data-toggle-theme/);
  assert.ok(!html.includes(EM), 'no em dash in the page');
});

test('the dossier takes the colours of the project theme', () => {
  const custom = { ...theme, color: { ...theme.color, accent: 'A8431F', heading: 'A8431F' } };
  const { html } = renderDossier(doc(), { theme: custom, labels, story: null });
  assert.match(html, /--accent:#A8431F/);
});

test('the dossier speaks the document language', () => {
  const fr = parseDocument(DOC.replace('language: en', 'language: fr'), 'docs/D1.fr.md');
  const { story } = parseStory(STORY, 'x.yaml');
  const { html } = renderDossier(fr, { theme, labels: loadLabels('fr'), story });
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /Le récap en 3 phrases/);
  assert.match(html, /Le vrai/);
});

test('the index lists the dossiers in document order with the files beside each', () => {
  const d1 = renderDossier(doc(), { theme, labels, story: parseStory(STORY, 'x').story }).html;
  const plan = renderDossier(parseDocument(DOC.replace('doc_id: D1', 'doc_id: PLAN'), 'docs/PLAN.md'), { theme, labels }).html;
  assert.equal(dossierEntry(d1).lede, 'A desk screen that says which tool is where.');
  assert.equal(dossierEntry('<html></html>'), null);
  const html = renderIndex([
    { file: 'PLAN.html', entry: dossierEntry(plan), others: ['PLAN.docx', 'PLAN.xlsx'] },
    { file: 'D1.html', entry: dossierEntry(d1), others: ['D1.docx'] },
  ], { theme, labels });
  assert.ok(html.indexOf('href="D1.html"') < html.indexOf('href="PLAN.html"'));
  assert.match(html, /href="PLAN.xlsx">XLSX</);
  assert.match(html, /<h1 class="title">Fernhill Lending<\/h1>/);
});

// ---------------------------------------------------------------------------------------------------------------
// The render command

function workspace(t, { story = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade dossier '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(root, 'recade'), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), 'version: 1\nmode: scratch\nphase: 0\ngates: {}\nlanguages:\n  deliverables: [en]\nlots: []\n');
  writeFileSync(join(root, 'docs', 'D1.md'), DOC);
  writeFileSync(join(root, 'docs', 'D2.md'), DOC.replace('doc_id: D1', 'doc_id: D2').replace('FR-LND-01', 'NFR-01'));
  if (story) writeFileSync(join(root, 'docs', 'D1.story.yaml'), STORY);
  return root;
}
const D1 = 'D1_Functional-Specifications';
const D2 = 'D2_Functional-Specifications';
const INDEX = 'INDEX_The-Project-Documents.html';
const noBrowser = () => { throw new Error('the browser must not launch'); };

test('the render writes a dossier for each document and one index, with and without a companion', async (t) => {
  const root = workspace(t);
  const { outputs } = await renderFiles([join(root, 'docs', 'D1.md'), join(root, 'docs', 'D2.md')], { formats: ['docx', 'html'], check: false, withBrowser: noBrowser });
  const out = join(root, 'docs', 'deliverables');
  assert.deepEqual(readdirSync(out).filter((f) => f !== '.recade-rendered.json').sort(), [D1 + '.docx', D1 + '.html', D2 + '.docx', D2 + '.html', INDEX].sort());
  assert.ok(outputs.includes(join(out, INDEX)));
  assert.match(readFileSync(join(out, D1 + '.html'), 'utf8'), /class="recap"/);
  assert.doesNotMatch(readFileSync(join(out, D2 + '.html'), 'utf8'), /class="recap"/);
  const index = readFileSync(join(out, INDEX), 'utf8');
  assert.match(index, new RegExp(`href="${D1}.html"`));
  assert.match(index, new RegExp(`href="${D2}.html"`));
  assert.match(index, new RegExp(`href="${D1}.docx">DOCX<`));
});

test('a later render of one document keeps the other dossiers in the index', async (t) => {
  const root = workspace(t);
  await renderFiles([join(root, 'docs', 'D2.md')], { formats: ['html'], check: false, withBrowser: noBrowser });
  await renderFiles([join(root, 'docs', 'D1.md')], { formats: ['html'], check: false, withBrowser: noBrowser });
  const index = readFileSync(join(root, 'docs', 'deliverables', INDEX), 'utf8');
  assert.match(index, new RegExp(`href="${D1}.html"`));
  assert.match(index, new RegExp(`href="${D2}.html"`));
});

test('--format without html writes no dossier and no index', async (t) => {
  const root = workspace(t);
  await renderFiles([join(root, 'docs', 'D1.md')], { formats: ['docx'], check: false, withBrowser: noBrowser });
  assert.ok(!existsSync(join(root, 'docs', 'deliverables', INDEX)));
});

test('an em dash in the companion stops the render like one in the document', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'docs', 'D1.story.yaml'), `kicker: Specs ${EM} first draft\n`);
  await assert.rejects(
    renderFiles([join(root, 'docs', 'D1.md')], { formats: ['html'], withBrowser: noBrowser }),
    (err) => err.findings.some((f) => f.rule === 'em-dash' && f.file === 'docs/D1.story.yaml'),
  );
  assert.ok(!existsSync(join(root, 'docs', 'deliverables')));
});

test('a broken companion is a warning and the dossier renders without it', async (t) => {
  const root = workspace(t);
  writeFileSync(join(root, 'docs', 'D1.story.yaml'), 'kicker: [unclosed\n');
  const { findings } = await renderFiles([join(root, 'docs', 'D1.md')], { formats: ['html'], check: false, withBrowser: noBrowser });
  assert.ok(findings.some((f) => f.rule === 'story-invalid' && f.file === 'docs/D1.story.yaml'));
  assert.doesNotMatch(readFileSync(join(root, 'docs', 'deliverables', D1 + '.html'), 'utf8'), /class="recap"/);
});

test('each language gets its own index page, named through the deliverable helper, and a dossier links its own', async (t) => {
  const root = workspace(t, { story: false });
  writeFileSync(join(root, 'docs', 'D1.fr.md'), DOC.replace('language: en', 'language: fr').replace('Functional Specifications', 'Spécifications fonctionnelles'));
  await renderFiles([join(root, 'docs', 'D1.md'), join(root, 'docs', 'D1.fr.md')], { formats: ['html'], check: false, withBrowser: noBrowser });
  const out = join(root, 'docs', 'deliverables');
  assert.deepEqual(readdirSync(out).filter((f) => f !== '.recade-rendered.json').sort(), [D1 + '.html', 'D1_Specifications-Fonctionnelles.html', 'INDEX_Les-Documents-du-Projet.html', INDEX].sort());
  assert.match(readFileSync(join(out, 'D1_Specifications-Fonctionnelles.html'), 'utf8'), /class="brand" href="INDEX_Les-Documents-du-Projet.html"/);
  assert.match(readFileSync(join(out, D1 + '.html'), 'utf8'), new RegExp(`class="brand" href="${INDEX}"`));
  const fr = readFileSync(join(out, 'INDEX_Les-Documents-du-Projet.html'), 'utf8');
  assert.ok(fr.indexOf('D1_Specifications-Fonctionnelles.html') < fr.indexOf(`${D1}.html`), 'the French dossiers come first');
});

// ---------------------------------------------------------------------------------------------------------------
// The Word file

const texts = (xml) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);

test('the Word cover reads kicker, title, lede and facts before the metadata table, and the recap comes before the contents', async () => {
  const { story } = parseStory(STORY, 'x.yaml');
  const zip = await JSZip.loadAsync(await renderDocx(doc(), { theme, labels, story }));
  const xml = await zip.file('word/document.xml').async('string');
  const all = texts(xml);
  const at = (s) => all.findIndex((t) => t.includes(s));
  assert.ok(at('Functional specifications') >= 0);
  assert.ok(at('Functional specifications') < at('Fernhill Lending, Functional Specifications'));
  assert.ok(at('Fernhill Lending, Functional Specifications') < at('A desk screen'));
  assert.ok(at('A desk screen') < at('about 300'));
  assert.ok(at('about 300') < all.indexOf('Document'), 'the metadata table follows');
  assert.ok(at('The recap in 3 sentences') > all.indexOf('Document'));
  assert.ok(at('The recap in 3 sentences') < xml.length);
  assert.ok(xml.indexOf('The recap in 3 sentences') < xml.indexOf('w:fldChar'), 'the recap comes before the table of contents');
  assert.ok(at('The image') > at('Loans'), 'the image follows its heading');
  assert.ok(at('The image') < at('Loans are on paper'));
  assert.ok(at('The real thing') < at('Loans are on paper'));
});

test('without a companion the Word cover starts with a kicker and the title, and has no recap', async () => {
  const zip = await JSZip.loadAsync(await renderDocx(doc(), { theme, labels }));
  const all = texts(await zip.file('word/document.xml').async('string'));
  assert.ok(all.indexOf('D1 · Fernhill Lending') >= 0);
  assert.ok(all.indexOf('D1 · Fernhill Lending') < all.indexOf('Fernhill Lending, Functional Specifications'));
  assert.ok(!all.some((t) => t.includes('The recap')));
  assert.ok(!all.some((t) => t.includes('The image')));
});

test('the dossier sets the whole page in Inter Tight, embeds its faces, and falls back to Arial', async () => {
  const { dossierCss } = await import('../../src/render/dossier.js');
  const css = dossierCss({ font: { family: 'Inter Tight', fallback: 'Arial' }, color: {} });
  assert.match(css, /--sans:"Inter Tight", Arial, sans-serif/);
  assert.match(css, /--serif:"Inter Tight", Arial, sans-serif/);
  assert.doesNotMatch(css, /Georgia|Charter|Cambria/);
});

test('the stylesheet keeps monospace for code only: chips, labels, numbers, IDs and links are in Inter Tight', () => {
  const css = readFileSync(new URL('../../render/dossier.css', import.meta.url), 'utf8');
  const rules = css.split('\n').filter((l) => l.includes('var(--mono)'));
  assert.deepEqual(rules.map((l) => l.split('{')[0]), ['code', 'pre']);
  for (const sel of ['.navlinks a', '.toggle', '.chips li', '.num', '.id', '.recap .n', '.stat .l', 'td.idcol', '.files a']) {
    const rule = css.split('\n').find((l) => l.startsWith(`${sel}{`));
    assert.ok(rule, sel);
    assert.match(rule, /font-family:var\(--sans\)/, sel);
  }
  for (const sel of ['.num', '.id', '.recap .n', 'td.idcol']) assert.match(css.split('\n').find((l) => l.startsWith(`${sel}{`)), /font-variant-numeric:tabular-nums/, sel);
});
