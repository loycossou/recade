import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { stringify } from 'yaml';
import { cleanup, formatCleanup, formatReconcile, reconcile } from '../../src/harness/board.js';
import { defaultExec } from '../../src/harness/stamps.js';
import { run } from '../../src/cli.js';

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

const ok = (data) => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
const flag = (args, name) => args[args.indexOf(name) + 1];

// ---------------------------------------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------------------------------------

const PLAN = `---
doc_id: PLAN
project: "Fernhill Lending"
---

# Fernhill Lending, delivery plan

## Backlog

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| LOAN-01 | Core | Apply for a loan | M | 2 | | 1 | Build | todo | |
| PAY-01 | Payments | Schedule a payout | S | 1 | | 2 | Build | todo | |
`;

const DOD = {
  ticked: '| # | Command (counts tests) | Expected | Done |\n|---|---|---|---|\n| 1 | `make test` (3 tests) | All green | [x] |\n| 2 | `make lint` | No finding | [x] |\n',
  open: '| # | Command (counts tests) | Expected | Done |\n|---|---|---|---|\n| 1 | `make test` (3 tests) | All green | [x] |\n| 2 | `make lint` | No finding | [ ] |\n',
  list: '- [x] `make test` (3 tests) is green\n- [x] `make lint` shows no finding\n',
  none: '| # | Command (counts tests) | Expected | Seen red first? |\n|---|---|---|---|\n| 1 | `make test` (3 tests) | All green | yes |\n',
};

function sheet(id, { lane = 'standard', dod = 'ticked', story, touches, extra = '' }) {
  return `---
doc_id: ${id}
title: "Slice ${id}"
repos: [app]
branch: slice/${id.toLowerCase()}-x
format: small
lane: ${lane}
implementer: implementer
increment: INC-1
depends_on: []
blocks: []
external_prerequisite: none
provisionals_used: []
size: S
touches:
${(touches ?? [`src/${id.toLowerCase()}/**`]).map((t) => `  - "${t}"`).join('\n')}
${extra}---

# ${id}: Slice ${id}

## Scope

- ${story} (the gist)

## Definition of Done

${DOD[dod]}
## Work order

1. Build it.
`;
}

const STATUS_ROW = (id, status) => `| ${id} | Slice ${id} | small | standard | INC-1 | ${status} | | S | |`;

/** A project with slices `{ 'S-01': {status, dod, lane, story} }`, a PLAN with two stories, and a recorded board. */
function project(slices) {
  const root = mkdtempSync(join(tmpdir(), 'recade-board-'));
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({
    version: 1, mode: 'scratch', lots: ['LOAN', 'PAY'], github: { owner: 'fernhill', repo: 'fernhill-lending', project_number: 7 },
  }));
  writeFileSync(join(root, 'docs', 'PLAN.md'), PLAN);
  const rows = [];
  for (const [id, s] of Object.entries(slices)) {
    writeFileSync(join(root, 'slices', `${id}-x.md`), sheet(id, s));
    rows.push(STATUS_ROW(id, s.status ?? 'todo'));
  }
  writeFileSync(join(root, 'slices', 'STATUS.md'), `# Slice status\n\n| Slice | Title | Format | Lane | Increment | State | Depends on | Size | Note |\n|---|---|---|---|---|---|---|---|---|\n${rows.join('\n')}\n`);
  return root;
}

const statusOf = (root, id) => new RegExp(`^\\| ${id} \\|.*$`, 'm').exec(readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8'))[0].split('|')[6].trim();

/**
 * A fake `gh` with a board, issues, items and pull requests. Field and option ids are made up, so the code
 * can only work when it reads them. `prs` maps a branch to its pull request. Every call is recorded.
 */
function fakeBoard({ prs = {}, items = {}, failOn = () => false } = {}) {
  const gh = { calls: [], comments: [], edits: [], items: [], issues: [] };
  const options = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'].map((name, i) => ({ id: `opt_${100 + i}_${name.length}`, name }));
  gh.fields = [
    { id: 'PVTSSF_status_xyz', name: 'Status', type: 'ProjectV2SingleSelectField', options },
    { id: 'PVTF_points_abc', name: 'Points', type: 'ProjectV2Field' },
  ];
  let n = 0;
  for (const [id, title] of [['S-01', 'Slice S-01'], ['S-02', 'Slice S-02'], ['LOAN-01', 'Apply for a loan'], ['PAY-01', 'Schedule a payout']]) {
    n++;
    const issue = { number: n, title: `[${id}] ${title}`, url: `https://github.com/fernhill/fernhill-lending/issues/${n}` };
    gh.issues.push(issue);
    if (items[id] !== null) gh.items.push({ id: `PVTI_${id}`, title: issue.title, status: items[id] ?? 'In progress', content: { url: issue.url, number: n, type: 'Issue' } });
  }
  gh.exec = (cmd) => {
    assert.equal(cmd[0], 'gh', `unexpected command ${cmd.join(' ')}`);
    const args = cmd.slice(1);
    gh.calls.push(args);
    if (failOn(args)) return { code: 1, stdout: '', stderr: 'HTTP 502: bad gateway\nsecond line' };
    const [a, b] = args;
    if (a === 'pr' && b === 'view') {
      const pr = prs[args[2]];
      return pr ? ok(pr) : { code: 1, stdout: '', stderr: `no pull requests found for branch "${args[2]}"` };
    }
    if (a === 'project' && b === 'view') return ok({ number: 7, id: 'PVT_board_node', title: 'Fernhill Lending delivery' });
    if (a === 'project' && b === 'field-list') return ok({ fields: gh.fields, totalCount: gh.fields.length });
    if (a === 'project' && b === 'item-list') return ok({ items: gh.items, totalCount: gh.items.length });
    if (a === 'issue' && b === 'list') return ok(gh.issues);
    if (a === 'project' && b === 'item-edit') {
      assert.equal(flag(args, '--project-id'), 'PVT_board_node');
      assert.equal(flag(args, '--field-id'), 'PVTSSF_status_xyz');
      const option = options.find((o) => o.id === flag(args, '--single-select-option-id'));
      assert.ok(option, 'an option id read from the board');
      const item = gh.items.find((i) => i.id === flag(args, '--id'));
      gh.edits.push([item.title.slice(1, item.title.indexOf(']')), item.status, option.name]);
      item.status = option.name;
      return ok({});
    }
    if (a === 'issue' && b === 'comment') {
      gh.comments.push({ number: Number(args[2]), repo: flag(args, '--repo'), body: flag(args, '--body') });
      return ok('https://github.com/fernhill/fernhill-lending/issues/1#issuecomment-1\n');
    }
    return { code: 1, stdout: '', stderr: `unexpected call: ${args.join(' ')}` };
  };
  return gh;
}

const merged = (number = 12, head = 'a'.repeat(40)) => ({ number, state: 'MERGED', mergedAt: '2026-11-13T10:00:00Z', url: `https://github.com/fernhill/fernhill-lending/pull/${number}`, headRefOid: head, baseRefName: 'main' });
const open = (number = 13) => ({ number, state: 'OPEN', mergedAt: null, url: `https://github.com/fernhill/fernhill-lending/pull/${number}`, headRefOid: 'b'.repeat(40), baseRefName: 'main' });
const itemStatus = (gh, id) => gh.items.find((i) => i.title.startsWith(`[${id}]`)).status;

test('reconcile: a merged slice with its DoD ticked is done in STATUS.md and on the board, with a comment on each issue', () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' }, 'S-02': { status: 'implementation', story: 'PAY-01' } });
  const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12) }, items: { 'S-01': 'In review', 'LOAN-01': 'In progress', 'S-02': 'Backlog', 'PAY-01': 'Backlog' } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(statusOf(root, 'S-01'), 'done');
  assert.equal(statusOf(root, 'S-02'), 'implementation');
  assert.equal(itemStatus(gh, 'S-01'), 'Done');
  assert.equal(itemStatus(gh, 'LOAN-01'), 'Done', 'the story of a done slice is done');
  assert.equal(itemStatus(gh, 'S-02'), 'In progress');
  assert.equal(itemStatus(gh, 'PAY-01'), 'In progress');
  assert.equal(gh.comments.length, 4, 'one comment for each move');
  const first = gh.comments.find((c) => c.number === 1);
  assert.equal(first.repo, 'fernhill/fernhill-lending');
  assert.match(first.body, /S-01/);
  assert.match(first.body, /Done/);
  assert.match(first.body, /#12/);
  for (const c of gh.comments) assert.equal(/\u2014/.test(c.body), false);
});

test('reconcile: a dry run prints the table and writes nothing', () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' } });
  const before = readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8');
  const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12) }, items: { 'S-01': 'In review', 'LOAN-01': 'In progress', 'S-02': null, 'PAY-01': null } });
  const result = reconcile(root, { exec: gh.exec });
  assert.equal(result.applied.length, 0);
  assert.equal(readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8'), before);
  assert.deepEqual(gh.edits, []);
  assert.deepEqual(gh.comments, []);
  assert.equal(gh.calls.every(([a, b]) => !(a === 'project' && b === 'item-edit') && !(a === 'issue' && b === 'comment')), true);
  const table = formatReconcile(result);
  assert.match(table, /S-01/);
  assert.match(table, /ready-to-merge/);
  assert.match(table, /merged #12/);
  assert.match(table, /Done/);
  assert.match(table, /LOAN-01/);
  assert.equal(/\u2014/.test(table), false);
});

test('reconcile: never done when the PR is not merged, even when STATUS.md says done', () => {
  const root = project({ 'S-01': { status: 'done', story: 'LOAN-01' } });
  const gh = fakeBoard({ prs: { 'slice/s-01-x': open(13) }, items: { 'S-01': 'Done', 'LOAN-01': 'Done', 'S-02': null, 'PAY-01': null } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(itemStatus(gh, 'S-01'), 'In review');
  assert.equal(itemStatus(gh, 'LOAN-01'), 'In review');
  assert.equal(statusOf(root, 'S-01'), 'done', 'reconcile never rewrites a status backwards');
  const row = result.rows.find((r) => r.id === 'S-01');
  assert.match(row.reason, /not merged/);
  assert.equal(gh.comments.length, 2);
});

test('reconcile: a merged PR with a DoD that is not ticked is never done', () => {
  for (const dod of ['open', 'none']) {
    const root = project({ 'S-01': { status: 'ready-to-merge', dod, story: 'LOAN-01' } });
    const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12) }, items: { 'S-01': 'In review', 'LOAN-01': 'In review', 'S-02': null, 'PAY-01': null } });
    const result = reconcile(root, { exec: gh.exec, apply: true });
    assert.equal(statusOf(root, 'S-01'), 'ready-to-merge', dod);
    assert.equal(itemStatus(gh, 'S-01'), 'In review', dod);
    assert.equal(itemStatus(gh, 'LOAN-01'), 'In review', dod);
    assert.match(result.rows.find((r) => r.id === 'S-01').reason, /DoD/, dod);
    assert.deepEqual(gh.comments, [], dod);
  }
});

test('reconcile: a DoD written as a checklist counts', () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', dod: 'list', story: 'LOAN-01' } });
  const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12) }, items: { 'S-01': 'In review', 'LOAN-01': 'In review', 'S-02': null, 'PAY-01': null } });
  reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(statusOf(root, 'S-01'), 'done');
});

test('reconcile: a merged slice that cannot go to done from its status is held, with the reason', () => {
  const root = project({ 'S-01': { status: 'gate-2', story: 'LOAN-01' } });
  const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12) }, items: { 'S-01': 'In review', 'LOAN-01': 'In review', 'S-02': null, 'PAY-01': null } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(statusOf(root, 'S-01'), 'gate-2');
  assert.equal(itemStatus(gh, 'S-01'), 'In review');
  assert.match(result.rows.find((r) => r.id === 'S-01').reason, /ready-to-merge/);
});

test('reconcile: the board follows STATUS.md for slices still in work, and Ready is not pushed back to Backlog', () => {
  const root = project({ 'S-01': { status: 'implementation', story: 'LOAN-01' }, 'S-02': { status: 'todo', story: 'PAY-01' } });
  const gh = fakeBoard({ items: { 'S-01': 'Backlog', 'LOAN-01': 'Backlog', 'S-02': 'Ready', 'PAY-01': 'Backlog' } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(itemStatus(gh, 'S-01'), 'In progress');
  assert.equal(itemStatus(gh, 'LOAN-01'), 'In progress');
  assert.equal(itemStatus(gh, 'S-02'), 'Ready');
  assert.equal(itemStatus(gh, 'PAY-01'), 'Backlog');
  assert.equal(gh.comments.length, 2);
});

test('reconcile: a second run after apply changes and writes nothing', () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' } });
  const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12) }, items: { 'S-01': 'In review', 'LOAN-01': 'In progress', 'S-02': null, 'PAY-01': null } });
  reconcile(root, { exec: gh.exec, apply: true });
  const edits = gh.edits.length;
  const comments = gh.comments.length;
  const again = reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(gh.edits.length, edits);
  assert.equal(gh.comments.length, comments);
  assert.equal(again.rows.every((r) => r.action !== 'move'), true);
});

test('reconcile: an item that is not on the board is reported, not created', () => {
  const root = project({ 'S-01': { status: 'implementation', story: 'LOAN-01' } });
  const gh = fakeBoard({ items: { 'S-01': null, 'LOAN-01': 'Backlog', 'S-02': null, 'PAY-01': null } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  const row = result.rows.find((r) => r.id === 'S-01');
  assert.equal(row.action, 'skip');
  assert.match(row.reason, /not on the board/);
  assert.equal(gh.calls.some(([a, b]) => a === 'project' && b === 'item-add'), false);
});

test('reconcile: a gh failure on one pull request is an error and the other rows still run', () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' }, 'S-02': { status: 'implementation', story: 'PAY-01' } });
  const gh = fakeBoard({ items: { 'S-01': 'In review', 'LOAN-01': 'In review', 'S-02': 'Backlog', 'PAY-01': 'Backlog' }, failOn: (a) => a[0] === 'pr' && a[2] === 'slice/s-01-x' });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /HTTP 502/);
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
  assert.equal(itemStatus(gh, 'S-01'), 'In review');
  assert.equal(itemStatus(gh, 'S-02'), 'In progress');
});

test('reconcile: a failing board read stops with one error and writes nothing', () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' } });
  const gh = fakeBoard({ failOn: (a) => a[0] === 'project' && a[1] === 'field-list' });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /field-list/);
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
});

test('reconcile: no recorded board is an error', () => {
  const root = project({ 'S-01': { status: 'todo', story: 'LOAN-01' } });
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch' }));
  const result = reconcile(root, { exec: () => assert.fail('no gh call without a board') });
  assert.match(result.errors[0], /recade github init/);
});

// ---------------------------------------------------------------------------------------------------------
// Cleanup, on real repositories, with a fake gh for the pull requests
// ---------------------------------------------------------------------------------------------------------

/**
 * A repository `main` with an origin (a bare repository), and slice branches, each in a worktree under
 * `.claude/worktrees/<S-nn>`, each pushed. `main` then gets one commit (the "squash" of each slice) that is a
 * different commit from the slice's own, so no slice branch is an ancestor of main.
 */
function makeRepo(slices = ['S-01'], { base = realpathSync(mkdtempSync(join(tmpdir(), 'recade-clean-'))), name = 'app', repoDir, branch = (id) => `slice/${id}-x` } = {}) {
  const origin = join(base, `${name}-origin.git`);
  const repo = repoDir ?? join(base, name);
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', 'main');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', origin);
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\ndist/\n.claude/worktrees/\n');
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, 'docs', 'STACK.md'), '# Stack\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'chore: start');
  git(repo, 'push', '-q', 'origin', 'main');
  const out = { base, origin, repo, branches: {}, trees: {}, heads: {} };
  for (const id of slices) {
    const branchName = branch(id);
    const tree = join(repo, '.claude', 'worktrees', id);
    git(repo, 'worktree', 'add', '-q', tree, '-b', branchName);
    writeFileSync(join(tree, `${id}.txt`), `work of ${id}\n`);
    git(tree, 'add', '.');
    git(tree, 'commit', '-q', '-m', `feat: ${id}`);
    git(tree, 'push', '-q', 'origin', branchName);
    out.branches[id] = branchName;
    out.trees[id] = tree;
    out.heads[id] = git(tree, 'rev-parse', 'HEAD');
  }
  for (const id of slices) {
    writeFileSync(join(repo, `${id}.txt`), `work of ${id}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `feat: ${id} (squashed)`);
  }
  git(repo, 'push', '-q', 'origin', 'main');
  return out;
}

/** Exec that sends `gh` to a fake and everything else to the real machine. `extra(cmd, opts)` can answer first. */
function wire({ prs = {}, extra = () => undefined } = {}) {
  const calls = [];
  const exec = (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd });
    const own = extra(cmd, opts);
    if (own !== undefined) return own;
    if (cmd[0] === 'gh') {
      assert.deepEqual(cmd.slice(1, 3), ['pr', 'view']);
      const pr = prs[cmd[3]];
      return pr ? ok(pr) : { code: 1, stdout: '', stderr: `no pull requests found for branch "${cmd[3]}"` };
    }
    return defaultExec(cmd, opts);
  };
  return { exec, calls };
}

const mergedPr = (head, number = 3) => ({ number, state: 'MERGED', mergedAt: '2026-11-13T10:00:00Z', headRefOid: head, baseRefName: 'main', url: `https://github.com/fernhill/app/pull/${number}` });
const branchExists = (repo, name) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repo }).status === 0;
const remoteHas = (origin, name) => spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { cwd: origin }).status === 0;

test('cleanup: a branch merged by squash (not an ancestor of main) is found through the PR state and removed with its worktree', () => {
  const r = makeRepo(['S-01']);
  assert.equal(git(r.repo, 'branch', '--merged', 'main').includes(r.branches['S-01']), false, 'the squash leaves it out of git branch --merged');
  mkdirSync(join(r.trees['S-01'], 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(r.trees['S-01'], 'node_modules', 'pkg', 'big.bin'), Buffer.alloc(300000, 1));
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(r.trees['S-01']), false);
  assert.equal(branchExists(r.repo, r.branches['S-01']), false);
  assert.equal(remoteHas(r.origin, r.branches['S-01']), false, 'the remote branch is gone');
  assert.equal(git(r.repo, 'worktree', 'list', '--porcelain').includes(r.trees['S-01']), false, 'pruned');
  assert.ok(result.bytesFreed >= 300000, `freed ${result.bytesFreed}`);
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].slice, 'S-01');
  assert.equal(branchExists(r.repo, 'main'), true);
  assert.equal(remoteHas(r.origin, 'main'), true);
});

test('cleanup: a dry run lists what it would do and changes nothing', () => {
  const r = makeRepo(['S-01', 'S-02']);
  mkdirSync(join(r.trees['S-01'], 'node_modules'));
  writeFileSync(join(r.trees['S-01'], 'node_modules', 'x.bin'), Buffer.alloc(100000, 1));
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec });
  assert.equal(existsSync(r.trees['S-01']), true);
  assert.equal(branchExists(r.repo, r.branches['S-01']), true);
  assert.equal(remoteHas(r.origin, r.branches['S-01']), true);
  assert.equal(result.removed.length, 0);
  assert.equal(result.bytesFreed, 0);
  assert.deepEqual(result.candidates.map((c) => c.slice), ['S-01']);
  assert.ok(result.bytesEstimate >= 100000);
  assert.deepEqual(result.kept.map((k) => k.slice), ['S-02']);
  assert.match(result.kept[0].reasons.join(' '), /no pull request|not merged/i);
  const text = formatCleanup(result);
  assert.match(text, /S-01/);
  assert.match(text, /S-02/);
  assert.equal(/\u2014/.test(text), false);
});

test('cleanup: a dirty worktree of a merged slice is kept with its branch', () => {
  const r = makeRepo(['S-01']);
  writeFileSync(join(r.trees['S-01'], 'draft.txt'), 'not committed\n');
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.equal(existsSync(join(r.trees['S-01'], 'draft.txt')), true);
  assert.equal(branchExists(r.repo, r.branches['S-01']), true);
  assert.equal(remoteHas(r.origin, r.branches['S-01']), true);
  assert.equal(result.removed.length, 0);
  assert.match(result.kept[0].reasons.join(' '), /uncommitted/);
});

test('cleanup: a modified tracked file also keeps the worktree', () => {
  const r = makeRepo(['S-01']);
  writeFileSync(join(r.trees['S-01'], 'S-01.txt'), 'changed after the merge\n');
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.equal(existsSync(r.trees['S-01']), true);
  assert.match(result.kept[0].reasons.join(' '), /uncommitted/);
});

test('cleanup: commits made after the merged PR head are unpushed work and are kept', () => {
  const r = makeRepo(['S-01']);
  writeFileSync(join(r.trees['S-01'], 'late.txt'), 'late\n');
  git(r.trees['S-01'], 'add', '.');
  git(r.trees['S-01'], 'commit', '-q', '-m', 'feat: late work');
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.equal(existsSync(r.trees['S-01']), true);
  assert.equal(branchExists(r.repo, r.branches['S-01']), true);
  assert.equal(remoteHas(r.origin, r.branches['S-01']), true);
  assert.match(result.kept[0].reasons.join(' '), /1 commit.*not in the merged/);
});

test('cleanup: a remote branch that moved after the merged PR head is kept', () => {
  const r = makeRepo(['S-01']);
  const other = join(r.base, 'other');
  git(r.base, 'clone', '-q', r.origin, other);
  git(other, 'switch', '-q', r.branches['S-01']);
  writeFileSync(join(other, 'theirs.txt'), 'a colleague pushed\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'feat: colleague');
  git(other, 'push', '-q', 'origin', r.branches['S-01']);
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.equal(remoteHas(r.origin, r.branches['S-01']), true);
  assert.equal(branchExists(r.repo, r.branches['S-01']), true);
  assert.match(result.kept[0].reasons.join(' '), /remote/);
});

test('cleanup: an open PR, a closed PR without merge and no PR are all kept untouched', () => {
  const r = makeRepo(['S-01', 'S-02', 'S-03']);
  const { exec } = wire({ prs: {
    [r.branches['S-01']]: { number: 4, state: 'OPEN', mergedAt: null, headRefOid: r.heads['S-01'], baseRefName: 'main' },
    [r.branches['S-02']]: { number: 5, state: 'CLOSED', mergedAt: null, headRefOid: r.heads['S-02'], baseRefName: 'main' },
  } });
  const result = cleanup(r.repo, { exec, apply: true });
  for (const id of ['S-01', 'S-02', 'S-03']) {
    assert.equal(existsSync(r.trees[id]), true, id);
    assert.equal(branchExists(r.repo, r.branches[id]), true, id);
    assert.equal(remoteHas(r.origin, r.branches[id]), true, id);
  }
  assert.equal(result.kept.length, 3);
  assert.equal(result.removed.length, 0);
});

test('cleanup: a slice branch that has no worktree any more is removed locally and on the remote', () => {
  const r = makeRepo(['S-01']);
  git(r.repo, 'worktree', 'remove', r.trees['S-01']);
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(branchExists(r.repo, r.branches['S-01']), false);
  assert.equal(remoteHas(r.origin, r.branches['S-01']), false);
});

test('cleanup: a branch already deleted on the remote (merged with delete branch) is still removed locally', () => {
  const r = makeRepo(['S-01']);
  git(r.origin, 'branch', '-D', r.branches['S-01']);
  git(r.repo, 'fetch', '-q', '--prune', 'origin');
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(branchExists(r.repo, r.branches['S-01']), false);
  assert.equal(existsSync(r.trees['S-01']), false);
});

test('cleanup: the stop command of the STACK runs in the worktree before it is removed', () => {
  const r = makeRepo(['S-01']);
  writeFileSync(join(r.repo, 'docs', 'STACK.md'), '# Stack\n\n## 12. Harness technical sheet\n\n| Item | Value |\n|---|---|\n| Test | `make test` |\n| Stop | `fake-stop --all` |\n');
  const stops = [];
  const { exec } = wire({
    prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) },
    extra: (cmd, opts) => {
      if (cmd[0] !== 'fake-stop') return undefined;
      stops.push({ cmd, cwd: opts.cwd, existed: existsSync(opts.cwd) });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(stops, [{ cmd: ['fake-stop', '--all'], cwd: r.trees['S-01'], existed: true }]);
  assert.equal(existsSync(r.trees['S-01']), false);
});

test('cleanup: a stop command that fails keeps the worktree and the branch', () => {
  const r = makeRepo(['S-01']);
  writeFileSync(join(r.repo, 'docs', 'STACK.md'), '# Stack\n\n## 12. Harness technical sheet\n\n| Item | Value |\n|---|---|\n| Stop | `fake-stop` |\n');
  const { exec } = wire({
    prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) },
    extra: (cmd) => (cmd[0] === 'fake-stop' ? { code: 1, stdout: '', stderr: 'port 8080 busy\n' } : undefined),
  });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.equal(existsSync(r.trees['S-01']), true);
  assert.equal(branchExists(r.repo, r.branches['S-01']), true);
  assert.match(result.kept[0].reasons.join(' '), /stop command failed/);
});

test('cleanup: no stop command in the STACK means nothing is run, and a command with shell syntax is not run either', () => {
  const r = makeRepo(['S-01']);
  const plain = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  cleanup(r.repo, { exec: plain.exec });
  assert.equal(plain.calls.some((c) => c.cmd[0] === 'fake-stop'), false);
  writeFileSync(join(r.repo, 'docs', 'STACK.md'), '# Stack\n\n## 12. Harness technical sheet\n\n| Item | Value |\n|---|---|\n| Stop | `docker compose down; rm -rf /` |\n');
  const shell = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec: shell.exec, apply: true });
  assert.equal(shell.calls.some((c) => c.cmd[0] === 'docker'), false);
  assert.equal(existsSync(r.trees['S-01']), true, 'kept: the services may still run');
  assert.match(result.kept[0].reasons.join(' '), /stop command/);
});

test('cleanup: git gc runs only when the repository grew over the threshold', () => {
  const r = makeRepo(['S-01']);
  const small = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const low = cleanup(r.repo, { exec: small.exec, apply: true, gcThresholdKiB: 10 * 1024 * 1024 });
  assert.equal(low.gc, false);
  assert.equal(small.calls.some((c) => c.cmd[0] === 'git' && c.cmd.includes('gc')), false);
  const r2 = makeRepo(['S-01']);
  const big = wire({ prs: { [r2.branches['S-01']]: mergedPr(r2.heads['S-01']) } });
  const high = cleanup(r2.repo, { exec: big.exec, apply: true, gcThresholdKiB: 0 });
  assert.equal(high.gc, true);
  assert.equal(big.calls.some((c) => c.cmd[0] === 'git' && c.cmd.includes('gc')), true);
});

test('cleanup: run from inside the worktree of a merged slice, that worktree is kept', () => {
  const r = makeRepo(['S-01']);
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.trees['S-01'], { exec, apply: true });
  assert.equal(existsSync(r.trees['S-01']), true);
  assert.match(result.kept[0].reasons.join(' '), /current folder/);
});

test('cleanup: only slice branches are ever touched, and never with a force push or a force remove', () => {
  const r = makeRepo(['S-01']);
  git(r.repo, 'branch', 'feature/other', 'main');
  git(r.repo, 'push', '-q', 'origin', 'feature/other');
  const { exec, calls } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']), 'feature/other': mergedPr('c'.repeat(40), 9) } });
  cleanup(r.repo, { exec, apply: true });
  assert.equal(branchExists(r.repo, 'feature/other'), true);
  assert.equal(remoteHas(r.origin, 'feature/other'), true);
  for (const c of calls) {
    assert.equal(c.cmd.includes('--force'), false, c.cmd.join(' '));
    assert.equal(c.cmd.includes('-f'), false, c.cmd.join(' '));
    assert.equal(c.cmd.includes('--no-verify'), false, c.cmd.join(' '));
    if (c.cmd[0] === 'git' && c.cmd.includes('push')) assert.equal(c.cmd.some((a) => /main|master/.test(a)), false, c.cmd.join(' '));
  }
});

test('cleanup: not a git repository is an error, not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-clean-none-'));
  const result = cleanup(dir, { exec: defaultExec });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /git/);
});

// ---------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------

function makeIO(cwd, runner) {
  const out = [];
  const err = [];
  return { io: { cwd, env: {}, run: runner, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out: () => out.join(''), err: () => err.join('') };
}

test('recade board: usage errors exit 2', async () => {
  for (const args of [[], ['nope'], ['reconcile', '--force'], ['cleanup', '--apply', 'x'], ['reconcile', '--apply', '--apply']]) {
    const t = makeIO(tmpdir());
    assert.equal(await run(['board', ...args], t.io), 2, args.join(' '));
    assert.match(t.err(), /Usage: recade board/);
  }
});

test('recade board reconcile: a dry run prints the table, --apply writes', async () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' } });
  const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12) }, items: { 'S-01': 'In review', 'LOAN-01': 'In progress', 'S-02': null, 'PAY-01': null } });
  const dry = makeIO(root, gh.exec);
  assert.equal(await run(['board', 'reconcile'], dry.io), 0);
  assert.match(dry.out(), /S-01/);
  assert.match(dry.out(), /Dry run/);
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
  const applied = makeIO(root, gh.exec);
  assert.equal(await run(['board', 'reconcile', '--apply'], applied.io), 0);
  assert.equal(statusOf(root, 'S-01'), 'done');
  assert.match(applied.out(), /Applied/);
});

test('recade board reconcile: no project exits 1, a gh failure exits 1', async () => {
  const none = makeIO(mkdtempSync(join(tmpdir(), 'recade-board-none-')));
  assert.equal(await run(['board', 'reconcile'], none.io), 1);
  assert.match(none.err(), /No Recade project here/);
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' } });
  const gh = fakeBoard({ failOn: (a) => a[0] === 'project' && a[1] === 'view' });
  const bad = makeIO(root, gh.exec);
  assert.equal(await run(['board', 'reconcile'], bad.io), 1);
  assert.match(bad.err(), /HTTP 502/);
});

test('recade board cleanup: a dry run lists, --apply removes, and kept work is not an error', async () => {
  const r = makeRepo(['S-01', 'S-02']);
  writeFileSync(join(r.trees['S-02'], 'draft.txt'), 'wip\n');
  const prs = { [r.branches['S-01']]: mergedPr(r.heads['S-01']), [r.branches['S-02']]: mergedPr(r.heads['S-02'], 4) };
  const { exec } = wire({ prs });
  const dry = makeIO(r.repo, exec);
  assert.equal(await run(['board', 'cleanup'], dry.io), 0);
  assert.match(dry.out(), /Dry run/);
  assert.equal(existsSync(r.trees['S-01']), true);
  const applied = makeIO(r.repo, exec);
  assert.equal(await run(['board', 'cleanup', '--apply'], applied.io), 0);
  assert.equal(existsSync(r.trees['S-01']), false);
  assert.equal(existsSync(r.trees['S-02']), true);
  assert.match(applied.out(), /Kept/);
  assert.match(applied.out(), /uncommitted/);
  assert.match(applied.out(), /Freed/);
});

test('recade board cleanup: outside a git repository exits 1', async () => {
  const t = makeIO(mkdtempSync(join(tmpdir(), 'recade-board-nogit-')));
  assert.equal(await run(['board', 'cleanup'], t.io), 1);
  assert.match(t.err(), /Not a git repository/);
});

// ---------------------------------------------------------------------------------------------------------
// The /board command
// ---------------------------------------------------------------------------------------------------------

const boardDoc = readFileSync(new URL('../../harness/commands/board.md', import.meta.url), 'utf8');
const stepOf = (n) => {
  const m = new RegExp(`^## Step ${n}\\. .*$`, 'm').exec(boardDoc);
  assert.ok(m, `step ${n}`);
  const rest = boardDoc.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
};

test('/board: front matter limits the tools, and it never merges, pushes or calls gh itself', () => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(boardDoc)[1];
  const tools = /^allowed-tools: (.*)$/m.exec(front)[1];
  assert.match(front, /^description: .{40,}/m);
  assert.equal(/Bash\((gh|\*)[:)]/.test(tools), false);
  assert.equal(/git push|Agent|Write|Edit/.test(tools), false);
  assert.match(tools, /AskUserQuestion/);
  for (const bad of ['gh pr merge', 'git push', '--no-verify', '--force', '--auto']) assert.equal(boardDoc.includes(bad), false, bad);
  assert.equal(boardDoc.includes('\u2014'), false);
});

test('/board: Step 0 finds the plugin root, and the CLI is called only through it', () => {
  const s = stepOf(0);
  for (const part of ['process.env.RECADE_PLUGIN_ROOT', '.recade/plugin-root', 'is not known here', 'and stop.', 'recade.js" version', 'npm ci --omit=dev --prefix "$RECADE_PLUGIN_ROOT"']) {
    assert.ok(s.includes(part), part);
  }
  for (const m of boardDoc.matchAll(/`recade ([a-z-]+)[^`]*`/g)) {
    if (m[1] !== '<sub>') assert.ok(['state', 'board', 'github', 'version', 'workspace', 'repo'].includes(m[1]), m[1]);
  }
});

test('/board: each apply comes after a dry run and an answer of the owner, with a default that applies nothing', () => {
  const dryR = boardDoc.indexOf('`recade board reconcile`');
  const askR = boardDoc.indexOf('Apply these moves');
  const applyR = boardDoc.indexOf('`recade board reconcile --apply`');
  const dryC = boardDoc.indexOf('`recade board cleanup`');
  const askC = boardDoc.indexOf('Remove the worktrees and branches');
  const applyC = boardDoc.indexOf('`recade board cleanup --apply`');
  assert.ok(dryR > 0 && dryR < askR && askR < applyR, 'reconcile order');
  assert.ok(applyR < dryC && dryC < askC && askC < applyC, 'cleanup order, after the reconcile');
  for (const s of [stepOf(3), stepOf(5)]) {
    assert.match(s, /AskUserQuestion/);
    assert.match(s, /`Not yet` \(recommended, the default, the safest\)/);
    assert.match(s, /Only an answer `(Apply|Remove them)` goes on/);
  }
  assert.match(stepOf(4), /never removes such a slice, even when the owner asks/);
  assert.match(stepOf(4), /squash merge is found too/);
});

test('/board: it runs from the workspace on an up to date main, and ends with the /merge-order suggestion', () => {
  const s = stepOf(1);
  assert.match(s, /`recade workspace root`/);
  assert.doesNotMatch(s, /git worktree list --porcelain/);
  assert.match(s, /git rev-list --count main\.\.origin\/main/);
  assert.match(s, /git pull --ff-only/);
  assert.match(stepOf(6), /\/merge-order/);
  assert.match(stepOf(6), /Do not run it here/);
});

// ---------------------------------------------------------------------------------------------------------
// Review fixes: the template DoD, stories cited twice, ignored files, .recade
// ---------------------------------------------------------------------------------------------------------

import { checkSlices } from '../../src/project/slices.js';
import { dodState } from '../../src/harness/board.js';

const template = readFileSync(new URL('../../templates/slice.md', import.meta.url), 'utf8');

test('the real slice template has a Done column that starts open, so done is reachable only by ticking', () => {
  const dod = /## Definition of Done([\s\S]*?)\n## /.exec(template)[1];
  assert.match(dod, /\| # \| Command \(counts tests\) \| Expected \| Seen red first\? \| Done \|/);
  const open = dodState(template);
  assert.deepEqual([open.met, open.ticked, open.open], [false, 0, 1]);
  const ticked = dodState(template.replace('| yes | [ ] |', '| yes | [x] |'));
  assert.deepEqual([ticked.met, ticked.ticked, ticked.open], [true, 1, 0]);
});

test('the DoD cap still counts table rows with the Done column', () => {
  const rows = (n) => `| # | Command (counts tests) | Expected | Seen red first? | Done |\n|---|---|---|---|---|\n${Array.from({ length: n }, (_, i) => `| ${i + 1} | \`make test\` | green | yes | [ ] |`).join('\n')}\n`;
  for (const [n, flagged] of [[15, false], [16, true]]) {
    const root = project({ 'S-01': { status: 'todo', story: 'LOAN-01' } });
    writeFileSync(join(root, 'slices', 'S-01-x.md'), sheet('S-01', { story: 'LOAN-01' }).replace(DOD.ticked, rows(n)));
    const found = checkSlices(root).findings.some((f) => f.rule === 'slice-too-many-dod');
    assert.equal(found, flagged, `${n} rows`);
  }
});

test('/slice says who ticks the DoD, when, and that only lines seen green are ticked', () => {
  const slice = readFileSync(new URL('../../harness/commands/slice.md', import.meta.url), 'utf8');
  assert.match(slice, /`Done` column of the DoD table/);
  assert.match(slice, /ticks at gate-2/);
  assert.match(slice, /before the merge/);
  assert.match(slice, /Never tick a line that was not seen green/);
  assert.match(slice, /recade gate check/);
});

test('reconcile: a story cited by two slices is done only when both are done, otherwise it follows the least advanced', () => {
  const both = (second) => {
    const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' }, 'S-02': { status: second, story: 'LOAN-01' } });
    const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12), 'slice/s-02-x': merged(14) }, items: { 'S-01': 'In review', 'S-02': 'In review', 'LOAN-01': 'In review', 'PAY-01': null } });
    const result = reconcile(root, { exec: gh.exec, apply: true });
    return { gh, result };
  };
  const one = both('implementation');
  assert.equal(itemStatus(one.gh, 'S-01'), 'Done');
  assert.equal(itemStatus(one.gh, 'LOAN-01'), 'In progress', 'one slice is still in work');
  assert.match(one.result.rows.find((r) => r.id === 'LOAN-01').reason, /least advanced/);
  const two = both('ready-to-merge');
  assert.equal(itemStatus(two.gh, 'S-02'), 'Done');
  assert.equal(itemStatus(two.gh, 'LOAN-01'), 'Done');
});

test('reconcile: a story stays out of done while a slice that cites it is merged without a ticked DoD', () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' }, 'S-02': { status: 'ready-to-merge', dod: 'open', story: 'LOAN-01' } });
  const gh = fakeBoard({ prs: { 'slice/s-01-x': merged(12), 'slice/s-02-x': merged(14) }, items: { 'S-01': 'In review', 'S-02': 'In review', 'LOAN-01': 'In review', 'PAY-01': null } });
  reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(itemStatus(gh, 'LOAN-01'), 'In review');
});

const excludeFile = (r) => join(r.repo, '.git', 'info', 'exclude');
const addExclude = (r, line) => writeFileSync(excludeFile(r), `${existsSync(excludeFile(r)) ? readFileSync(excludeFile(r), 'utf8') : ''}${line}\n`);

test('cleanup: an ignored file that is not a cache keeps the slice, and the services are not stopped', () => {
  const r = makeRepo(['S-01']);
  addExclude(r, '.env.local');
  writeFileSync(join(r.trees['S-01'], '.env.local'), 'TOKEN=fictional\n');
  writeFileSync(join(r.repo, 'docs', 'STACK.md'), '# Stack\n\n## 12. Harness technical sheet\n\n| Item | Value |\n|---|---|\n| Stop | `fake-stop` |\n');
  const stops = [];
  const { exec } = wire({
    prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) },
    extra: (cmd) => (cmd[0] === 'fake-stop' ? (stops.push(cmd), { code: 0, stdout: '', stderr: '' }) : undefined),
  });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.equal(existsSync(join(r.trees['S-01'], '.env.local')), true);
  assert.equal(branchExists(r.repo, r.branches['S-01']), true);
  assert.deepEqual(stops, []);
  assert.match(result.kept[0].reasons.join(' '), /\.env\.local/);
  assert.match(result.kept[0].reasons.join(' '), /not caches/);
});

test('cleanup: the owner can name the ignored files to lose, and only those', () => {
  const r = makeRepo(['S-01']);
  addExclude(r, '.env.local');
  addExclude(r, 'local.db');
  writeFileSync(join(r.trees['S-01'], '.env.local'), 'TOKEN=fictional\n');
  writeFileSync(join(r.trees['S-01'], 'local.db'), 'rows\n');
  const prs = { [r.branches['S-01']]: mergedPr(r.heads['S-01']) };
  const partial = cleanup(r.repo, { exec: wire({ prs }).exec, apply: true, allowIgnored: ['.env.local'] });
  assert.equal(existsSync(r.trees['S-01']), true);
  assert.match(partial.kept[0].reasons.join(' '), /local\.db/);
  assert.equal(/\.env\.local/.test(partial.kept[0].reasons.join(' ')), false);
  const full = cleanup(r.repo, { exec: wire({ prs }).exec, apply: true, allowIgnored: ['.env.local', 'local.db'] });
  assert.deepEqual(full.errors, []);
  assert.equal(existsSync(r.trees['S-01']), false);
  assert.equal(branchExists(r.repo, r.branches['S-01']), false);
});

test('cleanup: ignored caches alone (node_modules, dist) do not keep the slice', () => {
  const r = makeRepo(['S-01']);
  mkdirSync(join(r.trees['S-01'], 'dist'));
  writeFileSync(join(r.trees['S-01'], 'dist', 'out.js'), 'x'.repeat(5000));
  mkdirSync(join(r.trees['S-01'], 'packages', 'a', 'node_modules'), { recursive: true });
  writeFileSync(join(r.trees['S-01'], 'packages', 'a', 'node_modules', 'm.js'), 'x');
  const result = cleanup(r.repo, { exec: wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } }).exec });
  assert.deepEqual(result.candidates.map((c) => c.slice), ['S-01']);
  assert.ok(result.candidates[0].caches >= 5000);
});

test('cleanup: an untracked .recade folder (stamps, gate logs) does not make Git refuse the removal', () => {
  const r = makeRepo(['S-01']);
  mkdirSync(join(r.trees['S-01'], '.recade', 'gates'), { recursive: true });
  writeFileSync(join(r.trees['S-01'], '.recade', 'stamps.json'), '{}\n');
  writeFileSync(join(r.trees['S-01'], '.recade', 'gates', 'tests.log'), 'ok\n');
  writeFileSync(join(r.repo, 'docs', 'STACK.md'), '# Stack\n\n## 12. Harness technical sheet\n\n| Item | Value |\n|---|---|\n| Stop | `fake-stop` |\n');
  const stops = [];
  const { exec } = wire({
    prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) },
    extra: (cmd) => (cmd[0] === 'fake-stop' ? (stops.push(cmd), { code: 0, stdout: '', stderr: '' }) : undefined),
  });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(stops.length, 1);
  assert.equal(existsSync(r.trees['S-01']), false);
  assert.equal(branchExists(r.repo, r.branches['S-01']), false);
});

test('recade board cleanup: --allow-ignored is read, repeated, and refused with reconcile or an unsafe path', async () => {
  const r = makeRepo(['S-01']);
  addExclude(r, '.env.local');
  writeFileSync(join(r.trees['S-01'], '.env.local'), 'TOKEN=fictional\n');
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const kept = makeIO(r.repo, exec);
  assert.equal(await run(['board', 'cleanup', '--apply'], kept.io), 0);
  assert.equal(existsSync(r.trees['S-01']), true);
  assert.match(kept.out(), /\.env\.local/);
  const allowed = makeIO(r.repo, exec);
  assert.equal(await run(['board', 'cleanup', '--apply', '--allow-ignored', '.env.local'], allowed.io), 0);
  assert.equal(existsSync(r.trees['S-01']), false);
  for (const args of [['reconcile', '--allow-ignored', 'x'], ['cleanup', '--allow-ignored', '../x'], ['cleanup', '--allow-ignored', '/etc/x'], ['cleanup', '--allow-ignored'], ['cleanup', '--allow-ignored', '--apply']]) {
    const t = makeIO(r.repo, exec);
    assert.equal(await run(['board', ...args], t.io), 2, args.join(' '));
  }
});

// ---------------------------------------------------------------------------------------------------------
// Review fixes, round 3
// ---------------------------------------------------------------------------------------------------------

test('/slice: the DoD is ticked through the CLI in the sheet of the workspace, and the gates are green in every repository before ready-to-merge', () => {
  const slice = readFileSync(new URL('../../harness/commands/slice.md', import.meta.url), 'utf8');
  const para = /\*\*The Definition of Done is ticked before the merge\.\*\*[^\n]*/.exec(slice)[0];
  const tick = para.indexOf("run `recade slices dod '<S-nn>' --tick <n> --project '<home>'`");
  const commit = para.indexOf('commits the sheet in the workspace under the commit lock (`docs(slices): tick DoD row <n> of <S-nn>`), with no push');
  const green = para.indexOf('every stamp must be green for the current tree');
  const audit = para.indexOf('Run the guard audit');
  const move = para.indexOf('Only then run the `ready-to-merge` move');
  assert.ok(tick > 0 && tick < commit && commit < green && green < audit && audit < move, 'order: tick, commit in the workspace, green stamps, audit, move');
  assert.match(para, /never in a code repository/);
  assert.match(para, /never edit the sheet by hand or commit it with git/);
  assert.doesNotMatch(slice, /git -C '<home>' (add|commit)/);
  assert.match(para, /it changes no `HEAD` of a code repository and no gate stamp goes stale/);
  assert.match(para, /never open another pull request/);
  for (const m of slice.matchAll(/tick the Definition of Done[^\n]*?--set '<S-nn>' ready-to-merge/g)) assert.match(m[0], /check the gates as described above/);
});

test('cleanup: a modified tracked file of .recade keeps the slice and the services are not stopped', () => {
  const r = makeRepo(['S-01']);
  mkdirSync(join(r.trees['S-01'], '.recade'));
  writeFileSync(join(r.trees['S-01'], '.recade', 'note.txt'), 'tracked\n');
  git(r.trees['S-01'], 'add', '-f', '.recade/note.txt');
  git(r.trees['S-01'], 'commit', '-q', '-m', 'chore: track a recade file');
  git(r.trees['S-01'], 'push', '-q', 'origin', r.branches['S-01']);
  const head = git(r.trees['S-01'], 'rev-parse', 'HEAD');
  writeFileSync(join(r.trees['S-01'], '.recade', 'note.txt'), 'edited after the merge\n');
  writeFileSync(join(r.repo, 'docs', 'STACK.md'), '# Stack\n\n## 12. Harness technical sheet\n\n| Item | Value |\n|---|---|\n| Stop | `fake-stop` |\n');
  const stops = [];
  const { exec } = wire({
    prs: { [r.branches['S-01']]: mergedPr(head) },
    extra: (cmd) => (cmd[0] === 'fake-stop' ? (stops.push(cmd), { code: 0, stdout: '', stderr: '' }) : undefined),
  });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.deepEqual(stops, []);
  assert.equal(existsSync(join(r.trees['S-01'], '.recade', 'note.txt')), true);
  assert.match(result.kept[0].reasons.join(' '), /uncommitted/);
});

test('cleanup: a failing git ls-files on .recade keeps the slice with the reason instead of removing anything', () => {
  const r = makeRepo(['S-01']);
  mkdirSync(join(r.trees['S-01'], '.recade'));
  writeFileSync(join(r.trees['S-01'], '.recade', 'stamps.json'), '{}\n');
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const failing = (cmd, opts) => (cmd[0] === 'git' && cmd[1] === 'ls-files' && cmd.includes('.recade') ? { code: 128, stdout: '', stderr: 'fatal: simulated\n' } : exec(cmd, opts));
  const result = cleanup(r.repo, { exec: failing, apply: true });
  assert.equal(existsSync(r.trees['S-01']), true);
  assert.equal(branchExists(r.repo, r.branches['S-01']), true);
  assert.match(result.kept[0].reasons.join(' '), /git ls-files failed/);
});

// ---------------------------------------------------------------------------------------------------------
// Reconcile across code repositories (spec 6.13): one status, one pull request for each repository
// ---------------------------------------------------------------------------------------------------------

const SHA = { api: 'a1'.repeat(20), web: 'b2'.repeat(20) };
const green = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const red = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }];
const wsMerged = (repo, number) => ({ number, state: 'MERGED', mergedAt: '2026-11-13T10:00:00Z', url: `https://github.com/fernhill/${repo}/pull/${number}`, mergeCommit: { oid: SHA[repo] }, headRefOid: 'c'.repeat(40), baseRefName: 'main' });
const wsOpen = (repo, number, { checks = green, review = 'APPROVED' } = {}) => ({ number, state: 'OPEN', mergedAt: null, url: `https://github.com/fernhill/${repo}/pull/${number}`, headRefOid: 'd'.repeat(40), baseRefName: 'main', statusCheckRollup: checks, reviewDecision: review });

/** A workspace folder (no git needed for reconcile) with the registry `repos` and slices `{ 'S-01': {...} }`. */
function wsProject(slices, repos = ['api', 'web']) {
  const root = project(slices);
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({
    version: 1, kind: 'workspace', lots: ['LOAN', 'PAY'], repos: repos.map((name) => ({ name, remote: 'none', default_branch: 'main' })),
    github: { owner: 'fernhill', repo: 'fernhill-lending', project_number: 7 },
  }));
  return root;
}

/** The fake board with its `pr view` answered for each repository folder, and `issue close` recorded. */
function wsBoard(perRepo, boardOptions = {}) {
  const gh = fakeBoard(boardOptions);
  for (const i of gh.issues) i.state = 'OPEN';
  gh.views = [];
  gh.closed = [];
  const inner = gh.exec;
  gh.exec = (cmd, opts) => {
    const [a, b] = cmd.slice(1);
    if (a === 'pr' && b === 'view') {
      const repo = basename(opts.cwd);
      gh.views.push({ repo, cwd: opts.cwd, branch: cmd[3], fields: cmd[cmd.indexOf('--json') + 1] });
      const pr = perRepo[repo]?.[cmd[3]];
      if (pr === undefined && boardOptions.prs !== undefined) return inner(cmd, opts);
      return pr ? ok(pr) : { code: 1, stdout: '', stderr: `no pull requests found for branch "${cmd[3]}"` };
    }
    if (a === 'issue' && b === 'close') {
      const issue = gh.issues.find((i) => i.number === Number(cmd[3]));
      issue.state = 'CLOSED';
      gh.closed.push({ number: issue.number, repo: flag(cmd, '--repo'), args: cmd.slice(1) });
      return ok('');
    }
    return inner(cmd, opts);
  };
  return gh;
}

const TWO = ['api:src/a/**', 'web:src/w/**'];
const sheetText = (root, id = 'S-01') => readFileSync(join(root, 'slices', `${id}-x.md`), 'utf8');

test('reconcile (workspace): every pull request merged is done, with merged: and the workspace issue closed', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: TWO } });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsMerged('api', 3) }, web: { 'slice/s-01-x': wsMerged('web', 4) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(statusOf(root, 'S-01'), 'done');
  assert.match(sheetText(root), new RegExp(`\\nmerged:\\n  api: ${SHA.api}\\n  web: ${SHA.web}\\n---\\n`));
  assert.deepEqual(gh.closed.map((c) => [c.number, c.repo]), [[1, 'fernhill/fernhill-lending']], 'the issue of the slice, in the workspace repository');
  assert.equal(itemStatus(gh, 'S-01'), 'Done');
  assert.deepEqual(gh.views.map((v) => v.repo).sort(), ['api', 'web']);
  for (const v of gh.views) assert.equal(v.cwd, join(root, 'repos', v.repo), 'gh runs in the code repository folder');
  assert.match(gh.views[0].fields, /mergeCommit/);
  assert.match(gh.views[0].fields, /statusCheckRollup/);
  assert.match(gh.views[0].fields, /reviewDecision/);
  assert.deepEqual(result.writes, ['slices/S-01-x.md']);
  assert.equal(gh.comments.some((c) => /merged: api .*web /.test(c.body) && /issue closed/.test(c.body)), true);
});

test('reconcile (workspace): merged: follows merge_order, and a second run changes nothing', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: TWO, extra: 'merge_order: [web, api]\n' } });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsMerged('api', 3) }, web: { 'slice/s-01-x': wsMerged('web', 4) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  reconcile(root, { exec: gh.exec, apply: true });
  assert.match(sheetText(root), new RegExp(`merged:\\n  web: ${SHA.web}\\n  api: ${SHA.api}\\n`));
  const before = sheetText(root);
  const status = readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8');
  const closes = gh.closed.length;
  const again = reconcile(root, { exec: gh.exec, apply: true });
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.writes, []);
  assert.equal(sheetText(root), before);
  assert.equal(readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8'), status);
  assert.equal(gh.closed.length, closes, 'the issue is closed once');
});

test('reconcile (workspace): one merged and one failing stays ready-to-merge, names the failing pull request, closes nothing', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: TWO } });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsMerged('api', 3) }, web: { 'slice/s-01-x': wsOpen('web', 4, { checks: red }) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const before = sheetText(root);
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
  assert.equal(sheetText(root), before, 'no merged: record before the last merge');
  assert.deepEqual(gh.closed, []);
  assert.equal(itemStatus(gh, 'S-01'), 'In review');
  const row = result.rows.find((r) => r.id === 'S-01');
  assert.match(row.reason, /web #4.*checks failing/);
  assert.match(row.pr, /api merged #3/);
  assert.match(row.pr, /web open #4/);
  assert.match(formatReconcile(result), /web #4.*checks failing/);
});

test('reconcile (workspace): a merged pull request with an unticked DoD is never done, whatever the other repository says', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: TWO, dod: 'open' } });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsMerged('api', 3) }, web: { 'slice/s-01-x': wsMerged('web', 4) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
  assert.deepEqual(gh.closed, []);
});

test('reconcile (workspace): every pull request open, green and approved moves the slice to ready-to-merge', () => {
  const root = wsProject({ 'S-01': { status: 'audit', story: 'LOAN-01', touches: TWO } });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsOpen('api', 3) }, web: { 'slice/s-01-x': wsOpen('web', 4) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const dry = reconcile(root, { exec: gh.exec });
  assert.equal(statusOf(root, 'S-01'), 'audit', 'a dry run writes nothing');
  assert.equal(dry.rows.find((r) => r.id === 'S-01').action, 'move');
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
  assert.deepEqual(gh.closed, []);
});

test('reconcile (workspace): one pull request that is not approved keeps the slice where it is, and is named', () => {
  const root = wsProject({ 'S-01': { status: 'audit', story: 'LOAN-01', touches: TWO } });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsOpen('api', 3) }, web: { 'slice/s-01-x': wsOpen('web', 4, { review: 'REVIEW_REQUIRED' }) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(statusOf(root, 'S-01'), 'audit');
  assert.match(result.rows.find((r) => r.id === 'S-01').reason, /web #4.*not approved/);
});

test('reconcile (workspace): a dry run writes nothing and lists the sheet it would write', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: TWO } });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsMerged('api', 3) }, web: { 'slice/s-01-x': wsMerged('web', 4) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const before = [sheetText(root), readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8')];
  const result = reconcile(root, { exec: gh.exec });
  assert.deepEqual(result.writes, ['slices/S-01-x.md']);
  assert.deepEqual([sheetText(root), readFileSync(join(root, 'slices', 'STATUS.md'), 'utf8')], before);
  assert.deepEqual(gh.closed, []);
  assert.deepEqual(gh.edits, []);
});

test('reconcile (workspace): a registry of one repository reads the pull request there, for a sheet with unprefixed globs', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' } }, ['api']);
  const gh = wsBoard({ api: { 'slice/s-01-x': wsMerged('api', 3) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(statusOf(root, 'S-01'), 'done');
  assert.match(sheetText(root), new RegExp(`merged:\\n  api: ${SHA.api}\\n`));
  assert.deepEqual(gh.views.map((v) => v.repo), ['api']);
});

test('reconcile (workspace): a gh failure in one repository is an error, nothing moves for that slice, the other slices still run', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: TWO }, 'S-02': { status: 'ready-to-merge', story: 'PAY-01', touches: ['api:src/b/**'] } });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsMerged('api', 3), 'slice/s-02-x': wsMerged('api', 5) }, web: {} }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress', 'S-02': 'In review', 'PAY-01': 'In progress' } });
  const exec = (cmd, opts) => (cmd[1] === 'pr' && basename(opts.cwd) === 'web' ? { code: 1, stdout: '', stderr: 'HTTP 502: bad gateway' } : gh.exec(cmd, opts));
  const result = reconcile(root, { exec, apply: true });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /bad gateway/);
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
  assert.equal(statusOf(root, 'S-02'), 'done');
  assert.deepEqual(gh.closed.map((c) => c.number), [2]);
});

test('reconcile (legacy, no registry): one pull request in the project folder, no merged:, no issue closed', () => {
  const root = project({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01' } });
  const gh = wsBoard({}, { prs: { 'slice/s-01-x': merged(12) }, items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const before = sheetText(root);
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(statusOf(root, 'S-01'), 'done');
  assert.equal(sheetText(root), before);
  assert.deepEqual(gh.closed, []);
  assert.deepEqual(result.writes, []);
});

// ---------------------------------------------------------------------------------------------------------
// Cleanup across code repositories (spec 6.9): worktrees and merged branches of each repository,
// artifacts/<repo>/<S-nn>/ and tmp/, never artifacts/<repo>/<version>/
// ---------------------------------------------------------------------------------------------------------

/** A workspace (git, registry) with code repositories under repos/, each built by `makeRepo` with the same slices. */
function makeWs(names, slices = ['S-01'], { branch, stack } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'recade-wsclean-')));
  const ws = join(base, 'Projets Clients', 'Été-workspace');
  mkdirSync(join(ws, 'recade'), { recursive: true });
  mkdirSync(join(ws, 'docs'), { recursive: true });
  writeFileSync(join(ws, 'recade', 'state.yaml'), stringify({ version: 1, kind: 'workspace', repos: names.map((name) => ({ name, remote: 'none', default_branch: 'main' })) }));
  if (stack !== undefined) writeFileSync(join(ws, 'docs', 'STACK.md'), stack);
  git(ws, 'init', '-q', '-b', 'main');
  const repos = {};
  for (const name of names) repos[name] = makeRepo(slices, { base, name, repoDir: join(ws, 'repos', name), branch });
  const artifact = (repo, dir, file = 'build.bin') => {
    mkdirSync(join(ws, 'artifacts', repo, dir), { recursive: true });
    writeFileSync(join(ws, 'artifacts', repo, dir, file), Buffer.alloc(5000, 7));
  };
  return { base, ws, repos, artifact };
}

/** Exec that answers `gh pr view` for each repository folder from `prs[repo][branch]`, everything else on the machine. */
function wsWire(prs, extra = () => undefined) {
  const calls = [];
  const exec = (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd });
    const own = extra(cmd, opts);
    if (own !== undefined) return own;
    if (cmd[0] === 'gh') {
      const pr = prs[basename(opts.cwd)]?.[cmd[3]];
      return pr ? ok(pr) : { code: 1, stdout: '', stderr: `no pull requests found for branch "${cmd[3]}"` };
    }
    return defaultExec(cmd, opts);
  };
  return { exec, calls };
}

const allMerged = (w) => Object.fromEntries(Object.entries(w.repos).map(([name, r]) => [name, { [r.branches['S-01']]: mergedPr(r.heads['S-01'], name === 'api' ? 3 : 4) }]));

test('cleanup (workspace): worktrees and merged branches of each repository, artifacts of the slice and tmp/ go; the version folders stay', () => {
  const w = makeWs(['api', 'web']);
  w.artifact('api', 'S-01');
  w.artifact('api', '1.2.0', 'app.apk');
  w.artifact('web', 'S-01');
  mkdirSync(join(w.ws, 'tmp', 'sub'), { recursive: true });
  writeFileSync(join(w.ws, 'tmp', 'draft.txt'), 'draft\n');
  writeFileSync(join(w.ws, 'tmp', 'sub', 'more.txt'), 'more\n');
  const { exec, calls } = wsWire(allMerged(w));
  const result = cleanup(w.ws, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  for (const [name, r] of Object.entries(w.repos)) {
    assert.equal(existsSync(r.trees['S-01']), false, `${name} worktree`);
    assert.equal(branchExists(r.repo, r.branches['S-01']), false, `${name} branch`);
    assert.equal(remoteHas(r.origin, r.branches['S-01']), false, `${name} remote branch`);
    assert.equal(existsSync(join(w.ws, 'artifacts', name, 'S-01')), false, `${name} slice artifacts`);
  }
  assert.equal(existsSync(join(w.ws, 'artifacts', 'api', '1.2.0', 'app.apk')), true, 'a version folder is kept');
  assert.deepEqual(readdirSync(join(w.ws, 'tmp')), [], 'tmp/ is emptied and stays');
  assert.deepEqual(result.removed.map((r) => [r.repo, r.slice]), [['api', 'S-01'], ['web', 'S-01']]);
  assert.ok(result.bytesFreed >= 10000, `freed ${result.bytesFreed}`);
  assert.equal(result.tmp.removed, true);
  // gh ran in each repository folder
  assert.deepEqual([...new Set(calls.filter((c) => c.cmd[0] === 'gh').map((c) => basename(c.cwd)))].sort(), ['api', 'web']);
  const text = formatCleanup(result);
  assert.match(text, /api: S-01 slice\/S-01-x/);
  assert.match(text, /web: S-01 slice\/S-01-x/);
  assert.match(text, /artifacts\/api\/S-01/);
});

test('cleanup (workspace): a dry run lists everything and changes nothing', () => {
  const w = makeWs(['api', 'web']);
  w.artifact('api', 'S-01');
  mkdirSync(join(w.ws, 'tmp'));
  writeFileSync(join(w.ws, 'tmp', 'draft.txt'), 'draft\n');
  const { exec } = wsWire(allMerged(w));
  const result = cleanup(w.ws, { exec });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.candidates.map((c) => `${c.repo}:${c.slice}`), ['api:S-01', 'web:S-01']);
  assert.deepEqual(result.candidates[0].artifacts, ['artifacts/api/S-01']);
  assert.deepEqual(result.candidates[1].artifacts, []);
  assert.equal(result.tmp.planned, true);
  assert.ok(result.bytesEstimate >= 5000);
  for (const r of Object.values(w.repos)) assert.equal(existsSync(r.trees['S-01']), true);
  assert.equal(existsSync(join(w.ws, 'artifacts', 'api', 'S-01', 'build.bin')), true);
  assert.equal(existsSync(join(w.ws, 'tmp', 'draft.txt')), true);
  assert.match(formatCleanup(result), /Dry run/);
});

test('cleanup (workspace): an unpushed commit keeps that repository branch, its artifacts and tmp/; the other repository is cleaned', () => {
  const w = makeWs(['api', 'web']);
  w.artifact('api', 'S-01');
  w.artifact('web', 'S-01');
  mkdirSync(join(w.ws, 'tmp'));
  writeFileSync(join(w.ws, 'tmp', 'draft.txt'), 'draft\n');
  const api = w.repos.api;
  writeFileSync(join(api.trees['S-01'], 'late.txt'), 'late work\n');
  git(api.trees['S-01'], 'add', '.');
  git(api.trees['S-01'], 'commit', '-q', '-m', 'feat: late');
  const { exec } = wsWire(allMerged(w));
  const result = cleanup(w.ws, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(branchExists(api.repo, api.branches['S-01']), true, 'unpushed work is never deleted');
  assert.equal(existsSync(api.trees['S-01']), true);
  assert.equal(existsSync(join(w.ws, 'artifacts', 'api', 'S-01', 'build.bin')), true);
  assert.equal(existsSync(w.repos.web.trees['S-01']), false);
  assert.equal(existsSync(join(w.ws, 'artifacts', 'web', 'S-01')), false);
  assert.equal(existsSync(join(w.ws, 'tmp', 'draft.txt')), true, 'tmp/ stays while a slice is kept');
  assert.equal(result.tmp.removed, false);
  assert.deepEqual(result.kept.map((k) => k.repo), ['api']);
  assert.match(result.kept[0].reasons.join(' '), /not in the merged pull request/);
});

test('cleanup (workspace): a slice branch with a lower-case id (the default branch of /parallel) is found', () => {
  const w = makeWs(['api'], ['S-01'], { branch: (id) => `slice/${id.toLowerCase()}` });
  w.artifact('api', 'S-01');
  const { exec } = wsWire(allMerged(w));
  const result = cleanup(w.ws, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(branchExists(w.repos.api.repo, 'slice/s-01'), false);
  assert.equal(existsSync(join(w.ws, 'artifacts', 'api', 'S-01')), false);
});

test('cleanup (workspace): the stop command is the one of the table of each repository in the STACK of the workspace', () => {
  const table = (stop) => `| Item | Value |\n|---|---|\n| Test | \`make test\` |\n| Stop | \`${stop}\` |\n`;
  const stack = `# Stack\n\n## 12. Harness technical sheet\n\n### api\n\n${table('make stop-api')}\n### web\n\n${table('make stop-web')}`;
  const w = makeWs(['api', 'web'], ['S-01'], { stack });
  const stops = [];
  const { exec } = wsWire(allMerged(w), (cmd, opts) => {
    if (cmd[0] === 'make') {
      stops.push([cmd.join(' '), opts.cwd]);
      return ok('');
    }
    return undefined;
  });
  const result = cleanup(w.ws, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(stops, [['make stop-api', w.repos.api.trees['S-01']], ['make stop-web', w.repos.web.trees['S-01']]]);
});

test('cleanup (workspace): an artifacts folder that is a link is kept, never followed', () => {
  const w = makeWs(['api']);
  const outside = join(w.base, 'precious');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep\n');
  mkdirSync(join(w.ws, 'artifacts', 'api'), { recursive: true });
  symlinkSync(outside, join(w.ws, 'artifacts', 'api', 'S-01'));
  const { exec } = wsWire(allMerged(w));
  const result = cleanup(w.ws, { exec, apply: true });
  assert.equal(existsSync(join(outside, 'keep.txt')), true);
  assert.equal(existsSync(w.repos.api.trees['S-01']), false, 'the code part is cleaned');
  assert.match(result.warnings.join(' '), /artifacts\/api\/S-01.*link/);
});

test('cleanup (workspace): a repository folder that is missing is an error naming it, the others are cleaned', () => {
  const w = makeWs(['api', 'web']);
  rmSync(w.repos.web.repo, { recursive: true, force: true });
  const { exec } = wsWire(allMerged(w));
  const result = cleanup(w.ws, { exec, apply: true });
  assert.equal(existsSync(w.repos.api.trees['S-01']), false);
  assert.match(result.errors.join('\n'), /web: .*not a git repository/i);
});

test('cleanup (single repository, from a code repository folder) is unchanged: no repo field, no artifacts, no tmp', () => {
  const r = makeRepo(['S-01']);
  const { exec } = wire({ prs: { [r.branches['S-01']]: mergedPr(r.heads['S-01']) } });
  const result = cleanup(r.repo, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.removed[0].repo, undefined);
  assert.equal(result.tmp, undefined);
});

// ---------------------------------------------------------------------------------------------------------
// Fix round: cleanup never removes anything outside the workspace, unmerged work keeps its artifacts,
// a repository folder that is not its own git repository is never cleaned as the workspace
// ---------------------------------------------------------------------------------------------------------

/** A folder outside the workspace with one precious file at `rel`. */
function precious(w, name, rel) {
  const outside = join(w.base, name);
  mkdirSync(join(outside, rel, '..'), { recursive: true });
  writeFileSync(join(outside, rel), 'precious\n');
  return { outside, file: join(outside, rel) };
}

test('cleanup (workspace): artifacts/<repo> that is a link to a folder outside is never followed', () => {
  const w = makeWs(['api']);
  const p = precious(w, 'OUTSIDE', 'S-01/precious.txt');
  mkdirSync(join(w.ws, 'artifacts'), { recursive: true });
  symlinkSync(p.outside, join(w.ws, 'artifacts', 'api'));
  const result = cleanup(w.ws, { exec: wsWire(allMerged(w)).exec, apply: true });
  assert.equal(existsSync(p.file), true, 'nothing outside the workspace is removed');
  assert.match(result.warnings.join(' '), /artifacts\/api.*link/);
  assert.equal(existsSync(w.repos.api.trees['S-01']), false, 'the code part is still cleaned');
});

test('cleanup (workspace): artifacts/ that is a link to a folder outside is never followed, dry run included', () => {
  const w = makeWs(['api']);
  const p = precious(w, 'OUTSIDE2', 'api/S-01/precious.txt');
  symlinkSync(p.outside, join(w.ws, 'artifacts'));
  const dry = cleanup(w.ws, { exec: wsWire(allMerged(w)).exec });
  assert.deepEqual(dry.candidates[0].artifacts, []);
  assert.match(dry.warnings.join(' '), /artifacts.*link/);
  const result = cleanup(w.ws, { exec: wsWire(allMerged(w)).exec, apply: true });
  assert.equal(existsSync(p.file), true);
  assert.match(result.warnings.join(' '), /artifacts.*link/);
});

test('cleanup (workspace): a worktree whose path goes through a link to outside the repository is kept whole', () => {
  const w = makeWs(['api']);
  const api = w.repos.api;
  const moved = join(w.base, 'moved-worktrees');
  renameSync(join(api.repo, '.claude', 'worktrees'), moved);
  symlinkSync(moved, join(api.repo, '.claude', 'worktrees'));
  const result = cleanup(w.ws, { exec: wsWire(allMerged(w)).exec, apply: true });
  assert.equal(existsSync(join(moved, 'S-01', 'S-01.txt')), true, 'the worktree is untouched');
  assert.equal(branchExists(api.repo, api.branches['S-01']), true);
  assert.match(result.kept[0].reasons.join(' '), /outside the repository/);
});

test('cleanup (workspace): artifacts of a slice stay while another branch of that slice is kept in the same repository', () => {
  const w = makeWs(['api']);
  w.artifact('api', 'S-01');
  const api = w.repos.api;
  const other = join(api.repo, '.claude', 'worktrees', 'S-01b');
  git(api.repo, 'worktree', 'add', '-q', other, '-b', 'slice/S-01-other');
  writeFileSync(join(other, 'wip.txt'), 'unmerged\n');
  git(other, 'add', '.');
  git(other, 'commit', '-q', '-m', 'feat: wip');
  const prs = allMerged(w);
  const result = cleanup(w.ws, { exec: wsWire(prs).exec, apply: true });
  assert.deepEqual(result.kept.map((k) => k.branch), ['slice/S-01-other']);
  assert.deepEqual(result.removed.map((r) => r.branch), [api.branches['S-01']]);
  assert.equal(existsSync(join(w.ws, 'artifacts', 'api', 'S-01', 'build.bin')), true, 'the slice still has unmerged work here');
  assert.deepEqual(result.removed[0].artifacts, []);
});

test('cleanup (workspace): a registered repos/<name> with no .git of its own is an error, never cleaned as the workspace', () => {
  const w = makeWs(['api', 'web']);
  rmSync(w.repos.web.repo, { recursive: true, force: true });
  mkdirSync(w.repos.web.repo, { recursive: true });
  git(w.ws, 'commit', '-q', '--allow-empty', '-m', 'chore: start');
  git(w.ws, 'branch', 'slice/S-09-ws');
  const { exec, calls } = wsWire(allMerged(w));
  const result = cleanup(w.ws, { exec, apply: true });
  assert.match(result.errors.join('\n'), /web: repos\/web is not a git repository\. Run: recade repo sync/);
  assert.equal(result.kept.some((k) => k.repo === 'web'), false);
  assert.equal(branchExists(w.ws, 'slice/S-09-ws'), true);
  assert.equal(calls.some((c) => c.cmd[0] === 'gh' && c.cwd === w.repos.web.repo), false, 'no gh call in the empty folder');
  assert.equal(existsSync(w.repos.api.trees['S-01']), false, 'the other repository is cleaned');
});

test('reconcile (workspace): a repos/<name> with no .git of its own is an error, no pull request of the workspace is read for it', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: TWO } });
  mkdirSync(join(root, 'repos', 'web'), { recursive: true });
  const gh = wsBoard({ api: { 'slice/s-01-x': wsMerged('api', 3) }, web: { 'slice/s-01-x': wsMerged('web', 4) } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.match(result.errors.join('\n'), /web: repos\/web is not a git repository\. Run: recade repo sync/);
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
  assert.equal(gh.views.some((v) => v.repo === 'web'), false);
});

// ---------------------------------------------------------------------------------------------------------
// Fix round: a PR merged into another base is not merged here; a draft PR is not ready
// ---------------------------------------------------------------------------------------------------------

test('reconcile (workspace): a pull request merged into a branch other than the default branch does not count as merged', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: TWO } });
  const gh = wsBoard({
    api: { 'slice/s-01-x': { ...wsMerged('api', 3), baseRefName: 'develop' } },
    web: { 'slice/s-01-x': wsMerged('web', 4) },
  }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const before = sheetText(root);
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(statusOf(root, 'S-01'), 'ready-to-merge');
  assert.equal(sheetText(root), before);
  assert.deepEqual(gh.closed, []);
  assert.match(result.rows.find((r) => r.id === 'S-01').reason, /api #3.*develop.*main/);
  assert.match(gh.views[0].fields, /baseRefName/);
});

test('reconcile (workspace): the default branch of the entry decides, not the word main', () => {
  const root = wsProject({ 'S-01': { status: 'ready-to-merge', story: 'LOAN-01', touches: ['api:src/a/**'] } }, ['api']);
  const file = join(root, 'recade', 'state.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace('default_branch: main', 'default_branch: trunk'));
  const gh = wsBoard({ api: { 'slice/s-01-x': { ...wsMerged('api', 3), baseRefName: 'trunk' } } }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(statusOf(root, 'S-01'), 'done');
});

test('reconcile (workspace): a draft pull request is not ready, even green and approved', () => {
  const root = wsProject({ 'S-01': { status: 'audit', story: 'LOAN-01', touches: TWO } });
  const gh = wsBoard({
    api: { 'slice/s-01-x': wsOpen('api', 3) },
    web: { 'slice/s-01-x': { ...wsOpen('web', 4), isDraft: true } },
  }, { items: { 'S-01': 'In review', 'LOAN-01': 'In progress' } });
  const result = reconcile(root, { exec: gh.exec, apply: true });
  assert.equal(statusOf(root, 'S-01'), 'audit');
  assert.match(result.rows.find((r) => r.id === 'S-01').reason, /web #4 \(draft\)/);
  assert.match(gh.views[0].fields, /isDraft/);
});
