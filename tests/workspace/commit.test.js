import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { CommitError, LOCK_FILE, STALE_MS, commitWorkspace, pushWorkspace } from '../../src/workspace/commit.js';
import { createWorkspace } from '../../src/workspace/layout.js';
import { createProject } from '../../src/project/scaffold.js';
import { defaultExec as asyncExec } from '../../src/doctor.js';
import { defaultExec as syncExec } from '../../src/harness/stamps.js';
import { protect, protectionArgs, workspaceProtectionArgs } from '../../src/harness/protect.js';
import { run } from '../../src/cli.js';
import { git, makeIO } from '../harness/fixture-project.js';
import { createFakeGh } from '../../tools/fake-gh.js';

const BIN = new URL('../../bin/recade.js', import.meta.url).pathname;

/** Run the real CLI in a child process. */
function recade(cwd, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'recade-commit-')));
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
const files = (ws, rev = 'HEAD') => must(git(ws, 'show', '--name-only', '--format=', rev)).stdout.trim().split('\n').filter(Boolean);

/** A real workspace folder (git, one commit) with a name that holds spaces and accents. */
async function workspace(extraState = {}) {
  const parent = join(tmp(), 'Projets Clients');
  mkdirSync(parent);
  const { dir } = await createWorkspace(parent, 'Ete', { exec: asyncExec });
  write(dir, 'recade/state.yaml', stringify({ version: 1, kind: 'workspace', ...extraState }));
  must(git(dir, 'add', '-A'));
  must(git(dir, 'commit', '-q', '-m', 'chore: start'));
  return dir;
}

test('commitWorkspace stages only the given paths, commits, and releases the lock', async () => {
  const ws = await workspace();
  write(ws, 'decisions/DEC-01.md', 'draft\n');
  const r = await commitWorkspace(ws, ['slices/STATUS.md'], 'chore(slices): S-01 done', { exec: syncExec, mutate: () => write(ws, 'slices/STATUS.md', 'one\n') });
  assert.equal(r.committed, true);
  assert.match(r.sha, /^[0-9a-f]{40}$/);
  assert.equal(r.sha, must(git(ws, 'rev-parse', 'HEAD')).stdout.trim());
  assert.deepEqual(files(ws), ['slices/STATUS.md']);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
  assert.equal(LOCK_FILE, '.recade/commit.lock');
});

test('a dirty unrelated file, tracked or not, is not committed', async () => {
  const ws = await workspace();
  write(ws, 'design/notes.md', 'work in progress\n');
  must(git(ws, 'add', 'design/notes.md'));
  must(git(ws, 'commit', '-q', '-m', 'docs: notes'));
  write(ws, 'design/notes.md', 'edited later\n');
  write(ws, 'intake/new.md', 'untracked\n');
  const r = await commitWorkspace(ws, ['retros/INC-1.md'], 'docs(retros): INC-1', { exec: syncExec, mutate: () => write(ws, 'retros/INC-1.md', 'retro\n') });
  assert.equal(r.committed, true);
  assert.deepEqual(files(ws), ['retros/INC-1.md']);
  const status = must(git(ws, 'status', '--porcelain')).stdout;
  assert.match(status, / M design\/notes\.md/);
  assert.match(status, /\?\? intake\/new\.md/);
});

test('nothing to commit is not an error: committed false, no commit made', async () => {
  const ws = await workspace();
  const before = must(git(ws, 'rev-parse', 'HEAD')).stdout;
  const r = await commitWorkspace(ws, ['recade/state.yaml'], 'chore: nothing', { exec: syncExec });
  assert.deepEqual(r, { committed: false, sha: null, value: undefined });
  assert.equal(must(git(ws, 'rev-parse', 'HEAD')).stdout, before);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('an index that already holds staged changes outside the paths is refused, and listed', async () => {
  const ws = await workspace();
  write(ws, 'design/draft.md', 'staged by hand\n');
  must(git(ws, 'add', 'design/draft.md'));
  write(ws, 'slices/STATUS.md', 'x\n');
  const err = await commitWorkspace(ws, ['slices/STATUS.md'], 'chore(slices): S-01 done', { exec: syncExec }).catch((e) => e);
  assert.ok(err instanceof CommitError);
  assert.equal(err.exit, 1);
  assert.match(err.message, /design\/draft\.md/);
  assert.equal(subjects(ws).length, 1);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
  assert.equal(must(git(ws, 'diff', '--cached', '--name-only')).stdout.trim(), 'design/draft.md');
});

test('a path that is a folder covers the files under it', async () => {
  const ws = await workspace();
  const r = await commitWorkspace(ws, ['decisions'], 'docs(decisions): two', {
    exec: syncExec,
    mutate: () => {
      write(ws, 'decisions/DEC-01.md', 'a\n');
      write(ws, 'decisions/DEC-02.md', 'b\n');
    },
  });
  assert.equal(r.committed, true);
  assert.deepEqual(files(ws), ['decisions/DEC-01.md', 'decisions/DEC-02.md']);
});

test('a bad path is refused before anything runs', async () => {
  const ws = await workspace();
  for (const p of ['../outside', '/etc/passwd', '--all', '']) {
    const err = await commitWorkspace(ws, [p], 'x', { exec: syncExec }).catch((e) => e);
    assert.ok(err instanceof CommitError, p);
  }
  assert.equal(subjects(ws).length, 1);
});

test('Review Focus 2: two concurrent commits, one blocked on the lock, both land in order, no path lost', async () => {
  const ws = await workspace();
  const log = [];
  // A slow commit, so the second call really meets the lock.
  const slow = async (cmd, opts) => {
    log.push(cmd.join(' '));
    if (cmd.includes('commit')) await new Promise((r) => setTimeout(r, 80));
    return syncExec(cmd, opts);
  };
  const first = commitWorkspace(ws, ['slices/a.md'], 'chore(slices): S-01 done', { exec: slow, mutate: () => write(ws, 'slices/a.md', 'a\n') });
  const second = commitWorkspace(ws, ['slices/b.md'], 'chore(slices): S-02 done', { exec: slow, mutate: () => write(ws, 'slices/b.md', 'b\n') });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.committed && b.committed, true);
  assert.deepEqual(subjects(ws), ['chore: start', 'chore(slices): S-01 done', 'chore(slices): S-02 done']);
  assert.deepEqual(files(ws, 'HEAD~1'), ['slices/a.md']);
  assert.deepEqual(files(ws, 'HEAD'), ['slices/b.md']);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('mutate runs under the lock, its value comes back, and a message function can skip the commit', async () => {
  const ws = await workspace();
  let during = null;
  const r = await commitWorkspace(ws, ['slices/STATUS.md'], (v) => `chore(slices): ${v} done`, {
    exec: syncExec,
    mutate: () => {
      during = existsSync(join(ws, LOCK_FILE));
      write(ws, 'slices/STATUS.md', 'moved\n');
      return 'S-07';
    },
  });
  assert.equal(during, true);
  assert.equal(r.value, 'S-07');
  assert.equal(subjects(ws).at(-1), 'chore(slices): S-07 done');
  const skipped = await commitWorkspace(ws, ['slices/STATUS.md'], () => null, {
    exec: syncExec,
    mutate: () => write(ws, 'slices/STATUS.md', 'moved again\n'),
  });
  assert.equal(skipped.committed, false);
  assert.equal(subjects(ws).length, 2);
  assert.equal(readFileSync(join(ws, 'slices/STATUS.md'), 'utf8'), 'moved again\n');
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('a throwing mutate releases the lock and rethrows', async () => {
  const ws = await workspace();
  await assert.rejects(commitWorkspace(ws, ['a.md'], 'x', { exec: syncExec, mutate: () => { throw new Error('boom'); } }), /boom/);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('a lock older than 10 minutes is reported as stale and never removed', async () => {
  const ws = await workspace();
  const t0 = Date.parse('2026-11-18T10:00:00Z');
  write(ws, LOCK_FILE, JSON.stringify({ pid: 4242, at: new Date(t0 - STALE_MS - 1000).toISOString() }));
  write(ws, 'slices/STATUS.md', 'x\n');
  const err = await commitWorkspace(ws, ['slices/STATUS.md'], 'chore: x', { exec: syncExec, now: () => new Date(t0) }).catch((e) => e);
  assert.ok(err instanceof CommitError);
  assert.equal(err.exit, 1);
  assert.match(err.message, /stale lock, remove \.recade\/commit\.lock if no Recade command runs/);
  assert.equal(existsSync(join(ws, LOCK_FILE)), true);
  assert.equal(subjects(ws).length, 1);
  assert.equal(STALE_MS, 10 * 60 * 1000);
});

test('a fresh lock that never frees ends with an error that names the holder, and is not removed', async () => {
  const ws = await workspace();
  const now = Date.now();
  write(ws, LOCK_FILE, JSON.stringify({ pid: 4242, at: new Date(now).toISOString() }));
  const err = await commitWorkspace(ws, ['slices/STATUS.md'], 'chore: x', { exec: syncExec, wait: 60 }).catch((e) => e);
  assert.ok(err instanceof CommitError);
  assert.match(err.message, /4242/);
  assert.equal(existsSync(join(ws, LOCK_FILE)), true);
});

test('a lock whose content cannot be read ages by its file time', async () => {
  const ws = await workspace();
  write(ws, LOCK_FILE, 'not json');
  const old = new Date(Date.now() - STALE_MS - 60000);
  utimesSync(join(ws, LOCK_FILE), old, old);
  const err = await commitWorkspace(ws, ['a.md'], 'x', { exec: syncExec }).catch((e) => e);
  assert.match(err.message, /stale lock/);
});

test('a failing git commit is an error, the lock is released and the staged paths are unstaged', async () => {
  const ws = await workspace();
  const failing = (cmd, opts) => (cmd.includes('commit') ? { code: 1, stdout: '', stderr: 'error: hook said no\n' } : syncExec(cmd, opts));
  const err = await commitWorkspace(ws, ['slices/STATUS.md'], 'chore: x', { exec: failing, mutate: () => write(ws, 'slices/STATUS.md', 'x\n') }).catch((e) => e);
  assert.ok(err instanceof CommitError);
  assert.match(err.message, /hook said no/);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
  assert.equal(must(git(ws, 'diff', '--cached', '--name-only')).stdout, '');
});

test('a step path that was already dirty is refused and listed: someone else edit is never committed', async () => {
  const ws = await workspace();
  write(ws, 'slices/STATUS.md', 'first\n');
  must(git(ws, 'add', 'slices/STATUS.md'));
  must(git(ws, 'commit', '-q', '-m', 'docs: status'));
  write(ws, 'slices/STATUS.md', 'edited by the owner, not committed\n');
  write(ws, 'decisions/DEC-09.md', 'untracked\n');
  let ran = false;
  const err = await commitWorkspace(ws, ['slices/STATUS.md', 'decisions'], 'chore: x', { exec: syncExec, mutate: () => { ran = true; } }).catch((e) => e);
  assert.ok(err instanceof CommitError);
  assert.equal(err.exit, 1);
  assert.match(err.message, /slices\/STATUS\.md/);
  assert.match(err.message, /decisions\/DEC-09\.md/);
  assert.match(err.message, /did not make/);
  assert.equal(ran, false);
  assert.equal(readFileSync(join(ws, 'slices/STATUS.md'), 'utf8'), 'edited by the owner, not committed\n');
  assert.equal(subjects(ws).length, 2);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('a workspace with no commit yet accepts its own first files: nothing is foreign before the first commit', async () => {
  const parent = join(tmp(), 'Projets Clients');
  mkdirSync(parent);
  const { dir } = await createWorkspace(parent, 'Ete', { exec: asyncExec });
  const r = await commitWorkspace(dir, ['recade/state.yaml'], 'chore(recade): G0 passed', { exec: syncExec });
  assert.equal(r.committed, true);
  assert.deepEqual(files(dir), ['recade/state.yaml']);
});

test('a dirty file outside the step paths does not matter, and a clean step path is accepted', async () => {
  const ws = await workspace();
  write(ws, 'design/notes.md', 'dirty\n');
  const r = await commitWorkspace(ws, ['slices/STATUS.md'], 'chore: x', { exec: syncExec, mutate: () => write(ws, 'slices/STATUS.md', 'x\n') });
  assert.equal(r.committed, true);
});

test('a workspace that is not on its default branch is refused before anything is written', async () => {
  const ws = await workspace();
  must(git(ws, 'switch', '-q', '-c', 'feature/notes'));
  let ran = false;
  const err = await commitWorkspace(ws, ['a.md'], 'chore: a', { exec: syncExec, mutate: () => { ran = true; write(ws, 'a.md', 'x\n'); } }).catch((e) => e);
  assert.ok(err instanceof CommitError);
  assert.equal(err.exit, 1);
  assert.match(err.message, /feature\/notes/);
  assert.match(err.message, /default branch/);
  assert.match(err.message, /main/);
  assert.equal(ran, false);
  assert.equal(existsSync(join(ws, 'a.md')), false);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('the default branch is what origin/HEAD says; a detached HEAD is refused too', async () => {
  const ws = await workspace();
  const trunk = (cmd, opts) => (cmd.includes('refs/remotes/origin/HEAD') ? ok('origin/trunk\n') : syncExec(cmd, opts));
  const err = await commitWorkspace(ws, ['a.md'], 'chore: a', { exec: trunk, mutate: () => write(ws, 'a.md', 'x\n') }).catch((e) => e);
  assert.match(err.message, /default branch is trunk/);
  must(git(ws, 'checkout', '-q', '--detach'));
  const detached = await commitWorkspace(ws, ['a.md'], 'chore: a', { exec: syncExec, mutate: () => write(ws, 'a.md', 'x\n') }).catch((e) => e);
  assert.ok(detached instanceof CommitError);
  assert.match(detached.message, /default branch/);
});

test('state pass in a workspace on another branch exits 1 and writes nothing; with the state already edited it exits 1 too', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const before = readFileSync(join(ws, 'recade/state.yaml'), 'utf8');
  must(git(ws, 'switch', '-q', '-c', 'side'));
  const t = makeIO(ws, { run: syncExec });
  assert.equal(await run(['state', 'pass', 'G0'], t.io), 1);
  assert.match(t.err.join(''), /default branch/);
  assert.equal(readFileSync(join(ws, 'recade/state.yaml'), 'utf8'), before);
  must(git(ws, 'switch', '-q', 'main'));
  write(ws, 'recade/state.yaml', `${before}slicing: mixed\n`);
  const dirty = makeIO(ws, { run: syncExec });
  assert.equal(await run(['state', 'pass', 'G0'], dirty.io), 1);
  assert.match(dirty.err.join(''), /recade\/state\.yaml/);
  assert.match(dirty.err.join(''), /did not make/);
  assert.equal(readFileSync(join(ws, 'recade/state.yaml'), 'utf8'), `${before}slicing: mixed\n`);
});

// ---- pushWorkspace (fake exec only: never a real push)

test('push off, absent or false makes zero calls', async () => {
  for (const extra of [{}, { workspace: { auto_push: false } }, { workspace: { auto_push: 'yes' } }]) {
    const ws = await workspace(extra);
    const calls = [];
    const r = await pushWorkspace(ws, { exec: (cmd) => { calls.push(cmd); return ok(); } });
    assert.deepEqual(r, { pushed: false });
    assert.deepEqual(calls, []);
  }
});

test('push on runs git push origin <default branch> once, with the workspace as cwd', async () => {
  const ws = await workspace({ workspace: { auto_push: true, auto_push_since: '2026-11-18' } });
  const calls = [];
  const exec = (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd });
    return cmd.includes('symbolic-ref') ? ok('origin/trunk\n') : ok();
  };
  const r = await pushWorkspace(ws, { exec });
  assert.deepEqual(r, { pushed: true });
  const pushes = calls.filter((c) => c.cmd.includes('push'));
  assert.equal(pushes.length, 1);
  assert.deepEqual(pushes[0].cmd, ['git', 'push', 'origin', 'trunk']);
  assert.equal(pushes[0].cwd, ws);
  assert.ok(!calls.some((c) => c.cmd.includes('--force') || c.cmd.includes('-f')));
});

test('the default branch is main when the remote does not say', async () => {
  const ws = await workspace({ workspace: { auto_push: true } });
  const calls = [];
  const exec = (cmd) => {
    calls.push(cmd);
    return cmd.includes('symbolic-ref') ? { code: 128, stdout: '', stderr: 'fatal: not a symbolic ref\n' } : ok();
  };
  await pushWorkspace(ws, { exec });
  assert.deepEqual(calls.find((c) => c.includes('push')), ['git', 'push', 'origin', 'main']);
});

test('Review Focus 5: a failing push returns one warning line and never throws; the next push goes again', async () => {
  const ws = await workspace({ workspace: { auto_push: true } });
  let offline = true;
  const pushes = [];
  const exec = (cmd) => {
    if (cmd.includes('symbolic-ref')) return ok('origin/main\n');
    pushes.push(cmd.join(' '));
    return offline ? { code: 128, stdout: '', stderr: 'fatal: unable to access remote\nhint: more\n' } : ok();
  };
  const miss = await pushWorkspace(ws, { exec });
  assert.equal(miss.pushed, false);
  assert.match(miss.warning, /^workspace push failed: fatal: unable to access remote$/);
  assert.ok(!miss.warning.includes('\n'));
  // Two more commits while offline, then the network is back: one push carries them all.
  await commitWorkspace(ws, ['a.md'], 'chore: a', { exec: syncExec, mutate: () => write(ws, 'a.md', '1\n') });
  const again = await pushWorkspace(ws, { exec });
  assert.equal(again.pushed, false);
  offline = false;
  await commitWorkspace(ws, ['b.md'], 'chore: b', { exec: syncExec, mutate: () => write(ws, 'b.md', '2\n') });
  const done = await pushWorkspace(ws, { exec });
  assert.deepEqual(done, { pushed: true });
  assert.equal(pushes.length, 3);
  assert.ok(pushes.every((p) => p === 'git push origin main'));
});

test('an exec that throws is also a warning, not an exception', async () => {
  const ws = await workspace({ workspace: { auto_push: true } });
  const r = await pushWorkspace(ws, { exec: () => { throw new Error('spawn failed'); } });
  assert.equal(r.pushed, false);
  assert.match(r.warning, /spawn failed/);
});

// ---- CLI step ends

/** A runner that does the real git work but records, and fakes, every push. */
function recorder({ pushCode = 0 } = {}) {
  const pushes = [];
  const exec = (cmd, opts) => {
    if (cmd[0] === 'git' && cmd.includes('push')) {
      pushes.push({ cmd, cwd: opts.cwd });
      return pushCode === 0 ? ok() : { code: pushCode, stdout: '', stderr: 'fatal: Authentication failed\n' };
    }
    if (cmd[0] === 'git' && cmd.includes('refs/remotes/origin/HEAD')) return ok('origin/main\n');
    return syncExec(cmd, opts);
  };
  return { exec, pushes };
}
const gitSafe = (ws) => {
  // The repo has no git identity of its own in CI: give the commit one without touching global config.
  must(git(ws, 'config', 'user.name', 'ci'));
  must(git(ws, 'config', 'user.email', ['ci', 'example.invalid'].join('@')));
};

test('state pass in a workspace commits recade/state.yaml and, with auto-push on, pushes once', async () => {
  const ws = await workspace({ workspace: { auto_push: true, auto_push_since: '2026-11-18' } });
  gitSafe(ws);
  const rec = recorder();
  const t = makeIO(ws, { run: rec.exec });
  assert.equal(await run(['state', 'pass', 'G0'], t.io), 0);
  assert.equal(subjects(ws).length, 2);
  assert.match(subjects(ws)[1], /^chore\(recade\): G0 passed$/);
  assert.deepEqual(files(ws), ['recade/state.yaml']);
  assert.equal(rec.pushes.length, 1);
  assert.deepEqual(rec.pushes[0].cmd, ['git', 'push', 'origin', 'main']);
  assert.equal(rec.pushes[0].cwd, ws);
});

test('state pass with auto-push off commits and makes no push call at all', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const rec = recorder();
  const t = makeIO(ws, { run: rec.exec });
  assert.equal(await run(['state', 'pass', 'G0'], t.io), 0);
  assert.equal(subjects(ws).length, 2);
  assert.deepEqual(rec.pushes, []);
});

test('a failing push never fails the command: exit 0, one warning line on stderr, stdout unchanged', async () => {
  const ws = await workspace({ workspace: { auto_push: true } });
  gitSafe(ws);
  const ok1 = recorder();
  const quiet = makeIO(ws, { run: ok1.exec });
  assert.equal(await run(['state', 'pass', 'G0'], quiet.io), 0);
  const ws2 = await workspace({ workspace: { auto_push: true } });
  gitSafe(ws2);
  const bad = recorder({ pushCode: 128 });
  const t = makeIO(ws2, { run: bad.exec });
  assert.equal(await run(['state', 'pass', 'G0'], t.io), 0);
  assert.equal(bad.pushes.length, 1);
  assert.equal(t.err.join('').trim().split('\n').length, 1);
  assert.match(t.err.join(''), /^recade: warning: workspace push failed: fatal: Authentication failed\n$/);
  assert.equal(t.out.join(''), quiet.out.join(''));
  assert.equal(subjects(ws2).length, 2);
});

test('a folder that is not a git workspace commits and pushes nothing', async () => {
  const ws = await workspace({ workspace: { auto_push: true } });
  const plain = tmp();
  write(plain, 'recade/state.yaml', stringify({ version: 1, kind: 'workspace', workspace: { auto_push: true } }));
  const calls = [];
  const t = makeIO(plain, { run: (cmd, opts) => { calls.push(cmd); return syncExec(cmd, opts); } });
  assert.equal(await run(['state', 'pass', 'G0'], t.io), 0);
  assert.deepEqual(calls, []);
  assert.ok(ws);
});

test('a project that is not a workspace (no kind) commits and pushes nothing', async () => {
  const dir = tmp();
  must(git(dir, 'init', '-q', '-b', 'main'));
  write(dir, 'recade/state.yaml', stringify({ version: 1, mode: 'scratch', workspace: { auto_push: true } }));
  const calls = [];
  const t = makeIO(dir, { run: (cmd, opts) => { calls.push(cmd); return syncExec(cmd, opts); } });
  assert.equal(await run(['state', 'pass', 'G0'], t.io), 0);
  assert.deepEqual(calls, []);
});

test('state pass stops with exit 1 and writes nothing when the index holds other staged changes', async () => {
  const ws = await workspace();
  gitSafe(ws);
  write(ws, 'design/draft.md', 'x\n');
  must(git(ws, 'add', 'design/draft.md'));
  const before = readFileSync(join(ws, 'recade/state.yaml'), 'utf8');
  const t = makeIO(ws, { run: syncExec });
  assert.equal(await run(['state', 'pass', 'G0'], t.io), 1);
  assert.match(t.err.join(''), /design\/draft\.md/);
  assert.equal(readFileSync(join(ws, 'recade/state.yaml'), 'utf8'), before);
});

const STATUS_SHEET = (id) => `---\nid: ${id}\ntitle: Slice ${id}\nlane: no-code\ntouches: []\n---\n\n## Goal\n\nGoal.\n`;

test('Review Focus 2 at the CLI: two sessions move two slices to done at once, both moves survive and both commit', async () => {
  const ws = await workspace();
  gitSafe(ws);
  write(ws, 'slices/S-01-one.md', STATUS_SHEET('S-01'));
  write(ws, 'slices/S-02-two.md', STATUS_SHEET('S-02'));
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: sheets'));
  const seed = makeIO(ws, { run: syncExec });
  assert.equal(await run(['slices', 'status'], seed.io), 0);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '', 'the generation committed itself');
  const slow = async (cmd, opts) => {
    if (cmd.includes('commit')) await new Promise((r) => setTimeout(r, 60));
    return syncExec(cmd, opts);
  };
  const one = makeIO(ws, { run: slow });
  const two = makeIO(ws, { run: slow });
  const codes = await Promise.all([
    run(['slices', 'status', '--set', 'S-01', 'done'], one.io),
    run(['slices', 'status', '--set', 'S-02', 'done'], two.io),
  ]);
  assert.deepEqual(codes, [0, 0], one.err.join('') + two.err.join(''));
  const status = readFileSync(join(ws, 'slices/STATUS.md'), 'utf8');
  assert.match(status, /\| S-01 \|[^\n]*\| done \|/);
  assert.match(status, /\| S-02 \|[^\n]*\| done \|/);
  const log = subjects(ws).slice(-2).sort();
  assert.deepEqual(log, ['chore(slices): S-01 done', 'chore(slices): S-02 done']);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
});

test('slices status --set to a status other than done commits the move and does not push', async () => {
  const ws = await workspace({ workspace: { auto_push: true } });
  gitSafe(ws);
  write(ws, 'slices/S-01-one.md', STATUS_SHEET('S-01').replace('no-code', 'standard'));
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: sheets'));
  const rec = recorder();
  assert.equal(await run(['slices', 'status'], makeIO(ws, { run: rec.exec }).io), 0);
  const before = subjects(ws).length;
  const t = makeIO(ws, { run: rec.exec });
  assert.equal(await run(['slices', 'status', '--set', 'S-01', 'spec'], t.io), 0, t.err.join(''));
  assert.equal(subjects(ws).length, before + 1);
  assert.equal(subjects(ws).at(-1), 'chore(slices): S-01 spec');
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  assert.deepEqual(rec.pushes, []);
  for (const next of ['tests', 'implementation', 'audit', 'ready-to-merge']) {
    assert.equal(await run(['slices', 'status', '--set', 'S-01', next], makeIO(ws, { run: rec.exec }).io), 0, next);
  }
  assert.deepEqual(rec.pushes, []);
  assert.equal(await run(['slices', 'status', '--set', 'S-01', 'done'], makeIO(ws, { run: rec.exec }).io), 0);
  assert.equal(rec.pushes.length, 1);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
});

test('generate, move one slice, move it again, move another: every step exits 0 and the tree stays clean', async () => {
  const ws = await workspace();
  gitSafe(ws);
  for (const id of ['S-01', 'S-02']) write(ws, `slices/${id}-x.md`, STATUS_SHEET(id).replace('no-code', 'standard'));
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: sheets'));
  const step = async (...args) => {
    const t = makeIO(ws, { run: syncExec });
    assert.equal(await run(['slices', ...args], t.io), 0, `${args.join(' ')}: ${t.err.join('')}`);
    assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '', args.join(' '));
  };
  await step('status');
  await step('graph');
  await step('status', '--set', 'S-01', 'spec');
  await step('status', '--set', 'S-01', 'tests');
  await step('status', '--set', 'S-02', 'spec');
  await step('status');
});

test('two sessions move two slices to non-done statuses at once: both land, nothing is refused', async () => {
  const ws = await workspace();
  gitSafe(ws);
  for (const id of ['S-01', 'S-02', 'S-03']) write(ws, `slices/${id}-x.md`, STATUS_SHEET(id).replace('no-code', 'standard'));
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: sheets'));
  assert.equal(await run(['slices', 'status'], makeIO(ws, { run: syncExec }).io), 0);
  const slow = async (cmd, opts) => {
    if (cmd.includes('commit')) await new Promise((r) => setTimeout(r, 40));
    return syncExec(cmd, opts);
  };
  const ios = ['S-01', 'S-02', 'S-03'].map(() => makeIO(ws, { run: slow }));
  const codes = await Promise.all(['S-01', 'S-02', 'S-03'].map((id, i) => run(['slices', 'status', '--set', id, 'spec'], ios[i].io)));
  assert.deepEqual(codes, [0, 0, 0], ios.map((x) => x.err.join('')).join(''));
  const status = readFileSync(join(ws, 'slices/STATUS.md'), 'utf8');
  for (const id of ['S-01', 'S-02', 'S-03']) assert.match(status, new RegExp(`\\| ${id} \\|[^\\n]*\\| spec \\|`));
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
});

test('decision close commits its document', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const rec = recorder();
  const n = makeIO(ws, { run: rec.exec, now: () => new Date(2026, 10, 20, 12) });
  const options = JSON.stringify([
    { label: 'Daily', cost: 'x', closes: 'y', risks: 'z', calendar: 'c', repo: 'r' },
    { label: 'Weekly', cost: 'x', closes: 'y', risks: 'z', calendar: 'c', repo: 'r' },
  ]);
  assert.equal(await run(['decision', 'new', '--doc', 'D1', '--question', 'How often?', '--why', 'w', '--known', 'k', '--unknown', 'u', '--options', options, '--recommendation', 'B', '--change-mind', 'm'], n.io), 0, n.err.join(''));
  const before = subjects(ws).length;
  const t = makeIO(ws, { run: rec.exec, now: () => new Date(2026, 10, 20, 12) });
  assert.equal(await run(['decision', 'close', 'DEC-01', '--choice', 'B'], t.io), 0, t.err.join(''));
  assert.equal(subjects(ws).length, before + 1);
  assert.equal(subjects(ws).at(-1), 'docs(decisions): DEC-01 closed');
  assert.deepEqual(files(ws), ['decisions/DEC-01.md']);
});

// ---- harness protect on the workspace

test('protect on a workspace is looser: no pull request, no required check, but no force push, no deletion, linear history (fake gh)', async () => {
  const ws = await workspace({ github: { owner: 'acme', repo: 'fernhill-workspace' } });
  const calls = [];
  const exec = (cmd) => {
    calls.push(cmd);
    return ok();
  };
  const dry = protect(ws, { exec });
  assert.equal(dry.error, null);
  assert.equal(dry.applied, false);
  assert.equal(dry.repo, 'acme/fernhill-workspace');
  assert.equal(dry.workspace, true);
  assert.deepEqual(calls, []);
  const done = protect(ws, { exec, apply: true });
  assert.equal(done.error, null);
  assert.equal(done.applied, true);
  assert.equal(calls.length, 1);
  const text = calls[0].join(' ');
  assert.deepEqual(calls[0].slice(1, 5), ['api', '-X', 'PUT', 'repos/acme/fernhill-workspace/branches/main/protection']);
  assert.match(text, /required_status_checks=null/);
  assert.match(text, /required_pull_request_reviews=null/);
  assert.match(text, /required_linear_history=true/);
  assert.match(text, /allow_force_pushes=false/);
  assert.match(text, /allow_deletions=false/);
  assert.match(text, /restrictions=null/);
  assert.doesNotMatch(text, /required_approving_review_count|contexts/);
  assert.deepEqual(workspaceProtectionArgs('acme/fernhill-workspace', 'main'), calls[0].slice(1));
});

test('recade harness protect in a workspace says it is the looser rule and applies it once', async () => {
  const ws = await workspace({ github: { owner: 'acme', repo: 'fernhill-workspace' } });
  const calls = [];
  const t = makeIO(ws, { run: (cmd) => { calls.push(cmd.join(' ')); return ok(); } });
  assert.equal(await run(['harness', 'protect', '--apply'], t.io), 0, t.err.join(''));
  assert.match(t.out.join(''), /\(the workspace\): no pull request and no check required, no force push, no deletion, linear history\./);
  assert.match(t.out.join(''), /Protection applied\./);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /required_linear_history=true/);
});

test('a code repository keeps its rules: pull request, checks, administrators, no linear-history rule', () => {
  const args = protectionArgs('acme/api', 'main', ['CI']).join(' ');
  assert.match(args, /required_approving_review_count\]=0/);
  assert.match(args, /required_status_checks\[contexts\]\[\]=CI/);
  assert.match(args, /enforce_admins=true/);
  assert.doesNotMatch(args, /linear/);
});

test('protect on a code repository still refuses when no CI job is found', async () => {
  const dir = tmp();
  write(dir, 'recade/state.yaml', stringify({ version: 1, mode: 'scratch', github: { owner: 'acme', repo: 'api' } }));
  const r = protect(dir, { exec: () => ok() });
  assert.match(r.error, /No CI job found/);
});

// ---- the other step ends: retro and board reconcile --apply

const INC_SHEET = (id, extra = '') => `---\ndoc_id: ${id}\ntitle: "Slice ${id}"\nrepos: [app]\nbranch: slice/${id.toLowerCase()}-x\nformat: small\nlane: standard\nimplementer: implementer\nincrement: INC-1\ndepends_on: []\nblocks: []\nexternal_prerequisite: none\nprovisionals_used: []\nsize: S\ntouches:\n  - "src/${id.toLowerCase()}/**"\n${extra}---\n\n# ${id}: Slice ${id}\n\n## Scope\n\n- LOAN-01 (the gist)\n\n## Definition of Done\n\n| # | Command (counts tests) | Expected | Done |\n|---|---|---|---|\n| 1 | \`make test\` (3 tests) | All green | [x] |\n\n## Work order\n\n1. Build it.\n`;

test('retro commits retros/INC-n.md only, then pushes when auto-push is on', async () => {
  const ws = await workspace({ workspace: { auto_push: true } });
  gitSafe(ws);
  write(ws, 'slices/S-01-x.md', INC_SHEET('S-01'));
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: sheet'));
  write(ws, 'design/unrelated.md', 'dirty\n');
  const rec = recorder();
  const exec = (cmd, opts) => (cmd[0] === 'gh' ? ok('[]') : rec.exec(cmd, opts));
  const before = subjects(ws).length;
  const t = makeIO(ws, { run: exec });
  assert.equal(await run(['retro', 'INC-1'], t.io), 0, t.err.join(''));
  assert.equal(subjects(ws).length, before + 1);
  assert.equal(subjects(ws).at(-1), 'docs(retros): INC-1 written');
  assert.deepEqual(files(ws), ['retros/INC-1.md']);
  assert.match(must(git(ws, 'status', '--porcelain')).stdout, /design\/unrelated\.md/);
  assert.equal(rec.pushes.length, 1);
});

test('board reconcile --apply commits the STATUS.md move; a dry run commits nothing', async () => {
  const ws = await workspace({ github: { owner: 'fernhill', repo: 'fernhill-workspace', project_number: 7 } });
  gitSafe(ws);
  write(ws, 'slices/S-01-x.md', INC_SHEET('S-01'));
  write(ws, 'slices/STATUS.md', '# Slice status\n\n| Slice | Title | Format | Lane | Increment | State | Depends on | Size | Note |\n|---|---|---|---|---|---|---|---|---|\n| S-01 | Slice S-01 | small | standard | INC-1 | ready-to-merge | | S | |\n');
  write(ws, 'docs/PLAN.md', '# Plan\n\n## Backlog\n\n| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |\n|---|---|---|---|---|---|---|---|---|---|\n| LOAN-01 | Core | Apply | M | 2 | | 1 | Build | todo | |\n');
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: slices'));
  const options = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'].map((name, i) => ({ id: `opt_${i}`, name }));
  const issues = [{ number: 1, title: '[S-01] Slice S-01', url: 'https://github.com/fernhill/fernhill-workspace/issues/1' }, { number: 2, title: '[LOAN-01] Apply', url: 'https://github.com/fernhill/fernhill-workspace/issues/2' }];
  const items = issues.map((i) => ({ id: `PVTI_${i.number}`, title: i.title, status: 'In review', content: { url: i.url, number: i.number, type: 'Issue' } }));
  const lockedDuringGh = [];
  const gh = (cmd, opts) => {
    if (cmd[0] !== 'gh') return syncExec(cmd, opts);
    lockedDuringGh.push(existsSync(join(ws, LOCK_FILE)));
    const [a, b] = cmd.slice(1);
    if (a === 'pr' && b === 'view') return ok(JSON.stringify({ number: 12, state: 'MERGED', mergedAt: '2026-11-13T10:00:00Z', url: 'https://github.com/fernhill/app/pull/12', headRefOid: 'a'.repeat(40), baseRefName: 'main' }));
    if (a === 'project' && b === 'view') return ok(JSON.stringify({ number: 7, id: 'PVT_board', title: 'Board' }));
    if (a === 'project' && b === 'field-list') return ok(JSON.stringify({ fields: [{ id: 'F1', name: 'Status', options }], totalCount: 1 }));
    if (a === 'project' && b === 'item-list') return ok(JSON.stringify({ items, totalCount: items.length }));
    if (a === 'issue' && b === 'list') return ok(JSON.stringify(issues));
    return ok('{}');
  };
  const before = subjects(ws).length;
  const dry = makeIO(ws, { run: gh });
  assert.equal(await run(['board', 'reconcile'], dry.io), 0, dry.err.join(''));
  assert.equal(subjects(ws).length, before);
  // A status move of another slice came first and left nothing dirty: the reconcile is not refused after it.
  write(ws, 'slices/S-02-y.md', INC_SHEET('S-02'));
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: second sheet'));
  assert.equal(await run(['slices', 'status'], makeIO(ws, { run: gh }).io), 0);
  assert.equal(await run(['slices', 'status', '--set', 'S-02', 'spec'], makeIO(ws, { run: gh }).io), 0);
  const applied = makeIO(ws, { run: gh });
  lockedDuringGh.length = 0;
  assert.equal(await run(['board', 'reconcile', '--apply'], applied.io), 0, applied.err.join(''));
  assert.ok(lockedDuringGh.length > 0);
  assert.ok(lockedDuringGh.every((x) => x === false), 'no gh call while the commit lock is held');
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  assert.match(readFileSync(join(ws, 'slices/STATUS.md'), 'utf8'), /\| S-01 \|[^\n]*\| done \|/);
  assert.equal(subjects(ws).at(-1), 'chore(board): reconcile STATUS.md');
  assert.deepEqual(files(ws), ['slices/STATUS.md']);
});

// ---- state under the lock, with real processes

test('Review Focus 2, real processes: four state commands at once, each on its own key, no update is lost', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const runs = await Promise.all([
    recade(ws, 'state', 'set', 'slicing', 'small'),
    recade(ws, 'state', 'set', 'docs_step', 'direction'),
    recade(ws, 'state', 'set', 'hotspots', 'db/**'),
    recade(ws, 'state', 'set', 'lots', 'LOAN,PAY'),
  ]);
  assert.deepEqual(runs.map((r) => r.code), [0, 0, 0, 0], runs.map((r) => r.err).join(''));
  const state = parse(readFileSync(join(ws, 'recade/state.yaml'), 'utf8'));
  assert.equal(state.slicing, 'small');
  assert.equal(state.docs_step, 'direction');
  assert.deepEqual(state.hotspots, ['db/**']);
  assert.deepEqual(state.lots, ['LOAN', 'PAY']);
  assert.equal(subjects(ws).length, 5);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('Review Focus 2, real processes: slices moved by separate sessions at once, non-done and done, all land', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const ids = ['S-01', 'S-02', 'S-03', 'S-04'];
  for (const id of ids) write(ws, `slices/${id}-x.md`, STATUS_SHEET(id).replace('no-code', 'standard'));
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: sheets'));
  assert.equal((await recade(ws, 'slices', 'status')).code, 0);
  const runs = await Promise.all(ids.map((id) => recade(ws, 'slices', 'status', '--set', id, 'spec')));
  assert.deepEqual(runs.map((r) => r.code), [0, 0, 0, 0], runs.map((r) => r.err).join(''));
  const status = readFileSync(join(ws, 'slices/STATUS.md'), 'utf8');
  for (const id of ids) assert.match(status, new RegExp(`\\| ${id} \\|[^\\n]*\\| spec \\|`));
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
});

// ---- the lock of a dead process

const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const lockOf = (ws, data) => write(ws, LOCK_FILE, `${JSON.stringify(data)}\n`);

test('the lock of a dead process of this machine is removed, with one line of notice, and the commit goes on', async () => {
  const ws = await workspace();
  lockOf(ws, { pid: deadPid(), host: hostname(), at: new Date().toISOString() });
  const lines = [];
  const r = await commitWorkspace(ws, ['a.md'], 'chore: a', { exec: syncExec, mutate: () => write(ws, 'a.md', 'x\n'), notify: (l) => lines.push(l) });
  assert.equal(r.committed, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /removed \.recade\/commit\.lock: the process that held it \(pid \d+\) is gone\./);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('a lock of another machine, of a living process, or with no host is never removed by that rule', async () => {
  const cases = [
    { pid: deadPid(), host: `${hostname()}-other`, at: new Date().toISOString() },
    { pid: process.pid, host: hostname(), at: new Date().toISOString() },
    { pid: deadPid(), at: new Date().toISOString() },
  ];
  for (const data of cases) {
    const ws = await workspace();
    lockOf(ws, data);
    const err = await commitWorkspace(ws, ['a.md'], 'chore: a', { exec: syncExec, wait: 60, mutate: () => write(ws, 'a.md', 'x\n') }).catch((e) => e);
    assert.ok(err instanceof CommitError, JSON.stringify(data));
    assert.match(err.message, /holds \.recade\/commit\.lock/);
    assert.equal(existsSync(join(ws, LOCK_FILE)), true);
    assert.equal(existsSync(join(ws, 'a.md')), false);
  }
});

test('a dead holder is removed whatever the age of its lock, and the CLI says so on stderr', async () => {
  const ws = await workspace();
  gitSafe(ws);
  lockOf(ws, { pid: deadPid(), host: hostname(), at: new Date(Date.now() - 3 * STALE_MS).toISOString() });
  const t = makeIO(ws, { run: syncExec });
  assert.equal(await run(['state', 'set', 'slicing', 'small'], t.io), 0, t.err.join(''));
  assert.match(t.err.join(''), /^recade: removed \.recade\/commit\.lock: the process that held it \(pid \d+\) is gone\.\n$/);
  assert.equal(existsSync(join(ws, LOCK_FILE)), false);
});

test('the lock file records the pid and the host', async () => {
  const ws = await workspace();
  let seen = null;
  await commitWorkspace(ws, ['a.md'], 'chore: a', { exec: syncExec, mutate: () => { seen = JSON.parse(readFileSync(join(ws, LOCK_FILE), 'utf8')); write(ws, 'a.md', 'x\n'); } });
  assert.equal(seen.pid, process.pid);
  assert.equal(seen.host, hostname());
  assert.match(seen.at, /^\d{4}-\d\d-\d\dT/);
});

// ---- every writer commits its own paths

test('workspace auto-push, repo add and harness set each commit their change, so the next state step is not refused', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const rec = recorder();
  const t1 = makeIO(ws, { run: rec.exec, now: () => new Date(2026, 10, 20, 12) });
  assert.equal(await run(['workspace', 'auto-push', 'on'], t1.io), 0, t1.err.join(''));
  assert.equal(subjects(ws).at(-1), 'chore(recade): auto-push on');
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  const set = async (value) => {
    const t = makeIO(ws, { run: rec.exec });
    assert.equal(await run(['state', 'set', 'slicing', value], t.io), 0, t.err.join(''));
    assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  };
  await set('small');
  const t2 = makeIO(ws);
  assert.equal(await run(['repo', 'add', 'api', '--new'], t2.io), 0, t2.err.join(''));
  assert.equal(subjects(ws).at(-1), 'chore(recade): repository api added');
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  await set('mixed');
  const t3 = makeIO(ws, { run: rec.exec });
  assert.equal(await run(['harness', 'set', '--wip-limit', '3'], t3.io), 0, t3.err.join(''));
  assert.equal(subjects(ws).at(-1), 'chore(recade): harness settings set');
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  await set('small');
  assert.deepEqual(rec.pushes, [], 'none of these writers pushes');
});

test('repo add is refused before the clone work when a path of the step was edited by someone else', async () => {
  const ws = await workspace();
  gitSafe(ws);
  write(ws, 'recade/state.yaml', `${readFileSync(join(ws, 'recade/state.yaml'), 'utf8')}slicing: small\n`);
  const t = makeIO(ws);
  assert.equal(await run(['repo', 'add', 'api', '--new'], t.io), 1);
  assert.match(t.err.join(''), /did not make/);
  assert.equal(existsSync(join(ws, 'repos', 'api')), false);
});

test('github init commits the state it recorded (fake gh), and no lock is held while gh runs', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const gh = createFakeGh({ base: (cmd, args) => asyncExec(cmd, args) });
  const locked = [];
  const exec = async (cmd, args, timeout) => {
    if (cmd === 'gh') locked.push(existsSync(join(ws, LOCK_FILE)));
    return gh.exec(cmd, args, timeout);
  };
  const t = makeIO(ws, { exec });
  const code = await run(['github', 'init', '--owner', 'acme'], t.io);
  assert.equal(code, 0, t.err.join(''));
  assert.ok(locked.length > 0);
  assert.ok(locked.every((x) => x === false));
  assert.equal(subjects(ws).at(-1), 'chore(recade): GitHub board recorded');
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  assert.equal(parse(readFileSync(join(ws, 'recade/state.yaml'), 'utf8')).github.owner, 'acme');
  const next = makeIO(ws, { run: syncExec });
  assert.equal(await run(['state', 'set', 'slicing', 'small'], next.io), 0, next.err.join(''));
});

test('provisional open and close commit intake/provisionals.md', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const t = makeIO(ws, { run: syncExec });
  assert.equal(await run(['provisional', 'open', '--what', 'Fee rate', '--why', 'No quote yet', '--assumption', '2 percent', '--owner', 'Dana'], t.io), 0, t.err.join(''));
  assert.match(subjects(ws).at(-1), /^docs\(intake\): PRV-01 opened$/);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  const c = makeIO(ws, { run: syncExec });
  assert.equal(await run(['provisional', 'close', 'PRV-01', '--value', '2.5 percent'], c.io), 0, c.err.join(''));
  assert.match(subjects(ws).at(-1), /^docs\(intake\): PRV-01 closed$/);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
});

test('decision new checks and commits only the file it writes: an owner edit of another decision stays untouched', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const options = JSON.stringify([
    { label: 'Daily', cost: 'x', closes: 'y', risks: 'z', calendar: 'c', repo: 'r' },
    { label: 'Weekly', cost: 'x', closes: 'y', risks: 'z', calendar: 'c', repo: 'r' },
  ]);
  const open = async (question) => {
    const t = makeIO(ws, { run: syncExec, now: () => new Date(2026, 10, 20, 12) });
    const code = await run(['decision', 'new', '--doc', 'D1', '--question', question, '--why', 'w', '--known', 'k', '--unknown', 'u', '--options', options, '--recommendation', 'B', '--change-mind', 'm'], t.io);
    return { code, err: t.err.join(''), out: t.out.join('') };
  };
  const first = await open('How often?');
  assert.equal(first.code, 0, first.err);
  writeFileSync(join(ws, 'decisions/DEC-01.md'), `${readFileSync(join(ws, 'decisions/DEC-01.md'), 'utf8')}\nOwner note, not committed.\n`);
  const second = await open('Which bank?');
  assert.equal(second.code, 0, second.err);
  assert.equal(second.out, 'DEC-02\n');
  assert.deepEqual(files(ws), ['decisions/DEC-02.md']);
  assert.match(must(git(ws, 'status', '--porcelain')).stdout, / M decisions\/DEC-01\.md/);
});

test('decision new works in a workspace with no commit yet, where decisions/.gitkeep is untracked', async () => {
  const parent = join(tmp(), 'Projets Clients');
  mkdirSync(parent);
  const { dir } = await createWorkspace(parent, 'Ete', { exec: asyncExec });
  gitSafe(dir);
  const options = JSON.stringify([{ label: 'A', cost: 'x', closes: 'y', risks: 'z', calendar: 'c', repo: 'r' }, { label: 'B', cost: 'x', closes: 'y', risks: 'z', calendar: 'c', repo: 'r' }]);
  const t = makeIO(dir, { run: syncExec, now: () => new Date(2026, 10, 20, 12) });
  assert.equal(await run(['decision', 'new', '--doc', 'D1', '--question', 'Q?', '--why', 'w', '--known', 'k', '--unknown', 'u', '--options', options, '--recommendation', 'B', '--change-mind', 'm'], t.io), 0, t.err.join(''));
  assert.deepEqual(files(dir), ['decisions/DEC-01.md']);
});

// ---- harness protect from a code repository

test('harness protect run from a code repository protects that repository with the strict rules, not the workspace', async () => {
  const ws = await workspace({ github: { owner: 'acme', repo: 'fernhill-workspace' } });
  gitSafe(ws);
  assert.equal((await recade(ws, 'repo', 'add', 'api', '--new')).code, 0);
  const repo = join(ws, 'repos', 'api');
  write(repo, '.github/workflows/ci.yml', 'name: CI\non: [push]\njobs:\n  test:\n    name: CI\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n');
  const calls = [];
  const exec = (cmd, opts) => {
    calls.push({ cmd: cmd.join(' '), cwd: opts.cwd });
    return cmd.includes('view') ? ok('acme/api\n') : ok();
  };
  const t = makeIO(repo, { run: exec });
  assert.equal(await run(['harness', 'protect', '--apply'], t.io), 0, t.err.join(''));
  const api = calls.find((c) => c.cmd.startsWith('gh api'));
  assert.ok(api, calls.map((c) => c.cmd).join('\n'));
  assert.match(api.cmd, /repos\/acme\/api\/branches\/main\/protection/);
  assert.match(api.cmd, /required_approving_review_count\]=0/);
  assert.match(api.cmd, /required_status_checks\[contexts\]\[\]=CI/);
  assert.doesNotMatch(api.cmd, /linear_history/);
  assert.doesNotMatch(api.cmd, /fernhill-workspace/);
  assert.equal(calls.find((c) => c.cmd.includes('view')).cwd, repo);
  assert.match(t.out.join(''), /pull request required, checks required \(CI\)/);
  // From the workspace it is still the loose rule.
  const w = makeIO(ws, { run: (cmd) => ok() });
  assert.equal(await run(['harness', 'protect'], w.io), 0, w.err.join(''));
  assert.match(w.out.join(''), /\(the workspace\)/);
});

test('a new project workspace starts clean and committed, so the first step is not refused', async () => {
  const CONFIG = { voice: 'randall-munroe', languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] } };
  const root = join(tmp(), 'Projets Clients');
  mkdirSync(root);
  const r = await createProject('Fernhill Lending', { root, mode: 'scratch', config: CONFIG, exec: asyncExec, today: '2026-11-18' });
  assert.equal(must(git(r.dir, 'status', '--porcelain')).stdout, '');
  assert.deepEqual(subjects(r.dir), ['chore: create the workspace']);
  const t = makeIO(r.dir, { run: syncExec });
  assert.equal(await run(['provisional', 'open', '--what', 'Fee', '--why', 'w', '--assumption', 'a', '--owner', 'Dana'], t.io), 0, t.err.join(''));
  const s = makeIO(r.dir, { run: syncExec });
  assert.equal(await run(['state', 'pass', 'G0'], s.io), 0, s.err.join(''));
  assert.equal(must(git(r.dir, 'status', '--porcelain')).stdout, '');
});

/* ---------- final fix wave A ---------- */

test('final A, I3: a failed commit puts back the files the step wrote, says what to change, and the next step runs', async () => {
  const ws = await workspace();
  gitSafe(ws);
  write(ws, 'slices/STATUS.md', 'before\n');
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: status'));
  const head = must(git(ws, 'rev-parse', 'HEAD')).stdout;
  const hook = (cmd, opts) => (cmd.includes('commit')
    ? { code: 1, stdout: 'slices/STATUS.md:3:40 error no-em-dash An em dash is not allowed. Use a colon or a comma.\n', stderr: 'recade pre-commit: style errors in the staged files. Fix them, then commit again.\n' }
    : syncExec(cmd, opts));
  const err = await commitWorkspace(ws, ['slices'], 'chore: x', { exec: hook, mutate: () => {
    write(ws, 'slices/STATUS.md', 'after \u2014 note\n');
    write(ws, 'slices/S-09-new.md', 'new\n');
  } }).catch((e) => e);
  assert.ok(err instanceof CommitError);
  assert.match(err.message, /style errors/);
  assert.match(err.message, /slices\/STATUS\.md:3:40 error no-em-dash/);
  assert.match(err.message, /Nothing was recorded/);
  assert.ok(!err.message.includes('\n'), 'one line');
  assert.equal(readFileSync(join(ws, 'slices', 'STATUS.md'), 'utf8'), 'before\n');
  assert.equal(existsSync(join(ws, 'slices', 'S-09-new.md')), false);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  assert.equal(must(git(ws, 'rev-parse', 'HEAD')).stdout, head);
  // The next step is not refused as someone else's edit.
  const next = await commitWorkspace(ws, ['slices'], 'chore: y', { exec: syncExec, mutate: () => write(ws, 'slices/STATUS.md', 'after\n') });
  assert.equal(next.committed, true);
});

test('final A, I3: slices status --set with a refused commit leaves STATUS.md as it was, and the next move works', async () => {
  const ws = await workspace();
  gitSafe(ws);
  write(ws, 'slices/S-01-one.md', STATUS_SHEET('S-01').replace('no-code', 'standard'));
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: sheets'));
  assert.equal(await run(['slices', 'status'], makeIO(ws, { run: syncExec }).io), 0);
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: status', '--allow-empty'));
  const refuse = (cmd, opts) => (cmd.includes('commit')
    ? { code: 1, stdout: 'slices/STATUS.md:12:60 error no-em-dash An em dash is not allowed.\n', stderr: 'recade pre-commit: style errors in the staged files. Fix them, then commit again.\n' }
    : syncExec(cmd, opts));
  const t = makeIO(ws, { run: refuse });
  assert.equal(await run(['slices', 'status', '--set', 'S-01', 'blocked', '--note', 'waiting on the API'], t.io), 1);
  assert.match(t.err.join(''), /no-em-dash/);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  const again = makeIO(ws, { run: syncExec });
  assert.equal(await run(['slices', 'status', '--set', 'S-01', 'spec'], again.io), 0, again.err.join(''));
  assert.equal(subjects(ws).at(-1), 'chore(slices): S-01 spec');
});

test('final A, M4: repo add commits only its own files, not a sheet the owner edits during the clone', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const exec = (cmd, args) => {
    if (args.includes('init')) write(ws, 'slices/S-09-owner.md', 'the owner writes this during the clone\n');
    return asyncExec(cmd, args);
  };
  const t = makeIO(ws, { exec });
  assert.equal(await run(['repo', 'add', 'api', '--new'], t.io), 0, t.err.join(''));
  assert.equal(subjects(ws).at(-1), 'chore(recade): repository api added');
  assert.deepEqual(files(ws), ['recade/state.yaml']);
  assert.match(must(git(ws, 'status', '--porcelain')).stdout, /S-09-owner\.md/);
});

test('final A, M5: when the remote diverged, auto-push fetches, pushes nothing and gives the exact command', async () => {
  const ws = await workspace({ workspace: { auto_push: true } });
  gitSafe(ws);
  const bare = join(tmp(), 'ws.git');
  must(git(ws, 'clone', '-q', '--bare', ws, bare));
  must(git(ws, 'remote', 'add', 'origin', bare));
  must(git(ws, 'fetch', '-q', 'origin'));
  // Another machine pushes first.
  const other = join(tmp(), 'other');
  must(git(tmp(), 'clone', '-q', bare, other));
  gitSafe(other);
  write(other, 'b.md', 'other\n');
  must(git(other, 'add', '-A'));
  must(git(other, 'commit', '-q', '-m', 'docs: other'));
  must(git(other, 'push', '-q', 'origin', 'main'));
  await commitWorkspace(ws, ['a.md'], 'docs: a', { exec: syncExec, mutate: () => write(ws, 'a.md', 'here\n') });
  const r = await pushWorkspace(ws, { exec: syncExec });
  assert.equal(r.pushed, false);
  assert.match(r.warning, /diverged/);
  assert.ok(r.warning.includes(`git -C '${ws}' pull --rebase origin main`), r.warning);
  assert.ok(!r.warning.includes('\n'));
  // Once rebased, the next push goes through.
  must(git(ws, 'pull', '-q', '--rebase', 'origin', 'main'));
  assert.deepEqual(await pushWorkspace(ws, { exec: syncExec }), { pushed: true });
});

test('final A, I3: repo add whose commit is refused puts the registry back and removes the clone, so it can run again', async () => {
  const ws = await workspace();
  gitSafe(ws);
  const refuse = (cmd, opts) => (cmd.includes('commit') ? { code: 1, stdout: '', stderr: 'error: hook said no\n' } : syncExec(cmd, opts));
  const t = makeIO(ws, { run: refuse });
  assert.equal(await run(['repo', 'add', 'api', '--new'], t.io), 1);
  assert.match(t.err.join(''), /hook said no.*Nothing was recorded/);
  assert.equal(existsSync(join(ws, 'repos', 'api')), false);
  assert.equal(must(git(ws, 'status', '--porcelain')).stdout, '');
  const again = makeIO(ws);
  assert.equal(await run(['repo', 'add', 'api', '--new'], again.io), 0, again.err.join(''));
});
