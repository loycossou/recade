import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { stringify } from 'yaml';
import { LOCK_FILE } from '../../src/workspace/commit.js';
import { createWorkspace } from '../../src/workspace/layout.js';
import { defaultExec as asyncExec } from '../../src/doctor.js';
import { defaultExec as syncExec } from '../../src/harness/stamps.js';
import { run } from '../../src/cli.js';
import { git, makeIO } from '../harness/fixture-project.js';

const must = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const write = (ws, file, text) => {
  mkdirSync(join(ws, file, '..'), { recursive: true });
  writeFileSync(join(ws, file), text);
};
const subjects = (ws) => must(git(ws, 'log', '--format=%s')).stdout.trim().split('\n').reverse();
const files = (ws) => must(git(ws, 'show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n').filter(Boolean).sort();

const SHA = { api: 'a1'.repeat(20), web: 'b2'.repeat(20) };
const SHEET = `---\ndoc_id: S-01\ntitle: "Slice S-01"\nrepos: [api, web]\nbranch: slice/s-01-x\nformat: small\nlane: standard\nimplementer: implementer\nincrement: INC-1\ndepends_on: []\nblocks: []\nexternal_prerequisite: none\nprovisionals_used: []\nsize: S\ntouches:\n  - "api:src/a/**"\n  - "web:src/w/**"\n---\n\n# S-01: Slice S-01\n\n## Scope\n\n- LOAN-01 (the gist)\n\n## Definition of Done\n\n| # | Command (counts tests) | Expected | Done |\n|---|---|---|---|\n| 1 | \`make test\` (3 tests) | All green | [x] |\n\n## Work order\n\n1. Build it.\n`;
const STATUS = '# Slice status\n\n| Slice | Title | Format | Lane | Increment | State | Depends on | Size | Note |\n|---|---|---|---|---|---|---|---|---|\n| S-01 | Slice S-01 | small | standard | INC-1 | ready-to-merge | | S | |\n';
const PLAN = '# Plan\n\n## Backlog\n\n| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |\n|---|---|---|---|---|---|---|---|---|---|\n| LOAN-01 | Core | Apply | M | 2 | | 1 | Build | todo | |\n';

async function workspace() {
  const parent = join(realpathSync(mkdtempSync(join(tmpdir(), 'recade-life-'))), 'Projets Clients');
  mkdirSync(parent);
  const { dir } = await createWorkspace(parent, 'Ete', { exec: asyncExec });
  write(dir, 'recade/state.yaml', stringify({
    version: 1, kind: 'workspace', lots: ['LOAN'], repos: ['api', 'web'].map((name) => ({ name, remote: 'none', default_branch: 'main' })),
    github: { owner: 'fernhill', repo: 'fernhill-workspace', project_number: 7 },
  }));
  write(dir, 'slices/S-01-x.md', SHEET);
  write(dir, 'slices/STATUS.md', STATUS);
  write(dir, 'docs/PLAN.md', PLAN);
  must(git(dir, 'add', '-A'));
  must(git(dir, 'commit', '-q', '-m', 'chore: start'));
  return dir;
}

/** gh for the workspace board and one merged pull request in each repository. Records the calls, and whether the lock was held. */
function fakeGh(ws) {
  const options = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'].map((name, i) => ({ id: `opt_${i}`, name }));
  const issues = [{ number: 1, title: '[S-01] Slice S-01', url: 'https://github.com/fernhill/fernhill-workspace/issues/1', state: 'OPEN' }, { number: 2, title: '[LOAN-01] Apply', url: 'https://github.com/fernhill/fernhill-workspace/issues/2', state: 'OPEN' }];
  const items = issues.map((i) => ({ id: `PVTI_${i.number}`, title: i.title, status: 'In review', content: { url: i.url, number: i.number, type: 'Issue' } }));
  const log = { calls: [], underLock: [] };
  const exec = (cmd, opts) => {
    if (cmd[0] !== 'gh') return syncExec(cmd, opts);
    log.calls.push(cmd.slice(1, 3).join(' '));
    if (existsSync(join(ws, LOCK_FILE))) log.underLock.push(cmd.join(' '));
    const [a, b] = cmd.slice(1);
    if (a === 'pr' && b === 'view') {
      const repo = basename(opts.cwd);
      return ok(JSON.stringify({ number: repo === 'api' ? 3 : 4, state: 'MERGED', mergedAt: '2026-11-13T10:00:00Z', url: `https://github.com/fernhill/${repo}/pull/1`, mergeCommit: { oid: SHA[repo] }, headRefOid: 'c'.repeat(40) }));
    }
    if (a === 'project' && b === 'view') return ok(JSON.stringify({ number: 7, id: 'PVT_board', title: 'Board' }));
    if (a === 'project' && b === 'field-list') return ok(JSON.stringify({ fields: [{ id: 'F1', name: 'Status', options }], totalCount: 1 }));
    if (a === 'project' && b === 'item-list') return ok(JSON.stringify({ items, totalCount: items.length }));
    if (a === 'issue' && b === 'list') return ok(JSON.stringify(issues));
    return ok('{}');
  };
  return { exec, log };
}

test('board reconcile --apply across repositories: one commit holds STATUS.md and the sheet, no gh call under the lock', async () => {
  const ws = await workspace();
  const gh = fakeGh(ws);
  const before = subjects(ws).length;
  const t = makeIO(ws, { run: gh.exec });
  assert.equal(await run(['board', 'reconcile', '--apply'], t.io), 0, t.err.join(''));
  assert.equal(subjects(ws).length, before + 1);
  assert.equal(subjects(ws).at(-1), 'chore(board): reconcile slices');
  assert.deepEqual(files(ws), ['recade/state.yaml', 'slices/S-01-x.md', 'slices/STATUS.md'], 'the first done slice also records its day in the state');
  assert.match(readFileSync(join(ws, 'slices/STATUS.md'), 'utf8'), /\| S-01 \|[^\n]*\| done \|/);
  assert.match(readFileSync(join(ws, 'slices/S-01-x.md'), 'utf8'), new RegExp(`merged:\\n  api: ${SHA.api}\\n  web: ${SHA.web}\\n---`));
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout.includes('slices/'), false, 'nothing left dirty');
  assert.deepEqual(gh.log.underLock, []);
  assert.ok(gh.log.calls.includes('issue close'));
  // A second run has nothing to do and commits nothing.
  const again = makeIO(ws, { run: fakeGh(ws).exec });
  assert.equal(await run(['board', 'reconcile', '--apply'], again.io), 0, again.err.join(''));
  assert.equal(subjects(ws).length, before + 1);
});

test('board reconcile --apply refuses a sheet that has foreign edits, before any board write', async () => {
  const ws = await workspace();
  write(ws, 'slices/S-01-x.md', `${SHEET}\nA note the owner is typing.\n`);
  const gh = fakeGh(ws);
  const t = makeIO(ws, { run: gh.exec });
  assert.equal(await run(['board', 'reconcile', '--apply'], t.io), 1);
  assert.match(t.err.join(''), /slices\/S-01-x\.md/);
  assert.match(readFileSync(join(ws, 'slices/STATUS.md'), 'utf8'), /ready-to-merge/);
  assert.equal(gh.log.calls.some((c) => c === 'project item-edit' || c === 'issue close' || c === 'issue comment'), false);
});
