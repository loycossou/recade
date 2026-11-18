import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli.js';
import { chromiumStatus, withBrowser } from '../../src/render/browser.js';
import { renderFile, renderFiles } from '../../src/render/pipeline.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/render/fernhill/', import.meta.url));
const status = chromiumStatus();
const skip = status.ok ? false : `Chromium is not installed (${status.fix})`;
if (skip) console.log(`# pipeline tests needing Chromium are skipped: ${skip}`);
const NO_CHROMIUM = () => ({ ok: false, path: null, fix: 'npx --prefix "/plug in" playwright install chromium', detail: 'No Chromium executable reported' });

const EM = String.fromCharCode(0x2014);
const SMALL = (extra = '') => `---
doc_id: D2
title: Fernhill Lending, small note
project: Fernhill Lending
version: 1.0
date: 2026-11-13
status: Draft
---

# Note

Members borrow tools for 7 days. ${extra}
`;

/** A temp copy of the Fernhill project, in a folder whose name holds spaces. */
function project(t) {
  const base = mkdtempSync(join(tmpdir(), 'recade render '));
  const root = join(base, 'fern hill');
  cpSync(FIXTURE, root, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return root;
}

async function cli(args, { cwd, ...io } = {}) {
  const out = [];
  const err = [];
  const code = await run(['render', ...args], {
    stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
    cwd: cwd ?? tmpdir(), env: process.env, ...io,
  });
  return { code, out: out.join(''), err: err.join('') };
}

const deliverables = (root) => join(root, 'docs', 'deliverables');
const listDeliverables = (root) => (existsSync(deliverables(root)) ? readdirSync(deliverables(root)).sort() : []);
const isZip = (file) => readFileSync(file).subarray(0, 2).toString() === 'PK';
const isPdf = (file) => readFileSync(file).subarray(0, 5).toString() === '%PDF-';

// ---------------------------------------------------------------------------------------------------------------
// Rendering (Chromium needed: the Fernhill documents hold figures)

test('renders Fernhill D1 to D1.docx and D1.pdf in docs/deliverables', { skip }, async (t) => {
  const root = project(t);
  const { code, out, err } = await cli([join(root, 'docs', 'D1.md')]);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['D1.docx', 'D1.pdf']);
  assert.ok(isZip(join(deliverables(root), 'D1.docx')));
  assert.ok(isPdf(join(deliverables(root), 'D1.pdf')));
  assert.match(out, /D1\.docx/);
  assert.match(out, /D1\.pdf/);
});

test('PLAN.md also yields PLAN.xlsx', { skip }, async (t) => {
  const root = project(t);
  const { code, err } = await cli([join(root, 'docs', 'PLAN.md')]);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['PLAN.docx', 'PLAN.pdf', 'PLAN.xlsx']);
  assert.ok(isZip(join(deliverables(root), 'PLAN.xlsx')));
});

test('--format and --out pick the formats and the folder', { skip }, async (t) => {
  const root = project(t);
  const out = join(root, 'out folder');
  const { code, err } = await cli([join(root, 'docs', 'D1.md'), '--format', 'pdf', '--out', out]);
  assert.equal(code, 0, err);
  assert.deepEqual(readdirSync(out), ['D1.pdf']);
  assert.deepEqual(listDeliverables(root), []);
});

test('a second render overwrites the outputs and does not relaunch the browser for cached figures', { skip }, async (t) => {
  const root = project(t);
  const args = [join(root, 'docs', 'D1.md'), '--format', 'docx'];
  let launches = 0;
  const counting = (fn) => { launches += 1; return withBrowser(fn); };
  const first = await cli(args, { withBrowser: counting });
  assert.equal(first.code, 0, first.err);
  assert.equal(launches, 1);
  const docx = join(deliverables(root), 'D1.docx');
  writeFileSync(docx, 'stale');
  const second = await cli(args, { withBrowser: counting });
  assert.equal(second.code, 0, second.err);
  assert.equal(launches, 1, 'cached figures never touch the browser');
  assert.ok(isZip(docx), 'the stale file was replaced');
  assert.deepEqual(readdirSync(deliverables(root)), ['D1.docx'], 'no temp file is left behind');
});

test('figures and the PDF share one browser session', { skip }, async (t) => {
  const root = project(t);
  let launches = 0;
  const counting = (fn) => { launches += 1; return withBrowser(fn); };
  const { code, err } = await cli([join(root, 'docs', 'D1.md')], { withBrowser: counting });
  assert.equal(code, 0, err);
  assert.equal(launches, 1);
});

test('the figure cache lives in .recade-cache/figures and is added to an existing .gitignore only', { skip }, async (t) => {
  const root = project(t);
  const args = [join(root, 'docs', 'D1.md'), '--format', 'docx'];
  assert.equal((await cli(args)).code, 0);
  assert.ok(readdirSync(join(root, '.recade-cache', 'figures')).length > 0);
  assert.equal(existsSync(join(root, '.gitignore')), false, 'no .gitignore is created');

  writeFileSync(join(root, '.gitignore'), 'node_modules/');
  assert.equal((await cli(args)).code, 0);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\n.recade-cache/\n');
  assert.equal((await cli(args)).code, 0);
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), 'node_modules/\n.recade-cache/\n', 'not added twice');
});

test('a theme override under design/theme.json reaches the output', { skip }, async (t) => {
  const root = project(t);
  const { code, err } = await cli([join(root, 'docs', 'D1.md'), '--format', 'docx']);
  assert.equal(code, 0, err);
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(readFileSync(join(deliverables(root), 'D1.docx')));
  const xml = (await Promise.all(Object.keys(zip.files).filter((n) => n.endsWith('.xml')).map((n) => zip.file(n).async('string')))).join('');
  assert.match(xml, /2F6FD0/i);
});

// ---------------------------------------------------------------------------------------------------------------
// Checks stop the render before anything is written

test('an em dash in the source exits 1 and writes nothing', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'D1.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Members borrow tools', `Members ${EM} borrow tools`));
  const { code, out } = await cli([file]);
  assert.equal(code, 1);
  assert.match(out, /^docs\/D1\.md:\d+:\d+ em-dash /m);
  assert.deepEqual(listDeliverables(root), []);
  assert.equal(existsSync(join(root, '.recade-cache')), false);
});

test('an unknown ID exits 1 and writes nothing', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'D1.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Next steps are in D2.', 'Next steps are in D2, see FR-ZZZ-99.'));
  const { code, out, err } = await cli([file]);
  assert.equal(code, 1);
  assert.match(out, /^docs\/D1\.md:\d+:\d+ unknown-id FR-ZZZ-99 is not defined anywhere\.$/m);
  assert.equal(err.trim().split('\n').length, 1, 'one line on stderr');
  assert.deepEqual(listDeliverables(root), []);
});

test('only findings in the rendered file count', async (t) => {
  const root = project(t);
  const other = join(root, 'docs', 'D1.md');
  writeFileSync(other, readFileSync(other, 'utf8').replace('Next steps are in D2.', 'See FR-ZZZ-99.'));
  const { code, err } = await cli([join(root, 'docs', 'PLAN.md'), '--format', 'xlsx']);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['PLAN.xlsx']);
});

test('warnings are printed and do not stop the render', async (t) => {
  const root = project(t);
  const { code, out } = await cli([join(root, 'docs', 'PLAN.md'), '--format', 'xlsx']);
  assert.equal(code, 0);
  assert.match(out, /^docs\/PLAN\.md:\d+:\d+ missing-gist /m);
  assert.deepEqual(listDeliverables(root), ['PLAN.xlsx']);
});

test('--no-check renders anyway', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'note.md');
  writeFileSync(file, SMALL(`A ${EM} dash and FR-ZZZ-99.`));
  const blocked = await cli([file, '--format', 'docx']);
  assert.equal(blocked.code, 1);
  assert.deepEqual(listDeliverables(root), []);
  const { code, err } = await cli([file, '--format', 'docx', '--no-check']);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['note.docx']);
});

test('a missing figure file exits 1 naming the file and the line, and writes nothing', async (t) => {
  const root = project(t);
  rmSync(join(root, 'docs', 'figures', 'desk.svg'));
  const { code, err } = await cli([join(root, 'docs', 'D1.md'), '--format', 'docx']);
  assert.equal(code, 1);
  assert.match(err, /docs\/D1\.md:\d+: figure \S+: cannot read figures\/desk\.svg/);
  assert.equal(err.trim().split('\n').length, 1);
  assert.deepEqual(listDeliverables(root), []);
});

test('without Chromium and with figures: exit 1, the install hint, nothing written', async (t) => {
  const root = project(t);
  const { code, err } = await cli([join(root, 'docs', 'D1.md'), '--format', 'docx'], { chromiumStatus: NO_CHROMIUM });
  assert.equal(code, 1);
  assert.match(err, /playwright install chromium/);
  assert.equal(err.trim().split('\n').length, 1);
  assert.deepEqual(listDeliverables(root), []);
});

test('without Chromium, a PDF is refused with the install hint and nothing is written', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'note.md');
  writeFileSync(file, SMALL());
  const { code, err } = await cli([file], { chromiumStatus: NO_CHROMIUM });
  assert.equal(code, 1);
  assert.match(err, /playwright install chromium/);
  assert.deepEqual(listDeliverables(root), []);
});

test('a docx-only render of a figure-free document works without Chromium', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'note.md');
  writeFileSync(file, SMALL());
  const { code, err } = await cli([file, '--format', 'docx'], {
    chromiumStatus: NO_CHROMIUM,
    withBrowser: () => { throw new Error('the browser must not launch'); },
  });
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['note.docx']);
  assert.ok(isZip(join(deliverables(root), 'note.docx')));
});

test('several files are all or nothing', async (t) => {
  const root = project(t);
  const good = join(root, 'docs', 'note.md');
  const bad = join(root, 'docs', 'bad.md');
  writeFileSync(good, SMALL());
  writeFileSync(bad, SMALL(`Bad ${EM} dash.`).replace('D2', 'D3'));
  const { code } = await cli([good, bad, '--format', 'docx']);
  assert.equal(code, 1);
  assert.deepEqual(listDeliverables(root), []);
  const both = await cli([good, join(root, 'docs', 'PLAN.md'), '--format', 'docx,xlsx']);
  assert.equal(both.code, 2, 'xlsx on a non-PLAN document is a usage error');
  assert.deepEqual(listDeliverables(root), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Usage and project root

test('--format xlsx on D1 exits 2', async (t) => {
  const root = project(t);
  const { code, err } = await cli([join(root, 'docs', 'D1.md'), '--format', 'xlsx']);
  assert.equal(code, 2);
  assert.match(err, /xlsx/);
  assert.match(err, /PLAN/);
  assert.deepEqual(listDeliverables(root), []);
});

test('usage errors exit 2', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'D1.md');
  assert.equal((await cli([])).code, 2);
  assert.equal((await cli([file, '--format', 'odt'])).code, 2);
  assert.equal((await cli([file, '--format'])).code, 2);
  assert.equal((await cli([file, '--out'])).code, 2);
  assert.equal((await cli([file, '--bogus'])).code, 2);
  assert.equal((await cli([join(root, 'docs', 'nope.md')])).code, 2);
});

test('relative paths resolve against the working directory', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'note.md');
  writeFileSync(file, SMALL());
  const { code, err } = await cli(['docs/note.md', '--format', 'docx', '--out', 'built'], { cwd: root });
  assert.equal(code, 0, err);
  assert.deepEqual(readdirSync(join(root, 'built')), ['note.docx']);
});

test('without recade/state.yaml the project root is the folder of the file', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'recade loose '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(base, 'note.md');
  writeFileSync(file, SMALL());
  const { code, err } = await cli([file, '--format', 'docx']);
  assert.equal(code, 0, err);
  assert.deepEqual(readdirSync(join(base, 'docs', 'deliverables')), ['note.docx']);
});

test('renderFile returns the output paths and the findings', async (t) => {
  const root = project(t);
  const { outputs, findings } = await renderFile(join(root, 'docs', 'PLAN.md'), { formats: ['xlsx'] });
  assert.deepEqual(outputs, [join(deliverables(root), 'PLAN.xlsx')]);
  assert.ok(findings.some((f) => f.rule === 'missing-gist'));
  assert.ok(findings.every((f) => f.file === 'docs/PLAN.md'));
});

test('the render engine is loaded only by the render subcommand', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/cli.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /^import .* from '\.\/render\//m);
  assert.match(source, /import\('\.\/render\/pipeline\.js'\)/);
});

// ---------------------------------------------------------------------------------------------------------------
// The write stage is all or nothing

const twoNotes = (root) => {
  const a = join(root, 'docs', 'a.md');
  const b = join(root, 'docs', 'b.md');
  writeFileSync(a, SMALL());
  writeFileSync(b, SMALL().replace('D2', 'D3'));
  return [a, b];
};
const leftovers = (dir) => readdirSync(dir).filter((n) => /\.(tmp|bak)$/.test(n));

test('an output path that is already a folder exits 1, leaves previous outputs alone and no temp files', async (t) => {
  const root = project(t);
  const [a, b] = twoNotes(root);
  mkdirSync(join(deliverables(root), 'b.docx'), { recursive: true });
  writeFileSync(join(deliverables(root), 'a.docx'), 'previous');
  const { code, err } = await cli([a, b, '--format', 'docx']);
  assert.equal(code, 1);
  assert.equal(err.trim().split('\n').length, 1);
  assert.match(err, /b\.docx.*folder/);
  assert.equal(readFileSync(join(deliverables(root), 'a.docx'), 'utf8'), 'previous');
  assert.deepEqual(leftovers(deliverables(root)), []);
});

test('a build failure on the second document writes nothing for either', async (t) => {
  const root = project(t);
  const [a] = twoNotes(root);
  rmSync(join(root, 'docs', 'figures', 'desk.svg'));
  const { code, err } = await cli([a, join(root, 'docs', 'D1.md'), '--format', 'docx']);
  assert.equal(code, 1);
  assert.match(err, /cannot read figures\/desk\.svg/);
  assert.deepEqual(listDeliverables(root), []);
});

const failSecondRename = () => {
  let n = 0;
  return (from, to) => {
    if (from.endsWith('.tmp') && (n += 1) === 2) throw new Error('disk said no');
    return renameSync(from, to);
  };
};

test('a failed second rename restores every previous output and leaves no temp or backup file', async (t) => {
  const root = project(t);
  const [a, b] = twoNotes(root);
  mkdirSync(deliverables(root), { recursive: true });
  writeFileSync(join(deliverables(root), 'a.docx'), 'previous a');
  writeFileSync(join(deliverables(root), 'b.docx'), 'previous b');
  await assert.rejects(renderFiles([a, b], { formats: ['docx'], rename: failSecondRename() }), (err) => {
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /disk said no/);
    return true;
  });
  assert.equal(readFileSync(join(deliverables(root), 'a.docx'), 'utf8'), 'previous a');
  assert.equal(readFileSync(join(deliverables(root), 'b.docx'), 'utf8'), 'previous b');
  assert.deepEqual(readdirSync(deliverables(root)).sort(), ['a.docx', 'b.docx']);
});

test('a failed write removes the folders this run created, and only those', async (t) => {
  const root = project(t);
  const [a, b] = twoNotes(root);
  const out = join(root, 'new', 'nested out');
  await assert.rejects(renderFiles([a, b], { formats: ['docx'], outDir: out, rename: failSecondRename() }), /disk said no/);
  assert.equal(existsSync(join(root, 'new')), false, 'the whole created chain is gone');
  assert.ok(existsSync(join(root, 'docs')), 'folders that existed stay');
  // Through the CLI the failure is one line and exit 1.
  const ok = await cli([a, '--format', 'docx', '--out', out]);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(readdirSync(out), ['a.docx'], 'a render into the same place works afterwards');
});

test('a successful write leaves no backup of the file it replaced', async (t) => {
  const root = project(t);
  const [a] = twoNotes(root);
  mkdirSync(deliverables(root), { recursive: true });
  writeFileSync(join(deliverables(root), 'a.docx'), 'previous');
  const { code, err } = await cli([a, '--format', 'docx']);
  assert.equal(code, 0, err);
  assert.deepEqual(readdirSync(deliverables(root)), ['a.docx']);
  assert.ok(isZip(join(deliverables(root), 'a.docx')));
});

test('an empty --format list is a usage error and duplicate formats are rendered once', async (t) => {
  const root = project(t);
  const [a] = twoNotes(root);
  assert.equal((await cli([a, '--format', ','])).code, 2);
  assert.equal((await cli([a, '--format', ''])).code, 2);
  await assert.rejects(renderFiles([a], { formats: [] }), (err) => err.exitCode === 2);
  const { code, out, err } = await cli([a, '--format', 'docx,docx']);
  assert.equal(code, 0, err);
  assert.equal(out.match(/a\.docx/g).length, 1);
  assert.deepEqual(listDeliverables(root), ['a.docx']);
});

test('render takes --project <dir>: relative sources are read from that project', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'docs', 'note.md'), SMALL());
  const { code, err } = await cli(['docs/note.md', '--format', 'docx', '--project', root]);
  assert.equal(code, 0, err);
  assert.ok(isZip(join(deliverables(root), 'note.docx')));
});
