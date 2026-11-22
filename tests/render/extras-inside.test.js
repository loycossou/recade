import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { chromiumStatus, withBrowser } from '../../src/render/browser.js';
import { allowRequest } from '../../src/render/figures.js';
import { printBoard, readDecisions, readReviews, renderExtras } from '../../src/render/extras.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/render/fernhill/', import.meta.url));
const skip = chromiumStatus().ok ? false : 'Chromium is not installed';

const DEC = `---
doc_id: "DEC-01"
title: "Q?"
project: "p"
version: "0.1"
date: "2026-11-18"
status: open
---

## Question

Q?

## Decision

> [!DECISION]
> Decided: not yet. Option: none. By: nobody. Date: none.
`;
const NOTE = '---\ndoc_id: REVIEW-X\ntitle: "A note"\nproject: P\nversion: "0.1"\ndate: "2026-11-18"\nstatus: final\n---\n\n# A note\n\nBody.\n';
const BOARD = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head><body><h1>${name}</h1></body></html>\n`;

function setup(t) {
  const base = mkdtempSync(join(tmpdir(), 'recade inside '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'project');
  const outside = join(base, 'outside');
  cpSync(FIXTURE, root, { recursive: true });
  mkdirSync(join(outside, 'decisions'), { recursive: true });
  mkdirSync(join(outside, 'reviews'), { recursive: true });
  mkdirSync(join(outside, 'directions'), { recursive: true });
  writeFileSync(join(outside, 'decisions', 'DEC-01.md'), DEC);
  writeFileSync(join(outside, 'reviews', 'n.md'), NOTE);
  writeFileSync(join(outside, 'directions', 'a.html'), BOARD('A'));
  writeFileSync(join(outside, 'STACK.md'), '---\ndoc_id: STACK\ntitle: T\nproject: P\nversion: "1"\ndate: 2026-11-18\nstatus: draft\n---\n\n## 5. Weighted matrix\n\n| A | B |\n|---|---|\n| 1 | 2 |\n');
  return { base, root, outside };
}

test('a decisions, reviews or design folder that is a link out of the project is read as missing', async (t) => {
  const { root, outside } = setup(t);
  mkdirSync(join(root, 'docs'), { recursive: true });
  symlinkSync(join(outside, 'decisions'), join(root, 'decisions'));
  symlinkSync(join(outside, 'reviews'), join(root, 'docs', 'reviews'));
  mkdirSync(join(root, 'design'), { recursive: true });
  symlinkSync(join(outside, 'directions'), join(root, 'design', 'directions'));
  symlinkSync(join(outside, 'STACK.md'), join(root, 'docs', 'STACK.md'));
  assert.deepEqual(readDecisions(root).entries, []);
  assert.deepEqual(readReviews(root).notes, []);
  const result = await renderExtras(root, ['stack', 'decisions', 'design', 'reviews']);
  assert.deepEqual(result.outputs, []);
  assert.equal(result.warnings.length, 4);
});

test('a references.md that is a link out of the project, or sits in a design folder that is one, is read as missing', async (t) => {
  const { root, outside } = setup(t);
  const text = '---\ndoc_id: REFERENCES\ntitle: T\nproject: P\nversion: "1.0"\ndate: 2026-11-18\nstatus: Register\n---\n\n## Picks\n\nNone.\n';
  writeFileSync(join(outside, 'references.md'), text);
  mkdirSync(join(root, 'design'), { recursive: true });
  symlinkSync(join(outside, 'references.md'), join(root, 'design', 'references.md'));
  let result = await renderExtras(root, ['design']);
  assert.deepEqual(result.outputs, []);
  rmSync(join(root, 'design'), { recursive: true });
  mkdirSync(join(outside, 'design'), { recursive: true });
  writeFileSync(join(outside, 'design', 'references.md'), text);
  symlinkSync(join(outside, 'design'), join(root, 'design'));
  result = await renderExtras(root, ['design']);
  assert.deepEqual(result.outputs, []);
  assert.equal(existsSync(join(root, 'docs', 'deliverables')), false);
});

test('a whole docs folder that is a link out of the project is read as missing', async (t) => {
  const { root, outside } = setup(t);
  rmSync(join(root, 'docs'), { recursive: true });
  mkdirSync(join(outside, 'docs'));
  cpSync(join(outside, 'reviews'), join(outside, 'docs', 'reviews'), { recursive: true });
  cpSync(join(outside, 'STACK.md'), join(outside, 'docs', 'STACK.md'));
  symlinkSync(join(outside, 'docs'), join(root, 'docs'));
  const result = await renderExtras(root, ['stack', 'reviews']);
  assert.deepEqual(result.outputs, []);
  assert.equal(result.warnings.length, 2);
});

test('a link to a folder inside the project is still read', (t) => {
  const { root } = setup(t);
  mkdirSync(join(root, 'real-decisions'));
  writeFileSync(join(root, 'real-decisions', 'DEC-01.md'), DEC);
  symlinkSync(join(root, 'real-decisions'), join(root, 'decisions'));
  assert.equal(readDecisions(root).entries.length, 1);
});

test('allowRequest lets data URLs and project files through, and nothing else', (t) => {
  const { root, outside } = setup(t);
  writeFileSync(join(outside, 'secret'), 'x');
  writeFileSync(join(root, 'ok.png'), 'x');
  symlinkSync(join(outside, 'secret'), join(root, 'linked'));
  assert.equal(allowRequest('data:text/css,a{}', root), true);
  assert.equal(allowRequest(pathToFileURL(join(root, 'ok.png')).href, root), true);
  assert.equal(allowRequest(pathToFileURL(join(root, 'not-there.png')).href, root), true);
  assert.equal(allowRequest(pathToFileURL(join(outside, 'secret')).href, root), false);
  assert.equal(allowRequest(pathToFileURL(join(root, '..', 'outside', 'secret')).href, root), false);
  assert.equal(allowRequest(pathToFileURL(join(root, 'linked')).href, root), false);
  assert.equal(allowRequest('http://127.0.0.1/x', root), false);
  assert.equal(allowRequest('https://example.com/', root), false);
  assert.equal(allowRequest('ws://127.0.0.1/', root), false);
  assert.equal(allowRequest('file://not a url', root), false);
});

test('printBoard opens a context with JavaScript off and the network off, and only lets project files through', async (t) => {
  const { root, outside } = setup(t);
  writeFileSync(join(outside, 'secret'), 'x');
  const seen = {};
  const page = {
    goto: async (url) => { seen.url = url; },
    evaluate: async () => undefined,
    pdf: async () => Buffer.from('%PDF-'),
  };
  const context = {
    route: async (_glob, handler) => { seen.handler = handler; },
    newPage: async () => page,
    close: async () => { seen.closed = true; },
  };
  const browser = { newContext: async (options) => { seen.options = options; return context; } };
  const board = join(root, 'board.html');
  writeFileSync(board, BOARD('B'));
  await printBoard(browser, board, root);
  assert.equal(seen.options.javaScriptEnabled, false);
  assert.equal(seen.options.offline, true);
  assert.equal(seen.closed, true);
  const verdict = (url) => {
    let result;
    seen.handler({ request: () => ({ url: () => url }), continue: () => { result = 'continue'; }, abort: () => { result = 'abort'; } });
    return result;
  };
  assert.equal(verdict(pathToFileURL(board).href), 'continue');
  assert.equal(verdict(pathToFileURL(join(outside, 'secret')).href), 'abort');
  assert.equal(verdict('http://127.0.0.1/'), 'abort');
});

test('a board that reaches for the network or for a file outside the project still prints, and reaches nothing', { skip }, async (t) => {
  const { root, outside } = setup(t);
  let hits = 0;
  const server = createServer((req, res) => { hits += 1; res.end('x'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  writeFileSync(join(outside, 'secret.txt'), 'SECRET');
  mkdirSync(join(root, 'design', 'directions'), { recursive: true });
  const html = `<!doctype html><html><body><h1>Board</h1>
<img src="http://127.0.0.1:${port}/img"><iframe src="${pathToFileURL(join(outside, 'secret.txt')).href}"></iframe>
<script>fetch('http://127.0.0.1:${port}/f'); new WebSocket('ws://127.0.0.1:${port}/w');</script></body></html>`;
  writeFileSync(join(root, 'design', 'directions', 'x.html'), html);
  const out = await renderExtras(root, ['design']);
  assert.deepEqual(out.outputs.map((f) => f.split('/').at(-1)), ['DESIGN_X.pdf']);
  assert.equal(readFileSync(out.outputs[0]).subarray(0, 5).toString(), '%PDF-');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(hits, 0);
});

test('a board that needs no script prints with JavaScript off', { skip }, async (t) => {
  const { root } = setup(t);
  const board = join(root, 'b.html');
  writeFileSync(board, BOARD('Plain'));
  const bytes = await withBrowser((browser) => printBoard(browser, board, root));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
});

test('two boards whose names differ only by case are refused with a clear message, and nothing is written', async (t) => {
  const { root } = setup(t);
  mkdirSync(join(root, 'design', 'directions'), { recursive: true });
  writeFileSync(join(root, 'design', 'directions', 'x.html'), BOARD('x'));
  writeFileSync(join(root, 'design', 'directions', 'X.HTML'), BOARD('X'));
  await assert.rejects(
    renderExtras(root, ['design']),
    (err) => /^design\/directions holds x\.html and X\.HTML, which would both write DESIGN_X\.pdf\. Rename one\.$/.test(err.message),
  );
  assert.equal(existsSync(join(root, 'docs', 'deliverables')), false);
});

test('the heading of a decision escapes a pipe in its id', async () => {
  const { decisionRegisterMarkdown } = await import('../../src/render/extras.js');
  const entry = { id: 'DEC|01', question: 'Q?', status: 'open', document: '', due: '', options: [], recommendation: '', chosen: 'none yet', decidedBy: '', date: '' };
  const md = decisionRegisterMarkdown([entry], { project: 'P', date: '2026-11-21', language: 'en' });
  assert.match(md, /^## DEC\\\|01: Q\?$/m);
});
