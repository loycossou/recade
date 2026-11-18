import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { ID_PATTERN, buildIdPattern } from '../src/index/ids.js';
import { extractDefinitions, extractCitations, extractLineAnchors } from '../src/index/extract.js';
import { buildIndex, renderIndexMd, checkCitations, checkRoot } from '../src/index/check.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/index/${name}`, import.meta.url), 'utf8');

function sandbox(...names) {
  const root = mkdtempSync(join(tmpdir(), 'recade-index-'));
  for (const name of names) {
    copyFileSync(new URL(`./fixtures/index/${name}`, import.meta.url), join(root, name));
  }
  return root;
}

function makeIO(cwd) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {} },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

const ids = (text, lots) => [...text.matchAll(buildIdPattern(lots))].map((m) => m[0]);

test('ID grammar covers the spec forms with word boundaries', () => {
  const ok = 'FR-PAY-03 NFR-01 PAR-12 PRI-01 DEC-10 ADR-100 SEC-AUT-01 SEC-A12 TB-1 RSK-05 EXT-02 Q-07 PRV-01 S-01 S-01b INC-3 M1 M12';
  assert.equal(ids(ok).length, ok.split(' ').length);
  assert.deepEqual(ids('FR-PAY-0345 NFR-1 xM1 M123 S-1'), []);
  assert.deepEqual(ids('BKL-01 and BKL-1', ['BKL']), ['BKL-01']);
  assert.deepEqual(ids('BKL-01'), []);
  assert.ok(ID_PATTERN.global);
});

test('table rows and headings define IDs with their title', () => {
  const d1 = extractDefinitions(fixture('D1.md'), 'D1.md', { lots: [] });
  assert.deepEqual(d1, [
    { id: 'FR-PAY-03', file: 'D1.md', line: 5, title: 'Refund only within 24 h' },
    { id: 'NFR-01', file: 'D1.md', line: 6, title: 'Pages load in under 2 s' },
    { id: 'S-01', file: 'D1.md', line: 7, title: 'Checkout slice' },
  ]);
  const bad = extractDefinitions(fixture('bad.md'), 'bad.md', { lots: [] });
  assert.deepEqual(bad[0], { id: 'DEC-07', file: 'bad.md', line: 3, title: 'Use a single database' });
  assert.equal(bad.length, 2);
});

test('a row whose first cell is not exactly one ID is not a definition', () => {
  const md = '| ID | Title |\n|---|---|\n| FR-PAY-03 and NFR-01 | two |\n| see FR-PAY-03 | cite |\n| Name | Title |\n';
  assert.deepEqual(extractDefinitions(md, 'x.md', { lots: [] }), []);
});

test('only a table whose header starts with ID defines IDs', () => {
  const opts = { lots: [] };
  const ids = (md) => extractDefinitions(md, 'x.md', opts).map((d) => d.id);
  // Traceability table in a BIBLE: the first cell is a requirement, not a definition.
  assert.deepEqual(ids('| Requirement | Where |\n|---|---|\n| FR-PAY-03 | Enforce in refund service |\n'), []);
  assert.deepEqual(ids('| FR-PAY-03 | Enforce in refund service |\n'), []);
  // STATUS table.
  assert.deepEqual(ids('| Slice | State |\n|---|---|\n| S-01 | done |\n| S-02 | open |\n'), []);
  // Header spellings that count.
  for (const header of ['ID', 'id', 'Id', '**ID**', '`ID`', '__id__', ' ID ']) {
    assert.deepEqual(ids(`| ${header} | Title |\n|---|---|\n| FR-PAY-03 | Refund |\n`), ['FR-PAY-03'], header);
  }
  // Header spellings that do not.
  for (const header of ['IDs', 'ID code', 'Item ID', 'No']) {
    assert.deepEqual(ids(`| ${header} | Title |\n|---|---|\n| FR-PAY-03 | Refund |\n`), [], header);
  }
  // Each table has its own header.
  const two = '| ID | Title |\n|---|---|\n| FR-PAY-03 | A |\n\n| Slice | State |\n|---|---|\n| S-01 | done |\n';
  assert.deepEqual(ids(two), ['FR-PAY-03']);
  const back = '| Slice | State |\n|---|---|\n| S-01 | done |\n\n| ID | Title |\n|---|---|\n| NFR-01 | B |\n';
  assert.deepEqual(ids(back), ['NFR-01']);
  // Rows of an ID table keep defining after a fenced block elsewhere.
  assert.deepEqual(ids('```\n| ID | T |\n```\n| FR-PAY-03 | A |\n'), []);
});

test('rows of a non-ID table are citations', () => {
  const md = '| Requirement | Where |\n|---|---|\n| FR-PAY-03 | Enforce in refund service |\n';
  assert.deepEqual(extractCitations(md, 'x.md', {}).map((c) => [c.id, c.line, c.column]), [['FR-PAY-03', 3, 3]]);
});

test('headings from H1 to H4 define IDs, with an optional colon', () => {
  const md = [
    '# DEC-08 One database', '## DEC-07: Use Postgres', '### DEC-09 - Dash title', '#### DEC-10', '##### DEC-11 Too deep',
    '## DEC-12:No space', '## DEC-123x Not an ID', '## See DEC-13',
  ].join('\n');
  assert.deepEqual(extractDefinitions(md, 'x.md', { lots: [] }).map((d) => [d.id, d.line, d.title]), [
    ['DEC-08', 1, 'One database'],
    ['DEC-07', 2, 'Use Postgres'],
    ['DEC-09', 3, 'Dash title'],
    ['DEC-10', 4, ''],
    ['DEC-12', 6, 'No space'],
  ]);
  assert.deepEqual(extractCitations('## DEC-07: Use Postgres, see NFR-01\n', 'x.md', {}).map((c) => c.id), ['NFR-01']);
});

test('citation with matching gist yields no finding', () => {
  const index = { definitions: extractDefinitions(fixture('D1.md'), 'D1.md', {}), duplicates: [] };
  const cites = extractCitations('Refunds follow FR-PAY-03 (refund only within 24 h).\n', 'B.md', {});
  assert.equal(cites.length, 1);
  assert.equal(cites[0].gist, 'refund only within 24 h');
  assert.deepEqual(checkCitations(index, cites), []);
});

test('unknown id is an error, missing gist a warning', () => {
  const index = { definitions: extractDefinitions(fixture('D1.md'), 'D1.md', {}), duplicates: [] };
  const cites = extractCitations(fixture('BIBLE.md'), 'BIBLE.md', {});
  const findings = checkCitations(index, cites);
  const unknown = findings.filter((f) => f.rule === 'unknown-id');
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].severity, 'error');
  assert.equal(unknown[0].line, 5);
  assert.match(unknown[0].message, /FR-PAY-99/);
  const missing = findings.filter((f) => f.rule === 'missing-gist');
  assert.equal(missing.length, 1);
  assert.equal(missing[0].severity, 'warn');
  assert.equal(missing[0].line, 4);
  assert.equal(missing[0].file, 'BIBLE.md');
  assert.ok(Number.isInteger(missing[0].column) && missing[0].column >= 1);
});

test('line anchors are errors', () => {
  const anchors = extractLineAnchors(fixture('BIBLE.md'), 'BIBLE.md');
  assert.equal(anchors.length, 1);
  const findings = checkCitations({ definitions: [], duplicates: [] }, [], anchors);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'line-anchor');
  assert.equal(findings[0].severity, 'error');
  assert.equal(findings[0].line, 6);
  assert.match(findings[0].message, /D1\.md:42/);
});

test('line anchors are found in code spans and fenced blocks too', () => {
  const md = 'Cite `D1.md:42` here, or (D1.md:7).\n\n```\nsee BIBLE.md:3\n```\n';
  const anchors = extractLineAnchors(md, 'x.md');
  assert.deepEqual(anchors.map((a) => [a.anchor, a.line, a.column]), [
    ['D1.md:42', 1, 7],
    ['D1.md:7', 1, 27],
    ['BIBLE.md:3', 4, 5],
  ]);
  const findings = checkCitations({ definitions: [], duplicates: [] }, [], anchors);
  assert.deepEqual(findings.map((f) => f.rule), ['line-anchor', 'line-anchor', 'line-anchor']);
  assert.ok(findings.every((f) => f.severity === 'error'));
});

test('IDs in code, backticks and URLs are not citations', () => {
  const cites = extractCitations(fixture('BIBLE.md'), 'BIBLE.md', {});
  assert.deepEqual(cites.map((c) => [c.id, c.line]), [['FR-PAY-03', 3], ['NFR-01', 4], ['FR-PAY-99', 5]]);
  const tilde = extractCitations('~~~\nM1\n~~~\nM2 here and `M3` and <https://x.io/M4>\n', 'x.md', {});
  assert.deepEqual(tilde.map((c) => c.id), ['M2']);
});

test('definition cells are not citations, other cells are', () => {
  const md = '| ID | Title |\n|---|---|\n| FR-PAY-03 | Refund, see NFR-01 |\n### DEC-07 Use one database\n';
  assert.deepEqual(extractCitations(md, 'x.md', {}).map((c) => c.id), ['NFR-01']);
});

test('gist-mismatch when the gist no longer matches the title', () => {
  const index = { definitions: extractDefinitions(fixture('D1.md'), 'D1.md', {}), duplicates: [] };
  const cites = extractCitations('FR-PAY-03 (shipping costs for parcels)\n', 'B.md', {});
  const findings = checkCitations(index, cites);
  assert.deepEqual(findings.map((f) => [f.rule, f.severity]), [['gist-mismatch', 'warn']]);
  const accents = extractCitations('FR-PAY-03 (REFUND only within 24 h)\n', 'B.md', {});
  assert.deepEqual(checkCitations(index, accents), []);
});

test('duplicate definition across files is an error', () => {
  const root = sandbox('D1.md', 'bad.md');
  const index = buildIndex(root, {});
  assert.equal(index.duplicates.length, 1);
  assert.equal(index.definitions.filter((d) => d.id === 'FR-PAY-03').length, 1);
  const findings = checkCitations(index, []);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'duplicate-id');
  assert.equal(findings[0].severity, 'error');
  assert.match(findings[0].message, /D1\.md/);
  rmSync(root, { recursive: true });
});

test('INDEX.md is sorted, has the banner, no line numbers', () => {
  const root = sandbox('D1.md', 'bad.md');
  const md = renderIndexMd(buildIndex(root, {}).definitions);
  const lines = md.split('\n');
  assert.equal(lines[0], '<!-- Generated by recade index build. Do not edit. -->');
  assert.ok(md.includes('| ID | Title | Defined in |'));
  const order = lines.filter((l) => /^\| [A-Z]/.test(l) && !l.startsWith('| ID')).map((l) => l.split(' | ')[0].slice(2));
  assert.deepEqual(order, ['DEC-07', 'FR-PAY-03', 'NFR-01', 'S-01']);
  assert.ok(md.includes('| FR-PAY-03 | Refund only within 24 h | D1.md |'));
  assert.doesNotMatch(md, /\.md:\d/);
  rmSync(root, { recursive: true });
});

test('buildIndex skips the root INDEX.md and checkRoot combines every rule', () => {
  const root = sandbox('D1.md', 'BIBLE.md');
  writeFileSync(join(root, 'INDEX.md'), '| FR-PAY-03 | Stale | old.md |\n');
  const { index, findings } = checkRoot(root, {});
  assert.equal(index.duplicates.length, 0);
  assert.deepEqual(findings.map((f) => f.rule).sort(), ['line-anchor', 'missing-gist', 'unknown-id']);
  rmSync(root, { recursive: true });
});

test('recade index build writes INDEX.md, check exits 1 on errors', async () => {
  const root = sandbox('D1.md', 'BIBLE.md');
  const b = makeIO(root);
  assert.equal(await run(['index', 'build'], b.io), 0);
  assert.match(readFileSync(join(root, 'INDEX.md'), 'utf8'), /^<!-- Generated by recade index build/);
  const c = makeIO(root);
  assert.equal(await run(['index', 'check'], c.io), 1);
  assert.match(c.stdout(), /BIBLE\.md:5:\d+ error unknown-id/);
  assert.match(c.stdout(), /warn missing-gist/);
  rmSync(root, { recursive: true });
});

test('recade index check exits 0 when only warnings remain', async () => {
  const root = sandbox('D1.md');
  writeFileSync(join(root, 'ok.md'), 'NFR-01 holds.\n');
  const c = makeIO(root);
  assert.equal(await run(['index', 'check', root], c.io), 0);
  assert.match(c.stdout(), /warn missing-gist/);
  rmSync(root, { recursive: true });
});

test('recade index build exits 2 when INDEX.md cannot be written', async () => {
  const root = sandbox('D1.md');
  mkdirSync(join(root, 'INDEX.md'));
  const t = makeIO(root);
  assert.equal(await run(['index', 'build'], t.io), 2);
  assert.match(t.stderr(), /^Cannot write INDEX\.md: /);
  rmSync(root, { recursive: true });
});

test('--lots adds backlog ids, bad usage exits 2', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-index-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'backlog.md'), '| ID | Title |\n|---|---|\n| BKL-01 | Set up CI |\n');
  writeFileSync(join(root, 'a.md'), 'Do BKL-01 (set up CI) then BKL-02 (ghost).\n');
  const withLots = makeIO(root);
  assert.equal(await run(['index', 'check', '--lots', 'BKL'], withLots.io), 1);
  assert.match(withLots.stdout(), /unknown-id/);
  assert.match(withLots.stdout(), /BKL-02/);
  assert.doesNotMatch(withLots.stdout(), /BKL-01/);
  const without = makeIO(root);
  assert.equal(await run(['index', 'check'], without.io), 0);
  const bad = makeIO(root);
  assert.equal(await run(['index', 'check', '--lots', 'bad lot'], bad.io), 2);
  assert.equal(await run(['index', 'nope'], makeIO(root).io), 2);
  assert.equal(await run(['index'], makeIO(root).io), 2);
  assert.equal(await run(['index', 'check', '--wat'], makeIO(root).io), 2);
  rmSync(root, { recursive: true });
});

test('a table after a mirror comment defines nothing: its ID cells are citations', () => {
  const md = [
    '| ID | Title |', '|---|---|', '| FR-AB-01 | Real |', '',
    '<!-- mirror -->', '',
    '| ID | Question |', '|---|---|', '| FR-AB-01 | Mirrored |', '',
    '| ID | Other |', '|---|---|', '| FR-AB-02 | Defined again |', '',
  ].join('\n');
  assert.deepEqual(extractDefinitions(md, 'a.md').map((d) => d.id), ['FR-AB-01', 'FR-AB-02']);
  const cites = extractCitations(md, 'a.md').filter((c) => c.line === 9);
  assert.deepEqual(cites.map((c) => c.id), ['FR-AB-01']);
});

test('a mirror table raises no duplicate-id, and a normal ID table still defines', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-mirror-'));
  try {
    writeFileSync(join(root, 'd.md'), '| ID | Title |\n|---|---|\n| RSK-01 | Late data |\n');
    writeFileSync(join(root, 'p.md'), '<!-- mirror -->\n| ID | Risk |\n|---|---|\n| RSK-01 | Late data |\n');
    const { definitions, duplicates } = buildIndex(root);
    assert.deepEqual(definitions.map((d) => [d.id, d.file]), [['RSK-01', 'd.md']]);
    assert.deepEqual(duplicates, []);
    writeFileSync(join(root, 'q.md'), '| ID | Risk |\n|---|---|\n| RSK-01 | Late data |\n');
    assert.equal(buildIndex(root).duplicates.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the mirror marker applies to the next table only, and any other text cancels it', () => {
  const md = [
    '<!-- mirror -->', '', '| ID | A |', '|---|---|', '| FR-AB-01 | x |', '',
    '| ID | B |', '|---|---|', '| FR-AB-02 | y |', '',
    '<!-- mirror -->', 'Some words.', '', '| ID | C |', '|---|---|', '| FR-AB-03 | z |', '',
  ].join('\n');
  assert.deepEqual(extractDefinitions(md, 'a.md').map((d) => d.id), ['FR-AB-02', 'FR-AB-03']);
});

test('front matter is neither scanned for citations nor for definitions', () => {
  const md = '---\ndoc_id: S-01\nincrement: INC-1\ntitle: "FR-AB-01 | x"\n---\n\n# S-01: Slice\n\nSee FR-AB-02 (gist).\n';
  assert.deepEqual(extractCitations(md, 's.md').map((c) => [c.id, c.line]), [['FR-AB-02', 9]]);
  assert.deepEqual(extractDefinitions(md, 's.md').map((d) => [d.id, d.line]), [['S-01', 7]]);
  // a leading rule that never closes is body text, not front matter
  assert.deepEqual(extractCitations('---\nFR-AB-01 (x)\n', 'a.md').map((c) => c.id), ['FR-AB-01']);
});

test('cells of a mirror table raise no missing-gist, but an unknown ID is still an error', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-mirror-gist-'));
  try {
    writeFileSync(join(root, 'd.md'), '| ID | Title |\n|---|---|\n| RSK-01 | Late data |\n');
    writeFileSync(join(root, 'p.md'),
      '<!-- mirror -->\n| ID | Risk |\n|---|---|\n| RSK-01 | Late data |\n| RSK-09 | Ghost |\n\nSee RSK-01.\n');
    const { findings } = checkRoot(root);
    assert.deepEqual(findings.map((f) => [f.file, f.line, f.rule]), [
      ['p.md', 5, 'unknown-id'],
      ['p.md', 7, 'missing-gist'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('front matter with CRLF line endings is skipped too', () => {
  const md = '---\r\ndoc_id: S-01\r\n---\r\n\r\nSee FR-AB-02 (gist).\r\n';
  assert.deepEqual(extractCitations(md, 's.md').map((c) => [c.id, c.line]), [['FR-AB-02', 5]]);
});

test('a translation (D1.fr.md beside D1.md, fr delivered) defines no ID, but its citations are still checked', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-index-'));
  mkdirSync(join(root, 'recade'));
  writeFileSync(join(root, 'recade', 'state.yaml'), 'languages:\n  deliverables: [en, fr]\n');
  const doc = (word, cite) => `| ID | Requirement |\n|---|---|\n| FR-EX-01 | ${word} |\n\nSee ${cite}.\n`;
  writeFileSync(join(root, 'D1.md'), doc('Upload a proof of income', 'FR-EX-01 (upload a proof of income)'));
  writeFileSync(join(root, 'D1.fr.md'), doc('Envoyer un justificatif', 'FR-EX-09 (envoyer)'));
  const { index, findings } = checkRoot(root);
  assert.deepEqual(index.definitions.map((d) => [d.id, d.file]), [['FR-EX-01', 'D1.md']]);
  assert.deepEqual(findings.map((f) => [f.file, f.rule]), [['D1.fr.md', 'unknown-id']]);
  writeFileSync(join(root, 'notes.fr.md'), doc('Autre', 'FR-EX-01 (upload a proof of income)'));
  rmSync(join(root, 'D1.fr.md'));
  assert.equal(checkRoot(root).findings.filter((f) => f.rule === 'duplicate-id').length, 1, 'no base file, so it is a document of its own');
  rmSync(root, { recursive: true, force: true });
});

test('a translation that defines an ID its base does not is an error, and a language that is not delivered is no translation', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-index-'));
  mkdirSync(join(root, 'recade'));
  writeFileSync(join(root, 'recade', 'state.yaml'), 'languages:\n  deliverables: [en, fr]\n');
  const table = (...ids) => `| ID | Requirement |\n|---|---|\n${ids.map((i) => `| ${i} | Thing |\n`).join('')}`;
  writeFileSync(join(root, 'D1.md'), table('FR-EX-01'));
  writeFileSync(join(root, 'D1.fr.md'), table('FR-EX-01', 'FR-EX-02'));
  let f = checkRoot(root).findings;
  assert.deepEqual(f.map((x) => [x.file, x.rule, x.severity]), [['D1.fr.md', 'translation-extra-id', 'error']]);
  assert.match(f[0].message, /FR-EX-02 is defined in this translation but not in D1\.md/);
  writeFileSync(join(root, 'recade', 'state.yaml'), 'languages:\n  deliverables: [en]\n');
  f = checkRoot(root).findings;
  assert.deepEqual(f.map((x) => x.rule), ['duplicate-id'], 'fr is not delivered: D1.fr.md is an ordinary file');
  rmSync(root, { recursive: true, force: true });
});

test('recade index check takes --project <dir>', async () => {
  const root = sandbox('D1.md');
  const elsewhere = makeIO(mkdtempSync(join(tmpdir(), 'recade-index-')));
  assert.equal(await run(['index', 'check', '--project', root], elsewhere.io), 0, elsewhere.stdout() + elsewhere.stderr());
  rmSync(root, { recursive: true, force: true });
});
