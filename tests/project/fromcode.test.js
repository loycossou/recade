import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import {
  fromCode, readingTier, decideConvention, checkRules, checkInvariants, checkRegister,
} from '../../src/project/fromcode.js';
import { readCreated, writeOwnFile } from '../../src/project/adopt.js';
import { REGISTER_FILES, SOURCE_DIR, sourceDir } from '../../src/project/fromcode.js';

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * A workspace (the registry of its state names `repos`) with the files of each code repository under `repos/<name>/`.
 * `files` are added to the first repository, `api`; `others` maps another repository name to its files.
 */
function repo(files = {}, others = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recade-fromcode-'));
  const sets = {
    api: {
      'package.json': '{"name":"fernhill-api"}\n',
      'src/index.js': 'export const x = 1;\n',
      'README.md': '# Fernhill API\n\nA lending desk service.\n',
      'docs/architecture.md': '# Architecture\n\nOne service, one database.\n',
      ...files,
    },
    ...others,
  };
  mkdirSync(join(dir, 'recade'), { recursive: true });
  writeFileSync(join(dir, 'recade', 'state.yaml'), stringify({
    version: 1, kind: 'workspace', mode: 'adopt',
    repos: Object.keys(sets).map((name) => ({ name, path: `repos/${name}`, remote: 'none', default_branch: 'main', role: '', visibility: 'private' })),
  }));
  for (const [name, set] of Object.entries(sets)) {
    for (const [rel, text] of Object.entries(set).filter(([, t]) => t !== undefined)) {
      mkdirSync(join(dir, 'repos', name, rel, '..'), { recursive: true });
      writeFileSync(join(dir, 'repos', name, rel), text);
    }
  }
  return dir;
}

/** The paths a document of the workspace cites for code: relative to the workspace, so under `repos/api/`. */
const ws = (text) => text.replaceAll('src/index.js', 'repos/api/src/index.js').replaceAll('src/three.js', 'repos/api/src/three.js');

const write = (dir, rel, text) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

const RULES_OK = `# Rules

## Golden files

- \`src/index.js\`: the entry point every module copies.

## Rules

- Handlers return a result object, never throw (src/index.js:1).

## DONTs

- Do not read process.env outside the config module.
`;

const INVARIANTS_OK = `# Invariants

## Requirements

### REQ-01 Reject an empty loan
WHEN a loan has no amount THEN the request is refused
enforced: test tests/loan.test.js

## Invariants

### INV-01 Balances never go negative
A balance is never below zero.
enforced: code src/index.js:1
`;

const REGISTER = (rows) => `# Inventory

## Deviations

| ID | Axis | Deviation | Evidence | Severity | Effort |
|---|---|---|---|---|---|
${rows.join('\n')}
`;

// ---- targets ----

test('without --full only RULES, INVARIANTS and CONTRACTS are targeted, in docs/ of the workspace, each with its sections', async () => {
  const dir = repo();
  const r = await fromCode(dir, { full: false });
  assert.deepEqual(r.targets.map((t) => t.doc), ['docs/RULES.md', 'docs/INVARIANTS.md', 'docs/CONTRACTS.md']);
  assert.deepEqual(r.targets[0].sections, ['Golden files', 'Rules', 'DONTs']);
  assert.deepEqual(r.targets[1].sections, ['Requirements', 'Invariants']);
  assert.ok(r.targets.every((t) => t.exists === false));
});

test('with --full the targets are D1, D2 and D3 with the sections of their templates', async () => {
  const dir = repo();
  const r = await fromCode(dir, { full: true });
  assert.deepEqual(r.targets.map((t) => t.doc), ['docs/D1.md', 'docs/D2.md', 'docs/D3.md']);
  assert.ok(r.targets[0].sections.includes('1. Purpose and reading conventions'));
  assert.ok(r.targets[1].sections.includes('5. Data model and integrity'));
  assert.ok(r.targets[2].sections.includes('1. Security decisions'));
});

test('a D1 in a code repository changes nothing: the targets are always the workspace docs, never docs/recade/', async () => {
  const dir = repo({ 'docs/D1.md': '# Our own D1\n' });
  const r = await fromCode(dir, { full: true });
  assert.equal(r.targets[0].doc, 'docs/D1.md');
  assert.equal(r.targets[0].exists, false, 'the owner D1 is a source document of a repository, not the workspace D1');
  assert.ok(r.sources.some((s) => s.path === 'repos/api/docs/D1.md'));
  assert.equal(existsSync(join(dir, 'docs', 'recade')), false);
});

test('the sources live in docs/source/<repo>/ and the register in docs/inventory.md', () => {
  assert.equal(SOURCE_DIR, 'docs/source');
  assert.equal(sourceDir('api'), 'docs/source/api');
  assert.deepEqual([...REGISTER_FILES], ['docs/inventory.md']);
});

// ---- existing documents ----

test('existing documents are copied under docs/source/<repo>, byte for byte, and each target cites them by ID', async () => {
  const dir = repo();
  const original = (rel) => join(dir, 'repos', 'api', rel);
  const before = { readme: sha(original('README.md')), arch: sha(original('docs/architecture.md')) };
  const r = await fromCode(dir, { full: false });
  assert.deepEqual(r.sources.map((s) => [s.id, s.path]), [['SRC-01', 'repos/api/README.md'], ['SRC-02', 'repos/api/docs/architecture.md']]);
  assert.deepEqual(r.sources.map((s) => s.copy), ['docs/source/api/README.md', 'docs/source/api/docs/architecture.md']);
  assert.equal(sha(join(dir, 'docs/source/api/README.md')), before.readme);
  assert.equal(sha(join(dir, 'docs/source/api/docs/architecture.md')), before.arch);
  assert.equal(sha(original('README.md')), before.readme, 'the original is never edited');
  assert.equal(sha(original('docs/architecture.md')), before.arch);
  for (const t of r.targets) assert.deepEqual(t.cites, ['SRC-01', 'SRC-02']);
  const created = readCreated(dir);
  assert.ok(created.includes('docs/source/api/README.md') && created.includes('docs/source/INDEX.md'));
  assert.deepEqual(readCreated(join(dir, 'repos', 'api')), [], 'nothing is written in the code repository');
  const index = readFileSync(join(dir, 'docs/source/INDEX.md'), 'utf8');
  assert.match(index, /\| SRC-01 \| repos\/api\/README\.md \|/);
  assert.match(index, /\| SRC-02 \| repos\/api\/docs\/architecture\.md \|/);
});

test('two repositories: the copies go to docs/source/api/ and docs/source/web/, with one index and IDs that never repeat', async () => {
  const dir = repo({}, { web: { 'package.json': '{"name":"fernhill-web"}\n', 'README.md': '# Fernhill web\n' } });
  const r = await fromCode(dir, { full: false });
  assert.deepEqual(r.sources.map((s) => [s.id, s.path]), [
    ['SRC-01', 'repos/api/README.md'], ['SRC-02', 'repos/api/docs/architecture.md'], ['SRC-03', 'repos/web/README.md'],
  ]);
  assert.ok(existsSync(join(dir, 'docs/source/api/README.md')) && existsSync(join(dir, 'docs/source/web/README.md')));
  assert.equal(readFileSync(join(dir, 'docs/source/web/README.md'), 'utf8'), '# Fernhill web\n');
  assert.deepEqual(r.targets[0].cites, ['SRC-01', 'SRC-02', 'SRC-03']);
  assert.equal(r.reading.files, 3, 'the files of every repository are counted: two manifests and one source file');
});

test('a registered repository whose folder is missing is a gap that names recade repo sync; an empty registry is a gap too', async () => {
  const dir = repo();
  rmSync(join(dir, 'repos', 'api'), { recursive: true });
  const r = await fromCode(dir, { full: false });
  assert.ok(r.gaps.some((g) => g.includes('api') && /recade repo sync/.test(g)), r.gaps.join('\n'));
  const empty = mkdtempSync(join(tmpdir(), 'recade-fromcode-'));
  mkdirSync(join(empty, 'recade'));
  writeFileSync(join(empty, 'recade', 'state.yaml'), 'version: 1\nkind: workspace\n');
  assert.ok((await fromCode(empty, { full: false })).gaps.some((g) => /no code repository/i.test(g)));
});

test('a second run keeps the same IDs and changes nothing; a new document gets the next ID', async () => {
  const dir = repo();
  await fromCode(dir, { full: false });
  const idx = sha(join(dir, 'docs/source/INDEX.md'));
  const again = await fromCode(dir, { full: false });
  assert.deepEqual(again.sources.map((s) => s.id), ['SRC-01', 'SRC-02']);
  assert.equal(sha(join(dir, 'docs/source/INDEX.md')), idx);
  assert.deepEqual(again.gaps, []);
  write(dir, 'repos/api/docs/api-guide.md', '# API guide\n');
  const more = await fromCode(dir, { full: false });
  assert.deepEqual(more.sources.map((s) => [s.id, s.path]), [['SRC-01', 'repos/api/README.md'], ['SRC-02', 'repos/api/docs/architecture.md'], ['SRC-03', 'repos/api/docs/api-guide.md']]);
});

test('documents Recade wrote in a code repository, changelogs and agent instruction files are not ingested', async () => {
  const dir = repo({ 'CHANGELOG.md': '# Changes\n', 'CLAUDE.md': '# Instructions\n' });
  writeOwnFile(join(dir, 'repos', 'api'), 'docs/generated.md', '# Written by Recade\n');
  const r = await fromCode(dir, { full: false });
  assert.deepEqual(r.sources.map((s) => s.path), ['repos/api/README.md', 'repos/api/docs/architecture.md']);
});

test('a copy the owner edited is kept and listed as a gap; the original is read again only when it changes', async () => {
  const dir = repo();
  await fromCode(dir, { full: false });
  write(dir, 'docs/source/api/README.md', '# my notes\n');
  write(dir, 'repos/api/README.md', '# Fernhill API, new text\n');
  const r = await fromCode(dir, { full: false });
  assert.equal(readFileSync(join(dir, 'docs/source/api/README.md'), 'utf8'), '# my notes\n');
  assert.ok(r.gaps.some((g) => g.includes('docs/source/api/README.md') && /edited/.test(g)), r.gaps.join('\n'));
});

test('a document that changed at the source and whose copy is untouched is copied again', async () => {
  const dir = repo();
  await fromCode(dir, { full: false });
  write(dir, 'repos/api/README.md', '# Fernhill API, new text\n');
  const r = await fromCode(dir, { full: false });
  assert.equal(readFileSync(join(dir, 'docs/source/api/README.md'), 'utf8'), '# Fernhill API, new text\n');
  assert.deepEqual(r.gaps, []);
});

test('a document over the size cap is a gap, not a copy', async () => {
  const dir = repo({ 'docs/huge.md': 'x'.repeat(600 * 1024) });
  const r = await fromCode(dir, { full: false });
  assert.ok(r.gaps.some((g) => g.includes('docs/huge.md') && /too large/.test(g)));
  assert.equal(existsSync(join(dir, 'docs/source/api/docs/huge.md')), false);
});

test('a target that cites no source or an unknown one is a gap', async () => {
  const dir = repo();
  write(dir, 'docs/RULES.md', ws(RULES_OK));
  const none = await fromCode(dir, { full: false });
  assert.ok(none.gaps.some((g) => g.includes('docs/RULES.md') && /cites no source/.test(g)));
  write(dir, 'docs/RULES.md', `${ws(RULES_OK)}\nSee SRC-09 and SRC-01.\n`);
  const dangling = await fromCode(dir, { full: false });
  assert.ok(dangling.gaps.some((g) => g.includes('SRC-09') && /not in/.test(g)));
  assert.ok(!dangling.gaps.some((g) => /cites no source/.test(g)));
});

test('a repository with no existing document has no source and no cite gap', async () => {
  const bare = repo({ 'README.md': undefined, 'docs/architecture.md': undefined });
  write(bare, 'docs/RULES.md', ws(RULES_OK));
  write(bare, 'docs/inventory.md', REGISTER([]));
  const r = await fromCode(bare, { full: false });
  assert.deepEqual(r.sources, []);
  assert.deepEqual(r.gaps, []);
  assert.equal(existsSync(join(bare, 'docs/source')), false, 'nothing is copied');
});

// ---- the shapes ----

test('RULES.md without the three sections in order gives a gap for each missing or misplaced one', () => {
  assert.deepEqual(checkRules(RULES_OK, { file: 'RULES.md' }), []);
  const noDonts = RULES_OK.replace(/## DONTs[\s\S]*/, '');
  assert.deepEqual(checkRules(noDonts, { file: 'RULES.md' }), ['RULES.md: the section "DONTs" is missing.']);
  const none = checkRules('# Rules\n\nBe nice.\n', { file: 'RULES.md' });
  assert.equal(none.length, 3);
  const swapped = '## Rules\n\n- a\n\n## Golden files\n\n- `src/index.js`: why\n\n## DONTs\n\n- b\n';
  assert.ok(checkRules(swapped, { file: 'RULES.md' }).some((g) => /order/.test(g)));
});

test('a golden file entry needs a path and one line on why, and an exemplar that does not exist is a gap', () => {
  const bad = RULES_OK.replace('- `src/index.js`: the entry point every module copies.', '- src/index.js\n- `src/gone.js`: why it matters');
  const gaps = checkRules(bad, { file: 'RULES.md', exists: (p) => p === 'src/index.js' });
  assert.ok(gaps.some((g) => /entry without a path and a reason/.test(g)), gaps.join('\n'));
  assert.ok(gaps.some((g) => g.includes('src/gone.js') && /does not exist/.test(g)));
  const empty = RULES_OK.replace(/- `src\/index.js`.*\n/, '');
  assert.ok(checkRules(empty, { file: 'RULES.md' }).some((g) => /lists no exemplar/.test(g)));
});

test('an invariant without enforced gives a gap; a requirement needs WHEN and THEN', () => {
  assert.deepEqual(checkInvariants(INVARIANTS_OK, { file: 'INV.md' }).gaps, []);
  const noEnforced = INVARIANTS_OK.replace('enforced: code src/index.js:1\n', '');
  const r = checkInvariants(noEnforced, { file: 'INV.md' });
  assert.deepEqual(r.gaps, ['INV.md: INV-01 has no "enforced:" line (test <path>, code <path:line> or no).']);
  const badReq = INVARIANTS_OK.replace('WHEN a loan has no amount THEN the request is refused', 'A loan needs an amount.');
  assert.ok(checkInvariants(badReq, { file: 'INV.md' }).gaps.some((g) => g.includes('REQ-01') && /WHEN/.test(g)));
  const badValue = INVARIANTS_OK.replace('enforced: test tests/loan.test.js', 'enforced: maybe');
  assert.ok(checkInvariants(badValue, { file: 'INV.md' }).gaps.some((g) => g.includes('REQ-01') && /enforced/.test(g)));
  const badCode = INVARIANTS_OK.replace('enforced: code src/index.js:1', 'enforced: code src/index.js');
  assert.ok(checkInvariants(badCode, { file: 'INV.md' }).gaps.some((g) => g.includes('INV-01') && /path:line/.test(g)));
});

test('an invariant enforced: no is listed so that it also becomes a register row', () => {
  const text = INVARIANTS_OK.replace('enforced: code src/index.js:1', 'enforced: no');
  const r = checkInvariants(text, { file: 'INV.md' });
  assert.deepEqual(r.gaps, []);
  assert.deepEqual(r.unenforced, ['INV-01']);
});

test('the register refuses a row with no evidence and keeps the valid ones', () => {
  const text = REGISTER([
    '| DEV-01 | practice | Handlers throw in two places | src/index.js:12 | P2 | S |',
    '| DEV-02 | missing capability | No retry on payouts | | P1 | M |',
    '| DEV-03 | technical choice | Home made queue | the team says so | P3 | L |',
  ]);
  const r = checkRegister(text, { file: 'docs/inventory.md' });
  assert.deepEqual(r.rows.map((x) => x.id), ['DEV-01']);
  assert.equal(r.gaps.length, 2);
  assert.ok(r.gaps[0].includes('DEV-02') && /evidence/.test(r.gaps[0]));
  assert.ok(r.gaps[1].includes('DEV-03'));
});

test('the register checks the axis, the severity and the effort, and an evidence file that does not exist', () => {
  const text = REGISTER([
    '| DEV-01 | opinion | x | src/index.js:1 | P2 | S |',
    '| DEV-02 | practice | x | src/index.js:1 | P4 | S |',
    '| DEV-03 | practice | x | src/index.js:1 | P2 | XL |',
    '| DEV-04 | unwritten reasoning | x | src/gone.js:3 | P0 | M |',
    '| DEV-05 | Unwritten Reasoning | fine | src/index.js:3 | P0 | M |',
  ]);
  const r = checkRegister(text, { file: 'inv.md', exists: (p) => p === 'src/index.js' });
  assert.deepEqual(r.rows.map((x) => x.id), ['DEV-05']);
  assert.ok(r.gaps.some((g) => g.includes('DEV-01') && /axis/.test(g)));
  assert.ok(r.gaps.some((g) => g.includes('DEV-02') && /severity/.test(g)));
  assert.ok(r.gaps.some((g) => g.includes('DEV-03') && /effort/.test(g)));
  assert.ok(r.gaps.some((g) => g.includes('DEV-04') && /does not exist/.test(g)));
});

test('a file with no Deviations section has no register', () => {
  assert.equal(checkRegister('# Inventory\n', { file: 'inv.md' }).found, false);
  assert.equal(checkRegister(REGISTER([]), { file: 'inv.md' }).found, true);
});

// ---- fromCode reads what the agent wrote ----

test('fromCode reports the gaps of the files the code reader wrote, with the register beside the inventory', async () => {
  const dir = repo();
  write(dir, 'docs/RULES.md', ws(RULES_OK).replace(/## DONTs[\s\S]*/, ''));
  write(dir, 'docs/INVARIANTS.md', ws(INVARIANTS_OK).replace('enforced: code repos/api/src/index.js:1', 'enforced: no'));
  write(dir, 'docs/inventory.md', REGISTER(['| DEV-01 | practice | Handlers throw | repos/api/src/index.js:2 | P2 | S |', '| DEV-02 | missing capability | No retry | | P1 | M |']));
  const r = await fromCode(dir, { full: false });
  assert.ok(r.gaps.some((g) => g.includes('docs/RULES.md') && g.includes('"DONTs"')));
  assert.ok(r.gaps.some((g) => g.includes('DEV-02') && /evidence/.test(g)));
  assert.ok(r.gaps.some((g) => g.includes('INV-01') && /deviations register/.test(g)), 'enforced: no needs a register row');
  assert.equal(r.targets.find((t) => t.doc.endsWith('RULES.md')).exists, true);
  assert.equal(r.register.file, 'docs/inventory.md');
});

test('a golden file or an evidence path that is not under repos/<name>/ does not exist in the workspace and is a gap', async () => {
  const dir = repo();
  write(dir, 'docs/RULES.md', RULES_OK);
  const r = await fromCode(dir, { full: false });
  assert.ok(r.gaps.some((g) => g.includes('docs/RULES.md') && g.includes('src/index.js') && /does not exist/.test(g)), r.gaps.join('\n'));
});

test('an enforced: no invariant with a register row that names it is not a gap', async () => {
  const dir = repo();
  write(dir, 'docs/INVARIANTS.md', ws(INVARIANTS_OK).replace('enforced: code repos/api/src/index.js:1', 'enforced: no'));
  write(dir, 'docs/inventory.md', REGISTER(['| DEV-01 | missing capability | INV-01 is not enforced anywhere | repos/api/src/index.js:1 | P1 | M |']));
  const r = await fromCode(dir, { full: false });
  assert.ok(!r.gaps.some((g) => g.includes('INV-01')), r.gaps.join('\n'));
});

test('a register in docs/recade/ is never read: the register is docs/inventory.md', async () => {
  const dir = repo();
  write(dir, 'docs/RULES.md', ws(RULES_OK));
  write(dir, 'docs/recade/inventory.md', REGISTER(['| DEV-01 | practice | x | repos/api/src/index.js:2 | P2 | S |']));
  const r = await fromCode(dir, { full: false });
  assert.equal(r.register, null);
  assert.ok(r.gaps.some((g) => /no deviations register/.test(g) && g.includes('docs/inventory.md')));
});

test('once a target is written and there is no register anywhere, that is a gap', async () => {
  const dir = repo();
  write(dir, 'docs/RULES.md', ws(RULES_OK));
  const r = await fromCode(dir, { full: false });
  assert.ok(r.gaps.some((g) => /no deviations register/.test(g)));
});

// ---- reading tiers and conventions ----

test('the reading tier follows the size of the repository', () => {
  assert.deepEqual(readingTier(0), { tier: 'all', files: 0, maxFilesPerCapability: null });
  assert.equal(readingTier(49).tier, 'all');
  assert.equal(readingTier(50).tier, 'sample');
  assert.equal(readingTier(500).tier, 'sample');
  assert.deepEqual(readingTier(501), { tier: 'entry-points', files: 501, maxFilesPerCapability: 15 });
});

test('fromCode counts the source files and gives the tier, never counting documents, locks or vendored folders', async () => {
  const dir = repo();
  for (let i = 0; i < 60; i++) write(dir, `repos/api/src/m${i}.js`, 'export {};\n');
  write(dir, 'repos/api/node_modules/x/index.js', 'x');
  write(dir, 'repos/api/package-lock.json', '{}');
  const r = await fromCode(dir, { full: false });
  assert.equal(r.reading.tier, 'sample');
  assert.equal(r.reading.files, 62, 'index.js, package.json and 60 modules');
  const many = await fromCode(dir, { full: false, fileCount: 800 });
  assert.equal(many.reading.tier, 'entry-points');
});

test('a convention followed by over 95 percent, or with fewer than 10 counter cases, is a rule; a close split is a question', () => {
  assert.equal(decideConvention({ followers: 970, counter: 30 }), 'rule', '97 percent');
  assert.equal(decideConvention({ followers: 950, counter: 50 }), 'ask', 'exactly 95 percent is not over it');
  assert.equal(decideConvention({ followers: 40, counter: 9 }), 'rule', 'fewer than 10 counter cases');
  assert.equal(decideConvention({ followers: 40, counter: 10 }), 'ask', '10 counter cases is not fewer than 10');
  assert.equal(decideConvention({ followers: 55, counter: 45 }), 'ask', 'a close split');
  assert.equal(decideConvention({ followers: 5, counter: 5 }), 'ask', 'a tie is never a rule, whatever the counter');
  assert.equal(decideConvention({ followers: 6, counter: 4 }), 'ask', 'fewer than 10 counter cases but no clear majority');
  assert.equal(decideConvention({ followers: 8, counter: 2 }), 'rule');
  assert.equal(decideConvention({ followers: 0, counter: 0 }), 'ask');
});

// ---- review fixes ----

test('an enforced: no invariant is matched to a register row by its exact ID, not by a longer one', async () => {
  const dir = repo();
  write(dir, 'docs/INVARIANTS.md', ws(INVARIANTS_OK).replace('INV-01', 'INV-1').replace('enforced: code repos/api/src/index.js:1', 'enforced: no'));
  write(dir, 'docs/inventory.md', REGISTER(['| DEV-01 | missing capability | INV-12 is not enforced anywhere | repos/api/src/index.js:1 | P1 | M |']));
  const r = await fromCode(dir, { full: false });
  assert.ok(r.gaps.some((g) => g.includes('INV-1 ') && /deviations register/.test(g)), r.gaps.join('\n'));
  write(dir, 'docs/inventory.md', REGISTER(['| DEV-01 | missing capability | INV-12 is not enforced anywhere | repos/api/src/index.js:1 | P1 | M |', '| DEV-02 | missing capability | INV-1 is not enforced | repos/api/src/index.js:1 | P1 | M |']));
  assert.ok(!(await fromCode(dir, { full: false })).gaps.some((g) => g.includes('INV-1 ')));
});

test('an evidence line must be 1 or more, and within the file when the file is known', async () => {
  const dir = repo({ 'src/three.js': 'a\nb\nc\n' });
  const lines = (p) => (p === 'src/three.js' ? 3 : null);
  const text = REGISTER([
    '| DEV-01 | practice | x | src/three.js:0 | P2 | S |',
    '| DEV-02 | practice | x | src/three.js:99999 | P2 | S |',
    '| DEV-03 | practice | x | src/three.js:3 | P2 | S |',
  ]);
  const r = checkRegister(text, { file: 'inv.md', exists: () => true, lines });
  assert.deepEqual(r.rows.map((x) => x.id), ['DEV-03']);
  assert.ok(r.gaps.some((g) => g.includes('DEV-01') && /line/.test(g)));
  assert.ok(r.gaps.some((g) => g.includes('DEV-02') && /beyond/.test(g)));
  assert.ok(checkRegister(REGISTER(['| DEV-01 | practice | x | a.js:0 | P2 | S |']), { file: 'inv.md' }).gaps.length === 1, 'line 0 is refused even without a file check');
  const inv = checkInvariants(INVARIANTS_OK.replace('enforced: code src/index.js:1', 'enforced: code src/three.js:50'), { file: 'INV.md', exists: () => true, lines });
  assert.ok(inv.gaps.some((g) => g.includes('INV-01') && /beyond/.test(g)));
  const zero = checkInvariants(INVARIANTS_OK.replace('enforced: code src/index.js:1', 'enforced: code src/three.js:0'), { file: 'INV.md' });
  assert.ok(zero.gaps.some((g) => g.includes('INV-01') && /line/.test(g)));
  write(dir, 'docs/inventory.md', text.replaceAll('src/three.js', 'repos/api/src/three.js'));
  write(dir, 'docs/RULES.md', ws(RULES_OK));
  const full = await fromCode(dir, { full: false });
  assert.ok(full.gaps.some((g) => g.includes('DEV-02') && /beyond/.test(g)), 'fromCode reads the files for the line count');
});

test('a source ID is never reused: the index keeps the removed ones and a returning document gets its old ID', async () => {
  const dir = repo();
  await fromCode(dir, { full: false });
  rmSync(join(dir, 'repos/api/docs/architecture.md'));
  const gone = await fromCode(dir, { full: false });
  assert.deepEqual(gone.sources.map((s) => s.id), ['SRC-01']);
  write(dir, 'repos/api/docs/api-guide.md', '# API guide\n');
  const next = await fromCode(dir, { full: false });
  assert.deepEqual(next.sources.map((s) => [s.id, s.path]), [['SRC-01', 'repos/api/README.md'], ['SRC-03', 'repos/api/docs/api-guide.md']], 'SRC-02 is not given again');
  assert.match(readFileSync(join(dir, 'docs/source/INDEX.md'), 'utf8'), /SRC-02 \| repos\/api\/docs\/architecture\.md \(removed\)/);
  write(dir, 'repos/api/docs/architecture.md', '# Architecture\n\nOne service, one database.\n');
  const back = await fromCode(dir, { full: false });
  assert.ok(back.sources.some((s) => s.id === 'SRC-02' && s.path === 'repos/api/docs/architecture.md'));
  write(dir, 'docs/RULES.md', `${ws(RULES_OK)}\nSee SRC-01.\n`);
  rmSync(join(dir, 'repos/api/README.md'));
  const cites = await fromCode(dir, { full: false });
  assert.ok(cites.gaps.some((g) => g.includes('SRC-01') && /removed/.test(g)));
});
