import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { DEFAULT_BUDGETS, SHORT_BUDGETS, budgetsOf } from '../../src/budgets.js';
import { TRACKS, firstSliceLine, firstSliceTime, normalizeState, setSetting, trackOf } from '../../src/project/state.js';
import { checkSlices } from '../../src/project/slices.js';
import { createProject } from '../../src/project/scaffold.js';
import { applyStatusMoves } from '../../src/harness/board.js';
import { noteFirstSliceDone } from '../../src/state.js';
import { run } from '../../src/cli.js';

const PLAN = `---
doc_id: PLAN
---

# Delivery plan

## Backlog

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| LOAN-01 | Core | Apply for a loan | M | 2 | | 1 | Build | todo | |
| LOAN-02 | Core | Review an application | M | 2 | LOAN-01 | 1 | Build | todo | |
`;

function sheet(id, story, front = {}) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['app'], branch: `slice/${id.toLowerCase()}`, format: 'small',
    lane: 'no-code', implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [],
    external_prerequisite: 'none', provisionals_used: [], size: 'M', touches: [`src/${id.toLowerCase()}/**`], ...front,
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n\n## Goal\n\nOne sentence.\n\n## Scope\n\n- ${story} (the gist)\n\n## Definition of Done\n\n| # | Command (counts tests) | Expected | Seen red first? |\n|---|---|---|---|\n| 1 | \`make test\` (3 tests) | green | yes |\n`;
}

function project(state = {}, sheets = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade-short-'));
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', lots: ['LOAN'], gates: {}, ...state }));
  writeFileSync(join(root, 'docs', 'PLAN.md'), PLAN);
  for (const [name, text] of Object.entries(sheets)) writeFileSync(join(root, 'slices', name), text);
  return root;
}

const readState = (root) => parse(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8'));

function makeIO(cwd, now = new Date(2026, 10, 20, 12)) {
  const out = [];
  const err = [];
  return {
    io: { cwd, env: { HOME: cwd }, now: () => now, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

// ---- the setting

test('track: full by default, short when set, and nothing else is accepted', () => {
  assert.deepEqual([...TRACKS], ['full', 'short']);
  assert.equal(trackOf({}), 'full');
  assert.equal(trackOf(null), 'full');
  assert.equal(trackOf({ track: 'short' }), 'short');
  const s = setSetting(normalizeState({ version: 1, mode: 'scratch' }), 'track', 'short');
  assert.equal(s.track, 'short');
  assert.equal(setSetting(s, 'track', 'full').track, 'full');
  assert.throws(() => setSetting(s, 'track', 'tiny'), /Invalid track: tiny\. Use full, short\./);
});

test('recade state set track short is saved, and state show prints the track', async () => {
  const root = project();
  let t = makeIO(root);
  assert.equal(await run(['state', 'show'], t.io), 0);
  assert.match(t.stdout(), /^Track: full$/m);
  t = makeIO(root);
  assert.equal(await run(['state', 'set', 'track', 'short'], t.io), 0, t.stderr());
  assert.equal(readState(root).track, 'short');
  t = makeIO(root);
  assert.equal(await run(['state', 'show', '--json'], t.io), 0);
  assert.equal(JSON.parse(t.stdout()).track, 'short');
  t = makeIO(root);
  assert.equal(await run(['state', 'set', 'track', 'medium'], t.io), 2);
  assert.match(t.stderr(), /Invalid track/);
});

// ---- the budgets

test('the short track halves every budget, and explicit budgets still win', () => {
  for (const [doc, words] of Object.entries(DEFAULT_BUDGETS)) assert.equal(SHORT_BUDGETS[doc], words / 2, doc);
  assert.deepEqual(budgetsOf({ track: 'full' }), { ...DEFAULT_BUDGETS });
  assert.deepEqual(budgetsOf({ track: 'short' }), { ...SHORT_BUDGETS });
  assert.deepEqual(budgetsOf({ track: 'short', budgets: { D1: 12000 } }), { ...SHORT_BUDGETS, D1: 12000 });
});

test('recade docs budgets says which budgets come from the short track', async () => {
  const root = project({ track: 'short', budgets: { PLAN: 4000 } });
  const t = makeIO(root);
  assert.equal(await run(['docs', 'budgets'], t.io), 0);
  assert.match(t.stdout(), /^D1 5000 words \(short track\)$/m);
  assert.match(t.stdout(), /^PLAN 4000 words \(project\)$/m);
});

// ---- the walking skeleton

test('slices check warns in the short track when S-01 is not marked skeleton: true', () => {
  const sheets = { 'S-01-apply.md': sheet('S-01', 'LOAN-01'), 'S-02-review.md': sheet('S-02', 'LOAN-02', { depends_on: ['S-01'] }) };
  const full = checkSlices(project({}, sheets));
  assert.deepEqual(full.findings, []);
  const short = checkSlices(project({ track: 'short' }, sheets));
  assert.deepEqual(short.findings.map((f) => [f.file, f.rule, f.severity]), [['slices/S-01-apply.md', 'slice-skeleton', 'warn']]);
  assert.match(short.findings[0].message, /skeleton: true/);
  const marked = { ...sheets, 'S-01-apply.md': sheet('S-01', 'LOAN-01', { skeleton: true }) };
  assert.deepEqual(checkSlices(project({ track: 'short' }, marked)).findings, []);
});

test('slices check warns in the short track when there is no S-01 at all, and the check still exits 0', async () => {
  const root = project({ track: 'short' }, { 'S-02-apply.md': sheet('S-02', 'LOAN-01'), 'S-03-review.md': sheet('S-03', 'LOAN-02') });
  assert.deepEqual(checkSlices(root).findings.map((f) => f.rule), ['slice-skeleton']);
  const t = makeIO(root);
  assert.equal(await run(['slices', 'check'], t.io), 0, t.stdout() + t.stderr());
});

// ---- the dates

test('createProject records the day the project started', async () => {
  const r = await createProject('Short Track', {
    root: mkdtempSync(join(tmpdir(), 'recade-short-new-')), mode: 'scratch', today: '2026-11-13',
    config: { voice: 'v', languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] } },
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.equal(readState(r.dir).started, '2026-11-13');
});

test('the first slice moved to done records its day once, and a later one never overwrites it', async () => {
  const root = project({ started: '2026-11-01' }, { 'S-01-apply.md': sheet('S-01', 'LOAN-01'), 'S-02-review.md': sheet('S-02', 'LOAN-02') });
  assert.equal(await run(['slices', 'status'], makeIO(root).io), 0);
  let t = makeIO(root, new Date(2026, 10, 20, 12));
  assert.equal(await run(['slices', 'status', '--set', 'S-01', 'done'], t.io), 0, t.stderr());
  assert.equal(readState(root).first_slice_done, '2026-11-20');
  t = makeIO(root, new Date(2026, 10, 25, 12));
  assert.equal(await run(['slices', 'status', '--set', 'S-02', 'done'], t.io), 0, t.stderr());
  assert.equal(readState(root).first_slice_done, '2026-11-20');
  assert.equal(noteFirstSliceDone(root, '2026-12-01'), false);
  assert.equal(readState(root).first_slice_done, '2026-11-20');
});

test('a move that is not done records nothing, and the board reconcile records the first done', async () => {
  const root = project({}, { 'S-01-apply.md': sheet('S-01', 'LOAN-01', { lane: 'standard' }), 'S-02-review.md': sheet('S-02', 'LOAN-02') });
  assert.equal(await run(['slices', 'status'], makeIO(root).io), 0);
  assert.equal(await run(['slices', 'status', '--set', 'S-01', 'spec'], makeIO(root).io), 0);
  assert.equal(readState(root).first_slice_done, undefined);
  assert.deepEqual(applyStatusMoves(root, [{ id: 'S-02', to: 'done' }], { today: '2026-11-21', noteFirst: true }), []);
  assert.equal(readState(root).first_slice_done, '2026-11-21');
});

// ---- the status line

test('the line of the metric: delivered, not yet delivered, and an old state without a start date', () => {
  assert.equal(firstSliceLine({ started: '2026-11-01', first_slice_done: '2026-11-20' }, '2026-12-01'), 'Started on 2026-11-01. First slice delivered on 2026-11-20, 19 days later.');
  assert.equal(firstSliceLine({ started: '2026-11-01' }, '2026-11-02'), '1 day since the start, no slice delivered yet.');
  assert.equal(firstSliceLine({ gates: { G0: { passed: '2026-10-30', by: 'owner' } } }, '2026-11-09'), '10 days since the start, no slice delivered yet.');
  assert.equal(firstSliceTime({ mode: 'adopt', gates: { 'G0-inventory': { passed: '2026-10-01', by: 'owner' } } }, '2026-10-04').days, 3);
  assert.equal(firstSliceLine({ gates: {} }, '2026-11-09'), null);
  assert.equal(firstSliceLine({ started: '2026-03-28', first_slice_done: '2026-03-30' }, '2026-04-01'), 'Started on 2026-03-28. First slice delivered on 2026-03-30, 2 days later.');
});

test('state show prints the line of the metric, and the JSON holds it', async () => {
  const root = project({ started: '2026-11-01' });
  let t = makeIO(root, new Date(2026, 10, 15, 12));
  assert.equal(await run(['state', 'show'], t.io), 0);
  assert.match(t.stdout(), /^First slice: 14 days since the start, no slice delivered yet\.$/m);
  t = makeIO(root, new Date(2026, 10, 15, 12));
  assert.equal(await run(['state', 'show', '--json'], t.io), 0);
  assert.equal(JSON.parse(t.stdout()).first_slice, '14 days since the start, no slice delivered yet.');
  const old = project();
  t = makeIO(old);
  assert.equal(await run(['state', 'show'], t.io), 0);
  assert.doesNotMatch(t.stdout(), /First slice/);
});

test('compact: a number of tokens from 100k, written 600000 or 600k, and default takes it out', () => {
  const base = normalizeState({ version: 1, mode: 'scratch' });
  assert.equal(setSetting(base, 'compact', '600000').compact, 600000);
  assert.equal(setSetting(base, 'compact', '600k').compact, 600000);
  assert.equal('compact' in setSetting(setSetting(base, 'compact', '600k'), 'compact', 'default'), false);
  for (const bad of ['99999', '50k', 'lots', '3000000', '-1']) assert.throws(() => setSetting(base, 'compact', bad), /Invalid compact/, bad);
});

test('applyCompact writes autoCompactWindow in the local settings, keeps the other keys, and takes it out on default', async () => {
  const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { applyCompact } = await import('../../src/harness/compact.js');
  const dir = mkdtempSync(join(tmpdir(), 'recade-compact-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{"permissions":{"deny":["Bash(x:*)"]}}');
  assert.equal(applyCompact(dir, 600000).changed, true);
  const read = () => JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.deepEqual(read(), { permissions: { deny: ['Bash(x:*)'] }, autoCompactWindow: 600000 });
  assert.equal(applyCompact(dir, 600000).changed, false);
  assert.equal(applyCompact(dir, null).changed, true);
  assert.deepEqual(read(), { permissions: { deny: ['Bash(x:*)'] } });
  writeFileSync(join(dir, '.claude', 'settings.local.json'), '{not json');
  assert.match(applyCompact(dir, 600000).error, /not valid JSON/);
});
