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

/** A config folder with no config file: the defaults, whatever the user running the tests has set. */
const NO_CONFIG = join(tmpdir(), 'recade-no-config-for-render-tests');
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
    cwd: cwd ?? tmpdir(), env: { ...process.env, RECADE_CONFIG_DIR: NO_CONFIG }, ...io,
  });
  return { code, out: out.join(''), err: err.join('') };
}

const deliverables = (root) => join(root, 'docs', 'deliverables');
// The record of what Recade rendered (`.recade-rendered.json`) is left out: it is not a deliverable.
const listDeliverables = (root) => (existsSync(deliverables(root)) ? readdirSync(deliverables(root)).filter((f) => !f.startsWith('.')).sort() : []);
/** The files of a folder, the record of what Recade rendered aside. */
const listed = (dir) => readdirSync(dir).filter((f) => f !== '.recade-rendered.json');
const isZip = (file) => readFileSync(file).subarray(0, 2).toString() === 'PK';
const isPdf = (file) => readFileSync(file).subarray(0, 5).toString() === '%PDF-';

// ---------------------------------------------------------------------------------------------------------------
// Rendering (Chromium needed: the Fernhill documents hold figures)

test('renders Fernhill D1 to D1_Product-Definition.docx and its HTML dossier with the index in docs/deliverables, and no PDF by default', { skip }, async (t) => {
  const root = project(t);
  const { code, out, err } = await cli([join(root, 'docs', 'D1.md')]);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['D1_Product-Definition.docx', 'D1_Product-Definition.html', 'INDEX_The-Project-Documents.html']);
  assert.ok(isZip(join(deliverables(root), 'D1_Product-Definition.docx')));
  assert.equal(out.match(/^Wrote .*$/gm).join('\n'), ['D1_Product-Definition.docx', 'D1_Product-Definition.html', 'INDEX_The-Project-Documents.html'].map((f) => `Wrote ${join(deliverables(root), f)}`).join('\n'));
});

test('with deliverables.pdf true in the user config, the PDF comes too', { skip }, async (t) => {
  const root = project(t);
  const config = mkdtempSync(join(tmpdir(), 'recade-config-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  writeFileSync(join(config, 'config.yaml'), 'deliverables:\n  pdf: true\n');
  const { code, out, err } = await cli([join(root, 'docs', 'D1.md')], { env: { ...process.env, RECADE_CONFIG_DIR: config } });
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['D1_Product-Definition.docx', 'D1_Product-Definition.html', 'D1_Product-Definition.pdf', 'INDEX_The-Project-Documents.html']);
  assert.ok(isPdf(join(deliverables(root), 'D1_Product-Definition.pdf')));
  assert.match(out, /D1_Product-Definition\.pdf/);
});

test('PLAN.md also yields its workbook, under the same name', { skip }, async (t) => {
  const root = project(t);
  const { code, err } = await cli([join(root, 'docs', 'PLAN.md')]);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['INDEX_The-Project-Documents.html', 'PLAN_Delivery-Plan.docx', 'PLAN_Delivery-Plan.html', 'PLAN_Delivery-Plan.xlsx']);
  assert.ok(isZip(join(deliverables(root), 'PLAN_Delivery-Plan.xlsx')));
});

test('--format and --out pick the formats and the folder', { skip }, async (t) => {
  const root = project(t);
  const out = join(root, 'out folder');
  const { code, err } = await cli([join(root, 'docs', 'D1.md'), '--format', 'pdf', '--out', out]);
  assert.equal(code, 0, err);
  assert.deepEqual(listed(out), ['D1_Product-Definition.pdf']);
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
  const docx = join(deliverables(root), 'D1_Product-Definition.docx');
  writeFileSync(docx, 'stale');
  const second = await cli(args, { withBrowser: counting });
  assert.equal(second.code, 0, second.err);
  assert.equal(launches, 1, 'cached figures never touch the browser');
  assert.ok(isZip(docx), 'the stale file was replaced');
  assert.deepEqual(listed(deliverables(root)), ['D1_Product-Definition.docx'], 'no temp file is left behind');
});

test('figures and the PDF share one browser session', { skip }, async (t) => {
  const root = project(t);
  let launches = 0;
  const counting = (fn) => { launches += 1; return withBrowser(fn); };
  const { code, err } = await cli([join(root, 'docs', 'D1.md'), '--format', 'docx,pdf'], { withBrowser: counting });
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
  const zip = await JSZip.loadAsync(readFileSync(join(deliverables(root), 'D1_Product-Definition.docx')));
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
  assert.deepEqual(listDeliverables(root), ['PLAN_Delivery-Plan.xlsx']);
});

test('warnings are printed and do not stop the render', async (t) => {
  const root = project(t);
  const { code, out } = await cli([join(root, 'docs', 'PLAN.md'), '--format', 'xlsx']);
  assert.equal(code, 0);
  assert.match(out, /^docs\/PLAN\.md:\d+:\d+ missing-gist /m);
  assert.deepEqual(listDeliverables(root), ['PLAN_Delivery-Plan.xlsx']);
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
  assert.deepEqual(listDeliverables(root), ['note_Small-Note.docx']);
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
  const { code, err } = await cli([file, '--format', 'docx,pdf'], { chromiumStatus: NO_CHROMIUM });
  assert.equal(code, 1);
  assert.match(err, /playwright install chromium/);
  assert.deepEqual(listDeliverables(root), []);
});

test('a default render of a figure-free document works without Chromium', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'note.md');
  writeFileSync(file, SMALL());
  const { code, err } = await cli([file], {
    chromiumStatus: NO_CHROMIUM,
    withBrowser: () => { throw new Error('the browser must not launch'); },
  });
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['INDEX_The-Project-Documents.html', 'note_Small-Note.docx', 'note_Small-Note.html']);
  assert.ok(isZip(join(deliverables(root), 'note_Small-Note.docx')));
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
  assert.deepEqual(listed(join(root, 'built')), ['note_Small-Note.docx']);
});

test('without recade/state.yaml the project root is the folder of the file', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'recade loose '));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const file = join(base, 'note.md');
  writeFileSync(file, SMALL());
  const { code, err } = await cli([file, '--format', 'docx']);
  assert.equal(code, 0, err);
  assert.deepEqual(listed(join(base, 'docs', 'deliverables')), ['note_Small-Note.docx']);
});

test('renderFile returns the output paths and the findings', async (t) => {
  const root = project(t);
  const { outputs, findings } = await renderFile(join(root, 'docs', 'PLAN.md'), { formats: ['xlsx'] });
  assert.deepEqual(outputs, [join(deliverables(root), 'PLAN_Delivery-Plan.xlsx')]);
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
  mkdirSync(join(deliverables(root), 'b_Small-Note.docx'), { recursive: true });
  writeFileSync(join(deliverables(root), 'a_Small-Note.docx'), 'previous');
  const { code, err } = await cli([a, b, '--format', 'docx']);
  assert.equal(code, 1);
  assert.equal(err.trim().split('\n').length, 1);
  assert.match(err, /b_Small-Note\.docx.*folder/);
  assert.equal(readFileSync(join(deliverables(root), 'a_Small-Note.docx'), 'utf8'), 'previous');
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
  writeFileSync(join(deliverables(root), 'a_Small-Note.docx'), 'previous a');
  writeFileSync(join(deliverables(root), 'b_Small-Note.docx'), 'previous b');
  await assert.rejects(renderFiles([a, b], { formats: ['docx'], rename: failSecondRename() }), (err) => {
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /disk said no/);
    return true;
  });
  assert.equal(readFileSync(join(deliverables(root), 'a_Small-Note.docx'), 'utf8'), 'previous a');
  assert.equal(readFileSync(join(deliverables(root), 'b_Small-Note.docx'), 'utf8'), 'previous b');
  assert.deepEqual(listed(deliverables(root)).sort(), ['a_Small-Note.docx', 'b_Small-Note.docx']);
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
  assert.deepEqual(listed(out), ['a_Small-Note.docx'], 'a render into the same place works afterwards');
});

test('a successful write leaves no backup of the file it replaced', async (t) => {
  const root = project(t);
  const [a] = twoNotes(root);
  mkdirSync(deliverables(root), { recursive: true });
  writeFileSync(join(deliverables(root), 'a_Small-Note.docx'), 'previous');
  const { code, err } = await cli([a, '--format', 'docx']);
  assert.equal(code, 0, err);
  assert.deepEqual(listed(deliverables(root)), ['a_Small-Note.docx']);
  assert.ok(isZip(join(deliverables(root), 'a_Small-Note.docx')));
});

test('an empty --format list is a usage error and duplicate formats are rendered once', async (t) => {
  const root = project(t);
  const [a] = twoNotes(root);
  assert.equal((await cli([a, '--format', ','])).code, 2);
  assert.equal((await cli([a, '--format', ''])).code, 2);
  await assert.rejects(renderFiles([a], { formats: [] }), (err) => err.exitCode === 2);
  const { code, out, err } = await cli([a, '--format', 'docx,docx']);
  assert.equal(code, 0, err);
  assert.equal(out.match(/a_Small-Note\.docx/g).length, 1);
  assert.deepEqual(listDeliverables(root), ['a_Small-Note.docx']);
});

test('render takes --project <dir>: relative sources are read from that project', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'docs', 'note.md'), SMALL());
  const { code, err } = await cli(['docs/note.md', '--format', 'docx', '--project', root]);
  assert.equal(code, 0, err);
  assert.ok(isZip(join(deliverables(root), 'note_Small-Note.docx')));
});

// ---------------------------------------------------------------------------------------------------------------
// File names in the language of the document, and the files of an older render

const titled = (title, language = 'en') => SMALL().replace('title: Fernhill Lending, small note', `title: "${title}"\nlanguage: ${language}`);

test('a French copy is named after its French title, accents dropped, next to the English one', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'docs', 'D2.md'), titled('Fernhill Lending, Technical Architecture'));
  writeFileSync(join(root, 'docs', 'D2.fr.md'), titled('Fernhill Lending, Architecture technique détaillée', 'fr'));
  const { code, err } = await cli([join(root, 'docs', 'D2.md'), join(root, 'docs', 'D2.fr.md')]);
  assert.equal(code, 0, err);
  // The dossiers and their index pages follow the same names: only the Word files are compared here.
  assert.deepEqual(listDeliverables(root).filter((f) => !f.endsWith('.html')), ['D2_Architecture-Technique-Detaillee.docx', 'D2_Technical-Architecture.docx']);
  assert.ok(listDeliverables(root).includes('D2_Architecture-Technique-Detaillee.html'));
});

test('a copy whose title gives the name of its source keeps its language at the end', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'docs', 'D2.md'), titled('Fernhill Lending, Architecture'));
  writeFileSync(join(root, 'docs', 'D2.fr.md'), titled('Fernhill Lending, Architecture', 'fr'));
  const { code, err } = await cli([join(root, 'docs', 'D2.fr.md')]);
  assert.equal(code, 0, err);
  assert.deepEqual(listDeliverables(root), ['D2_Architecture.fr.docx', 'D2_Architecture.fr.html', 'INDEX_Les-Documents-du-Projet.html']);
});

test('the files of an older render are left as they were, and each is named once', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'note.md');
  writeFileSync(file, SMALL());
  mkdirSync(deliverables(root), { recursive: true });
  for (const name of ['note.docx', 'note.pdf', 'note_Small-Note.pdf', 'note.xlsx']) writeFileSync(join(deliverables(root), name), 'old');
  const { code, out, err } = await cli([file]);
  assert.equal(code, 0, err);
  for (const name of ['note.docx', 'note.pdf', 'note_Small-Note.pdf']) {
    assert.equal(readFileSync(join(deliverables(root), name), 'utf8'), 'old', `${name} is not deleted`);
    assert.ok(out.includes(`Left as it was: ${join(deliverables(root), name)}. Recade no longer writes`), name);
  }
  assert.equal(out.includes('note.xlsx'), false, 'a name Recade never wrote for this source is not named');
  assert.ok(isZip(join(deliverables(root), 'note_Small-Note.docx')));
  // Formats given on the command line: a PDF not asked for is not called stale.
  const again = await cli([file, '--format', 'docx']);
  assert.equal(again.out.includes('note_Small-Note.pdf'), false);
  assert.ok(again.out.includes('note.pdf'));
});

test('a renamed document leaves its old files, named as left, and the index lists the current one only', async (t) => {
  const root = project(t);
  const file = join(root, 'docs', 'note.md');
  writeFileSync(file, SMALL());
  assert.equal((await cli([file])).code, 0);
  writeFileSync(join(deliverables(root), 'note_Mine.html'), '<html>not a dossier</html>');
  writeFileSync(file, SMALL().replace('title: Fernhill Lending, small note', 'title: Fernhill Lending, short note'));
  const { code, out, err } = await cli([file]);
  assert.equal(code, 0, err);
  for (const name of ['note_Small-Note.docx', 'note_Small-Note.html']) {
    assert.ok(existsSync(join(deliverables(root), name)), `${name} is not deleted`);
    assert.ok(out.includes(`Left as it was: ${join(deliverables(root), name)}.`), name);
  }
  assert.equal(out.includes('note_Mine.html'), false, 'a file Recade did not write is not named');
  const index = readdirSync(deliverables(root)).find((f) => f.startsWith('INDEX_'));
  const html = readFileSync(join(deliverables(root), index), 'utf8');
  assert.equal((html.match(/class="card"/g) ?? []).length, 1, 'one card for the document');
  assert.ok(html.includes('note_Short-Note.html'));
  assert.equal(html.includes('note_Small-Note.html'), false);
  const record = JSON.parse(readFileSync(join(deliverables(root), '.recade-rendered.json'), 'utf8'));
  assert.deepEqual(record['docs/note.md'], { current: ['note_Short-Note.docx', 'note_Short-Note.html'], left: ['note_Small-Note.docx', 'note_Small-Note.html'] });
  // A render of the docx only keeps the HTML as current, and still names the old files.
  const again = await cli([file, '--format', 'docx']);
  assert.ok(again.out.includes('note_Small-Note.docx'));
  assert.equal(again.out.includes('note_Short-Note.html'), false);
  // From a render before the record: the old dossier is proven by its embedded entry.
  rmSync(join(deliverables(root), '.recade-rendered.json'));
  const legacy = await cli([file]);
  assert.ok(legacy.out.includes(`Left as it was: ${join(deliverables(root), 'note_Small-Note.html')}.`));
  assert.ok(legacy.out.includes(`Left as it was: ${join(deliverables(root), 'note_Small-Note.docx')}.`));
});

test('writeAll replaces an output written under the same name in another case, and puts it back when a write fails', async () => {
  const { writeAll } = await import('../../src/render/pipeline.js');
  const dir = mkdtempSync(join(tmpdir(), 'recade-case-'));
  writeFileSync(join(dir, 'D3_Exigences-De-Securite.docx'), 'old');
  writeFileSync(join(dir, 'D3_Other.docx'), 'other');
  writeAll([{ file: join(dir, 'D3_Exigences-de-Securite.docx'), bytes: 'new' }]);
  assert.deepEqual(readdirSync(dir).sort(), ['D3_Exigences-de-Securite.docx', 'D3_Other.docx']);
  assert.equal(readFileSync(join(dir, 'D3_Exigences-de-Securite.docx'), 'utf8'), 'new');
  // A failed write restores the old spelling and its contents.
  writeFileSync(join(dir, 'D1_Plan-De-Test.html'), 'kept');
  let calls = 0;
  const rename = (a, b) => { if (++calls === 2) throw new Error('disk full'); renameSync(a, b); };
  assert.throws(() => writeAll([{ file: join(dir, 'D1_Plan-de-Test.html'), bytes: 'x' }], rename), /disk full/);
  assert.equal(readFileSync(join(dir, 'D1_Plan-De-Test.html'), 'utf8'), 'kept');
  assert.equal(existsSync(join(dir, 'D1_Plan-de-Test.html')), false);
});
