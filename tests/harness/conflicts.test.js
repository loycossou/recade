import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.js';
import { makeWorkspace } from './fixture-project.js';
import { GitTooOldError, checkConflicts, inspectConflicts, inspectWorkspaceConflicts, listSliceBranches } from '../../src/harness/conflicts.js';

const sh = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

const lines = (n, mark = {}) => Array.from({ length: n }, (_, i) => mark[i + 1] ?? `line ${i + 1}`).join('\n') + '\n';

/** A repository on `main` with two ten-line files, then one branch for each `{name: {file: text}}`. */
function makeRepo(branches) {
  const repo = mkdtempSync(join(tmpdir(), 'recade-conflicts-'));
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'routes.txt'), lines(10));
  writeFileSync(join(repo, 'menu.txt'), lines(10));
  writeFileSync(join(repo, 'notes.txt'), 'notes\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'chore: start');
  for (const [name, files] of Object.entries(branches)) {
    sh(repo, 'switch', '-q', '-c', name, 'main');
    for (const [file, text] of Object.entries(files)) writeFileSync(join(repo, file), text);
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', `feat: ${name}`);
  }
  sh(repo, 'switch', '-q', 'main');
  return repo;
}

test('a real textual conflict between two slice branches is found, with the file', () => {
  const repo = makeRepo({
    'slice/S-01-menu': { 'routes.txt': lines(10, { 5: 'menu says A' }) },
    'slice/S-02-menu': { 'routes.txt': lines(10, { 5: 'menu says B' }) },
  });
  const found = checkConflicts(repo, { base: 'main', branches: ['slice/S-01-menu', 'slice/S-02-menu'] });
  assert.deepEqual(found, [{ a: 'slice/S-01-menu', b: 'slice/S-02-menu', files: ['routes.txt'] }]);
});

test('disjoint edits, and edits of different parts of one file, are not a conflict', () => {
  const repo = makeRepo({
    'slice/S-01-a': { 'routes.txt': lines(10, { 1: 'top edit' }) },
    'slice/S-02-b': { 'menu.txt': lines(10, { 5: 'other file' }), 'new.txt': 'fresh\n' },
    'slice/S-03-c': { 'routes.txt': lines(10, { 10: 'bottom edit' }) },
  });
  const result = inspectConflicts(repo, { base: 'main', branches: ['slice/S-01-a', 'slice/S-02-b', 'slice/S-03-c'] });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.checked, ['slice/S-01-a', 'slice/S-02-b', 'slice/S-03-c']);
});

test('a branch that conflicts with the base is reported against it, and the work tree is not touched', () => {
  const repo = makeRepo({ 'slice/S-01-a': { 'routes.txt': lines(10, { 5: 'branch side' }) } });
  writeFileSync(join(repo, 'routes.txt'), lines(10, { 5: 'main side' }));
  sh(repo, 'commit', '-q', '-am', 'feat: main moved');
  const before = sh(repo, 'status', '--porcelain');
  const found = checkConflicts(repo, { base: 'main', branches: ['slice/S-01-a'] });
  assert.deepEqual(found, [{ a: 'slice/S-01-a', b: 'main', files: ['routes.txt'] }]);
  assert.equal(sh(repo, 'status', '--porcelain'), before);
  assert.equal(sh(repo, 'branch', '--show-current').trim(), 'main');
});

test('a modify and delete conflict names the file, and a file name with a space survives', () => {
  const repo = makeRepo({});
  writeFileSync(join(repo, 'a b.txt'), 'x\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'chore: add a file with a space');
  sh(repo, 'switch', '-q', '-c', 'slice/S-01-del', 'main');
  sh(repo, 'rm', '-q', 'a b.txt');
  sh(repo, 'commit', '-q', '-m', 'feat: delete');
  sh(repo, 'switch', '-q', '-c', 'slice/S-02-edit', 'main');
  writeFileSync(join(repo, 'a b.txt'), 'y\n');
  sh(repo, 'commit', '-q', '-am', 'feat: edit');
  sh(repo, 'switch', '-q', 'main');
  assert.deepEqual(checkConflicts(repo, { branches: ['slice/S-01-del', 'slice/S-02-edit'] }), [
    { a: 'slice/S-01-del', b: 'slice/S-02-edit', files: ['a b.txt'] },
  ]);
});

test('a branch that only exists as origin/<name> is checked, and an unknown branch is skipped and named', () => {
  const repo = makeRepo({ 'slice/S-01-a': { 'menu.txt': lines(10, { 2: 'a' }) }, 'slice/S-02-b': { 'menu.txt': lines(10, { 2: 'b' }) } });
  sh(repo, 'update-ref', 'refs/remotes/origin/slice/S-02-b', 'refs/heads/slice/S-02-b');
  sh(repo, 'branch', '-q', '-D', 'slice/S-02-b');
  const result = inspectConflicts(repo, { branches: ['slice/S-01-a', 'slice/S-02-b', 'slice/S-09-gone', 'main', 'slice/S-01-a'] });
  assert.deepEqual(result.skipped, ['slice/S-09-gone']);
  assert.deepEqual(result.conflicts.map((c) => [c.a, c.b]), [['slice/S-01-a', 'slice/S-02-b']]);
  assert.deepEqual(listSliceBranches(repo), ['slice/S-01-a', 'slice/S-02-b']);
});

test('a missing base is an error that names it, and a git older than 2.38 is reported clearly', () => {
  const repo = makeRepo({ 'slice/S-01-a': { 'notes.txt': 'n\n' } });
  assert.throws(() => checkConflicts(repo, { base: 'trunk', branches: ['slice/S-01-a'] }), /base branch "trunk" does not exist/);
  const old = (cmd) => (cmd[1] === '--version' ? { code: 0, stdout: 'git version 2.34.1\n', stderr: '' } : { code: 129, stdout: '', stderr: 'usage' });
  assert.throws(() => checkConflicts(repo, { branches: ['slice/S-01-a'], exec: old }), (err) => err instanceof GitTooOldError && /2\.34 is too old.*2\.38 or newer/.test(err.message));
  const fake = (cmd) => {
    if (cmd[1] === '--version') return { code: 0, stdout: 'git version 2.38.0\n', stderr: '' };
    if (cmd[1] === 'rev-parse') return { code: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    return { code: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories' };
  };
  assert.throws(() => checkConflicts(repo, { branches: ['slice/S-01-a'], exec: fake }), /git merge-tree failed: fatal: refusing to merge unrelated histories/);
});

function makeIO(cwd) {
  const out = [];
  const err = [];
  return { io: { cwd, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out, err };
}

test('recade conflicts check: exit 1 with the files on a conflict, 0 when clean, 2 on bad arguments', async () => {
  const repo = makeRepo({
    'slice/S-01-menu': { 'routes.txt': lines(10, { 5: 'A' }) },
    'slice/S-02-menu': { 'routes.txt': lines(10, { 5: 'B' }) },
    'slice/S-03-free': { 'notes.txt': 'more notes\n' },
  });
  const bad = makeIO(repo);
  assert.equal(await run(['conflicts', 'check'], bad.io), 1);
  assert.match(bad.out.join(''), /slice\/S-01-menu and slice\/S-02-menu conflict on: routes\.txt/);
  assert.equal(bad.out.join('').includes('S-03'), false);
  const ok = makeIO(repo);
  assert.equal(await run(['conflicts', 'check', '--branches', 'slice/S-01-menu,slice/S-03-free', '--base', 'main'], ok.io), 0);
  assert.match(ok.out.join(''), /No conflicts: 2 branches/);
  for (const args of [['conflicts'], ['conflicts', 'check', '--base'], ['conflicts', 'check', '--base', '--evil'], ['conflicts', 'check', '--branches', 'a,-b'], ['conflicts', 'check', 'extra']]) {
    const t = makeIO(repo);
    assert.equal(await run(args, t.io), 2, args.join(' '));
    assert.match(t.err.join(''), /Usage: recade conflicts check/);
  }
  const elsewhere = makeIO(mkdtempSync(join(tmpdir(), 'recade-nogit-')));
  assert.equal(await run(['conflicts', 'check'], elsewhere.io), 1);
  assert.match(elsewhere.err.join(''), /Not a git repository/);
  const missing = makeIO(repo);
  assert.equal(await run(['conflicts', 'check', '--base', 'trunk'], missing.io), 2);
  const skip = makeIO(repo);
  assert.equal(await run(['conflicts', 'check', '--branches', 'slice/S-09-gone'], skip.io), 0);
  assert.match(skip.err.join(''), /Skipped slice\/S-09-gone/);
});

test('conflicts.yml: read-only permissions, lists the PR branches with gh, runs recade conflicts check', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { parse } = await import('yaml');
  const file = join(fileURLToPath(new URL('../../harness/ci/conflicts.yml', import.meta.url)));
  const text = readFileSync(file, 'utf8');
  const wf = parse(text);
  assert.deepEqual(wf.on, { pull_request: null });
  assert.deepEqual(wf.permissions, { contents: 'read', 'pull-requests': 'read' });
  assert.equal(/pull_request_target|secrets\./.test(text), false);
  const steps = wf.jobs.conflicts.steps;
  assert.equal(wf.jobs.conflicts.if, 'github.event.pull_request.head.repo.full_name == github.repository');
  assert.equal(steps[0].with['fetch-depth'], 0);
  for (const s of steps.filter((x) => x.uses?.startsWith('actions/checkout'))) assert.equal(s.with['persist-credentials'], false);
  assert.equal(steps.every((s) => s.uses === undefined || /@[0-9a-f]{40}$/.test(s.uses)), true, 'actions are pinned to a commit');
  const script = steps.map((s) => s.run ?? '').join('\n');
  assert.match(script, /gh pr list --state open .*--json headRefName/);
  assert.match(script, /git fetch --no-tags origin "\+refs\/heads\/\$\{name\}:refs\/remotes\/origin\/\$\{name\}"/);
  assert.match(script, /recade\.js conflicts check --base "\$\{BASE_REF\}" --branches "\$\{BRANCHES\}"/);
  // Values that come from the event travel through env, never inside the script text.
  assert.equal(/\$\{\{\s*(github\.(base_ref|head_ref)|steps\.)/.test(script), false);
  assert.equal(text.includes(String.fromCharCode(0x2014)), false);
});

/** Run the last step of conflicts.yml with a fake `recade` that prints `lines` and exits with `code`. */
async function runStep({ lines, code, head = 'slice/S-02-b' }) {
  const { readFileSync, mkdirSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const wf = parse(readFileSync(new URL('../../harness/ci/conflicts.yml', import.meta.url), 'utf8'));
  const steps = wf.jobs.conflicts.steps;
  const step = steps[steps.length - 1];
  const dir = mkdtempSync(join(tmpdir(), 'recade-ci-step-'));
  mkdirSync(join(dir, '.recade-tools', 'bin'), { recursive: true });
  writeFileSync(join(dir, '.recade-tools', 'bin', 'recade.js'), `process.stdout.write(${JSON.stringify(lines)}); process.exit(${code});`);
  const r = spawnSync('bash', ['-c', step.run], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: process.env.PATH, BASE_REF: 'main', HEAD_REF: head, BRANCHES: 'slice/S-01-a,slice/S-02-b,slice/S-03-c', GITHUB_STEP_SUMMARY: join(dir, 'summary.md') },
  });
  return r;
}

test('conflicts.yml fails only on conflicts that involve the head branch of the pull request', async () => {
  const other = 'slice/S-01-a and slice/S-03-c conflict on: routes.txt\n';
  const mine = 'slice/S-02-b and main conflict on: menu.txt\n';
  const theirs = 'slice/S-01-a and slice/S-02-b conflict on: routes.txt\n';
  let r = await runStep({ lines: other, code: 1 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /other open branches/);
  assert.match(r.stdout, /No conflict involves slice\/S-02-b/);
  for (const lines of [mine, theirs, other + mine]) {
    r = await runStep({ lines, code: 1 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /This pull request conflicts:/);
    assert.match(r.stdout, /S-02-b/);
  }
  r = await runStep({ lines: 'No conflicts: 3 branches checked\n', code: 0 });
  assert.equal(r.status, 0);
  // A branch whose name is the start of the head branch name is not the head branch.
  r = await runStep({ lines: 'slice/S-02-b-long and main conflict on: x.txt\n', code: 1 });
  assert.equal(r.status, 0, r.stdout);
  // An error of the check itself fails the job.
  r = await runStep({ lines: '', code: 2 });
  assert.equal(r.status, 2);
});

// ---------------------------------------------------------------------------------------------------------
// Across code repositories (spec 6.13): each repository on its own, pairs reported as repo:branch
// ---------------------------------------------------------------------------------------------------------

/** On `main` of `repo`: routes.txt with ten lines, committed. Then one branch for each `{name: {file: text}}`. */
function fillRepo(repo, branches) {
  writeFileSync(join(repo, 'routes.txt'), lines(10));
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'chore: routes');
  for (const [name, files] of Object.entries(branches)) {
    sh(repo, 'switch', '-q', '-c', name, 'main');
    for (const [file, text] of Object.entries(files)) writeFileSync(join(repo, file), text);
    sh(repo, 'add', '.');
    sh(repo, 'commit', '-q', '-m', `feat: ${name}`);
  }
  sh(repo, 'switch', '-q', 'main');
}

async function twoRepos() {
  const ws = await makeWorkspace({ repos: ['api', 'web'], parent: mkdtempSync(join(tmpdir(), 'Projets Clients ')) });
  fillRepo(ws.repo('api'), { 'slice/S-01-menu': { 'routes.txt': lines(10, { 5: 'api says A' }) }, 'slice/S-02-menu': { 'routes.txt': lines(10, { 5: 'api says B' }) } });
  // The same file name and the same lines in the other repository: no conflict between repositories.
  fillRepo(ws.repo('web'), { 'slice/S-01-menu': { 'routes.txt': lines(10, { 5: 'web says A' }) }, 'slice/S-03-free': { 'notes.txt': 'notes\n' } });
  return ws;
}

test('inspectWorkspaceConflicts: each repository on its own, branches named repo:branch', async () => {
  const ws = await twoRepos();
  const result = inspectWorkspaceConflicts(ws.dir);
  assert.deepEqual(result.conflicts.map((c) => [c.a, c.b, c.files]), [['api:slice/S-01-menu', 'api:slice/S-02-menu', ['routes.txt']]]);
  assert.deepEqual(result.checked.sort(), ['api:slice/S-01-menu', 'api:slice/S-02-menu', 'web:slice/S-01-menu', 'web:slice/S-03-free']);
  assert.deepEqual(result.skipped, []);
});

test('inspectWorkspaceConflicts: a branch list limits every repository, and a missing branch is skipped with its repository', async () => {
  const ws = await twoRepos();
  const result = inspectWorkspaceConflicts(ws.dir, { branches: ['slice/S-01-menu', 'slice/S-03-free'] });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.skipped, ['api:slice/S-03-free']);
});

test('inspectWorkspaceConflicts: a repository folder that is gone is an error naming it', async () => {
  const ws = await twoRepos();
  rmSync(ws.repo('web'), { recursive: true, force: true });
  assert.throws(() => inspectWorkspaceConflicts(ws.dir), /web: repos\/web is not a git repository here\. Run: recade repo sync/);
});

test('inspectWorkspaceConflicts: the default branch of each repository is the base', async () => {
  const ws = await twoRepos();
  sh(ws.repo('api'), 'branch', '-m', 'main', 'trunk');
  const file = join(ws.dir, 'recade', 'state.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/(name: api[\s\S]*?default_branch: )main/, '$1trunk'));
  const result = inspectWorkspaceConflicts(ws.dir);
  assert.equal(result.conflicts.length, 1, 'the api branches are checked against trunk');
});

test('recade conflicts check from the workspace covers every repository; from a code repository only that one', async () => {
  const ws = await twoRepos();
  const here = makeIO(ws.dir);
  assert.equal(await run(['conflicts', 'check'], here.io), 1);
  assert.match(here.out.join(''), /api:slice\/S-01-menu and api:slice\/S-02-menu conflict on: routes\.txt/);
  assert.equal(here.out.join('').includes('web:'), false);
  const clean = makeIO(ws.dir);
  assert.equal(await run(['conflicts', 'check', '--branches', 'slice/S-01-menu,slice/S-03-free'], clean.io), 0, clean.err.join(''));
  assert.match(clean.out.join(''), /No conflicts: 3 branches/);
  assert.match(clean.err.join(''), /Skipped api:slice\/S-03-free/);
  const inRepo = makeIO(ws.repo('web'));
  assert.equal(await run(['conflicts', 'check'], inRepo.io), 0, inRepo.err.join(''));
  assert.match(inRepo.out.join(''), /No conflicts: 2 branches/);
  const gone = await twoRepos();
  rmSync(gone.repo('web'), { recursive: true, force: true });
  const broken = makeIO(gone.dir);
  assert.equal(await run(['conflicts', 'check'], broken.io), 2);
  assert.match(broken.err.join(''), /recade repo sync/);
});
