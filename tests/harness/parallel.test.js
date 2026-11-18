import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { checkSlices, renderStatus } from '../../src/project/slices.js';
import { explainParallel, planParallel } from '../../src/harness/parallel.js';
import { run } from '../../src/cli.js';

/** A sheet with just the header: that is all the plan reads. */
function sheet(id, front = {}) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['app'], branch: `slice/${id.toLowerCase()}`, format: 'small', lane: 'standard',
    implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [], external_prerequisite: 'none',
    provisionals_used: [], size: 'M', touches: [`src/${id.toLowerCase()}/**`], ...front,
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n`;
}

/** `slices` maps a file name to the header keys; `statuses` maps an id to its state in STATUS.md. */
function project({ slices, statuses = {}, hotspots = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'recade-parallel-'));
  mkdirSync(join(root, 'recade'));
  mkdirSync(join(root, 'slices'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', hotspots }));
  for (const [name, front] of Object.entries(slices)) writeFileSync(join(root, 'slices', name), sheet(name.slice(0, 4), front));
  const rows = checkSlices(root).status;
  for (const r of rows) r.status = statuses[r.id] ?? 'todo';
  writeFileSync(join(root, 'slices', 'STATUS.md'), renderStatus(rows));
  return root;
}

const ids = (plan) => plan.map((p) => p.slice);

test('picks todo slices with done dependencies and disjoint scopes, smallest first', () => {
  const root = project({
    slices: {
      'S-01-base.md': { size: 'M' },
      'S-02-api.md': { size: 'L', depends_on: ['S-01'], touches: ['src/api/**'] },
      'S-03-docs.md': { size: 'S', touches: ['docs/**'] },
      'S-04-ui.md': { size: 'M', touches: ['src/ui/**'] },
      'S-05-late.md': { size: 'S', depends_on: ['S-02'], touches: ['src/late/**'] },
    },
    statuses: { 'S-01': 'done' },
  });
  const plan = planParallel(root, {});
  assert.deepEqual(ids(plan), ['S-03', 'S-04', 'S-02']);
  assert.equal(plan.every((p) => typeof p.reason === 'string' && p.reason.length > 0), true);
  assert.equal(ids(plan).includes('S-05'), false, 'S-05 waits for S-02');
  assert.equal(ids(plan).includes('S-01'), false, 'S-01 is done');
});

test('two slices with overlapping scopes are never picked together', () => {
  const root = project({
    slices: {
      'S-01-a.md': { size: 'S', touches: ['src/api/**'] },
      'S-02-b.md': { size: 'M', touches: ['src/api/users/**'] },
      'S-03-c.md': { size: 'M', touches: ['src/web/**'] },
      'S-04-d.md': { size: 'M', touches: ['src/ops/**'] },
    },
  });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(ids(picked), ['S-01', 'S-03', 'S-04']);
  assert.deepEqual(deferred.map((d) => d.slice), ['S-02']);
  assert.match(deferred[0].reason, /overlaps S-01/);
});

test('hotspot slices go one at a time', () => {
  const root = project({
    slices: {
      'S-01-menu.md': { size: 'S', touches: ['src/routes/**'] },
      'S-02-more.md': { size: 'S', touches: ['src/routes.js', 'src/more/**'] },
      'S-03-free.md': { size: 'M', touches: ['src/free/**'] },
      'S-04-lib.md': { size: 'M', touches: ['src/lib/**'] },
    },
    hotspots: ['src/routes/index.js', 'src/routes.js'],
  });
  const plan = planParallel(root, {});
  assert.equal(ids(plan).filter((i) => ['S-01', 'S-02'].includes(i)).length, 1);
  assert.deepEqual(ids(plan), ['S-01', 'S-03', 'S-04']);
  const { deferred } = explainParallel(root, {});
  assert.equal(deferred.length, 1);
  assert.match(deferred[0].reason, /hotspot|overlaps/);
});

test('a slice under way keeps its scope and its hotspot', () => {
  const root = project({
    slices: {
      'S-01-run.md': { touches: ['src/routes/**'] },
      'S-02-same.md': { touches: ['src/routes/admin/**'] },
      'S-03-hot.md': { touches: ['src/menu.js'] },
      'S-04-free.md': { touches: ['src/free/**'] },
    },
    statuses: { 'S-01': 'implementation' },
    hotspots: ['src/routes/index.js', 'src/menu.js'],
  });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(ids(picked), ['S-04']);
  assert.deepEqual(deferred.map((d) => d.slice), ['S-02', 'S-03']);
  assert.match(deferred[0].reason, /overlaps S-01, which is implementation/);
  assert.match(deferred[1].reason, /hotspot/);
});

test('the batch stops at max, and a wider combination is found when smallest-first leaves fewer than three', () => {
  const many = {};
  for (let i = 1; i <= 7; i++) many[`S-0${i}-x.md`] = { touches: [`src/m${i}/**`] };
  assert.equal(planParallel(project({ slices: many }), { max: 4 }).length, 4);
  assert.equal(planParallel(project({ slices: many }), {}).length, 5);
  // S-01 is the smallest but blocks S-02 and S-03, which do not overlap each other.
  const root = project({
    slices: {
      'S-01-wide.md': { size: 'S', touches: ['src/**'] },
      'S-02-a.md': { size: 'M', touches: ['src/a/**'] },
      'S-03-b.md': { size: 'M', touches: ['src/b/**'] },
      'S-04-c.md': { size: 'M', touches: ['src/c/**'] },
    },
  });
  assert.deepEqual(ids(planParallel(root, {})), ['S-02', 'S-03', 'S-04']);
});

test('a slice with no touches waits unless it is a no-code slice, and max must be a positive integer', () => {
  const root = project({
    slices: {
      'S-01-blank.md': { touches: [] },
      'S-02-docs.md': { lane: 'no-code', touches: [] },
    },
  });
  const { picked, deferred } = explainParallel(root, {});
  assert.deepEqual(ids(picked), ['S-02']);
  assert.match(deferred[0].reason, /no `touches:`/);
  assert.throws(() => planParallel(root, { max: 0 }), /Invalid max/);
});

function makeIO(cwd) {
  const out = [];
  const err = [];
  return { io: { cwd, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out, err };
}

test('recade parallel plan prints the picks and the waiting slices, and --json prints both lists', async () => {
  const root = project({
    slices: {
      'S-01-a.md': { size: 'S', touches: ['src/a/**'] },
      'S-02-b.md': { size: 'M', touches: ['src/a/x/**'] },
    },
  });
  const t = makeIO(root);
  assert.equal(await run(['parallel', 'plan'], t.io), 0);
  const text = t.out.join('');
  assert.match(text, /Start now \(1\):\n {2}S-01: size S/);
  assert.match(text, /Fewer than 3 slices/);
  assert.match(text, /Wait:\n {2}S-02: its scope overlaps S-01/);
  const j = makeIO(root);
  assert.equal(await run(['parallel', 'plan', '--json', '--max', '2'], j.io), 0);
  assert.deepEqual(Object.keys(JSON.parse(j.out.join(''))), ['picked', 'deferred']);
  const other = makeIO(tmpdir());
  assert.equal(await run(['parallel', 'plan', '--project', root], other.io), 0);
});

test('recade parallel rejects bad arguments with exit 2 and a project-less folder with exit 1', async () => {
  const root = project({ slices: { 'S-01-a.md': {} } });
  for (const args of [['parallel'], ['parallel', 'plan', '--max'], ['parallel', 'plan', '--max', '0'], ['parallel', 'plan', '--max', 'x'], ['parallel', 'plan', '--what'], ['parallel', 'go']]) {
    const t = makeIO(root);
    assert.equal(await run(args, t.io), 2, args.join(' '));
    assert.match(t.err.join(''), /Usage: recade parallel plan/);
  }
  const bare = makeIO(mkdtempSync(join(tmpdir(), 'recade-bare-')));
  assert.equal(await run(['parallel', 'plan'], bare.io), 1);
});
