import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAttachments } from '../src/style/attachments.js';
import { createProject } from '../src/project/scaffold.js';
import { run } from '../src/cli.js';

// Synthetic files only. Every hidden character is built from a code point.
const ch = (cp) => String.fromCodePoint(cp);
const RLO = ch(0x202e);
const ZWSP = ch(0x200b);

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A zip file in memory. `entries`: name to {data, method: 0|8, flags?, declared?}. Only what the scanner needs. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, spec] of Object.entries(entries)) {
    const e = typeof spec === 'string' || Buffer.isBuffer(spec) ? { data: spec } : spec;
    const raw = Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const flags = e.flags ?? 0;
    const usize = e.declared ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(usize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(flags, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(usize, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function attachments(files) {
  const root = mkdtempSync(join(tmpdir(), 'recade-att-'));
  mkdirSync(join(root, 'intake', 'attachments'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, 'intake', 'attachments', rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

const rules = (r) => r.findings.map((f) => [f.file.replace('intake/attachments/', ''), f.rule]);

test('html, htm, xml, csv, tsv, json, yaml, yml, ini and rtf are scanned as text, in any letter case', () => {
  const files = {};
  for (const ext of ['html', 'htm', 'xml', 'csv', 'tsv', 'json', 'yaml', 'yml', 'ini', 'rtf', 'TXT']) files[`f.${ext}`] = `a${RLO}b\n`;
  const r = scanAttachments(attachments(files));
  assert.equal(r.findings.length, 11);
  assert.ok(r.findings.every((f) => f.rule === 'bidi-control' && f.severity === 'error'));
  assert.equal(r.blocking, true);
});

test('docx, pptx, xlsx and odt are opened with zlib and their XML parts are scanned, stored and deflated entries alike', () => {
  const r = scanAttachments(attachments({
    'brief.docx': zip({ '[Content_Types].xml': '<a/>', 'word/document.xml': `<w:t>Scope${RLO}</w:t>`, 'word/media/image1.png': Buffer.from([1, 2, 3]) }),
    'plan.pptx': zip({ 'ppt/slides/slide1.xml': { data: `<a:t>x${ZWSP}</a:t>`, method: 0 } }),
    'sheet.xlsx': zip({ 'xl/sharedStrings.xml': `<si><t>a${RLO}</t></si>`, 'xl/worksheets/sheet1.xml': '<ok/>' }),
    'doc.odt': zip({ 'content.xml': `<text:p>${RLO}</text:p>`, mimetype: { data: 'application/x', method: 0 } }),
    'clean.docx': zip({ 'word/document.xml': '<w:t>fine</w:t>' }),
  }));
  assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.column, f.codePoint]), [
    ['intake/attachments/brief.docx!word/document.xml', 1, 11, 'U+202E'],
    ['intake/attachments/doc.odt!content.xml', 1, 9, 'U+202E'],
    ['intake/attachments/plan.pptx!ppt/slides/slide1.xml', 1, 7, 'U+200B'],
    ['intake/attachments/sheet.xlsx!xl/sharedStrings.xml', 1, 9, 'U+202E'],
  ]);
  assert.equal(r.blocking, true);
});

test('an archive that cannot be read, is encrypted, lies about its size or is too big is a BLOCKING not scanned finding', () => {
  const root = attachments({
    'garbage.docx': 'this is not a zip file at all',
    'truncated.xlsx': zip({ 'a.xml': '<a/>' }).subarray(0, 20),
    'enc.docx': zip({ 'word/document.xml': { data: '<a/>', flags: 1 } }),
    'bomb.docx': zip({ 'word/document.xml': { data: `<a>${'x'.repeat(5000)}</a>` } }),
    'lie.docx': zip({ 'word/document.xml': { data: '<a/>', declared: 50 } }),
  });
  const r = scanAttachments(root, { maxEntryBytes: 1000, maxFileBytes: 100 + 200 });
  const by = Object.fromEntries(rules(r).map(([f, rule]) => [f.split('!')[0], rule]));
  for (const name of ['garbage.docx', 'truncated.xlsx', 'enc.docx', 'bomb.docx', 'lie.docx']) assert.equal(by[name], 'not-scanned', name);
  assert.equal(r.blocking, true);
  assert.ok(r.findings.every((f) => f.severity === 'error'));
  assert.match(r.findings.find((f) => f.file.endsWith('enc.docx') || f.file.includes('enc.docx')).message, /encrypted/i);
});

test('a file over the byte cap is a BLOCKING not scanned finding, whatever its type', () => {
  const r = scanAttachments(attachments({ 'big.md': 'x'.repeat(2000), 'small.md': 'ok' }), { maxFileBytes: 1000 });
  assert.deepEqual(rules(r), [['big.md', 'not-scanned']]);
  assert.match(r.findings[0].message, /over/);
});

test('any other binary type is a BLOCKING not scanned finding; the OS litter files are not attachments', () => {
  const r = scanAttachments(attachments({ 'scan.pdf': Buffer.from('%PDF-1.4'), 'logo.png': Buffer.from([0x89, 0x50]), 'data.bin': Buffer.from([0]), '.DS_Store': 'x', 'Thumbs.db': 'x' }));
  assert.deepEqual(rules(r), [['data.bin', 'not-scanned'], ['logo.png', 'not-scanned'], ['scan.pdf', 'not-scanned']]);
  assert.equal(r.blocking, true);
});

test('the .gitkeep that the scaffold writes in an empty project is not an attachment: a fresh project scans clean', async () => {
  const base = mkdtempSync(join(tmpdir(), 'recade-fresh-'));
  const { dir } = await createProject('Fernhill Lending', { root: base, mode: 'scratch', config: { voice: 'randall-munroe', languages: { work: 'en' } }, exec: async () => ({ code: 0, stderr: '' }), today: '2026-11-18' });
  assert.ok(readFileSync(join(dir, 'intake', 'attachments', '.gitkeep'), 'utf8') === '', 'the scaffold wrote the placeholder');
  const r = scanAttachments(dir);
  assert.deepEqual(r.findings, []);
  assert.equal(r.blocking, false);
});

test('symbolic links and the folders the walk used to skip are BLOCKING findings, not silent skips', () => {
  const root = attachments({ 'real.md': `x${RLO}\n`, '.git/notes.txt': `y${RLO}`, 'node_modules/m/readme.md': 'z', 'ok/fine.md': 'fine' });
  symlinkSync(join(root, 'intake', 'attachments', 'real.md'), join(root, 'intake', 'attachments', 'link.md'));
  symlinkSync(join(root, 'intake', 'attachments', 'ok'), join(root, 'intake', 'attachments', 'linkdir'));
  const r = scanAttachments(root);
  assert.deepEqual(rules(r), [['.git', 'not-scanned'], ['link.md', 'not-scanned'], ['linkdir', 'not-scanned'], ['node_modules', 'not-scanned'], ['real.md', 'bidi-control']]);
  assert.match(r.findings.find((f) => f.file.endsWith('link.md')).message, /symbolic link/i);
});

test('findings are capped per file: the first 20 are listed, then one line with the total', () => {
  const r = scanAttachments(attachments({ 'many.md': `${ZWSP.repeat(30)}\n`, 'few.md': `${ZWSP.repeat(3)}\n` }));
  const many = r.findings.filter((f) => f.file.endsWith('many.md'));
  assert.equal(many.length, 21);
  assert.deepEqual(many.slice(0, 20).map((f) => f.column), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(many[20].rule, 'more-findings');
  assert.equal(many[20].severity, 'error');
  assert.equal(many[20].total, 30);
  assert.match(many[20].message, /10 more.*30 in total/);
  assert.equal(r.findings.filter((f) => f.file.endsWith('few.md')).length, 3);
  const small = scanAttachments(attachments({ 'm.md': `${ZWSP.repeat(5)}` }), { maxFindingsPerFile: 2 });
  assert.equal(small.findings.length, 3);
});

test('a capped file of warnings only stays a warning', () => {
  const r = scanAttachments(attachments({ 'fa.md': `${ch(0x200c).repeat(25)}\n` }));
  assert.equal(r.findings.at(-1).rule, 'more-findings');
  assert.equal(r.findings.at(-1).severity, 'warn');
  assert.equal(r.blocking, false);
});

test('UTF-16 text with a byte order mark is decoded before it is scanned', () => {
  const body = Buffer.from(`a${RLO}b`, 'utf16le');
  const r = scanAttachments(attachments({ 'le.txt': Buffer.concat([Buffer.from([0xff, 0xfe]), body]) }));
  assert.deepEqual(r.findings.filter((f) => f.rule === 'bidi-control').map((f) => f.column), [2]);
});

test('the ignore marker of a client file exempts nothing', () => {
  assert.equal(scanAttachments(attachments({ 'a.html': `<!-- recade-style-ignore -->${RLO}` })).findings.length, 1);
});

// ---------------------------------------------------------------------------------------------------------
// CLI, scaffold and the texts
// ---------------------------------------------------------------------------------------------------------

function project(files) {
  const root = attachments(files);
  mkdirSync(join(root, 'recade'), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), 'version: 1\nmode: scratch\nlanguages:\n  work: en\n');
  return root;
}

async function cli(args, cwd) {
  const out = [];
  const code = await run(args, { stdout: { write: (x) => out.push(x) }, stderr: { write: () => {} }, cwd, env: {} });
  return { code, out: out.join('') };
}

test('recade intake scan exits 1 when any BLOCKING finding exists, including a file that could not be scanned, and 0 for warnings only', async () => {
  const root = project({ 'scan.pdf': Buffer.from('%PDF') });
  const r = await cli(['intake', 'scan', '--project', root], tmpdir());
  assert.equal(r.code, 1);
  assert.match(r.out, /BLOCKING: intake\/attachments\/scan\.pdf not-scanned /);
  assert.equal((await cli(['intake', 'scan', '--json', '--project', root], tmpdir())).code, 1);
  const warn = project({ 'fa.md': `a${ch(0x200d)}b` });
  assert.equal((await cli(['intake', 'scan', '--project', warn], tmpdir())).code, 0);
  const capped = project({ 'many.md': ZWSP.repeat(40) });
  const c = await cli(['intake', 'scan', '--project', capped], tmpdir());
  assert.equal(c.code, 1);
  assert.match(c.out, /more-findings/);
  assert.match(c.out, /20 more.*40 in total/);
});

test('createProject --from lists the not scanned files and the capped findings under the Intake scan section of gaps.md', async () => {
  const from = mkdtempSync(join(tmpdir(), 'recade-att-from-'));
  writeFileSync(join(from, 'brief.md'), `Scope${RLO}\n`);
  writeFileSync(join(from, 'sheet.xlsx'), 'not really a zip');
  const config = { voice: 'randall-munroe', languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] } };
  const r = await createProject('Fernhill Lending', { root: mkdtempSync(join(tmpdir(), 'recade-att-root-')), mode: 'from-docs', from, config, exec: async () => ({ code: 0, stdout: '', stderr: '' }), today: '2026-11-18' });
  const gaps = readFileSync(join(r.dir, 'intake', 'gaps.md'), 'utf8');
  assert.match(gaps, /## Intake scan/);
  assert.match(gaps, /BLOCKING: intake\/attachments\/brief\.md:1:6 bidi-control U\+202E/);
  assert.match(gaps, /BLOCKING: intake\/attachments\/sheet\.xlsx not-scanned/);
});

test('the analyst reads no attachment before the scan passes or the owner accepts the listed findings; /recade:new asks the owner', () => {
  const analyst = readFileSync(new URL('../agents/intake-analyst.md', import.meta.url), 'utf8');
  assert.match(analyst, /exits 0/);
  assert.match(analyst, /accepts the listed findings/);
  assert.match(analyst, /not scanned/);
  const cmd = readFileSync(new URL('../commands/new.md', import.meta.url), 'utf8');
  assert.match(cmd, /Accept the listed findings/);
  assert.equal(`${analyst}${cmd}`.includes(ch(0x2014)), false);
});

// ---------------------------------------------------------------------------------------------------------
// Numeric character references
// ---------------------------------------------------------------------------------------------------------

test('numeric character references to hidden characters are decoded in html, htm, xml and svg, and reported at the reference', () => {
  const files = {
    'a.html': '<p>x&#x202E;y</p>\n',
    'b.htm': '<p>x&#8238;y</p>\n',
    'c.xml': '<a>\n  &#x0202e;\n</a>\n',
    'd.svg': '<svg><title>t&#X200B;</title></svg>\n',
    'e.xml': '<a>&#x00000202E;&#8238;</a>\n',
  };
  const r = scanAttachments(attachments(files));
  assert.deepEqual(r.findings.map((f) => [f.file.replace('intake/attachments/', ''), f.line, f.column, f.rule, f.codePoint]), [
    ['a.html', 1, 5, 'bidi-control', 'U+202E'],
    ['b.htm', 1, 5, 'bidi-control', 'U+202E'],
    ['c.xml', 2, 3, 'bidi-control', 'U+202E'],
    ['d.svg', 1, 14, 'invisible-char', 'U+200B'],
    ['e.xml', 1, 4, 'bidi-control', 'U+202E'],
    ['e.xml', 1, 17, 'bidi-control', 'U+202E'],
  ]);
  assert.match(r.findings[0].message, /&#x202E;/);
  assert.equal(r.blocking, true);
});

test('references to the legitimate joiners are warnings, a BOM reference is an error (a missing semicolon still decodes in html), ordinary references are fine', () => {
  const r = scanAttachments(attachments({
    'a.html': '<p>a&#x200D;b&#8204;c</p>\n',
    'b.html': '<p>&#xFEFF;</p>\n',
    'c.html': '<p>&amp; &#169; &#x41; &#0; &#x110000; &#xZZ;</p>\n',
    'd.html': '<p>&#x202E</p>\n',
  }));
  assert.deepEqual(r.findings.map((f) => [f.file.replace('intake/attachments/', ''), f.rule, f.severity, f.column]), [
    ['a.html', 'joiner', 'warn', 5],
    ['a.html', 'joiner', 'warn', 14],
    ['b.html', 'invisible-char', 'error', 4],
    ['d.html', 'bidi-control', 'error', 4],
  ]);
});

test('references are decoded in the XML parts of docx, pptx, xlsx and odt, and are plain text elsewhere', () => {
  const r = scanAttachments(attachments({
    'brief.docx': zip({ 'word/document.xml': '<w:t>a&#x202E;</w:t>' }),
    'sheet.xlsx': zip({ 'xl/sharedStrings.xml': '<t>&#8203;</t>' }),
    'notes.md': 'a &#x202E; is only text in markdown\n',
    'data.json': '{"a": "&#x202E;"}\n',
  }));
  assert.deepEqual(r.findings.map((f) => [f.file.replace('intake/attachments/', ''), f.column, f.codePoint]), [
    ['brief.docx!word/document.xml', 7, 'U+202E'],
    ['sheet.xlsx!xl/sharedStrings.xml', 4, 'U+200B'],
  ]);
});

test('character references count in the per file cap, and a file with a literal and a referenced character lists both in order', () => {
  const r = scanAttachments(attachments({ 'a.html': `x${RLO}&#x202E;y\n`, 'many.html': '&#x200B;'.repeat(30) }));
  assert.deepEqual(r.findings.filter((f) => f.file.endsWith('a.html')).map((f) => f.column), [2, 3]);
  const many = r.findings.filter((f) => f.file.endsWith('many.html'));
  assert.equal(many.length, 21);
  assert.equal(many[20].total, 30);
});
