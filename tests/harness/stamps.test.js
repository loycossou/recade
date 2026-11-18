import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.js';
import { checkGate, fingerprint, readStamps, runGate } from '../../src/harness/stamps.js';

const sh = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

/** A temp repository with one commit holding `a.txt`. */
function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'recade-stamps-'));
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'chore: start');
  return repo;
}

const okExec = (code = 0) => () => ({ code, stdout: 'raw out\n', stderr: 'raw err\n' });

function makeIO(cwd) {
  const out = [];
  const err = [];
  return { io: { cwd, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } }, out, err };
}

test('fingerprint is stable on a clean tree and counts dirty lines', () => {
  const repo = makeRepo();
  const a = fingerprint(repo);
  assert.equal(a.dirty, 0);
  assert.match(a.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(fingerprint(repo), a);
  writeFileSync(join(repo, 'b.txt'), 'new\n');
  const b = fingerprint(repo);
  assert.equal(b.dirty, 1);
  assert.notEqual(b.hash, a.hash);
});

test('fingerprint works on a repository with no commit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'recade-stamps-'));
  sh(repo, 'init', '-q', '-b', 'main');
  assert.equal(fingerprint(repo).head, 'none');
});

test('a green stamp goes stale when a tracked file is edited (review focus 2)', () => {
  const repo = makeRepo();
  assert.equal(checkGate('tests', { repo }), 'missing');
  const { code, stamp } = runGate('tests', ['npm', 'test'], { repo, exec: okExec(0) });
  assert.equal(code, 0);
  assert.equal(stamp.name, 'tests');
  assert.deepEqual(stamp.cmd, ['npm', 'test']);
  assert.equal(checkGate('tests', { repo }), 'green');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  assert.equal(checkGate('tests', { repo }), 'stale');
});

test('a second edit of a file that was already modified still makes the stamp stale', () => {
  const repo = makeRepo();
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  runGate('tests', ['t'], { repo, exec: okExec(0) });
  assert.equal(checkGate('tests', { repo }), 'green');
  writeFileSync(join(repo, 'a.txt'), 'three\n');
  assert.equal(checkGate('tests', { repo }), 'stale');
});

test('a new commit, a new file and a rename make the stamp stale', () => {
  const repo = makeRepo();
  runGate('tests', ['t'], { repo, exec: okExec(0) });
  writeFileSync(join(repo, 'new.txt'), 'x\n');
  assert.equal(checkGate('tests', { repo }), 'stale');
  runGate('tests', ['t'], { repo, exec: okExec(0) });
  assert.equal(checkGate('tests', { repo }), 'green');
  renameSync(join(repo, 'new.txt'), join(repo, 'moved.txt'));
  assert.equal(checkGate('tests', { repo }), 'stale');
  runGate('tests', ['t'], { repo, exec: okExec(0) });
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'chore: more');
  assert.equal(checkGate('tests', { repo }), 'stale');
});

test('a red run is stamped red, and a stamp for the current tree is not changed by the stamp files themselves', () => {
  const repo = makeRepo();
  const { code } = runGate('lint', ['x'], { repo, exec: okExec(3) });
  assert.equal(code, 3);
  assert.equal(checkGate('lint', { repo }), 'red');
  runGate('other', ['x'], { repo, exec: okExec(0) });
  assert.equal(checkGate('lint', { repo }), 'red', 'writing another stamp does not change the fingerprint');
});

test('the raw output goes to .recade/gates and stamps.json records name, cmd, code, fingerprint, at', () => {
  const repo = makeRepo();
  runGate('tests', ['node', '--test'], { repo, exec: okExec(0), now: () => new Date('2026-01-02T03:04:05Z') });
  const log = readFileSync(join(repo, '.recade', 'gates', 'tests.log'), 'utf8');
  assert.match(log, /raw out/);
  assert.match(log, /raw err/);
  const stamp = JSON.parse(readFileSync(join(repo, '.recade', 'stamps.json'), 'utf8')).tests;
  assert.deepEqual(Object.keys(stamp).sort(), ['at', 'cmd', 'code', 'fingerprint', 'name']);
  assert.equal(stamp.at, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(readStamps(repo).tests, stamp);
});

test('runGate refuses an unsafe gate name and an empty command', () => {
  const repo = makeRepo();
  assert.throws(() => runGate('../x', ['a'], { repo, exec: okExec() }), /Invalid gate name/);
  assert.throws(() => runGate('ok', [], { repo, exec: okExec() }), /needs a command/);
});

test('recade gate run then check: green, then stale after an edit', async () => {
  const repo = makeRepo();
  const a = makeIO(repo);
  assert.equal(await run(['gate', 'run', 'tests', '--', 'node', '-e', 'process.exit(0)'], a.io), 0);
  assert.match(a.out.join(''), /tests: green/);
  const b = makeIO(repo);
  assert.equal(await run(['gate', 'check', 'tests'], b.io), 0);
  assert.equal(b.out.join(''), 'tests: green\n');
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  const c = makeIO(repo);
  assert.equal(await run(['gate', 'check', 'tests'], c.io), 1);
  assert.equal(c.out.join(''), 'tests: stale\n');
});

test('recade gate run returns 1 for a failing command and gate check says red', async () => {
  const repo = makeRepo();
  const a = makeIO(repo);
  assert.equal(await run(['gate', 'run', 'tests', '--', 'node', '-e', 'process.exit(5)'], a.io), 1);
  const b = makeIO(repo);
  assert.equal(await run(['gate', 'check', 'tests'], b.io), 1);
  assert.equal(b.out.join(''), 'tests: red\n');
});

test('recade gate check with no name reads harness.required_gates from the state', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'recade'));
  writeFileSync(join(repo, 'recade', 'state.yaml'), 'version: 1\nmode: scratch\nphase: 5\ngates: {}\nharness:\n  required_gates: [tests, lint]\n');
  const a = makeIO(repo);
  assert.equal(await run(['gate', 'check'], a.io), 1);
  assert.equal(a.out.join(''), 'tests: missing\nlint: missing\n');
  await run(['gate', 'run', 'tests', '--', 'node', '-e', '0'], makeIO(repo).io);
  await run(['gate', 'run', 'lint', '--', 'node', '-e', '0'], makeIO(repo).io);
  const b = makeIO(repo);
  assert.equal(await run(['gate', 'check'], b.io), 0);
  assert.equal(b.out.join(''), 'tests: green\nlint: green\n');
});

test('recade gate check with no required gate passes', async () => {
  const repo = makeRepo();
  const a = makeIO(repo);
  assert.equal(await run(['gate', 'check'], a.io), 0);
});

test('recade gate usage errors exit 2', async () => {
  const repo = makeRepo();
  for (const args of [['gate'], ['gate', 'run'], ['gate', 'run', 'x'], ['gate', 'run', 'x', '--'], ['gate', 'run', '../x', '--', 'a'], ['gate', 'check', 'a', 'b'], ['gate', 'nope']]) {
    const t = makeIO(repo);
    assert.equal(await run(args, t.io), 2, args.join(' '));
    assert.match(t.err.join(''), /Usage: recade gate/);
  }
  const notGit = makeIO(mkdtempSync(join(tmpdir(), 'recade-nogit-')));
  assert.equal(await run(['gate', 'check', 'x'], notGit.io), 2);
  assert.equal(existsSync(join(notGit.io.cwd, '.recade')), false);
});

test('a gate command that changes the tree is stamped stale', async () => {
  const repo = makeRepo();
  const editing = (cmd, { cwd }) => {
    writeFileSync(join(cwd, 'generated.txt'), 'out\n');
    return { code: 0, stdout: '', stderr: '' };
  };
  const { code, stamp } = runGate('build', ['make'], { repo, exec: editing });
  assert.equal(code, 0);
  assert.equal(stamp.stale, true);
  assert.equal(checkGate('build', { repo }), 'stale');
  const t = makeIO(repo);
  rmGenerated(repo);
  assert.equal(await run(['gate', 'run', 'ok', '--', 'node', '-e', '0'], t.io), 0);
  const u = makeIO(repo);
  assert.equal(await run(['gate', 'run', 'gen', '--', 'node', '-e', "require('fs').writeFileSync('gen.txt','x')"], u.io), 1);
  assert.match(u.out.join(''), /gen: stale/);
  assert.equal(checkGate('gen', { repo }), 'stale');
});

function rmGenerated(repo) {
  spawnSync('rm', ['-f', join(repo, 'generated.txt')]);
}

test('a changed symlink target changes the fingerprint', () => {
  const repo = makeRepo();
  symlinkSync('a.txt', join(repo, 'link'));
  const a = fingerprint(repo);
  spawnSync('rm', [join(repo, 'link')]);
  symlinkSync('other.txt', join(repo, 'link'));
  assert.notEqual(fingerprint(repo).hash, a.hash);
});

test('required gate names that are not valid are an error, not dropped', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'recade'));
  writeFileSync(join(repo, 'recade', 'state.yaml'), 'version: 1\nharness:\n  required_gates: [tests, "../x"]\n');
  const t = makeIO(repo);
  assert.equal(await run(['gate', 'check'], t.io), 2);
  assert.match(t.err.join(''), /Invalid gate name/);
});
