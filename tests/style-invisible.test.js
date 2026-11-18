import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintText, lintFiles, scanInvisible } from '../src/style/lint.js';
import { scanAttachments } from '../src/style/attachments.js';
import { createProject } from '../src/project/scaffold.js';
import { run } from '../src/cli.js';

// Every invisible character below is built from a code point, never typed literally.
const ch = (cp) => String.fromCodePoint(cp);
const BIDI = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];
const HIDDEN = [0x200b, 0x2060, 0xfeff];
const JOINERS = [0x200c, 0x200d];
const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

test('each bidi control is an error with file, line, column and code point', () => {
  for (const cp of BIDI) {
    const f = lintText(`ok\nab${ch(cp)}cd`, 'x.md');
    assert.equal(f.length, 1, hex(cp));
    assert.deepEqual([f[0].rule, f[0].severity, f[0].file, f[0].line, f[0].column], ['bidi-control', 'error', 'x.md', 2, 3], hex(cp));
    assert.equal(f[0].codePoint, hex(cp));
    assert.ok(f[0].message.includes(hex(cp)), f[0].message);
  }
});

test('zero width space, word joiner and a BOM that is not at the start are errors', () => {
  for (const cp of HIDDEN) {
    const f = lintText(`ab${ch(cp)}cd`, 'x.md');
    assert.deepEqual(f.map((x) => [x.rule, x.severity, x.column, x.codePoint]), [['invisible-char', 'error', 3, hex(cp)]], hex(cp));
  }
  const bom = lintText(`line one\n${ch(0xfeff)}line two`, 'x.md');
  assert.deepEqual(bom.map((x) => [x.rule, x.severity, x.line, x.column]), [['invisible-char', 'error', 2, 1]]);
});

test('a BOM at offset 0 is a warning, once', () => {
  const f = lintText(`${ch(0xfeff)}title\nbody`, 'x.md');
  assert.deepEqual(f.map((x) => [x.rule, x.severity, x.line, x.column, x.codePoint]), [['bom', 'warn', 1, 1, 'U+FEFF']]);
  const two = lintText(`${ch(0xfeff)}${ch(0xfeff)}title`, 'x.md');
  assert.deepEqual(two.map((x) => [x.rule, x.severity, x.column]), [['bom', 'warn', 1], ['invisible-char', 'error', 2]]);
});

test('ZWNJ and ZWJ are warnings only: they are legitimate in Persian, Indic scripts and emoji', () => {
  for (const cp of JOINERS) {
    const f = lintText(`ab${ch(cp)}cd`, 'x.md');
    assert.deepEqual(f.map((x) => [x.rule, x.severity, x.codePoint]), [['joiner', 'warn', hex(cp)]], hex(cp));
  }
  const family = `${ch(0x1f469)}${ch(0x200d)}${ch(0x1f469)}${ch(0x200d)}${ch(0x1f467)}`;
  assert.deepEqual(lintText(family, 'x.md').map((x) => x.severity), ['warn', 'warn']);
});

test('every occurrence on a line is reported, in order', () => {
  const f = lintText(`a${ch(0x202e)}b${ch(0x200b)}c${ch(0x202e)}`, 'x.md');
  assert.deepEqual(f.map((x) => [x.column, x.codePoint]), [[2, 'U+202E'], [4, 'U+200B'], [6, 'U+202E']]);
});

test('recade-style-ignore exempts the line that carries it', () => {
  const f = lintText(`a${ch(0x202e)}b <!-- recade-style-ignore -->\nc${ch(0x202e)}d`, 'x.md');
  assert.deepEqual(f.map((x) => x.line), [2]);
});

test('ordinary text, accents, en dash, non-breaking space and Arabic letters are untouched', () => {
  assert.deepEqual(lintText(`café – a${ch(0xa0)}b مرحبا`, 'x.md'), []);
});

test('lintFiles finds the characters in a file and exits the CLI with 1 on an error, 0 on a warning only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-inv-'));
  writeFileSync(join(root, 'bad.md'), `x${ch(0x202e)}y\n`);
  assert.deepEqual(lintFiles(root, ['bad.md']).map((f) => [f.rule, f.severity]), [['bidi-control', 'error']]);
  const out = [];
  const io = (cwd) => ({ stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, cwd, env: {} });
  assert.equal(await run(['lint-style', 'bad.md'], io(root)), 1);
  assert.match(out.join(''), /^bad\.md:1:2 bidi-control .*U\+202E/m);
  const ok = mkdtempSync(join(tmpdir(), 'recade-inv-'));
  writeFileSync(join(ok, 'fa.md'), `a${ch(0x200c)}b\n`);
  assert.equal(await run(['lint-style', 'fa.md'], io(ok)), 0);
});

// ---------------------------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------------------------

function attachments(files) {
  const root = mkdtempSync(join(tmpdir(), 'recade-inv-intake-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, 'intake', 'attachments', rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(join(root, 'intake'), { recursive: true });
  return root;
}

test('scanInvisible keeps only the invisible Unicode findings and ignores the style tics', () => {
  const f = scanInvisible(`a robust plan\u2014${ch(0x202e)}`, 'x.md'); // recade-style-ignore
  assert.deepEqual(f.map((x) => x.rule), ['bidi-control']);
});

test('a lone CR is a line break, like CRLF and LF', () => {
  const f = lintText(`a\rb\rc${ch(0x202e)}`, 'x.md');
  assert.deepEqual(f.map((x) => [x.line, x.column]), [[3, 2]]);
  assert.deepEqual(lintText(`a\r\nb${ch(0x202e)}`, 'x.md').map((x) => [x.line, x.column]), [[2, 2]]);
});

test('columns count code points, so a character outside the BMP counts once', () => {
  const smile = ch(0x1f600);
  const f = lintText(`${smile}${smile}a${ch(0x202e)}`, 'x.md');
  assert.deepEqual(f.map((x) => x.column), [4]);
  assert.deepEqual(lintText(`${smile}a${ch(0x200b)}b${ch(0x200b)}`, 'x.md').map((x) => x.column), [3, 5]);
  assert.match(f[0].message, /U\+202E/);
});

test('scanAttachments scans the text files under intake/attachments at any depth', () => {
  const root = attachments({
    'brief.md': `Scope${ch(0x202e)}\n`,
    'deep/er/notes.txt': `a${ch(0x200b)}b\n`,
    'logo.svg': `<svg><title>x${ch(0x2066)}</title></svg>\n`,
    'ok.md': 'clean\n',
    'persian.md': `a${ch(0x200c)}b\n`,
  });
  const r = scanAttachments(root);
  assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.column, f.codePoint, f.severity]), [
    ['intake/attachments/brief.md', 1, 6, 'U+202E', 'error'],
    ['intake/attachments/deep/er/notes.txt', 1, 2, 'U+200B', 'error'],
    ['intake/attachments/logo.svg', 1, 14, 'U+2066', 'error'],
    ['intake/attachments/persian.md', 1, 2, 'U+200C', 'warn'],
  ]);
  assert.equal(r.blocking, true);
  assert.deepEqual(scanAttachments(attachments({ 'a.md': 'fine' })), { findings: [], blocking: false });
  assert.deepEqual(scanAttachments(mkdtempSync(join(tmpdir(), 'recade-inv-none-'))), { findings: [], blocking: false });
});

test('scanAttachments does not honour the ignore comment: a client file cannot exempt itself', () => {
  const root = attachments({ 'a.md': `x${ch(0x202e)}y recade-style-ignore\n` });
  assert.equal(scanAttachments(root).findings.length, 1);
});

test('recade intake scan lists each finding with file and position, exits 1 on an error, 0 otherwise, 2 on bad usage', async () => {
  const root = attachments({ 'brief.md': `Scope${ch(0x202e)}\n`, 'fa.md': `a${ch(0x200d)}b\n` });
  const out = [];
  const err = [];
  const io = (cwd) => ({ stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {} });
  mkdirSync(join(root, 'recade'), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), 'version: 1\nmode: scratch\nlanguages:\n  work: en\n');
  assert.equal(await run(['intake', 'scan', '--project', root], io(tmpdir())), 1);
  const text = out.join('');
  assert.match(text, /BLOCKING: intake\/attachments\/brief\.md:1:6 bidi-control U\+202E/);
  assert.match(text, /intake\/attachments\/fa\.md:1:2 joiner U\+200D/);
  assert.equal(text.includes(ch(0x202e)), false, 'the invisible character is never echoed');
  out.length = 0;
  assert.equal(await run(['intake', 'scan', '--json', '--project', root], io(tmpdir())), 1);
  const json = JSON.parse(out.join(''));
  assert.equal(json.blocking, true);
  assert.equal(json.findings[0].codePoint, 'U+202E');
  const clean = attachments({ 'a.md': 'fine' });
  mkdirSync(join(clean, 'recade'), { recursive: true });
  writeFileSync(join(clean, 'recade', 'state.yaml'), 'version: 1\nmode: scratch\nlanguages:\n  work: en\n');
  out.length = 0;
  assert.equal(await run(['intake', 'scan', '--project', clean], io(tmpdir())), 0);
  assert.match(out.join(''), /No invisible Unicode/);
  for (const args of [['intake'], ['intake', 'nope'], ['intake', 'scan', '--bogus']]) {
    assert.equal(await run(args, io(clean)), 2, args.join(' '));
  }
  assert.equal(await run(['intake', 'scan'], io(tmpdir())), 1);
});

test('createProject with --from scans the copied text files and lists the errors in intake/gaps.md under a BLOCKING section', async () => {
  const from = mkdtempSync(join(tmpdir(), 'recade-inv-from-'));
  writeFileSync(join(from, 'brief.md'), `Scope${ch(0x202e)}\n`);
  writeFileSync(join(from, 'ok.md'), 'clean\n');
  const config = { voice: 'randall-munroe', languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] } };
  const r = await createProject('Fernhill Lending', { root: mkdtempSync(join(tmpdir(), 'recade-inv-root-')), mode: 'from-docs', from, config, exec: async () => ({ code: 0, stdout: '', stderr: '' }), today: '2026-11-18' });
  assert.deepEqual(r.invisible.map((f) => [f.file, f.codePoint]), [['intake/attachments/brief.md', 'U+202E']]);
  const gaps = readFileSync(join(r.dir, 'intake', 'gaps.md'), 'utf8');
  assert.match(gaps, /## Intake scan/);
  assert.match(gaps, /BLOCKING/);
  assert.match(gaps, /intake\/attachments\/brief\.md:1:6 bidi-control U\+202E/);
  assert.equal(gaps.includes(ch(0x202e)), false);
  const clean = await createProject('Other Project', { root: mkdtempSync(join(tmpdir(), 'recade-inv-root-')), mode: 'scratch', config, exec: async () => ({ code: 0, stdout: '', stderr: '' }), today: '2026-11-18' });
  assert.deepEqual(clean.invisible, []);
});

test('the intake analyst and /recade:new say what to do with a BLOCKING invisible character', () => {
  const analyst = readFileSync(new URL('../agents/intake-analyst.md', import.meta.url), 'utf8');
  assert.match(analyst, /Intake scan/);
  assert.match(analyst, /BLOCKING/);
  assert.match(analyst, /do not read/i);
  const cmd = readFileSync(new URL('../commands/new.md', import.meta.url), 'utf8');
  assert.match(cmd, /recade intake scan/);
  assert.equal(`${analyst}${cmd}`.includes(ch(0x2014)), false);
});
