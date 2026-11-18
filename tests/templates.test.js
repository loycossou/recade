import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fillTemplate } from '../src/project/scaffold.js';
import { parseDocument } from '../src/render/parse.js';
import { splitFrontMatter } from '../src/render/frontmatter.js';
import { PLAN_SHEETS } from '../src/render/xlsx.js';
import { lintText } from '../src/style/lint.js';
import { checkRoot } from '../src/index/check.js';
import { techSheet } from '../src/harness/claudemd.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const read = (name) => readFileSync(join(DIR, name), 'utf8');

/** Every placeholder a template may use. Task 3 fills these. */
const KNOWN_KEYS = [
  'project', 'title', 'version', 'date', 'author', 'approver', 'language', 'doc_id',
  'role', 'inspired_by', 'model', 'effort', 'source_title', 'source_url',
];
const VALUES = {
  project: 'Fernhill Lending',
  title: 'Fernhill Lending, working title',
  version: '0.1',
  date: '2026-11-13',
  author: 'Project lead, Recade team',
  approver: 'Owner',
  language: 'en',
  doc_id: 'XX-01',
  role: 'architect',
  inspired_by: 'A public expert',
  model: 'sonnet',
  effort: 'high',
  source_title: 'A public talk',
  source_url: 'https://example.com/talk',
};
// Templates filled per slice, decision or increment get a real ID of their own form.
const OWN_ID = { 'slice.md': 'S-01', 'DEC.md': 'DEC-01', 'retro.md': 'INC-1' };

/** name -> {doc_id, headings}. Headings are H2 titles with any leading number removed. */
const DOCS = {
  'D1.md': {
    doc_id: 'D1',
    headings: [
      'Purpose and reading conventions', 'Context, objectives and scope', 'Non-negotiable business principles',
      'Actors, surfaces and roles', 'Module catalogue', 'End-to-end journeys', 'Requirements per module',
      'Optional sections', 'Non-functional requirements', 'Configurable parameters',
      'Acceptance criteria per milestone', 'Exclusions', 'Decisions to close before sign-off',
      'Traceability to backlog', 'Acceptance', 'Annex A. Glossary', 'Annex B. Traceability matrix',
    ],
    ids: ['FR-EX-01', 'NFR-01', 'PAR-01', 'PRI-01', 'Q-01'],
  },
  'D2.md': {
    doc_id: 'D2',
    headings: [
      'Purpose, principles and scope', 'Context, containers and boundaries', 'Infrastructure and cost', 'CI/CD',
      'Data model and integrity', 'API conventions', 'Applications and async jobs',
      'Domain engines and integrations', 'Security summary', 'Observability, backup, recovery and capacity',
      'Technology stack and quality gates', 'Architecture decisions', 'Technical risks', 'Acceptance',
    ],
    ids: ['PRI-10', 'RSK-01'],
    mirrored: ['ADR-01'],
  },
  'D3.md': {
    doc_id: 'D3',
    headings: [
      'Purpose and standards', 'Security decisions', 'Assets, actors, trust boundaries and flows', 'Amendments',
      'Cross-cutting requirements', 'Per-component requirements', 'Channels and operational security',
      'Coverage matrix', 'Residual risks', 'Induced backlog items', 'Open decisions and accepted risks',
    ],
    ids: [
      'SEC-IDN-01', 'SEC-CRY-01', 'SEC-LOG-01', 'SEC-DAT-01', 'SEC-BAK-01', 'SEC-SDL-01', 'SEC-INF-01',
      'SEC-A01', 'TB-1', 'RSK-02',
    ],
  },
  'STACK.md': {
    doc_id: 'STACK',
    headings: [
      'Criteria and weights', 'Candidates per layer', 'Research', 'Spikes', 'Weighted matrix',
      'Risks and exit cost', 'Recommendation and contributor opinions', 'Decision', 'Selected stack',
      'Rejected options', 'Conditions for re-examination', 'Harness technical sheet',
    ],
    ids: ['ADR-01'],
  },
  'PLAN.md': {
    doc_id: 'PLAN',
    headings: ['Increments', ...PLAN_SHEETS.map((s) => s.name)],
    ids: ['INC-1', 'LOT-01', 'M1', 'EXT-01'],
    mirrored: ['DEC-01', 'RSK-01'],
    lots: ['LOT'],
  },
  'BIBLE.md': {
    doc_id: 'BIBLE',
    headings: [
      'Mission and quality bar', 'Mandatory reading order', 'Verified facts', 'Binding documents by precedence',
      'Decisions', 'Invariants', 'Business rules', 'Conventions', 'Design rules', 'Writing voice',
      'Exclusions', 'Blockers and escalation', 'Definition of done', 'Session discipline',
      'Parallelism, WIP limits and model policy', 'Quality gates', 'Prohibitions', 'Where to read state',
    ],
    ids: [],
  },
  'slice.md': {
    doc_id: 'S-01',
    headings: [
      'Goal', 'Scope', 'Out of scope', 'Sources', 'Frozen decisions', 'Interfaces', 'Expected tree', 'Design',
      'Definition of Done', 'Work order', 'Human actions after', 'Implementer prompt',
      'Decided while building', 'Proposed spec changes',
    ],
    ids: ['S-01'],
    frontKeys: [
      'repos', 'branch', 'format', 'lane', 'implementer', 'increment', 'depends_on', 'blocks',
      'external_prerequisite', 'provisionals_used', 'size', 'touches',
    ],
  },
  'DEC.md': {
    doc_id: 'DEC-01',
    headings: [
      'Question', 'Why now', 'Known and unknown', 'Options', 'Recommendation and its price',
      'What would change our mind', 'Repo changes per option', 'Decision',
    ],
    ids: ['DEC-01'],
  },
  'BLOCKERS.md': { doc_id: 'BLOCKERS', headings: ['Today', 'Log'], ids: [] },
  'provisionals.md': { doc_id: 'PROVISIONALS', headings: ['Open', 'Closed'], ids: ['PRV-01', 'PRV-02'] },
  'retro.md': {
    doc_id: 'INC-1',
    headings: [
      'Demo', 'Delivered', 'Decisions', 'Carry-over', 'Provisionals still open', 'Quarantined tests', 'DORA metrics',
      'Cost per slice', 'Recalibrated dates', 'Spec back-ports done', 'How to open the next increment',
    ],
    ids: [],
  },
  'questionnaire.md': {
    doc_id: 'QUESTIONNAIRE',
    headings: [
      'The client and their business', 'The problem', 'The users', 'The scope',
      'Constraints', 'What exists today', 'Integrations', 'The team on the client side', 'Success criteria',
      'Brand', 'Attachments',
    ],
    ids: [],
  },
};
const NAMES = [...Object.keys(DOCS), 'doctrine.md'];

const h2 = (md) =>
  md
    .split('\n')
    .filter((l) => /^## /.test(l))
    .map((l) => l.slice(3).trim());
const strip = (h) => h.replace(/^\d+\s*[.)]?\s*/, '');
const filled = (name) => fillTemplate(read(name), { ...VALUES, doc_id: OWN_ID[name] ?? VALUES.doc_id });

test('the templates folder holds exactly the expected files plus a README', () => {
  assert.deepEqual(readdirSync(DIR).sort(), [...NAMES, 'README.md'].sort());
});

test('fillTemplate replaces known keys and leaves unknown ones alone', () => {
  assert.equal(fillTemplate('a {{x}} b {{ y }} c {{z}}', { x: 1, y: 'two' }), 'a 1 b two c {{z}}');
  assert.equal(fillTemplate('{{x}}{{x}}', { x: 'ab' }), 'abab');
  assert.equal(fillTemplate('{{__proto__}} {{k}}', { k: undefined }), '{{__proto__}} {{k}}');
});

test('every placeholder is a known key', () => {
  for (const name of NAMES) {
    const keys = new Set([...read(name).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
    for (const key of keys) assert.ok(KNOWN_KEYS.includes(key), `${name} uses unknown placeholder {{${key}}}`);
  }
});

test('filled templates leave no placeholder behind', () => {
  for (const name of NAMES) assert.ok(!/\{\{/.test(filled(name)), `${name} still has a placeholder`);
});

test('each document template has its front matter and parses once filled', () => {
  for (const [name, spec] of Object.entries(DOCS)) {
    const raw = splitFrontMatter(read(name).replace(/\{\{\s*[A-Za-z0-9_]+\s*\}\}/g, 'x'), name).meta;
    for (const key of ['doc_id', 'title', 'project', 'version', 'date', ...(name === 'slice.md' ? [] : ['status']), 'language']) {
      assert.ok(key in raw, `${name} front matter lacks ${key}`);
    }
    // A slice sheet has no status key (the state lives in STATUS.md), but the document parser asks for one.
    const text = name === 'slice.md' ? filled(name).replace(/^---\n/, '---\nstatus: n/a\n') : filled(name);
    const doc = parseDocument(text, name, { lots: spec.lots ?? [] });
    assert.equal(doc.meta.doc_id, spec.doc_id, name);
    assert.equal(doc.meta.project, 'Fernhill Lending');
    assert.equal(doc.meta.language, 'en');
    assert.deepEqual(doc.warnings, [], `${name} parse warnings`);
  }
});

test('the unfilled templates keep valid YAML front matter', () => {
  for (const name of NAMES) {
    const { meta } = splitFrontMatter(read(name), name);
    assert.ok(meta && typeof meta === 'object', name);
  }
});

test('every template lists its required headings, in order', () => {
  for (const [name, spec] of Object.entries(DOCS)) {
    const found = h2(read(name)).map(strip);
    assert.deepEqual(found.filter((h) => spec.headings.includes(h)), spec.headings, `${name} headings`);
  }
});

test('the BIBLE has sections 0 to 17 numbered in order', () => {
  const titles = h2(read('BIBLE.md'));
  assert.equal(titles.length, 18);
  titles.forEach((t, i) => assert.ok(t.startsWith(`${i}. `), `section ${i}: "${t}"`));
});

test('the D1, D2 and D3 headings are numbered as in the spec outline', () => {
  const d1 = h2(read('D1.md'));
  for (let i = 1; i <= 15; i++) assert.ok(d1[i - 1].startsWith(`${i}. `), `D1 ${i}`);
  const d2 = h2(read('D2.md'));
  for (let i = 1; i <= 14; i++) assert.ok(d2[i - 1].startsWith(`${i}. `), `D2 ${i}`);
  const d3 = h2(read('D3.md'));
  for (let i = 0; i <= 10; i++) assert.ok(d3[i].startsWith(`${i}. `), `D3 ${i}`);
});

test('the PLAN has one H2 per workbook sheet with the exact columns', () => {
  const doc = parseDocument(filled('PLAN.md'), 'PLAN.md', { lots: ['LOT'] });
  let current = null;
  const header = new Map();
  for (const b of doc.blocks) {
    if (b.type === 'heading' && b.level === 2) current = b.runs.map((r) => r.text ?? '').join('').trim();
    else if (b.type === 'table' && current && !header.has(current)) {
      header.set(current, b.header.map((c) => c.map((r) => r.text ?? '').join('').trim()));
    }
  }
  for (const sheet of PLAN_SHEETS) {
    const cols = header.get(sheet.name);
    assert.ok(cols, `PLAN has a table under ${sheet.name}`);
    if (sheet.name === 'RACI') assert.equal(cols[0], 'Activity');
    else if (sheet.name === 'Gantt') assert.deepEqual(cols.slice(0, 3), sheet.columns);
    else assert.deepEqual(cols, sheet.columns, sheet.name);
  }
});

test('ID tables show one example row per ID kind', () => {
  for (const [name, spec] of Object.entries(DOCS)) {
    const { index } = checkRoot(dirOf(name, filled(name)), { lots: spec.lots ?? [] });
    const ids = index.definitions.map((d) => d.id);
    for (const id of spec.ids) assert.ok(ids.includes(id), `${name} defines ${id}`);
    for (const id of spec.mirrored ?? []) assert.ok(!ids.includes(id), `${name} only mirrors ${id}`);
    assert.equal(new Set(ids).size, ids.length, `${name} defines no ID twice`);
  }
});

test('all the templates, filled and indexed together, define no ID twice', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-tpl-all-'));
  made.push(root);
  for (const name of Object.keys(DOCS)) writeFileSync(join(root, name), filled(name));
  const { index } = checkRoot(root, { lots: ['LOT'] });
  assert.deepEqual(index.duplicates.map((d) => `${d.id} in ${d.file} and ${d.firstFile}`), []);
});

test('D2 mirrors the ADRs defined in STACK, and the STACK defines them', () => {
  assert.match(read('D2.md'), /<!-- mirror -->\s*\n\s*\| ID \| Decision \|/);
  assert.match(read('D2.md'), /cite the ADRs of STACK/i);
});

test('the D3 cross-cutting sections 4.1 to 4.7 each have the seven requirement columns', () => {
  const text = read('D3.md');
  const sections = text.split(/^### 4\.\d /m).slice(1, 8);
  assert.equal(sections.length, 7);
  for (const part of sections) {
    const body = part.split(/^## /m)[0];
    assert.match(body, /\| ID \| Requirement \| Priority \| Reference \| Verification \| Status \| Owner \|/);
  }
});

test('the STACK contributor table includes the domain expert', () => {
  assert.match(read('STACK.md'), /\| domain-expert \|/);
});

test('a replace-the-examples comment sits in every template with ID tables', () => {
  for (const [name, spec] of Object.entries(DOCS)) {
    // The slice and the decision define their ID in the title, not in a table.
    if (spec.ids.length > 0 && !OWN_ID[name]) assert.match(read(name), /<!-- replace the example rows/, name);
  }
});

test('index check finds no error beyond citations of documents that live elsewhere', () => {
  for (const [name, spec] of Object.entries(DOCS)) {
    const { findings } = checkRoot(dirOf(name, filled(name)), { lots: spec.lots ?? [] });
    const errors = findings.filter((f) => f.severity === 'error' && f.rule !== 'unknown-id');
    assert.deepEqual(errors, [], name);
  }
});

test('lint-style finds no finding in any template, filled or not', () => {
  for (const name of NAMES) {
    assert.deepEqual(lintText(read(name), name), [], name);
    assert.deepEqual(lintText(filled(name), name), [], name);
  }
});

test('the PLAN Decisions and Risks tables are mirrors, marked just before the table', () => {
  const lines = read('PLAN.md').split('\n');
  for (const title of ['Decisions', 'Risks']) {
    const at = lines.findIndex((l) => l === `## ${title}`);
    const table = lines.findIndex((l, i) => i > at && l.startsWith('| ID |'));
    const before = lines.slice(at, table).filter((l) => l.trim() !== '');
    assert.equal(before.at(-1), '<!-- mirror -->', `${title} mirror marker`);
  }
});

test('fillTemplate escapes quotes and backslashes inside double-quoted front matter only', () => {
  const tricky = 'The "Fernhill" plan \\ draft';
  const text = '---\ntitle: "{{title}}"\nauthor: {{title}}\n---\n\nBody {{title}} and "{{title}}".\n';
  const out = fillTemplate(text, { title: tricky });
  assert.equal(
    out,
    `---\ntitle: "The \\"Fernhill\\" plan \\\\ draft"\nauthor: ${tricky}\n---\n\nBody ${tricky} and "${tricky}".\n`,
  );
  const doc = parseDocument(fillTemplate(read('D1.md'), { ...VALUES, title: tricky }), 'D1.md');
  assert.equal(doc.meta.title, `${tricky}, Functional Specifications`);
});

test('fillTemplate handles CRLF front matter', () => {
  const out = fillTemplate('---\r\ntitle: "{{title}}"\r\n---\r\nBody "{{title}}"\r\n', { title: 'a"b' });
  assert.equal(out, '---\r\ntitle: "a\\"b"\r\n---\r\nBody "a"b"\r\n');
});

test('the slice sheet carries the header fields of the spec', () => {
  const { meta } = splitFrontMatter(read('slice.md'), 'slice.md');
  for (const key of DOCS['slice.md'].frontKeys) assert.ok(key in meta, `slice front matter lacks ${key}`);
  assert.ok(Array.isArray(meta.touches), 'touches is a list of path patterns');
  assert.equal('status' in meta || 'model' in meta, false, 'the state lives in STATUS.md and the model with the harness');
  assert.match(read('slice.md'), /\| # \| Command \(counts tests\) \| Expected \| Seen red first\? \|/);
});

test('the doctrine template follows spec section 6', () => {
  const { meta, body } = splitFrontMatter(filled('doctrine.md'), 'doctrine.md');
  for (const key of ['role', 'inspired_by', 'model', 'effort', 'sources']) assert.ok(key in meta, `doctrine lacks ${key}`);
  assert.ok(Array.isArray(meta.sources));
  const titles = body.split('\n').filter((l) => /^## /.test(l)).map((l) => l.slice(3).trim());
  assert.deepEqual(titles, [
    'Why this profile for this project', 'Convictions (each with its source)', 'Working rules (imperative, verifiable)',
    'Review checklist', 'What they refuse', 'How they settle a disagreement', 'Limits (what not to ask them)',
  ]);
});

test('the questionnaire carries every intake question of section 5.1', () => {
  const text = read('questionnaire.md').toLowerCase();
  for (const topic of [
    'budget', 'deadline', 'hosting', 'regulation', 'logo', 'colors', 'tone', 'love', 'hate', 'intake/attachments',
    'blocking', 'replaceable', 'provisional',
  ]) assert.ok(text.includes(topic), `questionnaire mentions ${topic}`);
});

test('the README has one line per template', () => {
  const lines = read('README.md').split('\n').filter((l) => l.startsWith('- '));
  for (const name of NAMES) assert.ok(lines.some((l) => l.includes(`\`${name}\``)), `README lists ${name}`);
  assert.equal(lines.length, NAMES.length);
});

test('no template holds an em dash, a raw e-mail or an unfilled TODO marker', () => {
  for (const name of [...NAMES, 'README.md']) {
    const text = read(name);
    assert.ok(!text.includes('\u2014'), `${name} has an em dash`);
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text), `${name} has an e-mail`);
    assert.ok(!/\b(TODO|TBD|FIXME)\b/.test(text), `${name} has a TODO marker`);
  }
});

// A temp directory holding one file, for the index checks. Removed at exit.
const made = [];
function dirOf(name, text) {
  const root = mkdtempSync(join(tmpdir(), 'recade-tpl-'));
  made.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, name), text);
  return root;
}
process.on('exit', () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('the STACK template carries the existing key and a "Stack in place" section before section 1, and its sheet is still read', () => {
  const text = read('STACK.md');
  assert.match(text, /^existing: false$/m);
  assert.ok(h2(text).indexOf('Stack in place') >= 0 && h2(text).indexOf('Stack in place') < h2(text).findIndex((h) => h.startsWith('1. ')));
  assert.match(text, /\| Package \| Path \| Language \| Framework \| Test \| Lint \| Build \|/);
  const adopted = fillTemplate(text.replace('existing: false', 'existing: true'), VALUES);
  const doc = parseDocument(adopted, 'STACK.md');
  assert.equal(splitFrontMatter(adopted, 'STACK.md').meta.existing, true);
  assert.deepEqual(doc.warnings, []);
  const rows = techSheet(adopted);
  assert.equal(rows.get('test'), 'make test');
});

test('the STACK template tells the owner that section 12 takes one table per code repository, headed ### <repo>', () => {
  const text = read('STACK.md');
  const section = text.slice(text.indexOf('## 12. Harness technical sheet'));
  assert.match(section, /### <repo>/);
  assert.match(section, /one table per code repository/i);
  // The comment is not a heading or a table: the single table below it is still the one read without a repository.
  assert.equal(techSheet(fillTemplate(text, VALUES)).get('test'), 'make test');
  assert.equal(techSheet(fillTemplate(text, VALUES), 'api').get('test'), 'make test');
});

test('D2 section 2.5 shows the workspace layout with the code repositories under repos/<name>/', () => {
  const text = read('D2.md');
  const section = text.slice(text.indexOf('### 2.5 Repository layout'), text.indexOf('## 3. Infrastructure and cost'));
  assert.match(section, /\| Repository \| Holds \| Visibility \|/);
  assert.match(section, /<project>-workspace\//);
  assert.match(section, /\n {2}repos\/\n {4}api\/\n {4}web\//);
  assert.match(section, /never copied into a code repository/);
  assert.equal(section.includes('packages/'), false);
});
