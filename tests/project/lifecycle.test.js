import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { checkSlices, sliceRepoOrder, statusFromPulls, writeMerged } from '../../src/project/slices.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function sheet(id, front = {}) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['api', 'web'], branch: `slice/${id.toLowerCase()}-x`, format: 'small', lane: 'standard',
    implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [], external_prerequisite: 'none',
    provisionals_used: [], size: 'S', touches: ['api:src/a/**', 'web:src/w/**'], ...front,
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n`;
}

function workspace(front) {
  const root = mkdtempSync(join(tmpdir(), 'recade-lifecycle-'));
  mkdirSync(join(root, 'recade'));
  mkdirSync(join(root, 'slices'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, kind: 'workspace', repos: [{ name: 'api' }, { name: 'web' }] }));
  writeFileSync(join(root, 'slices', 'S-01-x.md'), sheet('S-01', front));
  return root;
}

const rules = (root) => checkSlices(root).findings.filter((f) => f.file === 'slices/S-01-x.md').map((f) => f.rule);

test('a sheet with no merge_order and no merged record has no lifecycle finding', () => {
  assert.deepEqual(rules(workspace({})).filter((r) => /merge|merged/.test(r)), []);
});

test('merge_order must list exactly the repositories of the touches, each once', () => {
  assert.deepEqual(rules(workspace({ merge_order: ['web', 'api'] })).filter((r) => r === 'merge-order'), []);
  for (const bad of [['web'], ['web', 'api', 'api'], ['web', 'api', 'ghost'], ['api', 'workspace'], 'web']) {
    assert.ok(rules(workspace({ merge_order: bad })).includes('merge-order'), JSON.stringify(bad));
  }
});

test('merged: must map registered repositories to commit ids', () => {
  assert.deepEqual(rules(workspace({ merged: { api: SHA_A, web: SHA_B } })).filter((r) => r === 'merged-record'), []);
  for (const bad of [{ api: 'not a sha' }, { ghost: SHA_A }, ['api'], 'api']) {
    assert.ok(rules(workspace({ merged: bad })).includes('merged-record'), JSON.stringify(bad));
  }
});

test('the status rows carry the touches, merge_order and merged record of the sheet', () => {
  const row = checkSlices(workspace({ merge_order: ['web', 'api'], merged: { api: SHA_A } })).status[0];
  assert.deepEqual(row.touches, ['api:src/a/**', 'web:src/w/**']);
  assert.deepEqual(row.merge_order, ['web', 'api']);
  assert.deepEqual(row.merged, { api: SHA_A });
  assert.equal(row.branch, 'slice/s-01-x');
});

test('sliceRepoOrder: merge_order wins over the order of the touches; registry names only', () => {
  const registry = ['api', 'web'];
  assert.deepEqual(sliceRepoOrder({ touches: ['api:a/**', 'web:b/**'], merge_order: [] }, registry), ['api', 'web']);
  assert.deepEqual(sliceRepoOrder({ touches: ['api:a/**', 'web:b/**'], merge_order: ['web', 'api'] }, registry), ['web', 'api']);
  assert.deepEqual(sliceRepoOrder({ touches: ['web:b/**', 'api:a/**', 'web:c/**'] }, registry), ['web', 'api']);
  assert.deepEqual(sliceRepoOrder({ touches: ['ghost:a/**', 'api:a/**'], merge_order: ['ghost'] }, registry), ['api']);
  assert.deepEqual(sliceRepoOrder({ touches: ['src/**'] }, ['api']), ['api'], 'a one-repository registry owns unprefixed globs');
  assert.deepEqual(sliceRepoOrder({ touches: ['src/**'] }, []), []);
});

const P = (repo, kind, extra = {}) => ({ repo, kind, number: kind === 'none' ? undefined : (repo === 'api' ? 3 : 4), checks: 'green', approved: true, ...extra });

test('statusFromPulls: every pull request merged is done', () => {
  assert.deepEqual(statusFromPulls([P('api', 'merged'), P('web', 'merged')]), { status: 'done', failing: [], pending: [] });
});

test('statusFromPulls: every pull request open, green and approved is ready-to-merge', () => {
  const r = statusFromPulls([P('api', 'open'), P('web', 'open')]);
  assert.equal(r.status, 'ready-to-merge');
  assert.deepEqual(r.failing, []);
});

test('statusFromPulls: one open pull request that is red, pending, unapproved or missing keeps the slice out of ready-to-merge and is named', () => {
  for (const [extra, why] of [[{ checks: 'red' }, /checks failing/], [{ checks: 'pending' }, /checks pending/], [{ checks: 'none' }, /no check/], [{ approved: false }, /not approved/]]) {
    const r = statusFromPulls([P('api', 'open'), P('web', 'open', extra)]);
    assert.equal(r.status, null);
    assert.equal(r.failing.length, 1);
    assert.equal(r.failing[0].repo, 'web');
    assert.equal(r.failing[0].number, 4);
    assert.match(r.failing[0].why, why);
  }
  const missing = statusFromPulls([P('api', 'open'), P('web', 'none')]);
  assert.equal(missing.status, null);
  assert.match(missing.failing[0].why, /no pull request/);
});

test('statusFromPulls: a merged pull request with a failing one stays ready-to-merge, and the failing one is named', () => {
  const r = statusFromPulls([P('api', 'merged'), P('web', 'open', { checks: 'red' })]);
  assert.equal(r.status, 'ready-to-merge');
  assert.deepEqual(r.failing.map((f) => f.repo), ['web']);
  const waiting = statusFromPulls([P('api', 'merged'), P('web', 'open')]);
  assert.equal(waiting.status, 'ready-to-merge');
  assert.deepEqual(waiting.failing, []);
  assert.deepEqual(waiting.pending.map((f) => f.repo), ['web'], 'a healthy pull request that is not merged yet is pending, not failing');
  const closed = statusFromPulls([P('api', 'merged'), P('web', 'closed')]);
  assert.match(closed.failing[0].why, /closed without merge/);
});

test('statusFromPulls: no pull request at all gives no opinion', () => {
  assert.deepEqual(statusFromPulls([]), { status: null, failing: [], pending: [] });
});

test('writeMerged adds, replaces and keeps the rest of the front matter, line endings included', () => {
  const text = sheet('S-01', {});
  const once = writeMerged(text, { api: SHA_A, web: SHA_B });
  assert.match(once, new RegExp(`\\nmerged:\\n  api: ${SHA_A}\\n  web: ${SHA_B}\\n---\\n`));
  assert.ok(once.startsWith(text.slice(0, text.indexOf('\n---\n\n'))));
  const twice = writeMerged(once, { api: SHA_B });
  assert.equal(twice.match(/^merged:/gm).length, 1);
  assert.match(twice, new RegExp(`merged:\\n  api: ${SHA_B}\\n---\\n`));
  assert.equal(twice.includes(SHA_A), false);
  assert.equal(writeMerged(twice, { api: SHA_B }), twice, 'writing the same record changes nothing');
  const crlf = writeMerged(text.replace(/\n/g, '\r\n'), { api: SHA_A });
  assert.match(crlf, /\r\nmerged:\r\n  api: /);
  assert.equal(/[^\r]\n/.test(crlf.slice(0, crlf.indexOf('---\r\n\r\n#'))), false, 'no bare LF added to a CRLF sheet');
  const root = workspace({});
  writeFileSync(join(root, 'slices', 'S-01-x.md'), once);
  assert.deepEqual(checkSlices(root).status[0].merged, { api: SHA_A, web: SHA_B });
  assert.equal(readFileSync(join(root, 'slices', 'S-01-x.md'), 'utf8'), once);
});

test('statusFromPulls: a draft pull request is not ready, and a merge into another branch is named', () => {
  const draft = statusFromPulls([P('api', 'open'), P('web', 'open', { draft: true })]);
  assert.equal(draft.status, null);
  assert.equal(draft.failing[0].why, 'draft');
  const other = statusFromPulls([P('api', 'other', { base: 'develop', expected: 'main' }), P('web', 'merged')]);
  assert.equal(other.status, 'ready-to-merge');
  assert.match(other.failing[0].why, /merged into develop, not into main/);
  assert.equal(statusFromPulls([P('api', 'other', { base: 'develop', expected: 'main' })]).status, null, 'merged elsewhere is never done');
});
