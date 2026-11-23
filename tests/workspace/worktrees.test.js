import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { install } from '../../src/harness/install.js';
import { defaultExec } from '../../src/harness/stamps.js';
import { ignoresWorktrees, legacyWorktrees, openSlice, worktreePath, worktreeRel } from '../../src/workspace/worktrees.js';
import { cli, git, makeWorkspace, plugin } from '../harness/fixture-project.js';

const exec = defaultExec;
const sheet = (ws, id, slug, { lane = 'standard', touches, branch = `slice/${id}-${slug}` } = {}) => writeFileSync(
  join(ws.dir, 'slices', `${id}-${slug}.md`),
  `---\nid: ${id}\ntitle: ${slug}\nlane: ${lane}\nbranch: ${branch}\ntouches: [${touches.join(', ')}]\n---\n\n## Goal\n\n${slug}.\n`,
);

async function workspace() {
  const ws = await makeWorkspace({ repos: ['api', 'web'] });
  install(ws.dir, { pluginRoot: plugin, target: 'workspace', ref: 'v1.0.0' });
  sheet(ws, 'S-04', 'orders', { touches: ['web:src/orders/**', 'api:src/orders/**'] });
  return ws;
}

test('the worktree of a slice is worktrees/<repo>/<S-nn> of the workspace', () => {
  assert.equal(worktreeRel('api', 'S-04'), 'worktrees/api/S-04');
  assert.equal(worktreePath('/w', 'api', 'S-04'), '/w/worktrees/api/S-04');
  assert.equal(ignoresWorktrees('repos/\nworktrees/\n'), true);
  assert.equal(ignoresWorktrees('/worktrees/\n'), true);
  assert.equal(ignoresWorktrees('repos/\n.claude/worktrees/\n'), false);
});

test('openSlice reads touches: and opens one worktree for each repository it names, on the branch of the sheet, in order', async () => {
  const ws = await workspace();
  const r = openSlice(ws.dir, 'S-04', { exec });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.worktrees.map((w) => [w.repo, w.status]), [['web', 'created'], ['api', 'created']]);
  for (const name of ['api', 'web']) {
    const tree = join(ws.dir, 'worktrees', name, 'S-04');
    assert.equal(git(tree, 'branch', '--show-current').stdout.trim(), 'slice/S-04-orders');
    assert.equal(realpathSync(git(tree, 'rev-parse', '--path-format=absolute', '--git-common-dir').stdout.trim()), realpathSync(join(ws.repo(name), '.git')));
  }
  // The workspace does not see them: worktrees/ is ignored.
  assert.equal(git(ws.dir, 'status', '--porcelain', '--untracked-files=all', '--', 'worktrees').stdout, '');
  // A second run keeps what is there.
  const again = openSlice(ws.dir, 'S-04', { exec });
  assert.deepEqual(again.worktrees.map((w) => w.status), ['exists', 'exists']);
});

test('openSlice: a no-code slice opens nothing, a branch without a worktree is attached, and what is in the way is refused', async () => {
  const ws = await workspace();
  sheet(ws, 'S-05', 'choose-a-bank', { lane: 'no-code', touches: [] });
  const none = openSlice(ws.dir, 'S-05', { exec });
  assert.deepEqual([none.lane, none.worktrees, none.errors], ['no-code', [], []]);
  // The branch exists in api already (a slice that was resumed after its worktree was removed).
  git(ws.repo('api'), 'branch', 'slice/S-04-orders');
  // A plain folder sits where the web worktree goes.
  mkdirSync(join(ws.dir, 'worktrees', 'web', 'S-04'), { recursive: true });
  const r = openSlice(ws.dir, 'S-04', { exec });
  assert.deepEqual(r.worktrees.map((w) => [w.repo, w.status]), [['api', 'attached']]);
  assert.match(r.errors.join('\n'), /^web: worktrees\/web\/S-04 exists and is not a worktree of web/);
  // A sheet whose branch breaks the rule, an unknown slice, and a workspace that does not ignore worktrees/.
  sheet(ws, 'S-06', 'pay', { touches: ['api:src/pay/**'], branch: 'feature/pay' });
  assert.match(openSlice(ws.dir, 'S-06', { exec }).errors[0], /the rule is slice\/S-06-pay/);
  assert.match(openSlice(ws.dir, 'S-09', { exec }).errors[0], /no sheet for S-09/);
  // An older workspace that kept worktrees/ out by .gitignore only: the line goes to .git/info/exclude, the slice opens.
  const exclude = join(ws.dir, '.git', 'info', 'exclude');
  writeFileSync(exclude, '');
  writeFileSync(join(ws.dir, '.gitignore'), 'repos/\n');
  sheet(ws, 'S-07', 'refunds', { touches: ['api:src/refunds/**'] });
  assert.deepEqual(openSlice(ws.dir, 'S-07', { exec }).errors, []);
  assert.deepEqual(readFileSync(exclude, 'utf8').split('\n').filter(Boolean), ['repos/', 'worktrees/']);
  assert.equal(readFileSync(join(ws.dir, '.gitignore'), 'utf8'), 'repos/\n', 'the tracked .gitignore is left as it is');
  // A workspace with no git at all cannot keep them out: the slice does not open.
  const bare = await workspace();
  sheet(bare, 'S-07', 'refunds', { touches: ['api:src/refunds/**'] });
  rmSync(join(bare.dir, '.git'), { recursive: true, force: true });
  writeFileSync(join(bare.dir, '.gitignore'), '');
  assert.match(openSlice(bare.dir, 'S-07', { exec }).errors[0], /does not keep worktrees\/ out of git/);
});

test('recade slices open runs from the workspace, prints the worktrees, and exits 1 when one is missing', async () => {
  const ws = await workspace();
  const out = await cli(ws.dir, ['slices', 'open', 'S-04']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /created {2}web: .*worktrees\/web\/S-04 on slice\/S-04-orders/);
  const json = JSON.parse((await cli(ws.dir, ['slices', 'open', 'S-04', '--json'])).stdout);
  assert.deepEqual(json.worktrees.map((w) => w.status), ['exists', 'exists']);
  const fromRepo = await cli(ws.repo('api'), ['slices', 'open', 'S-04']);
  assert.equal(fromRepo.code, 1);
  assert.match(fromRepo.stderr, /runs from the workspace/);
  assert.equal((await cli(ws.dir, ['slices', 'open', 'S-4'])).code, 2);
});

test('legacyWorktrees lists the slice worktrees of the old layout only', async () => {
  const ws = await workspace();
  openSlice(ws.dir, 'S-04', { exec });
  const old = join(ws.repo('api'), '.claude', 'worktrees', 'S-02');
  git(ws.repo('api'), 'worktree', 'add', '-q', '-b', 'slice/S-02-old', old);
  const found = legacyWorktrees(ws.dir, { exec });
  assert.deepEqual(found.map((t) => [t.repo, t.name, t.branch]), [['api', 'S-02', 'slice/S-02-old']]);
  assert.ok(existsSync(old));
});
