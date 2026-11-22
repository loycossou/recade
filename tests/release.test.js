import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(repo, 'tools', 'release.sh');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ci', GIT_AUTHOR_EMAIL: 'ci', GIT_COMMITTER_NAME: 'ci', GIT_COMMITTER_EMAIL: 'ci',
  GIT_CONFIG_NOSYSTEM: '1', RECADE_PRIVATE_NAMES: 'Zorblax',
};

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

const write = (root, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

/**
 * A source repository with stand-ins for the checks (npm test prints the TAP summary, the names check and publish-check
 * exit with the code given), the real release script, and an empty release repository. Both on main, committed.
 */
function setup({ testFails = false, guardCode = 0, publishCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'recade-release-'));
  const src = join(dir, 'src');
  const rel = join(dir, 'rel');
  mkdirSync(src);
  mkdirSync(rel);
  write(src, {
    'package.json': JSON.stringify({ name: 'x', scripts: { test: testFails ? "echo '# fail 1'; exit 1" : "echo '# pass 3'; echo '# fail 0'" } }),
    'bin/recade.js': `process.exit(${guardCode});\n`,
    'tools/publish-check.js': `process.exit(${publishCode});\n`,
    'README.md': 'first\n',
    'old.md': 'removed later\n',
  });
  mkdirSync(join(src, 'tools'), { recursive: true });
  copyFileSync(SCRIPT, join(src, 'tools', 'release.sh'));
  chmodSync(join(src, 'tools', 'release.sh'), 0o755);
  git(src, 'init', '-q');
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'one');
  git(rel, 'init', '-q');
  git(rel, 'commit', '-q', '--allow-empty', '-m', 'root');
  return { dir, src, rel };
}

const release = (src, args, env = ENV) => spawnSync('bash', [join(src, 'tools', 'release.sh'), ...args], { cwd: src, encoding: 'utf8', env });

test('release copies main to the release repository, deletes what main deleted, commits, and does not push without --push', (t) => {
  const { dir, src, rel } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let r = release(src, [rel, '-m', 'first release']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(rel, 'old.md')));
  git(src, 'rm', '-q', 'old.md');
  write(src, { 'README.md': 'second\n' });
  git(src, 'commit', '-qam', 'two');
  r = release(src, [rel, '-m', 'second release']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(rel, 'old.md')), false, 'a file deleted from main is deleted from the release');
  assert.match(git(rel, 'log', '-1', '--format=%s'), /second release/);
  assert.match(r.stdout, /Run again with --push/);
  assert.equal(git(rel, 'status', '--porcelain'), '');
});

test('release refuses a release repository with changes nobody committed, and touches nothing', (t) => {
  const { dir, src, rel } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(rel, { 'notes.md': 'work of another session\n' });
  const r = release(src, [rel, '-m', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /changes nobody committed/);
  assert.ok(existsSync(join(rel, 'notes.md')));
  assert.equal(git(rel, 'log', '--format=%s').trim(), 'root');
});

test('release refuses when the source has uncommitted changes or is not on main', (t) => {
  const { dir, src, rel } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(src, { 'README.md': 'edited\n' });
  let r = release(src, [rel, '-m', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /uncommitted changes/);
  git(src, 'checkout', '-q', '--', 'README.md');
  git(src, 'checkout', '-q', '-b', 'feature');
  r = release(src, [rel, '-m', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not on main/);
});

test('release refuses without a private name list', (t) => {
  const { dir, src, rel } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...ENV, RECADE_PRIVATE_NAMES: '', XDG_CONFIG_HOME: join(dir, 'empty-config') };
  const r = release(src, [rel, '-m', 'x'], env);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no private name list/);
});

test('release reads the private names from the config file when the variable is not set', (t) => {
  const { dir, src, rel } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  write(dir, { 'config/recade/private-names': '# names\nZorblax\n' });
  const r = release(src, [rel, '-m', 'x'], { ...ENV, RECADE_PRIVATE_NAMES: '', XDG_CONFIG_HOME: join(dir, 'config') });
  assert.equal(r.status, 0, r.stderr);
});

for (const [what, options, message] of [
  ['a failing test', { testFails: true }, /npm test failed/],
  ['a failing names check', { guardCode: 1 }, /names check failed/],
]) {
  test(`release commits nothing after ${what}`, (t) => {
    const { dir, src, rel } = setup(options);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = release(src, [rel, '-m', 'x']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, message);
    assert.equal(git(rel, 'log', '--format=%s').trim(), 'root');
  });
}

test('release keeps the commit local and says how to undo it when publish-check fails', (t) => {
  const { dir, src, rel } = setup({ publishCode: 1 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = release(src, [rel, '-m', 'x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /local only; undo it with git -C .* reset --hard HEAD~1/);
});

test('release asks for a commit message', (t) => {
  const { dir, src, rel } = setup();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = release(src, [rel]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage/);
});
