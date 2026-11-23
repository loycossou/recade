import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { run } from '../../src/cli.js';
import { chosenBoard, contrast, clip, decodePng, deckContent, deckPalette, displayName, findLogo, imageColours, prepareSlides } from '../../src/render/deck.js';
import { chromiumStatus } from '../../src/render/browser.js';
import { readDecisions } from '../../src/render/extras.js';
import { loadLabels, loadTheme } from '../../src/render/theme.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/render/fernhill/', import.meta.url));
const EM = String.fromCharCode(0x2014);
const skip = chromiumStatus().ok ? false : 'Chromium is not installed';
const ORANGE = 'E4572E';
const TEAL = '17BEBB';

/** A CRC-32 table, for the PNG chunks of the test logo. */
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/** An RGB PNG, the left part in `left` and the right part in `right`, each row with a different filter. */
function twoColourPng(width, height, left, right, split = 0.6) {
  const [l, r] = [left, right].map((hex) => [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)));
  const rows = [];
  for (let y = 0; y < height; y++) {
    const pixels = [];
    for (let x = 0; x < width; x++) pixels.push(...(x < width * split ? l : r));
    const filter = y % 2; // 0 none, 1 sub
    const line = Buffer.from(pixels);
    if (filter === 1) for (let i = line.length - 1; i >= 3; i--) line[i] = (line[i] - line[i - 3]) & 255;
    rows.push(Buffer.from([filter]), line);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const FRONT = (id, title) => `---
doc_id: ${id}
title: Fernhill Lending, ${title}
project: Fernhill Lending
version: "1.0"
date: 2026-11-13
status: Draft
language: en
---
`;

const D2 = `${FRONT('D2', 'technical architecture')}
## 1. Context, containers and boundaries

One small server at the desk keeps the loans, and members reach it from their phones.

![Context of the desk](figures/context.png)

## 2. Data

| Store | Kind |
|---|---|
| Loans | SQLite file |
`;

const D3 = `${FRONT('D3', 'security requirements')}
## 1. Security decisions

| ID | Decision |
|---|---|
| SEC-01 | Members sign in with a one-time link |
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
---

# DEC-0${n}: ${question}

## Question

${question}

## Options

### Option A: JSON file

| Item | Value |
|---|---|
| Cost | None |

## Decision

> [!DECISION]
> ${decided}
`;

const PROVISIONALS = `---
doc_id: PROVISIONALS
title: "Fernhill Lending, provisional values"
project: "Fernhill Lending"
version: "0.1"
date: "2026-11-13"
status: open
language: "en"
---

## Open

| ID | What | Why it is provisional | Assumption used | Who gives the real one | Due |
|---|---|---|---|---|---|
| PRV-03 | Late fee amount | The board has not voted | 1 per day | Board | 2026-12-01 |

## Closed

| ID | What | Real value | Closed on | Replaced in |
|---|---|---|---|---|
`;

const LOTS = `## Lots

| Code | Lot | Goal |
|---|---|---|
| CAT | Catalogue | Every tool has a record and a photo |
| LOA | Loans | A member borrows and returns a tool |
| MEM | Members | A neighbour signs up at the desk |
| DSK | Desk | Volunteers run a shift without help |
| REP | Reports | The board reads one report a month |

`;

/** A temp copy of the Fernhill project, with every source of the deck unless `full` is false. */
function project(t, { full = true, language = 'en' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'recade deck '));
  const root = join(base, 'fern hill');
  cpSync(FIXTURE, root, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const put = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  if (language !== 'en') {
    const state = readFileSync(join(root, 'recade', 'state.yaml'), 'utf8');
    put('recade/state.yaml', state.replace('deliverables: [en]', `deliverables: [${language}]`));
  }
  if (!full) return root;
  put('docs/D1.story.yaml', [
    'kicker: A tool library for the street',
    'lede: Neighbours borrow tools from a Saturday desk instead of buying them.',
    'facts:',
    '  - { label: tools on the shelves, value: "140" }',
    '  - { label: opening day, value: 2026-12-28 }',
    'recap:',
    '  - Members borrow a tool for seven days.',
    '  - Volunteers run the desk on Saturdays.',
    '  - The board votes the late fee.',
    'sections:',
    '  - section: Scope',
    '    stats:',
    '      - { value: "4", label: volunteers per shift }',
    '',
  ].join('\n'));
  put('docs/D2.md', D2);
  writeFileSync(join(root, 'docs', 'figures', 'context.png'), twoColourPng(40, 20, '2F6FD0', 'F2F2F2'));
  put('docs/D3.md', D3);
  put('docs/D3.story.yaml', 'recap:\n  - Sign-in is a one-time link.\n  - No password is stored.\n  - The desk tablet locks itself.\n');
  const plan = readFileSync(join(root, 'docs', 'PLAN.md'), 'utf8');
  put('docs/PLAN.md', plan.replace('## 1. Summary', `${LOTS}## 1. Summary`));
  put('decisions/DEC-01.md', DEC(1, { status: 'closed', question: 'Where does the desk store its data?', decided: 'Decided: yes. Option: A (JSON file). By: owner. Date: 2026-11-18.' }));
  put('decisions/DEC-02.md', DEC(2, { status: 'open', question: 'Which server runs the desk?', decided: 'Decided: not yet. Option: none. By: nobody. Date: none.' }));
  put('intake/provisionals.md', PROVISIONALS);
  writeFileSync(join(root, 'design', 'logo.png'), twoColourPng(60, 20, ORANGE, TEAL));
  return root;
}

async function cli(t, root, deck, extras = []) {
  const cfg = mkdtempSync(join(tmpdir(), 'recade deck cfg '));
  t.after(() => rmSync(cfg, { recursive: true, force: true }));
  writeFileSync(join(cfg, 'config.yaml'), `deliverables:\n  extras: [${extras.join(', ')}]\n${deck === undefined ? '' : `  deck: "${deck}"\n`}`);
  const out = [];
  const err = [];
  const code = await run(['render', 'extras', '--project', root], {
    stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
    cwd: tmpdir(), env: { ...process.env, RECADE_CONFIG_DIR: cfg },
  });
  return { code, out: out.join(''), err: err.join('') };
}

const deliverables = (root) => (existsSync(join(root, 'docs', 'deliverables')) ? readdirSync(join(root, 'docs', 'deliverables')).sort() : []);

/** The XML of every slide of a pptx, in order. */
async function slidesOf(file) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));
  return { zip, slides: await Promise.all(names.map((n) => zip.file(n).async('string'))) };
}
const textOf = (xml) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ');

test('deckContent: a title, three parts with their dividers, and every slide of a full project, with no warning', (t) => {
  const root = project(t);
  const { slides, warnings } = deckContent(root, {
    project: 'Fernhill Lending', date: '2026-11-23', labels: loadLabels('en').deck, decisions: readDecisions(root),
  });
  assert.deepEqual(warnings, []);
  assert.deepEqual(slides.map((s) => s.kind), ['title', 'divider', 'context', 'stats', 'cards', 'divider', 'figure', 'steps', 'divider', 'timeline', 'decisions', 'risks', 'next']);
  const [title] = slides;
  assert.equal(title.kicker, 'A tool library for the street');
  assert.equal(title.lede, 'Neighbours borrow tools from a Saturday desk instead of buying them.');
  const plan = slides.find((s) => s.kind === 'timeline');
  assert.deepEqual(plan.lots.map((l) => l.name), ['Catalogue', 'Loans', 'Members', 'Desk', 'Reports']);
  assert.deepEqual(plan.lots.map((l) => l.estimate), ['3 pts', '6 pts', '3 pts', '2 pts', '3 pts']);
  const decisions = slides.find((s) => s.kind === 'decisions');
  assert.equal(decisions.closed, 1);
  assert.deepEqual(decisions.open.map((d) => d.id), ['DEC-02']);
  assert.equal(slides.find((s) => s.kind === 'risks').items[0].id, 'PRV-03');
  assert.equal(slides.find((s) => s.kind === 'next').gate, 'Next gate: G0, the intake');
  assert.equal(JSON.stringify(slides).includes(EM), false);
});

test('render extras writes DECK_Project-Overview.pptx with deliverables.deck yes, even with no other extra', async (t) => {
  const root = project(t);
  const { code, out, err } = await cli(t, root, 'yes');
  assert.equal(code, 0, err);
  assert.equal(err, '');
  assert.deepEqual(deliverables(root), ['DECK_Project-Overview.pptx']);
  assert.match(out, /Wrote .*DECK_Project-Overview\.pptx/);
  const file = join(root, 'docs', 'deliverables', 'DECK_Project-Overview.pptx');
  assert.equal(readFileSync(file).subarray(0, 2).toString(), 'PK');
  const { zip, slides } = await slidesOf(file);
  // The architecture is its text, then its figure on a slide of its own.
  assert.equal(slides.length, 14);
  assert.match(textOf(slides[0]), /Fernhill Lending/);
  const plan = textOf(slides[10]);
  for (const lot of ['Catalogue', 'Loans', 'Members', 'Desk', 'Reports']) assert.ok(plan.includes(lot), lot);
  for (const [n, xml] of slides.entries()) {
    assert.ok(xml.includes('typeface="Inter Tight"'), `slide ${n + 1}`);
    assert.equal(xml.includes('typeface="Calibri"'), false, `slide ${n + 1}`);
  }
  assert.match(await zip.file('ppt/theme/theme1.xml').async('string'), /<a:latin typeface="Inter Tight"/);
  assert.match(await zip.file('ppt/presentation.xml').async('string'), /<p:sldSz cx="12192000" cy="6858000"/);
});

test('the deck is coloured from the logo: a coloured title slide, three palette colours at least, the logo as a picture', async (t) => {
  const root = project(t);
  assert.equal(findLogo(root).rel, 'design/logo.png');
  const palette = deckPalette(root, loadTheme(root), imageColours(readFileSync(join(root, 'design', 'logo.png')), '.png'));
  assert.equal(palette.source, 'logo');
  assert.deepEqual(palette.colours.slice(0, 2), [ORANGE, TEAL]);
  assert.ok(palette.colours.length >= 4);
  assert.equal((await cli(t, root, 'yes')).code, 0);
  const { zip, slides } = await slidesOf(join(root, 'docs', 'deliverables', 'DECK_Project-Overview.pptx'));
  const background = /<p:bg>.*?<a:srgbClr val="([0-9A-F]{6})"/s.exec(slides[0])?.[1];
  assert.ok(background && background !== 'FFFFFF', `title background ${background}`);
  assert.ok(contrast(background, 'FFFFFF') >= 4.5, 'white text on the title slide reads at AA');
  const used = new Set(slides.flatMap((xml) => [...xml.matchAll(/srgbClr val="([0-9A-F]{6})"/g)].map((m) => m[1])));
  assert.ok(palette.colours.filter((c) => used.has(c)).length >= 3, [...used].join(' '));
  assert.ok(slides[0].includes('<p:pic>'), 'the logo is on the title slide');
  assert.ok(slides.filter((xml) => xml.includes('<p:pic>')).length >= 10, 'the logo is in a corner of the slides');
  assert.ok(Object.keys(zip.files).some((n) => /^ppt\/media\/.+\.png$/.test(n)));
  // The first figure of D2 has a slide of its own, after the text of the architecture.
  assert.match(textOf(slides[6]), /Architecture/);
  assert.match(textOf(slides[7]), /Architecture at a glance/);
  assert.ok(slides[7].split('<p:pic>').length - 1 >= 2, 'logo and figure on the figure slide');
  // Every content slide has a coloured title band over a tinted ground.
  for (const xml of slides.slice(2)) assert.match(xml, /<p:bg>/);
});

test('without a logo the palette comes from the art direction tokens, then from the render theme', (t) => {
  const root = project(t, { full: false });
  assert.equal(findLogo(root), null);
  const theme = loadTheme(root);
  assert.equal(deckPalette(root, theme).source, 'theme');
  assert.equal(deckPalette(root, theme).colours[0], '2F6FD0');
  writeFileSync(join(root, 'design', 'tokens.json'), JSON.stringify({ color: { brand: { primary: { $value: '#7A3E9D' } }, surface: { page: { $value: '#FFFFFF' } } } }));
  const fromTokens = deckPalette(root, theme);
  assert.equal(fromTokens.source, 'tokens');
  assert.equal(fromTokens.colours[0], '7A3E9D');
  assert.ok(fromTokens.colours.length >= 4);
  assert.equal(fromTokens.colours.includes('FFFFFF'), false);
});

test('an SVG logo gives its colours, and a PNG decodes with its filters', () => {
  assert.deepEqual(imageColours(Buffer.from('<svg><text fill="#2F6B3A">A</text><rect fill="#fff"/><path stroke="#c03"/></svg>'), '.svg'), ['2F6B3A', 'CC0033']);
  const image = decodePng(twoColourPng(10, 4, ORANGE, TEAL, 0.5));
  assert.deepEqual([image.width, image.height], [10, 4]);
  assert.deepEqual([...image.pixels.subarray(0, 3)], [0xe4, 0x57, 0x2e]);
  const last = (10 * 4 - 1) * 4;
  assert.deepEqual([...image.pixels.subarray(last, last + 4)], [0x17, 0xbe, 0xbb, 255]);
  assert.equal(decodePng(Buffer.from('not a png')), null);
});

test('deliverables.deck ask or no writes no deck and says so in one line', async (t) => {
  const root = project(t);
  for (const [deck, line] of [[undefined, /^No deck: deliverables\.deck is ask/m], ['ask', /^No deck: deliverables\.deck is ask/m], ['no', /^No deck: deliverables\.deck is no\. Turn it on with: recade config set deliverables\.deck yes$/m]]) {
    const { code, out, err } = await cli(t, root, deck);
    assert.equal(code, 0, err);
    assert.match(out, line);
    assert.deepEqual(deliverables(root), []);
  }
  const bad = await cli(t, root, 'maybe');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /deliverables\.deck in .* must be ask, yes, no/);
});

test('a missing source drops its slide with a Warning line, never a failure', async (t) => {
  const root = project(t, { full: false });
  const { code, out, err } = await cli(t, root, 'yes');
  assert.equal(code, 0, err);
  const warnings = err.trim().split('\n');
  for (const what of ['docs/D2.md', 'docs/D3.md', 'decisions/DEC-\\*\\.md', 'intake/provisionals\\.md']) {
    assert.ok(warnings.some((w) => new RegExp(`^Warning: deck: no ${what}, the slide ".+" is left out\\.$`).test(w)), what);
  }
  assert.match(out, /Wrote .*DECK_Project-Overview\.pptx/);
  const { slides } = await slidesOf(join(root, 'docs', 'deliverables', 'DECK_Project-Overview.pptx'));
  // Title, the project (context, scope), the delivery (the lots of the backlog, next steps): no technical part.
  assert.equal(slides.length, 7);
  assert.match(textOf(slides[5]), /Catalogue/);
  assert.match(textOf(slides[5]), /backlog items/);
});

test('the deck is named and written in the documents language, and the same sources give the same bytes', async (t) => {
  const root = project(t, { language: 'fr' });
  assert.equal((await cli(t, root, 'yes')).code, 0);
  assert.deepEqual(deliverables(root), ['DECK_Synthese-Du-Projet.pptx']);
  const file = join(root, 'docs', 'deliverables', 'DECK_Synthese-Du-Projet.pptx');
  const first = readFileSync(file);
  const { slides } = await slidesOf(file);
  assert.match(textOf(slides[1]), /Le projet/);
  assert.match(textOf(slides.at(-1)), /Prochaines étapes/);
  assert.equal((await cli(t, root, 'yes')).code, 0);
  assert.ok(readFileSync(file).equals(first), 'a second render gives the same bytes');
});

test('the deck goes next to the other extras', async (t) => {
  const root = project(t);
  const { code, err } = await cli(t, root, 'yes', ['decisions']);
  assert.equal(code, 0, err);
  assert.ok(deliverables(root).includes('DECK_Project-Overview.pptx'));
  assert.ok(deliverables(root).some((n) => n.startsWith('DECISIONS_')));
});

test('clip cuts at a word with an ellipsis, and contrast follows WCAG', () => {
  assert.equal(clip('short'), 'short');
  assert.equal(clip('one two three four five', 12), 'one two…');
  assert.equal(Math.round(contrast('FFFFFF', '000000')), 21);
});

test('the project is named as its documents write it, accents and capitals kept', (t) => {
  const root = project(t, { full: false });
  assert.equal(displayName(root, 'fern-hill'), 'Fernhill Lending');
  const d1 = readFileSync(join(root, 'docs', 'D1.md'), 'utf8');
  writeFileSync(join(root, 'docs', 'D1.md'), d1.replace('title: Fernhill Lending, product definition', 'title: "Potager partagé, spécifications"').replace('project: Fernhill Lending', 'project: potager-partage'));
  assert.equal(displayName(root, 'x'), 'Potager partagé');
  writeFileSync(join(root, 'docs', 'D1.md'), d1.replace('title: Fernhill Lending, product definition', 'title: "Something else, spécifications"').replace('project: Fernhill Lending', 'project: potager-partage'));
  assert.equal(displayName(root, 'x'), 'potager-partage');
});

test('the chosen board comes from the tokens, else from the directions README', (t) => {
  const root = project(t, { full: false });
  assert.equal(chosenBoard(root), null);
  mkdirSync(join(root, 'design', 'directions'), { recursive: true });
  writeFileSync(join(root, 'design', 'directions', 'ledger.html'), '<!doctype html><title>Ledger</title><h1>Ledger</h1>');
  writeFileSync(join(root, 'design', 'directions', 'README.md'), '# Directions\n\n## Chosen direction\n\n**ledger**, chosen by the owner.\n');
  assert.equal(chosenBoard(root).rel, 'design/directions/ledger.html');
  writeFileSync(join(root, 'design', 'tokens.json'), JSON.stringify({ $meta: { source: 'design/directions/../../secret.html' } }));
  assert.equal(chosenBoard(root).rel, 'design/directions/ledger.html', 'a source that leaves the folder is not taken');
});

test('prepareSlides drops a picture slide with no picture and renumbers the dividers', () => {
  const labels = loadLabels('en').deck;
  const slides = [
    { kind: 'title' }, { kind: 'divider', part: 'project', number: '01', title: 'P', items: [] }, { kind: 'picture', part: 'project', image: 'board', title: 'Look' },
    { kind: 'divider', part: 'tech', number: '02', title: 'T', items: [] }, { kind: 'figure', part: 'tech', image: 'architecture', title: 'Architecture', bullets: [] },
  ];
  const png = { bytes: Buffer.from('x'), width: 10, height: 5 };
  assert.deepEqual(prepareSlides(slides, {}, labels).map((s) => s.kind), ['title', 'divider', 'steps']);
  const both = prepareSlides(slides, { board: png, architecture: png }, labels);
  assert.deepEqual(both.map((s) => s.kind), ['title', 'divider', 'picture', 'divider', 'steps', 'picture']);
  assert.deepEqual(both[3].items, ['Architecture', 'Architecture at a glance']);
  assert.equal(prepareSlides(slides, {}, labels)[1].number, '01');
});

test('a chosen board gives a look and feel slide with its picture', { skip }, async (t) => {
  const root = project(t);
  mkdirSync(join(root, 'design', 'directions'), { recursive: true });
  writeFileSync(join(root, 'design', 'directions', 'ledger.html'), '<!doctype html><html><body style="background:#faf6ee"><h1>Ledger paper</h1></body></html>');
  writeFileSync(join(root, 'design', 'tokens.json'), JSON.stringify({ $meta: { source: 'design/directions/ledger.html' } }));
  const { code, err } = await cli(t, root, 'yes');
  assert.equal(code, 0, err);
  assert.equal(err, '');
  const { slides } = await slidesOf(join(root, 'docs', 'deliverables', 'DECK_Project-Overview.pptx'));
  const look = slides.find((xml) => textOf(xml).startsWith('Look and feel'));
  assert.ok(look && look.split('<p:pic>').length - 1 >= 2, 'the board and the logo');
});
