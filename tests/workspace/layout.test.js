import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  WORKSPACE_TREE, IGNORED, LOCAL_ONLY, LINK_FILE, keepLocal, keptOut, createWorkspace, findWorkspace, linkRepo, checkLink,
} from '../../src/workspace/layout.js';
import { defaultExec } from '../../src/doctor.js';
import { git } from '../harness/fixture-project.js';
import { cli } from '../harness/fixture-project.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'recade-ws-')));
const must = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r;
};

/** A workspace with one real code repository `api` (one commit) linked to it. */
async function withRepo(parent = tmp(), name = 'api') {
  const { dir } = await createWorkspace(parent, 'fernhill', { exec: defaultExec });
  const repo = join(dir, 'repos', name);
  mkdirSync(repo, { recursive: true });
  must(git(repo, 'init', '-q', '-b', 'main'));
  must(git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: start'));
  linkRepo(dir, repo);
  return { dir, repo, parent };
}

test('constants: the tracked tree, the ignored entries, the code checkouts and the link file', () => {
  assert.deepEqual(IGNORED, ['artifacts/', 'tmp/', '.recade/']);
  assert.deepEqual(LOCAL_ONLY, ['repos/', 'worktrees/']);
  assert.equal(LINK_FILE, '.recade/workspace');
  for (const d of ['recade', 'intake', 'team', 'design', 'decisions', 'retros', 'docs/figures', 'docs/deliverables', 'docs/source', 'slices']) {
    assert.ok(WORKSPACE_TREE.some((t) => t === d || t.startsWith(`${d}/`)), d);
  }
  assert.ok(!WORKSPACE_TREE.some((t) => [...IGNORED, ...LOCAL_ONLY].some((i) => t.startsWith(i))));
});

test('createWorkspace makes <slug>-workspace with the tree, the four ignored lines and kind: workspace', async () => {
  const parent = tmp();
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const { dir } = await createWorkspace(parent, 'fernhill', { exec });
  assert.equal(dir, join(parent, 'fernhill-workspace'));
  assert.deepEqual(calls, [['git', '-C', dir, 'init', '-b', 'main']]);
  for (const d of WORKSPACE_TREE) assert.ok(existsSync(join(dir, d)), d);
  assert.deepEqual(readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').filter(Boolean), IGNORED);
  const state = parse(readFileSync(join(dir, 'recade', 'state.yaml'), 'utf8'));
  assert.equal(state.kind, 'workspace');
});

test('createWorkspace refuses a non-empty target, accepts an empty one and cleans up when git init fails', async () => {
  const parent = tmp();
  const ok = async () => ({ code: 0, stdout: '', stderr: '' });
  mkdirSync(join(parent, 'fernhill-workspace'));
  await createWorkspace(parent, 'fernhill', { exec: ok });
  await assert.rejects(createWorkspace(parent, 'fernhill', { exec: ok }), /already exists and is not empty/);
  const other = tmp();
  const bad = async () => ({ code: 1, stdout: '', stderr: 'fatal: nope\nmore' });
  await assert.rejects(createWorkspace(other, 'fernhill', { exec: bad }), /git init failed: fatal: nope/);
  assert.deepEqual(readdirSync(other), []);
});

test('a parent path with a space and an accent works, the path stays one argv element', async () => {
  const parent = join(tmp(), 'Projets Clients', 'Été');
  mkdirSync(parent, { recursive: true });
  const seen = [];
  const exec = (cmd, args) => {
    seen.push(args);
    return defaultExec(cmd, args);
  };
  const { dir } = await createWorkspace(parent, 'fernhill', { exec });
  assert.equal(seen[0][1], dir);
  assert.ok(existsSync(join(dir, '.git')));
  const repo = join(dir, 'repos', 'api');
  mkdirSync(repo, { recursive: true });
  must(git(repo, 'init', '-q', '-b', 'main'));
  linkRepo(dir, repo);
  assert.deepEqual(findWorkspace(repo), { dir, via: 'link' });
  assert.deepEqual(checkLink(repo), { ok: true });
});

test('findWorkspace: self from the root and its folders, link from a code repository and from a real worktree', async () => {
  const { dir, repo } = await withRepo();
  assert.deepEqual(findWorkspace(dir), { dir, via: 'self' });
  assert.deepEqual(findWorkspace(join(dir, 'docs', 'figures')), { dir, via: 'self' });
  assert.deepEqual(findWorkspace(repo), { dir, via: 'link' });
  mkdirSync(join(repo, 'src'));
  assert.deepEqual(findWorkspace(join(repo, 'src')), { dir, via: 'link' });
  const wt = join(repo, '.claude', 'worktrees', 'S-01');
  must(git(repo, 'worktree', 'add', '-q', '-b', 'slice/S-01', wt));
  assert.deepEqual(findWorkspace(wt), { dir, via: 'link' });
  mkdirSync(join(wt, 'deep'));
  assert.deepEqual(findWorkspace(join(wt, 'deep')), { dir, via: 'link' });
  assert.deepEqual(checkLink(wt), { ok: true });
});

test('findWorkspace is null outside a workspace and for a code repository without a link', async () => {
  assert.equal(findWorkspace(tmp()), null);
  const { dir } = await createWorkspace(tmp(), 'fernhill', { exec: defaultExec });
  const repo = join(dir, 'repos', 'web');
  mkdirSync(repo, { recursive: true });
  must(git(repo, 'init', '-q', '-b', 'main'));
  assert.equal(findWorkspace(repo), null);
  assert.deepEqual(checkLink(repo), { ok: false, reason: 'link missing' });
});

test('linkRepo writes the path in .recade/workspace and keeps it out of git without touching tracked files', async () => {
  const { dir, repo } = await withRepo();
  assert.equal(readFileSync(join(repo, '.recade', 'workspace'), 'utf8'), `${dir}\n`);
  const status = must(git(repo, 'status', '--porcelain')).stdout;
  assert.equal(status, '');
  linkRepo(dir, repo);
  assert.equal(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l === '/.recade/').length, 1);
});

test('checkLink: a link to another workspace is refused', async () => {
  const { repo } = await withRepo();
  const other = await createWorkspace(tmp(), 'other', { exec: defaultExec });
  writeFileSync(join(repo, '.recade', 'workspace'), `${other.dir}\n`);
  assert.deepEqual(checkLink(repo), { ok: false, reason: 'link points elsewhere' });
});

test('checkLink: a moved workspace leaves a stale link, a re-cloned one a link to the old workspace', async () => {
  const { dir, repo, parent } = await withRepo();
  const moved = join(parent, 'Été renamed-workspace');
  renameSync(dir, moved);
  const movedRepo = join(moved, 'repos', 'api');
  assert.deepEqual(checkLink(movedRepo), { ok: false, reason: 'workspace moved' });
  assert.equal(findWorkspace(movedRepo), null);
  assert.deepEqual(findWorkspace(moved), { dir: moved, via: 'self' });
  linkRepo(moved, movedRepo);
  assert.deepEqual(checkLink(movedRepo), { ok: true });
  assert.ok(!existsSync(repo));
});

test('checkLink: a link to a folder that is not a workspace counts as moved', async () => {
  const { repo } = await withRepo();
  writeFileSync(join(repo, '.recade', 'workspace'), `${tmp()}\n`);
  assert.deepEqual(checkLink(repo), { ok: false, reason: 'workspace moved' });
});

test('recade workspace root prints the path; outside a workspace it exits 1 and advises recade repo sync', async () => {
  const { dir, repo } = await withRepo();
  const inside = await cli(repo, ['workspace', 'root']);
  assert.equal(inside.code, 0);
  assert.equal(inside.stdout, `${dir}\n`);
  const root = await cli(dir, ['workspace', 'root']);
  assert.deepEqual([root.code, root.stdout], [0, `${dir}\n`]);
  const none = await cli(tmp(), ['workspace', 'root']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no workspace/);
  assert.match(none.stderr, /recade repo sync/);
  assert.equal(none.stdout, '');
  const usage = await cli(dir, ['workspace']);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /^Usage: recade workspace root \| auto-push on\|off/);
  assert.equal((await cli(dir, ['workspace', 'root', 'x'])).code, 2);
});

test('linkRepo and checkLink refuse a folder that is not a git repository yet, even inside a workspace', async () => {
  const { dir } = await withRepo();
  const bare = join(dir, 'repos', 'web');
  mkdirSync(bare, { recursive: true });
  assert.throws(() => linkRepo(dir, bare), /not a git repository/);
  assert.equal(existsSync(join(dir, '.recade', 'workspace')), false);
  assert.deepEqual(checkLink(bare), { ok: false, reason: 'not a git repository' });
  assert.equal(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8').includes('/.recade/'), false);
});

test('recade workspace auto-push on|off writes workspace.auto_push and keeps the other state', async () => {
  const { dir } = await withRepo();
  const now = () => new Date(2026, 10, 18);
  const read = () => parse(readFileSync(join(dir, 'recade', 'state.yaml'), 'utf8'));
  const on = await cli(dir, ['workspace', 'auto-push', 'on'], { now });
  assert.equal(on.code, 0);
  assert.deepEqual(read().workspace, { auto_push: true, auto_push_since: '2026-11-18' });
  assert.equal(read().kind, 'workspace');
  const again = await cli(dir, ['workspace', 'auto-push', 'on'], { now: () => new Date(2026, 11, 1) });
  assert.equal(again.code, 0);
  assert.equal(read().workspace.auto_push_since, '2026-11-18');
  const off = await cli(dir, ['workspace', 'auto-push', 'off'], { now });
  assert.equal(off.code, 0);
  assert.deepEqual(read().workspace, { auto_push: false });
  assert.equal((await cli(dir, ['workspace', 'auto-push', 'maybe'])).code, 2);
  assert.equal((await cli(dir, ['workspace', 'auto-push'])).code, 2);
  const none = await cli(tmp(), ['workspace', 'auto-push', 'on']);
  assert.equal(none.code, 1);
  assert.match(none.stderr, /no workspace/);
});
