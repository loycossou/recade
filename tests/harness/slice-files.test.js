import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleHook } from '../../src/harness/guard.js';
import { linkRepo } from '../../src/workspace/layout.js';

// Spec 6.14: no private slice content in a code repository or a pull request. The tracking sheet, the journal, the PR
// body and the human actions of a slice live in the workspace, under tmp/<S-nn>/, never under docs/suivi/ of a code
// repository, and the PR body carries no DoD row, no decision and no text of the sheet.

const plugin = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const agentsDir = join(plugin, 'harness', 'agents');
const commandsDir = join(plugin, 'harness', 'commands');
const agent = (n) => readFileSync(join(agentsDir, `${n}.md`), 'utf8');
const section = (body, title) => {
  const m = new RegExp(`^## ${title}\\s*$`, 'm').exec(body);
  if (m === null) return '';
  const rest = body.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
};
const writesOf = (body) => [...section(body, 'Writes').matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** A workspace with one linked code repository `api` and the worktree of slice S-01. */
function makeWorkspace() {
  const ws = join(mkdtempSync(join(tmpdir(), 'recade-ws-')), 'fern-workspace');
  mkdirSync(join(ws, 'recade'), { recursive: true });
  mkdirSync(join(ws, 'slices'));
  writeFileSync(join(ws, '.gitignore'), 'repos/\nartifacts/\ntmp/\n.recade/\n');
  writeFileSync(join(ws, 'recade', 'state.yaml'), 'version: 1\nkind: workspace\nrepos:\n  - name: api\n    path: repos/api\n');
  writeFileSync(join(ws, 'slices', 'S-01-orders.md'), '---\nid: S-01\ntouches:\n  - "src/**"\n---\n# S-01\n');
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '.');
  git(ws, 'commit', '-q', '-m', 'chore: start');
  const repo = join(ws, 'repos', 'api');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'src', 'a.ts'), 'api\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'chore: start');
  linkRepo(ws, repo);
  const wt = join(repo, '.claude', 'worktrees', 'S-01');
  git(repo, 'worktree', 'add', '-q', '-b', 'slice/S-01-orders', wt, 'main');
  return { ws: realpathSync(ws), wt };
}

const write = (cwd, name, file) => handleHook(JSON.stringify({ cwd, agent_type: name, tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }), { pluginRoot: plugin, tmp: [] });
const isDenied = (out) => out !== '' && JSON.parse(out).hookSpecificOutput.permissionDecision === 'deny';

test('no harness agent or command keeps the tracking sheet, the journal or the PR body under docs/suivi: they live in the workspace, under tmp/<S-nn>/', () => {
  for (const dir of [agentsDir, commandsDir]) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      assert.equal(/docs\/suivi\/<S-nn>(\.md|-journal|-pr|-human-actions)|suivi\/S-\d\d(\.md|-)/.test(readFileSync(join(dir, f), 'utf8')), false, `${f} names a slice file of a code repository`);
    }
  }
  for (const n of ['implementer', 'implementer-critical']) {
    const w = writesOf(agent(n));
    assert.ok(w.includes('workspace:tmp/<S-nn>/tracking.md') && w.includes('workspace:tmp/<S-nn>/journal.md'), n);
  }
  assert.deepEqual(writesOf(agent('release-manager')), ['workspace:artifacts/*/<S-nn>/**', 'workspace:tmp/<S-nn>/**', 'workspace:slices/reviews/<S-nn>.md']);
});

test('the PR body holds the technical summary, the test evidence and the issue URL only, never a DoD row, a decision or the sheet', () => {
  const rules = section(agent('release-manager'), 'Rules');
  for (const part of ['`<home>/tmp/<S-nn>/pr.md`', 'the technical summary of the change', 'the test evidence', 'Slice issue:', 'never a row of the DoD', '`<home>/tmp/<S-nn>/merge-notes.md`', "gh pr create --body-file '<home>/tmp/<S-nn>/pr.md'"]) {
    assert.ok(rules.includes(part), part);
  }
  const body = rules.split('\n').find((l) => l.startsWith('- Write the PR body'));
  assert.equal(/DoD table|verdicts of the reviewers|decisions taken/.test(body), false, 'the PR body rule lists no DoD row, verdict or decision');
  assert.ok(rules.split('\n').find((l) => l.includes('merge-notes.md')).includes('the DoD table with each row PASS or FAIL'), 'they go to the merge notes in the workspace');
  const slice = readFileSync(join(commandsDir, 'slice.md'), 'utf8');
  assert.equal(slice.includes('commit those two files by name'), false, 'the PR body is not committed in the code repository');
  assert.ok(slice.includes('never in the body of a pull request'));
  const protocol = readFileSync(join(plugin, 'harness', 'protocol.md'), 'utf8');
  assert.ok(protocol.includes('The tracking sheet, the journal, the PR body and the human actions of a slice live in `<home>/tmp/<S-nn>/`'));
});

test('guard: the implementer writes its tracking sheet and journal in the workspace, never under docs/suivi of the code repository', async () => {
  const { ws, wt } = makeWorkspace();
  assert.equal(await write(wt, 'implementer', join(ws, 'tmp', 'S-01', 'journal.md')), '');
  assert.equal(await write(wt, 'implementer', join(ws, 'tmp', 'S-01', 'tracking.md')), '');
  assert.ok(isDenied(await write(wt, 'implementer', join(wt, 'docs', 'suivi', 'S-01-journal.md'))));
  assert.ok(isDenied(await write(wt, 'implementer', join(ws, 'tmp', 'S-02', 'journal.md'))), 'another slice is refused');
  assert.equal(await write(wt, 'release-manager', join(ws, 'tmp', 'S-01', 'pr.md')), '');
  assert.ok(isDenied(await write(wt, 'release-manager', join(wt, 'docs', 'suivi', 'S-01-pr.md'))));
});
