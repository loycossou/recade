import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createWorkspace } from '../../src/workspace/layout.js';
import { defaultExec as asyncExec } from '../../src/doctor.js';
import { defaultExec as syncExec } from '../../src/harness/stamps.js';
import { run } from '../../src/cli.js';
import { git, makeIO } from '../harness/fixture-project.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'recade-wscommit-')));
const must = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const write = (ws, file, text) => {
  mkdirSync(join(ws, file, '..'), { recursive: true });
  writeFileSync(join(ws, file), text);
};
const subjects = (ws) => must(git(ws, 'log', '--format=%s')).stdout.trim().split('\n').reverse();
const filesOf = (ws) => must(git(ws, 'show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n').filter(Boolean);

async function workspace(extra = {}) {
  const parent = join(tmp(), 'Projets Clients');
  mkdirSync(parent);
  const { dir } = await createWorkspace(parent, 'Ete', { exec: asyncExec });
  write(dir, 'recade/state.yaml', stringify({ version: 1, kind: 'workspace', ...extra }));
  must(git(dir, 'config', 'user.name', 'ci'));
  must(git(dir, 'config', 'user.email', ['ci', 'example.invalid'].join('@')));
  must(git(dir, 'add', '-A'));
  must(git(dir, 'commit', '-q', '-m', 'chore: start'));
  return dir;
}

function recorder() {
  const pushes = [];
  const exec = (cmd, opts) => {
    if (cmd[0] === 'git' && cmd.includes('push')) {
      pushes.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd[0] === 'git' && cmd.includes('refs/remotes/origin/HEAD')) return { code: 0, stdout: 'origin/main\n', stderr: '' };
    return syncExec(cmd, opts);
  };
  return { exec, pushes };
}

const call = async (ws, args, opts = { run: syncExec }) => {
  const t = makeIO(ws, opts);
  const code = await run(['workspace', 'commit', ...args], t.io);
  return { code, out: t.out.join(''), err: t.err.join('') };
};

test('recade workspace commit commits the named files under the lock, with no push, and leaves other files alone', async () => {
  const ws = await workspace({ workspace: { auto_push: true, auto_push_since: '2026-11-18' } });
  write(ws, 'slices/S-01-one.md', 'sheet\n');
  write(ws, 'design/ux/S-01/a.md', 'variant\n');
  write(ws, 'intake/draft.md', 'owner work\n');
  const rec = recorder();
  const r = await call(ws, ['--paths', 'slices/S-01-one.md,design/ux/S-01', '-m', 'docs(slices): S-01 sheet and variants'], { run: rec.exec });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Committed 2 paths: docs\(slices\): S-01 sheet and variants/);
  assert.equal(subjects(ws).at(-1), 'docs(slices): S-01 sheet and variants');
  assert.deepEqual(filesOf(ws).sort(), ['design/ux/S-01/a.md', 'slices/S-01-one.md']);
  assert.match(must(git(ws, 'status', '--porcelain')).stdout, /\?\? intake\/draft\.md/);
  assert.deepEqual(rec.pushes, [], 'a leftover commit is not an end of phase: no push');
});

test('nothing to commit is not an error, and no commit is made', async () => {
  const ws = await workspace();
  write(ws, 'slices/S-01-one.md', 'sheet\n');
  assert.equal((await call(ws, ['--paths', 'slices/S-01-one.md', '-m', 'docs(slices): S-01'])).code, 0);
  const before = subjects(ws).length;
  const again = await call(ws, ['--paths', 'slices/S-01-one.md', '-m', 'docs(slices): S-01 again']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /Nothing to commit/);
  assert.equal(subjects(ws).length, before);
});

test('only the document folders of the workspace can be committed, and a bad call is exit 2', async () => {
  const ws = await workspace();
  write(ws, 'slices/S-01-one.md', 'sheet\n');
  for (const args of [
    [], ['--paths', 'slices/S-01-one.md'], ['-m', 'docs: x'], ['--paths', '', '-m', 'docs: x'],
    ['--paths', 'slices/S-01-one.md', '-m', 'two\nlines'], ['--paths', 'slices/S-01-one.md', '-m', ''],
    ['--paths', 'slices/S-01-one.md', '-m', 'x'.repeat(201)],
    ['--paths', '.claude/agents/a.md', '-m', 'docs: x'], ['--paths', 'recade/state.yaml', '-m', 'docs: x'],
    ['--paths', '.recade/stamps.json', '-m', 'docs: x'], ['--paths', '.githooks/pre-commit', '-m', 'docs: x'],
    ['--paths', 'repos/api/a.ts', '-m', 'docs: x'], ['--paths', 'tmp/a.md', '-m', 'docs: x'], ['--paths', 'artifacts/a', '-m', 'docs: x'],
    ['--paths', '../outside.md', '-m', 'docs: x'], ['--paths', '/etc/passwd', '-m', 'docs: x'], ['--paths', '-A', '-m', 'docs: x'],
    ['--paths', 'slices/S-01-one.md', '-m', 'docs: x', '--all'],
    ['--paths', '.github/workflows/workspace.yml', '-m', 'ci: x'], ['--paths', '.github/workflows', '-m', 'ci: x'],
    ['--paths', '.github/dependabot.yml', '-m', 'ci: x'], ['--paths', '.github/workflows/sub/a.yml', '-m', 'ci: x'],
  ]) {
    const r = await call(ws, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.err}`);
  }
  assert.equal(subjects(ws).length, 1, 'nothing was committed');
});

test('a file staged outside the paths stops the commit with exit 1', async () => {
  const ws = await workspace();
  write(ws, 'slices/S-01-one.md', 'sheet\n');
  write(ws, 'decisions/DEC-01.md', 'draft\n');
  must(git(ws, 'add', 'decisions/DEC-01.md'));
  const r = await call(ws, ['--paths', 'slices/S-01-one.md', '-m', 'docs(slices): S-01']);
  assert.equal(r.code, 1);
  assert.match(r.err, /decisions\/DEC-01\.md/);
  assert.equal(subjects(ws).length, 1);
});

test('a project that is not a workspace under git exits 1', async () => {
  const dir = tmp();
  write(dir, 'recade/state.yaml', stringify({ version: 1 }));
  const r = await call(dir, ['--paths', 'slices/S-01-one.md', '-m', 'docs: x']);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a workspace under git/);
  assert.equal(readFileSync(join(dir, 'recade', 'state.yaml'), 'utf8').includes('version'), true);
});

test('final B #4: recade workspace commit takes --project, from any folder', async () => {
  const ws = await workspace();
  write(ws, 'slices/S-01-one.md', 'sheet\n');
  const t = makeIO(tmp(), { run: syncExec });
  const code = await run(['workspace', 'commit', '--paths', 'slices/S-01-one.md', '-m', 'docs(slices): S-01 sheet', '--project', ws], t.io);
  assert.equal(code, 0, t.err.join(''));
  assert.equal(subjects(ws).at(-1), 'docs(slices): S-01 sheet');
});

test('final B #6: recade help keeps a space after a long label, and names workspace commit', async () => {
  const t = makeIO(tmp());
  assert.equal(await run(['help'], t.io), 0);
  const out = t.out.join('');
  assert.match(out, /^recade release-notes +Release notes/m);
  assert.match(out, /^recade workspace +.*\| commit --paths/m);
  for (const l of out.split('\n').filter((x) => x.startsWith('recade '))) assert.match(l, /^recade [a-z-]+ {2,}\S/, l);
});

test('a workflow file of the project under .github/workflows/ is committed like a document; workspace.yml stays Recade\'s', async () => {
  const ws = await workspace();
  write(ws, '.github/workflows/workspace-secrets.yml', 'name: Secrets\n');
  const r = await call(ws, ['--paths', '.github/workflows/workspace-secrets.yml', '-m', 'ci(S-48): secret scan of the workspace']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(filesOf(ws), ['.github/workflows/workspace-secrets.yml']);
});
