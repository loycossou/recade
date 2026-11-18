import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../../src/cli.js';
import { lintText } from '../../src/style/lint.js';
import { checkBash, decide, handleHook, matchGlob, parseTouches, parseWrites, resolveGlobs, rootOf } from '../../src/harness/guard.js';
import { linkRepo } from '../../src/workspace/layout.js';

const plugin = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const guardMjs = join(plugin, 'harness', 'hooks', 'guard.mjs');
const launcherMjs = join(plugin, 'harness', 'hooks', 'launcher.mjs');
const EM = '\u2014';

// Every git call carries its own identity: a merge needs one too, and a CI machine has none.
const gitRaw = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const git = (cwd, ...args) => {
  const r = gitRaw(cwd, ...args);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

function makeRepo(branch = 'main') {
  const repo = mkdtempSync(join(tmpdir(), 'recade-guard-'));
  git(repo, 'init', '-q', '-b', branch);
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'chore: start');
  return repo;
}

const hook = (repo, event, opts = {}) => handleHook(JSON.stringify({ cwd: repo, ...event }), { pluginRoot: plugin, ...opts });
const denied = (out) => {
  assert.notEqual(out, '', 'expected a deny');
  const j = JSON.parse(out);
  assert.equal(j.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(j.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(j.hookSpecificOutput.permissionDecisionReason.length > 0);
  return j.hookSpecificOutput.permissionDecisionReason;
};

test('matchGlob: ** crosses folders, * stays in one, a leading * matches at any depth', () => {
  assert.ok(matchGlob('tests/**', 'tests/a/b.js'));
  assert.ok(!matchGlob('tests/**', 'src/tests/a.js'));
  assert.ok(matchGlob('**/*.test.*', 'src/a/b.test.js'));
  assert.ok(matchGlob('**/*.test.*', 'b.test.js'));
  assert.ok(matchGlob('*.spec.*', 'deep/er/x.spec.ts'));
  assert.ok(matchGlob('**/__tests__/**', 'src/__tests__/x.js'));
  assert.ok(matchGlob('src/*.js', 'src/a.js'));
  assert.ok(!matchGlob('src/*.js', 'src/a/b.js'));
  assert.ok(matchGlob('Dockerfile', 'Dockerfile'));
  assert.ok(!matchGlob('Dockerfile', 'sub/Dockerfile'));
  assert.ok(matchGlob('src/api/', 'src/api/x.js'));
  assert.ok(matchGlob('docs/suivi/S-01.md', 'docs/suivi/S-01.md'));
  assert.ok(!matchGlob('docs/suivi/S-01.md', 'docs/suivi/S-011.md'));
});

test('parseWrites reads the backticked bullets, None, and a missing section', () => {
  assert.deepEqual(parseWrites('# x\n\n## Writes\n\n- `a/**`\n- `b.md`\n\n## Rules\n- `c`\n'), ['a/**', 'b.md']);
  assert.deepEqual(parseWrites('## Writes\n\nNone. This agent writes no file.\n\n## Rules\n'), []);
  assert.equal(parseWrites('## Rules\n- `x`\n'), null);
});

test('parseTouches reads block and inline lists, quoted or not', () => {
  assert.deepEqual(parseTouches('---\nid: S-01\ntouches:\n  - "src/a/**"\n  - lib/*.js # note\nnext: 1\n---\nbody\n- x\n'), ['src/a/**', 'lib/*.js']);
  assert.deepEqual(parseTouches('---\ntouches: [src/a/**, "b.md"]\n---\n'), ['src/a/**', 'b.md']);
  assert.equal(parseTouches('---\nid: x\n---\n'), null);
  assert.equal(parseTouches('no front matter'), null);
});

test('resolveGlobs fills the placeholders and reports what it cannot resolve', () => {
  const ctx = (o = {}) => ({ branch: () => 'slice/S-12-login', touches: () => ['src/login/**'], conflicted: () => ['a.js', 'b[1].js'], ...o });
  const globs = ['<touches>', 'docs/suivi/<S-nn>.md', '<conflicted-files>', 'x/**'];
  const ok = resolveGlobs(globs, ctx());
  assert.deepEqual(ok.globs, ['src/login/**', 'docs/suivi/S-12.md', 'a.js', 'b\\[1\\].js', 'x/**']);
  assert.deepEqual(ok.unresolved, []);
  assert.ok(matchGlob(ok.globs[3], 'b[1].js'));
  assert.ok(!matchGlob(ok.globs[3], 'b1.js'));
  const lower = resolveGlobs(['docs/<S-nn>.md'], ctx({ branch: () => 'slice/s-03a-x' }));
  assert.deepEqual(lower.globs, ['docs/S-03A.md']);
  const none = resolveGlobs(globs, ctx({ branch: () => 'main', conflicted: () => [] }));
  assert.deepEqual(none.globs, ['x/**']);
  assert.equal(none.unresolved.length, 3);
  const thrown = resolveGlobs(['<touches>'], ctx({ touches: () => { throw new Error('boom'); } }));
  assert.equal(thrown.unresolved.length, 1);
  const empty = resolveGlobs(['<touches>'], ctx({ touches: () => [] }));
  assert.match(empty.unresolved[0], /touches: list is empty/);
});

test('decide: no agent type means the deny list only (review focus 1)', () => {
  const write = decide({ agentType: null, tool: 'Write', input: { file_path: '/p/src/x.js' }, allow: null, root: '/p' });
  assert.equal(write.allow, true);
  assert.equal(decide({ tool: 'Edit', input: { file_path: '/p/src/x.js' }, allow: null, root: '/p' }).allow, true);
  assert.equal(decide({ tool: 'Read', input: { file_path: '/etc/passwd' }, allow: { globs: [], unresolved: [] }, root: '/p' }).allow, true);
  assert.equal(decide({ tool: 'Bash', input: { command: 'gh pr merge 4' }, allow: null }).allow, false);
});

test('decide: a known agent writing outside its globs is refused with the reason', () => {
  const allow = { globs: ['tests/**', '**/*.test.*'], unresolved: [] };
  const base = { agentType: 'test-engineer', tool: 'Write', allow, root: '/p' };
  assert.equal(decide({ ...base, input: { file_path: '/p/tests/a.js' } }).allow, true);
  assert.equal(decide({ ...base, input: { file_path: 'src/a.test.js' } }).allow, true);
  const no = decide({ ...base, input: { file_path: '/p/src/a.js' } });
  assert.equal(no.allow, false);
  assert.match(no.reason, /test-engineer may write tests\/\*\*, \*\*\/\*\.test\.\*, not src\/a\.js/);
  assert.equal(decide({ ...base, tool: 'Edit', input: { file_path: '/elsewhere/a.js' } }).allow, false);
  assert.equal(decide({ ...base, tool: 'NotebookEdit', input: { notebook_path: '/p/n.ipynb' } }).allow, false);
  assert.equal(decide({ ...base, input: { file_path: '/p/tests/../src/a.js' } }).allow, false);
  const none = decide({ agentType: 'explorer', tool: 'Write', input: { file_path: '/p/a' }, allow: { globs: [], unresolved: [] }, root: '/p' });
  assert.equal(none.allow, false);
  assert.match(none.reason, /no file/);
});

test('decide: an unresolved placeholder refuses with its reason, resolved globs still work', () => {
  const allow = { globs: ['docs/x.md'], unresolved: ['<touches> cannot be resolved: the branch is not slice/S-nn-...'] };
  assert.equal(decide({ agentType: 'reviewer', tool: 'Write', input: { file_path: '/p/docs/x.md' }, allow, root: '/p' }).allow, true);
  const no = decide({ agentType: 'reviewer', tool: 'Write', input: { file_path: '/p/src/a.js' }, allow, root: '/p' });
  assert.equal(no.allow, false);
  assert.match(no.reason, /<touches> cannot be resolved/);
});

test('decide: threshold files are refused for everyone', () => {
  const deny = { thresholdFiles: ['jest.config.js', 'config/coverage.json'] };
  assert.equal(decide({ tool: 'Edit', input: { file_path: '/p/jest.config.js' }, allow: null, deny, root: '/p' }).allow, false);
  assert.equal(decide({ tool: 'Write', input: { file_path: 'config/coverage.json' }, allow: null, deny, root: '/p' }).allow, false);
  assert.equal(decide({ tool: 'Write', input: { file_path: '/p/src/jest.config.js' }, allow: null, deny, root: '/p' }).allow, true);
  assert.match(checkBash('sed -i s/80/10/ jest.config.js', deny), /threshold/);
  assert.match(checkBash("echo 'x' > config/coverage.json", deny), /threshold/);
  assert.equal(checkBash('cat jest.config.js', deny), null);
});

test('checkBash: the deny list', () => {
  const refused = [
    'gh pr merge 12 --squash',
    'gh pr merge --auto',
    'gh api -X PUT repos/o/r/pulls/3/merge',
    'git push origin main',
    'git push -f origin HEAD:main',
    'git push origin :main',
    'git push origin refs/heads/master',
    'git push --all',
    'git push',
    'git push origin',
    'git push --mirror origin',
    'git commit -m "x" --no-verify',
    'git commit -nm "x"',
    'git push --no-verify origin slice/a',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git rm tests/a.test.js',
    'git rm -r e2e',
    'git rm src/a.spec.ts',
    'rm -rf tests/unit',
    'npm test && gh pr merge 3',
    'echo $(gh pr merge 3)',
    'bash -c "git push origin main"',
    'sudo git push origin main',
    'GIT_X=1 git push origin main',
  ];
  for (const c of refused) assert.ok(checkBash(c), `should refuse: ${c}`);
  const fine = [
    'git push -u origin slice/S-01-login',
    'git commit -m "docs: say that --no-verify is forbidden"',
    'git commit -am "feat: x"',
    'git log -n 5',
    'git rm src/old.js',
    'gh pr create --fill',
    'gh pr view 3',
    'git push --force-with-lease origin slice/S-02-x',
    'npm test',
    'ls tests',
    'cat tests/a.js | head',
    'git status',
  ];
  for (const c of fine) assert.equal(checkBash(c), null, `should allow: ${c}`);
  assert.ok(checkBash('git push origin HEAD', { currentBranch: 'main' }));
  assert.ok(checkBash('git push origin HEAD', { currentBranch: null }));
  assert.equal(checkBash('git push origin HEAD', { currentBranch: 'slice/S-01-x' }), null);
  assert.equal(checkBash('git push origin slice/x', { currentBranch: 'main' }), null);
  assert.ok(checkBash('git push', { currentBranch: 'slice/S-01-x' }), 'a bare push names no branch');
  assert.ok(checkBash('git merge slice/S-01-x', { currentBranch: 'main' }));
  assert.equal(checkBash('git merge main', { currentBranch: 'slice/S-01-x' }), null);
});

test('handleHook: no agent type writes freely, the deny list applies', async () => {
  const repo = makeRepo();
  assert.equal(await hook(repo, { tool_name: 'Write', tool_input: { file_path: join(repo, 'src', 'a.js') } }), '');
  denied(await hook(repo, { tool_name: 'Bash', tool_input: { command: 'gh pr merge 9' } }));
});

test('handleHook: a known agent writing outside its Writes is denied with the Claude Code JSON', async () => {
  const repo = makeRepo();
  const out = await hook(repo, { agent_type: 'test-engineer', tool_name: 'Write', tool_input: { file_path: join(repo, 'src', 'a.js') } });
  assert.match(denied(out), /test-engineer may write/);
  assert.equal(await hook(repo, { agent_type: 'test-engineer', tool_name: 'Write', tool_input: { file_path: join(repo, 'tests', 'a.test.js') } }), '');
  assert.equal(await hook(repo, { subagent_type: 'test-engineer', tool_name: 'Edit', tool_input: { file_path: join(repo, 'tests', 'a.test.js') } }), '');
  denied(await hook(repo, { subagent_type: 'test-engineer', tool_name: 'Edit', tool_input: { file_path: join(repo, 'src', 'b.js') } }));
  denied(await hook(repo, { agent_type: 'explorer', tool_name: 'Write', tool_input: { file_path: join(repo, 'x.md') } }));
  assert.equal(await hook(repo, { agent_type: 'recade:test-engineer', tool_name: 'Write', tool_input: { file_path: join(repo, 'tests', 'a.js') } }), '');
});

test('handleHook: an unknown agent is only held by the deny list', async () => {
  const repo = makeRepo();
  assert.equal(await hook(repo, { agent_type: 'general-purpose', tool_name: 'Write', tool_input: { file_path: join(repo, 'src', 'a.js') } }), '');
  assert.equal(await hook(repo, { agent_type: '../../etc/passwd', tool_name: 'Write', tool_input: { file_path: join(repo, 'a') } }), '');
  denied(await hook(repo, { agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'git push origin main' } }));
});

test('handleHook: the project copy of an agent file wins over the plugin copy', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'agents', 'doc-writer.md'), '---\nname: doc-writer\n---\n\n## Writes\n\n- `notes/**`\n');
  assert.equal(await hook(repo, { agent_type: 'doc-writer', tool_name: 'Write', tool_input: { file_path: join(repo, 'notes', 'a.md') } }), '');
  denied(await hook(repo, { agent_type: 'doc-writer', tool_name: 'Write', tool_input: { file_path: join(repo, 'docs', 'guides', 'a.md') } }));
});

test('handleHook: <S-nn> and <touches> resolve from the branch and the slice sheet', async () => {
  const repo = makeRepo('slice/S-07-login');
  mkdirSync(join(repo, 'slices'));
  writeFileSync(join(repo, 'slices', 'S-07-login.md'), '---\nid: S-07\ntouches:\n  - "src/login/**"\n---\n# S-07\n');
  const w = (agent, file) => hook(repo, { agent_type: agent, tool_name: 'Write', tool_input: { file_path: join(repo, file) } });
  assert.equal(await w('implementer', 'src/login/form.js'), '');
  // The tracking sheet and the journal live in the workspace (spec 6.14): docs/suivi of a code repository is refused.
  denied(await w('implementer', 'docs/suivi/S-07.md'));
  denied(await w('implementer', 'docs/suivi/S-07-journal.md'));
  denied(await w('implementer', 'src/other/x.js'));
  assert.equal(await w('reviewer', 'src/login/a.js'), '');
});

test('handleHook: an unresolved placeholder refuses the write with the reason (fail closed)', async () => {
  const onMain = makeRepo('main');
  const reason = denied(await hook(onMain, { agent_type: 'implementer', tool_name: 'Write', tool_input: { file_path: join(onMain, 'src', 'a.js') } }));
  assert.match(reason, /not slice\/S-nn/);
  const noSheet = makeRepo('slice/S-09-x');
  const r2 = denied(await hook(noSheet, { agent_type: 'reviewer', tool_name: 'Edit', tool_input: { file_path: join(noSheet, 'src', 'a.js') } }));
  assert.match(r2, /sheet of S-09 was not found/);
  denied(await hook(noSheet, { agent_type: 'merge-keeper', tool_name: 'Edit', tool_input: { file_path: join(noSheet, 'README.md') } }));
});

test('handleHook: merge-keeper may edit the conflicted files only', async () => {
  const repo = makeRepo('main');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'chore: a');
  git(repo, 'checkout', '-q', '-b', 'side');
  writeFileSync(join(repo, 'a.txt'), 'side\n');
  git(repo, 'commit', '-qam', 'chore: side');
  git(repo, 'checkout', '-q', 'main');
  writeFileSync(join(repo, 'a.txt'), 'main\n');
  git(repo, 'commit', '-qam', 'chore: main');
  gitRaw(repo, 'merge', 'side'); // stops on the conflict, which is what the test needs
  assert.match(git(repo, 'diff', '--name-only', '--diff-filter=U'), /a\.txt/);
  assert.equal(await hook(repo, { agent_type: 'merge-keeper', tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.txt') } }), '');
  denied(await hook(repo, { agent_type: 'merge-keeper', tool_name: 'Edit', tool_input: { file_path: join(repo, 'README.md') } }));
});

test('handleHook: threshold files from the state are refused for everyone', async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, 'recade'));
  writeFileSync(join(repo, 'recade', 'state.yaml'), 'version: 1\nharness:\n  threshold_files:\n    - jest.config.js\n');
  denied(await hook(repo, { tool_name: 'Write', tool_input: { file_path: join(repo, 'jest.config.js') } }));
  denied(await hook(repo, { tool_name: 'Bash', tool_input: { command: "sed -i 's/90/1/' jest.config.js" } }));
  assert.equal(await hook(repo, { tool_name: 'Write', tool_input: { file_path: join(repo, 'src', 'a.js') } }), '');
});

test('handleHook: a denial is logged to .recade/guard.log', async () => {
  const repo = makeRepo();
  await hook(repo, { tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } });
  assert.match(readFileSync(join(repo, '.recade', 'guard.log'), 'utf8'), /deny Bash/);
});

const runLauncher = (cwd, input, env = {}) =>
  spawnSync('node', [launcherMjs], { cwd, input, encoding: 'utf8', env: { ...process.env, RECADE_PLUGIN_ROOT: '', CLAUDE_PROJECT_DIR: cwd, ...env } });

const runMjs = (cwd, input, env = {}) =>
  spawnSync('node', [guardMjs], { cwd, input, encoding: 'utf8', env: { ...process.env, RECADE_PLUGIN_ROOT: plugin, ...env } });

test('guard.mjs prints the deny JSON for a refused call and nothing for an allowed one', () => {
  const repo = makeRepo();
  const bad = runMjs(repo, JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'git push origin main' } }));
  assert.equal(bad.status, 0);
  assert.equal(JSON.parse(bad.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const ok = runMjs(repo, JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'ls' } }));
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, '');
});

test('guard.mjs with a malformed stdin refuses the call (fail closed), exits 0 and logs', () => {
  const repo = makeRepo();
  for (const input of ['{not json', '', 'null', '[]']) {
    const r = runMjs(repo, input);
    assert.equal(r.status, 0, input);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', input);
  }
  assert.match(readFileSync(join(repo, '.recade', 'guard.log'), 'utf8'), /guard error, call refused/);
});

test('guard.mjs with a RECADE_PLUGIN_ROOT that has no decision code uses its own folder', () => {
  const repo = makeRepo();
  const r = runMjs(repo, JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } }), { RECADE_PLUGIN_ROOT: join(repo, 'missing') });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('recade guard reads the hook JSON from stdin', async () => {
  const repo = makeRepo();
  const out = [];
  const io = {
    cwd: repo,
    env: {},
    stdout: { write: (s) => out.push(s) },
    stderr: { write: () => {} },
    readStdin: async () => JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'gh pr merge 2' } }),
  };
  assert.equal(await run(['guard'], io), 0);
  assert.equal(JSON.parse(out.join('')).hookSpecificOutput.permissionDecision, 'deny');
  const out2 = [];
  assert.equal(await run(['guard'], { ...io, stdout: { write: (s) => out2.push(s) }, readStdin: async () => '{bad' }), 0);
  assert.deepEqual(out2, []);
  assert.equal(await run(['guard', 'x'], io), 2);
});

/* ---------- git hooks ---------- */

const hooksDir = join(plugin, 'harness', 'githooks');

test('git hooks are POSIX sh, executable, and tracked executable', () => {
  for (const name of ['pre-commit', 'commit-msg']) {
    const file = join(hooksDir, name);
    assert.match(readFileSync(file, 'utf8'), /^#!\/bin\/sh\n/);
    assert.ok(statSync(file).mode & 0o100, `${name} executable`);
    const staged = spawnSync('git', ['ls-files', '-s', '--', `harness/githooks/${name}`], { cwd: plugin, encoding: 'utf8' }).stdout;
    if (staged !== '') assert.match(staged, /^100755 /, `${name} tracked as 100755`);
    assert.equal(spawnSync('sh', ['-n', file]).status, 0, `${name} parses`);
  }
});

function commitMsg(text) {
  const dir = mkdtempSync(join(tmpdir(), 'recade-cm-'));
  const file = join(dir, 'MSG');
  writeFileSync(file, text);
  return spawnSync('sh', [join(hooksDir, 'commit-msg'), file], { encoding: 'utf8' });
}

test('commit-msg refuses an em dash and a non-conventional subject', () => {
  assert.equal(commitMsg('feat(harness): gate stamps\n').status, 0);
  assert.equal(commitMsg('fix!: drop the old flag\n\nbody text\n').status, 0);
  assert.equal(commitMsg('Merge branch x\n').status, 0);
  const dash = commitMsg(`feat: stamps ${EM} and hooks\n`);
  assert.equal(dash.status, 1);
  assert.match(dash.stderr, /em dash/);
  const body = commitMsg(`feat: stamps\n\nbody ${EM} here\n`);
  assert.equal(body.status, 1);
  const bad = commitMsg('added some stuff\n');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not conventional/);
  assert.equal(commitMsg('Feat: Capital\n').status, 1);
  assert.equal(commitMsg('feat:no space\n').status, 1);
  assert.equal(commitMsg('# comment only\n').status, 1);
});

function preCommitRepo() {
  const repo = makeRepo();
  mkdirSync(join(repo, 'recade'));
  writeFileSync(join(repo, 'recade', 'state.yaml'), 'version: 1\nharness:\n  required_gates: [tests]\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'chore: state');
  return repo;
}
const preCommit = (repo, env = {}) =>
  spawnSync('sh', [join(hooksDir, 'pre-commit')], { cwd: repo, encoding: 'utf8', env: { ...process.env, RECADE_PLUGIN_ROOT: plugin, ...env } });

test('pre-commit refuses style errors in staged files', () => {
  const repo = preCommitRepo();
  writeFileSync(join(repo, 'doc.md'), `a ${EM} b\n`);
  git(repo, 'add', 'doc.md');
  const r = preCommit(repo);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /em-dash/);
});

test('pre-commit refuses when a required gate has no green stamp for the tree, and passes once it has', async () => {
  const repo = preCommitRepo();
  writeFileSync(join(repo, 'ok.md'), 'fine text\n');
  git(repo, 'add', 'ok.md');
  const no = preCommit(repo);
  assert.equal(no.status, 1);
  assert.match(no.stdout, /tests: missing/);
  const io = { cwd: repo, env: {}, stdout: { write: () => {} }, stderr: { write: () => {} } };
  assert.equal(await run(['gate', 'run', 'tests', '--', 'node', '-e', '0'], io), 0);
  assert.equal(preCommit(repo).status, 0);
  writeFileSync(join(repo, 'ok.md'), 'changed text\n');
  git(repo, 'add', 'ok.md');
  const stale = preCommit(repo);
  assert.equal(stale.status, 1, 'stale after an edit');
  assert.match(stale.stdout, /tests: stale/);
});

test('pre-commit explains a missing plugin root', () => {
  const repo = preCommitRepo();
  const r = preCommit(repo, { RECADE_PLUGIN_ROOT: join(repo, 'nowhere') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /RECADE_PLUGIN_ROOT/);
});

/* ---------- settings ---------- */

test('settings.json: deny list, PreToolUse hook to the project launcher, no plugin path', () => {
  const text = readFileSync(join(plugin, 'harness', 'settings.json'), 'utf8');
  const settings = JSON.parse(text);
  assert.ok(settings.permissions.deny.includes('Bash(gh pr merge:*)'));
  assert.ok(settings.permissions.deny.some((d) => /^Bash\(git push .*main/.test(d)));
  assert.ok(settings.permissions.deny.some((d) => d.includes('--no-verify')));
  assert.equal(settings.env, undefined, 'no environment: a plugin path would be committed');
  assert.doesNotMatch(text, /RECADE_PLUGIN_ROOT/);
  const entry = settings.hooks.PreToolUse[0];
  assert.match(entry.matcher, /Write/);
  assert.match(entry.matcher, /Bash/);
  assert.match(entry.hooks[0].command, /^node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/recade-guard\.mjs" \|\| \{ .*exit 2; \}$/);
  assert.ok(existsSync(guardMjs));
  assert.ok(existsSync(launcherMjs));
});

test('the new harness files pass the style lint', () => {
  for (const f of ['src/harness/stamps.js', 'src/harness/guard.js', 'harness/hooks/guard.mjs', 'harness/githooks/pre-commit', 'harness/githooks/commit-msg', 'harness/settings.json']) {
    assert.deepEqual(lintText(readFileSync(join(plugin, f), 'utf8'), f), [], f);
  }
});

/* ---------- review fixes: bypasses ---------- */

test('gh: global flags in front of the subcommand do not hide a merge', () => {
  for (const c of [
    'gh -R o/r pr merge 3',
    'gh --repo o/r pr merge 3',
    'gh pr --repo a/b merge 3',
    'gh pr -R a/b merge --auto',
    'gh pr --repo=a/b merge 3',
    'gh pr -Ra/b merge 3',
    '/usr/bin/gh pr merge 3',
    'gh alias set m "pr merge"',
    'gh api -X PUT repos/o/r/pulls/3/merge',
    'gh api repos/o/r/merges -f base=main -f head=x',
    'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc',
    'gh api -X PATCH repos/o/r/git/refs/heads/%6Dain -f sha=abc',
    'gh api repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc',
    'gh api repos/o/r/pulls/3 --input body.json',
    'gh api repos/o/r/pulls/3 -F body=@body.json',
    'gh api graphql -f query="mutation { mergePullRequest(input:{pullRequestId:\\"x\\"}) { clientMutationId } }"',
    'gh api graphql -f query="mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }"',
    'gh api repos/o/r/pulls/$N/merge',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['gh -R o/r pr view 3', 'gh pr list --repo o/r', 'gh api repos/o/r/pulls/3', 'gh pr create --fill', 'gh -R o/r issue list']) {
    assert.equal(checkBash(c), null, `should allow: ${c}`);
  }
});

test('wrappers and nested shells do not hide a refused command', () => {
  for (const c of [
    'env -i gh pr merge 3',
    'env -u HOME gh pr merge 3',
    "env -S 'gh pr merge 3'",
    'env FOO=1 git push origin main',
    'sudo -u root git push origin main',
    'sudo -E -- git push origin main',
    'time -p git push origin main',
    'nice -n 5 git push origin main',
    'xargs -n 1 -I X git push origin main',
    'xargs -0 -r gh pr merge',
    'timeout 5 gh pr merge 3',
    'command git push origin main',
    'eval "gh pr merge 3"',
    "eval 'git push origin main'",
    'eval "$CMD"',
    'bash -c "gh pr merge 3"',
    "sh -lc 'git push origin main'",
    'bash -c "bash -c \'gh pr merge 3\'"',
    'zsh -c "git push origin main"',
    'find . -name x -exec git push origin main \;',
    'cat <<< "x"; bash <<< "gh pr merge 3"',
    'echo gh pr merge 3 | sh',
    'echo x | bash',
    'echo x | bash -s',
    'cmd=$(echo; gh pr merge 3)',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['env FOO=1 npm test', 'sudo npm test', 'time npm test', 'bash -c "npm test"', 'bash script.sh', 'echo sh', 'xargs -n 1 echo']) {
    assert.equal(checkBash(c), null, `should allow: ${c}`);
  }
});

test('the git hooks cannot be turned off, whatever the spelling', () => {
  for (const c of [
    'git -c core.hooksPath=/dev/null commit -m x',
    'git -c core.hookspath=/dev/null commit -m x',
    'git -c CORE.HOOKSPATH=/x commit -m x',
    'git config core.hooksPath /dev/null',
    'git config --local core.hooksPath x',
    'git --config-env=core.hooksPath=ENVVAR commit -m x',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x',
    'export GIT_CONFIG_PARAMETERS="core.hooksPath=/x"; git commit -m x',
    'GIT_CONFIG_GLOBAL=/tmp/cfg git commit -m x',
    'git commit -m x --no-verify',
    'git commit -m x --no-verif',
    'git commit -m x --no-ver',
    'git commit -m x --no-v',
    'git push --no-verif origin slice/a',
    'git merge --no-verify x',
    'git commit -m x -n',
    "git commit -m x -$'n'",
    "git commit -m x --$'no-verify'",
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['git commit -m "docs: mention core.hooksPath and --no-verify"', 'git commit --no-edit', 'git commit --amend --no-edit -m x', 'git config user.name ci']) {
    assert.equal(checkBash(c), null, `should allow: ${c}`);
  }
});

test('refs hidden by quoting, expansion or a chained checkout do not reach main', () => {
  for (const c of [
    "git push origin $'main'",
    "git push origin ma$'in'",
    'git push origin ma\\\nin',
    'git push origin "$BR"',
    'git push origin $(echo main)',
    'git push origin `echo main`',
    'git push origin {main,x}',
    'git push origin ma*',
    'git push origin [m]ain',
    'git push origin HEAD:refs/heads/ma?n',
    'git switch main && git push origin HEAD',
    'git checkout main; git push origin HEAD',
    'git push origin HEAD:main',
    'git push origin @:main',
    'git merge $BR',
    'git pull origin ma*',
    'git checkout main && git merge slice/S-01-x',
    'git switch master && git pull',
    'git push',
    'git push -u origin',
  ]) assert.ok(checkBash(c, { currentBranch: 'slice/S-01-x' }), `should refuse: ${c}`);
  for (const c of ['git push -u origin slice/S-01-x', 'git push origin slice/S-01-x:slice/S-01-x', 'git merge origin/main', 'git pull --rebase origin slice/S-01-x', 'git push origin HEAD']) {
    assert.equal(checkBash(c, { currentBranch: 'slice/S-01-x' }), null, `should allow: ${c}`);
  }
});

test('the tokenizer reads $-quotes and a backslash before a newline', async () => {
  const { tokenize } = await import('../../src/harness/guard.js');
  assert.deepEqual(tokenize("git push origin $'ma\\x69n'"), [['git', 'push', 'origin', 'main']]);
  assert.deepEqual(tokenize("echo $'a\\nb\\101'"), [['echo', 'a\nbA']]);
  assert.deepEqual(tokenize('git pu\\\nsh origin x'), [['git', 'push', 'origin', 'x']]);
  assert.deepEqual(tokenize('echo "a\\\nb"'), [['echo', 'ab']]);
});

test('decide: the stamps, the hooks, the settings and the harness state are protected for every agent', () => {
  const w = (file, tool = 'Write', input = {}) => decide({ tool, input: { file_path: file, ...input }, allow: null, root: '/p' });
  for (const f of ['/p/.recade/stamps.json', '/p/.recade/guard.log', '/p/.recade/plugin-root', '/p/.githooks/pre-commit', '/p/.git/hooks/pre-commit', '/p/.claude/settings.json', '/p/.claude/settings.local.json', '/home/me/.claude/settings.json', '/p/recade/state.yaml']) {
    assert.equal(w(f).allow, false, f);
  }
  assert.equal(w('/p/recade/state.yaml', 'Edit', { old_string: 'a: 1', new_string: 'required_gates: []' }).allow, false);
  assert.equal(w('/p/recade/state.yaml', 'MultiEdit', { edits: [{ old_string: 'a', new_string: 'harness:' }] }).allow, false);
  assert.equal(w('/p/recade/state.yaml', 'Edit', { old_string: 'phase: 1', new_string: 'phase: 2' }).allow, true);
  assert.equal(w('/p/src/a.js').allow, true);
  // Plan 5b: the agent and command files of the harness are protected too.
  assert.equal(w('/p/.claude/agents/x.md').allow, false);
  assert.equal(w('/p/.claude/protocol.md').allow, true);
  for (const c of ['echo {} > .recade/stamps.json', 'rm -rf .recade', "sed -i 's/1/0/' .claude/settings.json", 'cp x .githooks/pre-commit', 'echo x >> recade/state.yaml', 'chmod -x .githooks/pre-commit']) {
    assert.ok(checkBash(c), `should refuse: ${c}`);
  }
  for (const c of ['cat .recade/stamps.json', 'ls .githooks', 'node bin/recade.js gate run tests -- npm test', 'tail .recade/guard.log']) {
    assert.equal(checkBash(c), null, `should allow: ${c}`);
  }
});

test('handleHook: threshold_files that cannot be read refuse every write; readable ones are parsed without yaml', async () => {
  const { readThresholdFiles } = await import('../../src/harness/guard.js');
  assert.deepEqual(readThresholdFiles('harness:\n  threshold_files:\n    - a.json # x\n    - "b/c.js"\n  other: 1\n'), { files: ['a.json', 'b/c.js'], error: false });
  assert.deepEqual(readThresholdFiles('harness:\n  threshold_files: [a.json, "b.js"]\n'), { files: ['a.json', 'b.js'], error: false });
  assert.deepEqual(readThresholdFiles('harness:\n  threshold_files: []\n'), { files: [], error: false });
  assert.deepEqual(readThresholdFiles('phase: 1\n'), { files: [], error: false });
  assert.equal(readThresholdFiles('harness: {threshold_files: [a]}\n').error, true);
  assert.equal(readThresholdFiles('harness:\n  threshold_files: a.json\n').error, true);
  const repo = makeRepo();
  mkdirSync(join(repo, 'recade'));
  writeFileSync(join(repo, 'recade', 'state.yaml'), 'harness: {threshold_files: [jest.config.js]}\n');
  denied(await hook(repo, { tool_name: 'Write', tool_input: { file_path: join(repo, 'src', 'a.js') } }));
  writeFileSync(join(repo, 'recade', 'state.yaml'), 'harness:\n  threshold_files:\n    - jest.config.js\n');
  denied(await hook(repo, { tool_name: 'Write', tool_input: { file_path: join(repo, 'jest.config.js') } }));
});

test('decide: a shell write refusal names the agent and lists its Writes', () => {
  const allow = { globs: ['docs/guides/**', 'notes.md'], unresolved: [] };
  const no = decide({ agentType: 'doc-writer', tool: 'Bash', input: { command: 'echo x > src/a.js' }, allow, root: '/p' });
  assert.equal(no.allow, false);
  assert.match(no.reason, /doc-writer/);
  assert.match(no.reason, /docs\/guides\/\*\*, notes\.md/);
  assert.match(no.reason, /src\/a\.js is not among them/);
  const none = decide({ agentType: 'explorer', tool: 'Bash', input: { command: 'echo x > a.txt' }, allow: { globs: [], unresolved: [] }, root: '/p' });
  assert.match(none.reason, /explorer/);
  assert.match(none.reason, /no file/);
});

test('guard: a shell write refusal in a workspace session names the agent and lists its Writes', async () => {
  const { wt } = makeWorkspace();
  const out = await hook(wt.api, { agent_type: 'implementer', tool_name: 'Bash', tool_input: { command: 'echo x > docs/a.md' } });
  assert.match(denied(out), /implementer/);
  assert.match(denied(out), /src\/\*\*/);
  assert.match(denied(out), /docs\/a\.md is not among them/);
});

test('decide: a known agent cannot write outside its Writes through the shell', () => {
  const allow = { globs: ['docs/guides/**', 'notes.md'], unresolved: [] };
  const sh = (command) => decide({ agentType: 'doc-writer', tool: 'Bash', input: { command }, allow, root: '/p' });
  for (const c of [
    'echo x > src/a.js',
    'echo x >src/a.js',
    'echo x >> src/a.js',
    'echo x 1>src/a.js',
    'cat a | tee src/a.js',
    'cat a | tee -a docs/guides/x.md src/b.js',
    "sed -i 's/a/b/' src/a.js",
    "sed -i.bak -e 's/a/b/' src/a.js",
    "sed -Ei 's/a/b/' src/a.js",
    "perl -pi -e 's/a/b/' src/a.js",
    'sed --in-place s/a/b/ src/a.js',
    'cp a.txt src/a.txt',
    'mv docs/guides/a.md src/a.md',
    'cp -t src a.txt',
    'cp a.txt .',
    'git apply fix.patch',
    'patch -p1 < fix.diff',
    'echo x > "$OUT"',
    'echo x > ~/f',
    'dd if=a of=src/a.js',
    'truncate -s 0 src/a.js',
  ]) assert.equal(sh(c).allow, false, `should refuse: ${c}`);
  for (const c of [
    'echo x > docs/guides/a.md',
    'echo x > notes.md',
    'npm test 2>&1',
    'npm test > /dev/null 2>&1',
    'npm test 2>/dev/null',
    'cat a | tee docs/guides/x.md',
    "sed -i 's/a/b/' docs/guides/a.md",
    'cp a.txt docs/guides/',
    'cp a.txt /tmp/a.txt',
    'echo x > /tmp/out',
    'grep a src/a.js',
    'ls > /dev/null',
  ]) assert.equal(sh(c).allow, true, `should allow: ${c}`);
  assert.equal(decide({ tool: 'Bash', input: { command: 'echo x > src/a.js' }, allow: null, root: '/p' }).allow, true, 'no agent type: deny list only');
  assert.match(sh('echo x > src/a.js').reason, /not among them/);
  assert.equal(decide({ agentType: 'explorer', tool: 'Bash', input: { command: 'echo x > a.txt' }, allow: { globs: [], unresolved: [] }, root: '/p' }).allow, false);
});

test('handleHook: the shell guard for a known agent runs through the hook', async () => {
  const repo = makeRepo();
  denied(await hook(repo, { agent_type: 'doc-writer', tool_name: 'Bash', tool_input: { command: 'echo x > src/a.js' } }));
  assert.equal(await hook(repo, { agent_type: 'doc-writer', tool_name: 'Bash', tool_input: { command: 'echo x > docs/guides/a.md' } }), '');
  assert.equal(await hook(repo, { tool_name: 'Bash', tool_input: { command: 'echo x > src/a.js' } }), '');
});

test('hooks find the plugin root from .recade/plugin-root, also from another worktree', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.recade'));
  writeFileSync(join(repo, '.recade', 'plugin-root'), `${plugin}\n`);
  const event = (cwd) => JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } });
  const a = runLauncher(repo, event(repo));
  assert.equal(JSON.parse(a.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const wt = join(mkdtempSync(join(tmpdir(), 'recade-wt-')), 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'slice/S-01-x', wt);
  const b = runLauncher(wt, event(wt), { CLAUDE_PROJECT_DIR: wt });
  assert.equal(JSON.parse(b.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(runLauncher(wt, JSON.stringify({ cwd: wt, tool_name: 'Bash', tool_input: { command: 'ls' } }), { CLAUDE_PROJECT_DIR: wt }).stdout, '');
  writeFileSync(join(wt, 'ok.md'), 'fine\n');
  git(wt, 'add', 'ok.md');
  const pc = spawnSync('sh', [join(hooksDir, 'pre-commit')], { cwd: wt, encoding: 'utf8', env: { ...process.env, RECADE_PLUGIN_ROOT: '' } });
  assert.equal(pc.status, 0, pc.stderr + pc.stdout);
  const none = spawnSync('sh', [join(hooksDir, 'pre-commit')], { cwd: makeRepo(), encoding: 'utf8', env: { ...process.env, RECADE_PLUGIN_ROOT: '' } });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /plugin-root/);
});

test('pre-commit refuses a file that is staged and changed again after staging', async () => {
  const repo = preCommitRepo();
  const io = { cwd: repo, env: {}, stdout: { write: () => {} }, stderr: { write: () => {} } };
  writeFileSync(join(repo, 'ok.md'), 'first\n');
  git(repo, 'add', 'ok.md');
  writeFileSync(join(repo, 'ok.md'), 'second\n');
  await run(['gate', 'run', 'tests', '--', 'node', '-e', '0'], io);
  const r = preCommit(repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /staged and changed again/);
  assert.match(r.stderr, /ok\.md/);
  git(repo, 'add', 'ok.md');
  assert.equal(preCommit(repo).status, 1, 'staging changed the porcelain lines: the stamp is stale');
  await run(['gate', 'run', 'tests', '--', 'node', '-e', '0'], io);
  assert.equal(preCommit(repo).status, 0);
});

/* ---------- heredoc messages, hooks wording, plugin-root fallback ---------- */

test('a heredoc commit message or PR body that mentions forbidden commands is text, not a command', () => {
  const msg = (body, delim = "'EOF'", end = 'EOF') => `git commit -m "$(cat <<${delim}\n${body}\n${end}\n)"`;
  const text = 'fix: explain that `git push origin main` and gh pr merge 3 and --no-verify are refused\n\nbody with "quotes" and it\'s odd\ngit push origin main';
  for (const c of [
    msg(text),
    msg(text, '"EOF"'),
    msg(text, '\\EOF'),
    msg(text.replaceAll('`', ''), '-EOF', 'EOF'),
    `gh pr create --title "feat: x" --body "$(cat <<'EOF'\n${text}\nEOF\n)"`,
    `git commit -F - <<'EOF'\n${text}\nEOF`,
    `cat > notes.md <<'EOF'\n${text}\nEOF\ngit add notes.md`,
    `git commit -m "$(cat <<'MSG'\n${text}\nMSG\n)" && git push -u origin slice/S-01-x`,
    `echo "git push origin main"`,
    `gh pr create --body "never run gh pr merge or git push origin main"`,
  ]) assert.equal(checkBash(c, { currentBranch: 'slice/S-01-x' }), null, `should allow: ${c}`);
});

test('a substitution that runs is still scanned, in a message flag or bare, and an unquoted heredoc runs its substitutions', () => {
  for (const c of [
    '$(git push origin main)',
    'git commit -m "$(git push origin main)"',
    'git commit -m "$(gh pr merge 3)"',
    'gh pr create --body "$(gh pr merge 3)"',
    'git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)$(git push origin main)"',
    'cat <<EOF\n$(git push origin main)\nEOF',
    'cat <<EOF\n`gh pr merge 3`\nEOF',
    "bash <<'EOF'\ngit push origin main\nEOF",
    "cat <<'EOF' | sh\ngit push origin main\nEOF",
    "cat <<'EOF'\nharmless\nEOF\ngit push origin main",
    "cat <<'EOF'\nharmless\nEOF\n$(gh pr merge 3)",
  ]) assert.ok(checkBash(c, { currentBranch: 'slice/S-01-x' }), `should refuse: ${c}`);
});

test('core.hooksPath is only a bypass next to git: grep and echo may name it', () => {
  for (const c of ['grep -rn hooksPath .', 'echo core.hooksPath', 'cat .githooks/pre-commit | grep -i hookspath', 'grep GIT_CONFIG env.txt']) {
    assert.equal(checkBash(c), null, `should allow: ${c}`);
  }
  for (const c of ['git config core.hooksPath x', 'GIT_CONFIG_COUNT=1 git status', 'echo core.hooksPath | xargs git config', 'git -c core.hooksPath=x log']) {
    assert.ok(checkBash(c), `should refuse: ${c}`);
  }
});

test('guard.mjs falls back to its own folder when .recade/plugin-root points nowhere', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.recade'));
  writeFileSync(join(repo, '.recade', 'plugin-root'), `${join(repo, 'gone')}\n`);
  const r = runMjs(repo, JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } }), { RECADE_PLUGIN_ROOT: '' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

/* ---------- fix wave: refs, gh api writes, .recade ---------- */

test('a push to main is refused whatever the spelling of the ref: heads/, refs/heads/, a leading +', () => {
  for (const c of [
    'git push origin HEAD:heads/main',
    'git push origin heads/main',
    'git push origin x:heads/master',
    'git push origin +x:refs/heads/main',
    'git push origin +main',
    'git push origin slice/S-01-x:refs/heads/master',
  ]) assert.ok(checkBash(c, { currentBranch: 'slice/S-01-x' }), `should refuse: ${c}`);
  for (const c of ['git push origin slice/S-01-x:heads/slice/S-01-x', 'git push origin x:refs/heads/mainline', 'git push origin heads/maint']) {
    assert.equal(checkBash(c, { currentBranch: 'slice/S-01-x' }), null, `should allow: ${c}`);
  }
});

test('gh api with a write method on contents, protection, merges or refs is refused', () => {
  for (const c of [
    'gh api -X PUT repos/o/r/contents/src/a.js -f message=x -f content=eA==',
    'gh api --method DELETE repos/o/r/contents/a.txt',
    'gh api --method=PUT repos/o/r/branches/main/protection',
    'gh api -XDELETE repos/o/r/branches/main/protection',
    'gh api -X POST repos/o/r/git/refs',
    'gh api -X PATCH repos/o/r/git/refs/heads/slice/x',
    'gh api repos/o/r/contents/a.txt -f message=x',
    'gh api repos/o/r/contents/a.txt -F content=@a.txt',
    'gh api repos/o/r/branches/main/protection/required_status_checks -F strict=false',
    'gh api repos/o/r/git/refs/heads/x --field sha=abc',
    'gh api -X post repos/o/r/merges',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of [
    'gh api repos/o/r/contents/README.md',
    'gh api -X GET repos/o/r/contents/README.md',
    'gh api repos/o/r/branches/main/protection',
    'gh api -X GET repos/o/r/git/refs -f per_page=5',
    'gh api repos/o/r/issues/3/comments -f body=hello',
  ]) assert.equal(checkBash(c), null, `should allow: ${c}`);
});

test('decide: only the stamps, the guard log and the plugin root are protected under .recade/', () => {
  const w = (file) => decide({ tool: 'Write', input: { file_path: file, content: 'x' }, allow: null, root: '/p' }).allow;
  for (const f of ['/p/.recade/stamps.json', '/p/.recade/stamps', '/p/.recade/stamps/tests.json', '/p/.recade/guard.log', '/p/.recade/plugin-root']) assert.equal(w(f), false, f);
  for (const f of ['/p/.recade/slices/S-01/progress.md', '/p/.recade/second-opinion-12.md']) assert.equal(w(f), true, f);
  // The shell keeps the broad refusal: only Write and Edit may touch the rest of .recade/.
  for (const c of ['echo x > .recade/slices/S-01/progress.md', 'cp a.md .recade/second-opinion-12.md', 'cp a .recade//stamps.json']) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['echo {} > .recade/stamps.json', 'rm -rf .recade', 'echo x >> .recade/guard.log', 'echo /x > .recade/plugin-root', 'rm .recade/*']) assert.ok(checkBash(c), `should refuse: ${c}`);
});

test('decide: .git/info/exclude may be edited, the git hooks and the hook launcher may not', () => {
  const w = (file) => decide({ tool: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' }, allow: null, root: '/p' }).allow;
  assert.equal(w('/p/.git/info/exclude'), true);
  assert.equal(w('/p/.git/hooks/pre-commit'), false);
  assert.equal(w('/p/.git/config'), false);
  assert.equal(w('/p/.claude/hooks/recade-guard.mjs'), false);
  assert.ok(checkBash("sed -i 's/a/b/' .claude/hooks/recade-guard.mjs"));
});

test('handleHook: a write resolves the repository, branch and conflicts from the target, not from the session folder', async () => {
  const home = makeRepo('main');
  writeFileSync(join(home, 'a.txt'), 'base\n');
  git(home, 'add', '.');
  git(home, 'commit', '-q', '-m', 'chore: a');
  git(home, 'branch', 'side');
  writeFileSync(join(home, 'a.txt'), 'main\n');
  git(home, 'commit', '-qam', 'chore: main');
  const merge = join(home, '.claude', 'worktrees', 'merge-7');
  git(home, 'worktree', 'add', '-q', merge, 'side');
  writeFileSync(join(merge, 'a.txt'), 'side\n');
  git(merge, 'commit', '-qam', 'chore: side');
  gitRaw(merge, 'merge', 'main'); // stops on the conflict, which is what the test needs
  assert.match(git(merge, 'diff', '--name-only', '--diff-filter=U'), /a\.txt/);
  // The session stays on the main checkout, where nothing conflicts.
  assert.equal(await hook(home, { agent_type: 'merge-keeper', tool_name: 'Edit', tool_input: { file_path: join(merge, 'a.txt') } }), '');
  denied(await hook(home, { agent_type: 'merge-keeper', tool_name: 'Edit', tool_input: { file_path: join(merge, 'README.md') } }));
  denied(await hook(home, { agent_type: 'merge-keeper', tool_name: 'Edit', tool_input: { file_path: join(home, 'a.txt') } }));

  // /design in a slice worktree: <S-nn> comes from the branch of the worktree the file is in, even for a new folder.
  // This project is not a workspace, so the `workspace:` prefix of the real agent means nothing here: the agent file of the project drops it.
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(home, '.claude', 'agents', 'ui-designer.md'), readFileSync(join(plugin, 'harness', 'agents', 'ui-designer.md'), 'utf8').replaceAll('`workspace:', '`'));
  git(home, 'add', '.claude/agents/ui-designer.md');
  git(home, 'commit', '-q', '-m', 'chore: agent');
  const slice = join(home, '.claude', 'worktrees', 'S-03');
  git(home, 'worktree', 'add', '-q', '-b', 'slice/S-03-pay', slice, 'main');
  assert.equal(await hook(home, { agent_type: 'ui-designer', tool_name: 'Write', tool_input: { file_path: join(slice, 'design', 'ui', 'S-03', 'deep', 'pay.md'), content: 'x' } }), '');
  denied(await hook(home, { agent_type: 'ui-designer', tool_name: 'Write', tool_input: { file_path: join(slice, 'design', 'ui', 'S-04', 'pay.md'), content: 'x' } }));
  denied(await hook(home, { agent_type: 'ui-designer', tool_name: 'Write', tool_input: { file_path: join(home, 'design', 'ui', 'S-03', 'pay.md'), content: 'x' } }));
  // The fixed protections follow the worktree too.
  denied(await hook(home, { tool_name: 'Write', tool_input: { file_path: join(slice, '.recade', 'stamps.json'), content: '{}' } }));
});

test('the launcher fails closed when the plugin folder is unknown or stale: writes and Bash refused, reinstall allowed', () => {
  const repo = makeRepo();
  const ev = (tool, input) => JSON.stringify({ cwd: repo, tool_name: tool, tool_input: input });
  const deny = (r) => {
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(j.permissionDecision, 'deny');
    assert.match(j.permissionDecisionReason, /\/recade:harness/);
  };
  for (const setup of [() => {}, () => {
    mkdirSync(join(repo, '.recade'), { recursive: true });
    writeFileSync(join(repo, '.recade', 'plugin-root'), `${join(repo, 'gone')}\n`);
  }]) {
    setup();
    deny(runLauncher(repo, ev('Write', { file_path: join(repo, 'a.js'), content: 'x' })));
    deny(runLauncher(repo, ev('Edit', { file_path: join(repo, 'a.js'), old_string: 'a', new_string: 'b' })));
    deny(runLauncher(repo, ev('Bash', { command: 'ls' })));
    deny(runLauncher(repo, ev('Bash', { command: 'node "/x/bin/recade.js" harness install; rm -rf src' })));
    deny(runLauncher(repo, ev('Bash', { command: 'node "$(evil)/bin/recade.js" version' })));
    deny(runLauncher(repo, '{not json'));
    assert.equal(runLauncher(repo, ev('Read', { file_path: join(repo, 'a.js') })).stdout, '');
    assert.equal(runLauncher(repo, ev('Grep', { pattern: 'x' })).stdout, '');
    for (const c of [
      `node "${plugin}/bin/recade.js" harness install --project '/home/x/app'`,
      `node "${plugin}/bin/recade.js" version`,
      `node "${plugin}/bin/recade.js" state show --project '/p'`,
      `node ${plugin}/bin/recade.js harness verify --project '/p'`,
      `npm ci --omit=dev --prefix "${plugin}"`,
      `node "${plugin}/bin/recade.js" harness install --ref v1.2.3 --force --project '/p'`,
      `node "${plugin}/bin/recade.js" harness verify --json --project /p`,
      `node "${plugin}/bin/recade.js" state can-start --json`,
      `\tnode "${plugin}/bin/recade.js"\tversion `,
      "git -C '/p' rev-parse --show-toplevel",
      `node "${plugin}/bin/recade.js" harness install --target workspace --project '/p'`,
      `node "${plugin}/bin/recade.js" harness install --target code --repo api --ref v1.2.3 --project '/p'`,
      `node "${plugin}/bin/recade.js" harness verify --target code --repo web-app --json --project /p`,
      `node "${plugin}/bin/recade.js" harness verify --target workspace`,
    ]) assert.equal(runLauncher(repo, ev('Bash', { command: c })).stdout, '', c);
    for (const c of reinstallBypasses(repo)) deny(runLauncher(repo, ev('Bash', { command: c })));
  }
});

/** Commands that look like a reinstall and would run other code. Each one must be refused while the guard is down. */
function reinstallBypasses(repo) {
  const fake = (name, files) => {
    const dir = mkdtempSync(join(tmpdir(), `recade-${name}-`));
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), text);
    }
    return dir;
  };
  const noGuard = fake('noguard', { 'bin/recade.js': '', 'package.json': '{"name":"recade"}' });
  const otherName = fake('other', { 'bin/recade.js': '', 'harness/hooks/guard.mjs': '', 'package.json': '{"name":"evil"}' });
  mkdirSync(join(repo, 'evil', 'bin'), { recursive: true });
  return [
    `node "--eval=require('child_process').execSync('id')//bin/recade.js" version`,
    'node -r/any/bin/recade.js version',
    'node ./evil/bin/recade.js version',
    'node evil/bin/recade.js version',
    'node "/opt/recade/bin/recade.js" version',
    `node ${plugin}\\/bin/recade.js version`,
    `node "${plugin}\\/bin/recade.js" version`,
    'node "${CLAUDE_PLUGIN_ROOT}/bin/recade.js" version',
    `node "${noGuard}/bin/recade.js" version`,
    `node "${otherName}/bin/recade.js" version`,
    `node "${plugin}/bin/recade.js" version; id`,
    `node "${plugin}/bin/recade.js" gate run x -- id`,
    'npm ci --omit=dev --prefix .',
    'npm ci --omit=dev --prefix ./evil',
    `npm ci --omit=dev --prefix "${otherName}"`,
    'npm ci --omit=dev --prefix "${CLAUDE_PLUGIN_ROOT}"',
    `node "${plugin}/bin/recade.js" version\nid`,
    `node "${plugin}/bin/recade.js" version\rid`,
    `node "${plugin}/bin/recade.js" harness install\nrm -rf src`,
    `npm ci --omit=dev --prefix "${plugin}"\nid`,
    "git rev-parse --show-toplevel\nid",
    `node "${plugin}/bin/recade.js"\nversion`,
    `node "${plugin}/bin/recade.js" version extra`,
    `node "${plugin}/bin/recade.js" harness install --project rel`,
    `node "${plugin}/bin/recade.js" harness install --ref`,
    `node "${plugin}/bin/recade.js" harness install --eval x`,
    `node "${plugin}/bin/recade.js" harness verify --force`,
    `node "${plugin}/bin/recade.js" state show --project /p /q`,
    `node "${plugin}/bin/recade.js" state can-start S-01`,
    `node "${plugin}/bin/recade.js" harness install --target both --project '/p'`,
    `node "${plugin}/bin/recade.js" harness install --target`,
    `node "${plugin}/bin/recade.js" harness verify --target Code`,
    `node "${plugin}/bin/recade.js" harness install --target code --repo ../web`,
    `node "${plugin}/bin/recade.js" harness install --target code --repo 'my web'`,
    `node "${plugin}/bin/recade.js" harness install --target code --repo Web`,
    `node "${plugin}/bin/recade.js" harness install --target code --target workspace`,
    `node "${plugin}/bin/recade.js" harness verify --repo api --repo web --target code`,
    `node "${plugin}/bin/recade.js" harness install --project /p --project /q`,
    `node "${plugin}/bin/recade.js" state show --target code`,
    `node "${plugin}/bin/recade.js" harness install --target code --repo api\nid`,
  ];
}

test('the launcher fails closed when the guard of the plugin cannot load', () => {
  const repo = makeRepo();
  const broken = mkdtempSync(join(tmpdir(), 'recade-broken-'));
  mkdirSync(join(broken, 'harness', 'hooks'), { recursive: true });
  writeFileSync(join(broken, 'harness', 'hooks', 'guard.mjs'), 'export async function runGuard() { throw new Error("broken"); }\n');
  mkdirSync(join(repo, '.recade'));
  writeFileSync(join(repo, '.recade', 'plugin-root'), `${broken}\n`);
  const r = runLauncher(repo, JSON.stringify({ cwd: repo, tool_name: 'Write', tool_input: { file_path: join(repo, 'a.js'), content: 'x' } }));
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /broken/);
});

test('the hook command of the settings blocks with exit 2 when the launcher is missing, and runs it when present', () => {
  const repo = makeRepo();
  const command = JSON.parse(readFileSync(join(plugin, 'harness', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].command;
  const sh = () => spawnSync('sh', ['-c', command], { cwd: repo, input: JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
  const missing = sh();
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /launcher/);
  mkdirSync(join(repo, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(repo, '.claude', 'hooks', 'recade-guard.mjs'), readFileSync(launcherMjs, 'utf8'));
  mkdirSync(join(repo, '.recade'));
  writeFileSync(join(repo, '.recade', 'plugin-root'), `${plugin}\n`);
  const present = sh();
  assert.equal(present.status, 0, present.stderr);
  assert.equal(JSON.parse(present.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

/* ---------- re-review: nested repositories, symlinks ---------- */

test('handleHook: a nested git init does not unlock the protected files, and another repository is outside the project', async () => {
  for (const nested of ['.claude', 'recade', 'tests']) {
    const repo = makeRepo();
    mkdirSync(join(repo, nested), { recursive: true });
    git(join(repo, nested), 'init', '-q');
    denied(await hook(repo, { tool_name: 'Write', tool_input: { file_path: join(repo, '.claude', 'settings.json'), content: '{}' } }));
    denied(await hook(repo, { tool_name: 'Write', tool_input: { file_path: join(repo, 'recade', 'state.yaml'), content: 'x' } }));
    denied(await hook(repo, { agent_type: 'implementer', tool_name: 'Write', tool_input: { file_path: join(repo, 'tests', 'a.test.js'), content: 'x' } }));
  }
  const repo = makeRepo();
  const other = makeRepo('slice/S-01-x');
  const reason = denied(await hook(repo, { agent_type: 'doc-writer', tool_name: 'Write', tool_input: { file_path: join(other, 'docs', 'guides', 'a.md'), content: 'x' } }));
  assert.match(reason, /outside/);
});

test('the shell refuses git init, which would hide files of the project behind another repository', () => {
  for (const c of ['git init .claude', 'git init', 'cd tests && git init', 'git -C recade init']) assert.ok(checkBash(c), `should refuse: ${c}`);
});

test('decide: a symlink does not hide a protected file', () => {
  const repo = makeRepo();
  mkdirSync(join(repo, '.recade'));
  writeFileSync(join(repo, '.recade', 'stamps.json'), '{}');
  symlinkSync(join(repo, '.recade'), join(repo, 'link'));
  symlinkSync(join(repo, '.recade', 'stamps.json'), join(repo, 'stamps.json'));
  mkdirSync(join(repo, '.githooks'));
  symlinkSync(join(repo, '.githooks'), join(repo, 'hooks-link'));
  const w = (file) => decide({ tool: 'Write', input: { file_path: file, content: 'x' }, allow: null, root: repo }).allow;
  assert.equal(w(join(repo, 'link', 'stamps.json')), false);
  assert.equal(w(join(repo, 'stamps.json')), false);
  assert.equal(w(join(repo, 'hooks-link', 'new', 'pre-commit')), false);
  assert.equal(w(join(repo, 'src', 'a.js')), true);
});

test('the shell cannot reach the hook launcher through // or /./ or a glob', () => {
  for (const c of [
    "sed -i 's/a/b/' .claude//hooks/recade-guard.mjs",
    'cp x .claude/./hooks/recade-guard.mjs',
    'cp x .claude/hoo*/recade-guard.mjs',
    'cp x .cl*/hooks/r*',
    'rm -rf .claude/h?oks',
    'echo > .claude/[h]ooks/recade-guard.mjs',
    'rm -rf .cl*',
    'mv x /abs/proj/.claude/hooks/recade-guard.mjs',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  // Plan 5b: .claude/agents/ is protected now, so the copies into it moved to the refused side.
  for (const c of ['cp a .claude/agents/x.md', 'cp a .claude/agents/*.md']) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['cat .claude/hooks/recade-guard.mjs', 'cp a .claude/notes/x.md', 'cp a .claude/notes/*.md', 'ls .claude/*']) assert.equal(checkBash(c), null, `should allow: ${c}`);
});

test('gh api: rulesets writes and graphql mutations are refused', () => {
  for (const c of [
    'gh api -X POST repos/o/r/rulesets -f name=x',
    'gh api -X DELETE repos/o/r/rulesets/12',
    'gh api --method PUT orgs/o/rulesets/3 -f enforcement=disabled',
    'gh api graphql -f query="mutation { deleteBranchProtectionRule(input:{}) { clientMutationId } }"',
    'gh api graphql -f query=\'MUTATION{updateRef(input:{}){clientMutationId}}\'',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['gh api repos/o/r/rulesets', 'gh api graphql -f query="query { viewer { login } }"']) assert.equal(checkBash(c), null, `should allow: ${c}`);
});

test('rm of a test file is refused when git tracks it; an untracked red test may be set aside', async () => {
  assert.ok(checkBash('rm tests/new.test.js'), 'without git, every test path is protected');
  assert.equal(checkBash('rm tests/new.test.js', { isTracked: () => false }), null);
  assert.ok(checkBash('rm tests/old.test.js', { isTracked: (p) => p === 'tests/old.test.js' }));
  const repo = makeRepo();
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, 'tests', 'old.test.js'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'test: old');
  writeFileSync(join(repo, 'tests', 'new.test.js'), 'x');
  assert.equal(await hook(repo, { tool_name: 'Bash', tool_input: { command: 'rm tests/new.test.js' } }), '');
  denied(await hook(repo, { tool_name: 'Bash', tool_input: { command: 'rm tests/old.test.js' } }));
  denied(await hook(repo, { tool_name: 'Bash', tool_input: { command: 'rm -rf tests' } }));
  denied(await hook(repo, { tool_name: 'Bash', tool_input: { command: 'rm tests/*.js' } }));
});

test('the shell cannot write the hook launcher from an interpreter string or an assignment', () => {
  for (const c of [
    'node -e "require(\\"fs\\").writeFileSync(\\".claude/hooks/recade-guard.mjs\\",\\"\\")"',
    'python3 -c \'open(".claude/hooks/recade-guard.mjs","w")\'',
    'tee=.claude/hooks/x',
    'node -e "require(\'fs\').rmSync(\'.claude//hooks\',{recursive:true})"',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
});

test('rm of a test path after a change of folder counts as tracked', () => {
  const untracked = { isTracked: () => false };
  for (const c of [
    'cd src && rm sub/a.test.js',
    'cd src/sub && rm a.test.js',
    'pushd src; rm a.test.js; popd',
    'popd && rm a.test.js',
    'git -C src status && rm tests/a.test.js',
  ]) assert.ok(checkBash(c, untracked), `should refuse: ${c}`);
  assert.equal(checkBash('rm tests/a.test.js', untracked), null);
});

test('the shell cannot reach the stamps, the settings, the git hooks or the state through // or a glob', () => {
  for (const c of [
    'rm -rf .rec*',
    'cp x .recade//stamps.json',
    'echo > .r?cade/stamps.json',
    'cp x .claude/sett*.json',
    'cp x .claude/./settings.json',
    'cp x .cl*/settings.local.json',
    'rm -rf .gith*',
    'cp x .githooks//pre-commit',
    'cp x rec*/state.yaml',
    'cp x recade//state.yaml',
    'sed -i s/a/b/ recade/st*.yaml',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['rm build/*', 'cp a .claude/notes/*.md', 'rm -rf dist/*', 'cp *.js out/', 'cp x recade/docs/a.md']) {
    assert.equal(checkBash(c), null, `should allow: ${c}`);
  }
});

test('cd and pushd into the harness folders are refused', () => {
  for (const c of [
    'cd .claude && rm -rf hooks',
    'cd .claude/hooks',
    'pushd .recade',
    'cd ./.githooks; echo > pre-commit',
    'cd recade && cp x state.yaml',
    'cd .cl*',
    'cd /abs/proj/.recade',
    'cd src; cd ../.claude',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['cd src', 'cd /home/u/projects/plugins/recade', 'cd ..', 'pushd tests']) assert.equal(checkBash(c), null, `should allow: ${c}`);
});

test('git include.path and includeIf cannot pull in a config that sets core.hooksPath', () => {
  for (const c of [
    'git -c include.path=/tmp/x commit -m a',
    'git -c includeIf.gitdir:/.path=/tmp/x commit -m a',
    'git -c Include.Path=/tmp/x commit -m a',
    'git -c INCLUDEIF.onbranch:main.PATH=/tmp/x commit -m a',
    'git -cinclude.path=/tmp/x commit -m a',
    'git -cincludeIf.gitdir:/.path=/tmp/x commit -m a',
    'git "-c" "include.path=/tmp/x" commit -m a',
    "git -c 'includeif.gitdir:/x/.path=/tmp/x' commit -m a",
    'git -c include.path commit -m a',
    'git -C . -c include.path=/tmp/x log',
    'git --config-env=include.path=V commit -m a',
    'git --config-env include.path=V commit -m a',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=/tmp/x git commit -m a',
    'git config include.path /tmp/x',
    'git config --global include.path /tmp/x',
    'git config --local includeIf.gitdir:/a/.path /tmp/x',
    'git config --file .git/config include.path /tmp/x',
    'git config --add include.path /tmp/x',
    'git config --global --replace-all Include.Path /tmp/x',
    'git -C . config --global include.path /tmp/x',
    'git config set include.path /tmp/x',
    'git config --unset include.path',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of [
    'git config --get include.path',
    'git config --get-all includeIf.gitdir:/a/.path',
    'git config --list',
    'git config get include.path',
    'git log --grep=include.path',
    'git commit -m "docs: explain include.path and includeIf"',
    'grep -rn include.path .',
    'echo include.path',
  ]) assert.equal(checkBash(c), null, `should allow: ${c}`);
});

test('git aliases cannot carry a --no-verify commit, and a variable cannot stand for the subcommand', () => {
  for (const c of [
    "git -c alias.x='commit --no-verify' x -m a",
    "git -calias.x='commit -n' x -m a",
    "git config alias.c 'commit -n'",
    "git config --global alias.c 'commit --no-verify'",
    'cmd=commit; git $cmd -n',
    'git ${SUB} --no-verify',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['git config --get alias.c', 'git config --list', 'git log --oneline', 'git status']) assert.equal(checkBash(c), null, `should allow: ${c}`);
});

test('the git configuration files are not written through the shell', () => {
  for (const c of [
    "echo '[include]' >> .git/config",
    "printf '[core]\\nhooksPath=x' >> .git/config",
    "sed -i 's/a/b/' .git/config",
    "echo '[include]' >> ~/.gitconfig",
    'cp /tmp/evil .git/config',
    "tee -a .git/config <<< '[include]'",
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of ['cat .git/config', 'grep url .git/config', 'git config --get remote.origin.url']) assert.equal(checkBash(c), null, `should allow: ${c}`);
});

test('regression corpus: commit-hook bypass spellings stay refused', () => {
  for (const c of [
    'git commit --no-veri -m a',
    'git commit --no-v -m a',
    'git commit -a --no-veri -m a',
    'git commit -an -m a',
    'git commit -sn -m a',
    'git commit -vn -m a',
    'git commit -avn -m a',
    'git commit -nm a',
    'git commit -S -n -m a',
    'git -c Core.HooksPath=/x commit -m a',
    'git -cCore.hooksPath=/x commit -m a',
    'git config Core.HooksPath /x',
    'git config --global Core.HooksPath /x',
    "printf 'git commit --no-verify' | sh",
    "printf '%s' 'git commit -an' | bash",
    "echo 'git commit -n' | sh",
    "bash <<< 'git commit -n'",
    "sh <<<'git commit --no-ver'",
    "bash -c 'git commit -an'",
    'zsh -c "git commit -sn"',
    "bash <<'EOF'\ngit commit -n\nEOF",
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
});

test('git config bypasses, round 1: backtick subcommand, section rename, variable keys, late -c, edit, exported GIT_CONFIG', () => {
  for (const c of [
    // B1: a backtick substitution as the subcommand
    'git -c include.path=/tmp/x `echo commit` -m a',
    'git `echo commit` -n',
    'git -c include.path=/tmp/x `echo commit`',
    // B2: build a forbidden section from a harmless one
    'git config --rename-section foo include',
    'git config --rename-section foo alias',
    'git config --global --rename-section foo core',
    'git config rename-section foo include',
    'git config --remove-section include',
    'git config remove-section alias',
    // M1: a variable or a substitution as the key
    'K=include.path; git -c $K=/tmp/x commit -m a',
    'git -c "${K}"=x commit -m a',
    'git -c "$K" status',
    'git -c `echo include.path`=/tmp/x commit -m a',
    'git config $KEY /tmp/x',
    // M2: -c and --config after the subcommand
    'git clone -c include.path=/x u',
    'git clone -cinclude.path=/x u',
    'git clone --config include.path=/x u',
    'git clone --config=include.path=/x u',
    'git clone --config=core.hooksPath=/x u',
    'git clone -c alias.x=y u',
    // M3: opening the config in an editor
    'git config -e',
    'git config --edit',
    'git config --global --edit',
    'git config edit',
    // M4: an exported GIT_CONFIG variable, with no git in the command
    'export GIT_CONFIG_GLOBAL=/tmp/evil',
    'export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path',
    'declare -x GIT_CONFIG_SYSTEM=/tmp/evil',
    'typeset -x GIT_CONFIG_PARAMETERS="include.path=/x"',
    'readonly GIT_CONFIG_GLOBAL=/tmp/evil',
    // git-dir before -c
    'git --git-dir=x -c include.path=/x commit',
    'git --git-dir x -c include.path=/x commit',
    // writes to a git config file as a target
    'cp /tmp/evil ~/.gitconfig',
    'mv /tmp/evil .git/config',
    'echo x>>.git/config',
    "sed -i.bak 's/a/b/' .git/config",
    'bash -c "echo x >> .git/config"',
    'echo x | tee ~/.config/git/config',
    'cat /tmp/evil > $HOME/.gitconfig',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of [
    'cp ~/.gitconfig /tmp/b',
    'cat .git/config > /tmp/c',
    'echo "## .gitconfig notes" >> docs/notes.md',
    'echo "see .git/config" > notes.md',
    'touch .gitconfig-notes',
    'touch docs/.gitconfig.md',
    'cp docs/gitconfig.md /tmp/x',
    'git commit -c HEAD',
    'git log -c',
    'git --version',
    'git commit -m "msg `date`"',
    'git config --get alias.c',
    'git -c color.ui=always log',
    'git config user.name x',
    'export PATH=$PATH:/x',
    'export GIT_AUTHOR_NAME=a',
  ]) assert.equal(checkBash(c), null, `should allow: ${c}`);
});

/* ---------- plan 5b: the guard across the code repositories and the workspace ---------- */

/**
 * A workspace with two linked code repositories, `api` and `web`, each with a worktree of slice S-01 under
 * `repos/<name>/.claude/worktrees/S-01`. The sheet `slices/S-01-orders.md` of the workspace holds `touches`.
 */
function makeWorkspace({ touches = ['api:src/**', 'web:src/**'], parent } = {}) {
  const base = parent ?? mkdtempSync(join(tmpdir(), 'recade-ws-'));
  mkdirSync(base, { recursive: true });
  const ws = join(base, 'fern-workspace');
  mkdirSync(join(ws, 'recade'), { recursive: true });
  mkdirSync(join(ws, 'slices'));
  writeFileSync(join(ws, '.gitignore'), 'repos/\nartifacts/\ntmp/\n.recade/\n');
  writeFileSync(join(ws, 'recade', 'state.yaml'), 'version: 1\nkind: workspace\nrepos:\n  - name: api\n    path: repos/api\n  - name: web\n    path: repos/web\n');
  writeFileSync(join(ws, 'BIBLE.md'), '# Bible\n');
  writeFileSync(join(ws, 'slices', 'S-01-orders.md'), `---\nid: S-01\ntouches:\n${touches.map((t) => `  - "${t}"\n`).join('')}---\n# S-01\n`);
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '.');
  git(ws, 'commit', '-q', '-m', 'chore: start');
  const repo = {};
  const wt = {};
  for (const name of ['api', 'web']) {
    repo[name] = join(ws, 'repos', name);
    mkdirSync(repo[name], { recursive: true });
    git(repo[name], 'init', '-q', '-b', 'main');
    writeFileSync(join(repo[name], 'README.md'), `${name}\n`);
    mkdirSync(join(repo[name], 'src'));
    writeFileSync(join(repo[name], 'src', 'a.ts'), `${name}\n`);
    git(repo[name], 'add', '.');
    git(repo[name], 'commit', '-q', '-m', 'chore: start');
    linkRepo(ws, repo[name]);
    wt[name] = join(repo[name], '.claude', 'worktrees', 'S-01');
    git(repo[name], 'worktree', 'add', '-q', '-b', 'slice/S-01-orders', wt[name], 'main');
  }
  return { ws: realpathSync(ws), repo, wt };
}

const write = (cwd, agent, file, extra = {}) =>
  hook(cwd, { ...(agent ? { agent_type: agent } : {}), tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, ...extra });

test('rootOf ties a path to the workspace, to a code repository of the registry, or to nothing', () => {
  const { ws, repo, wt } = makeWorkspace();
  const ctx = { ws, registry: ['api', 'web'] };
  assert.deepEqual(rootOf(join(ws, 'BIBLE.md'), ctx), { kind: 'workspace', root: ws });
  assert.deepEqual(rootOf(join(ws, 'tmp', 'new', 'draft.md'), ctx), { kind: 'workspace', root: ws });
  assert.deepEqual(rootOf(join(wt.web, 'src', 'deep', 'a.ts'), ctx), { kind: 'repo', name: 'web', root: realpathSync(wt.web) });
  assert.deepEqual(rootOf(join(repo.api, 'src', 'a.ts'), ctx), { kind: 'repo', name: 'api', root: realpathSync(repo.api) });
  // A repository under repos/ that the registry does not hold, a repository the registry does not name, and /tmp.
  const stray = join(ws, 'repos', 'stray');
  mkdirSync(stray);
  git(stray, 'init', '-q');
  assert.equal(rootOf(join(stray, 'a.ts'), ctx).kind, 'outside');
  assert.equal(rootOf(join(wt.web, 'src', 'a.ts'), { ws, registry: ['api'] }).kind, 'outside');
  assert.equal(rootOf(join(mkdtempSync(join(tmpdir(), 'recade-out-')), 'a.md'), ctx).kind, 'outside');
  // A symbolic link is followed first.
  const link = join(mkdtempSync(join(tmpdir(), 'recade-ln-')), 'web');
  symlinkSync(wt.web, link);
  assert.deepEqual(rootOf(join(link, 'src', 'a.ts'), ctx), { kind: 'repo', name: 'web', root: realpathSync(wt.web) });
});

test('guard: a slice that touches api and web may write the web worktree from the api session (space and accent in the path)', async () => {
  const { ws, repo, wt } = makeWorkspace({ parent: join(mkdtempSync(join(tmpdir(), 'recade-ws-')), 'Projets Clients', 'Été') });
  assert.equal(await write(wt.api, 'implementer', join(wt.web, 'src', 'a.ts')), '');
  assert.equal(await write(wt.api, 'implementer', join(wt.api, 'src', 'a.ts')), '');
  assert.match(denied(await write(wt.api, 'implementer', join(wt.web, 'lib', 'a.ts'))), /web:src\/\*\*|src\/\*\*/);
  // An unprefixed Writes line holds in every code repository of the slice.
  assert.equal(await write(wt.api, 'test-engineer', join(wt.web, 'tests', 'a.test.ts')), '');
  // The main checkout of web is on main: <touches> cannot be resolved there.
  assert.match(denied(await write(wt.api, 'implementer', join(repo.web, 'src', 'a.ts'))), /not slice\/S-nn/);
  // The session folder may be reached through a symbolic link.
  const link = join(mkdtempSync(join(tmpdir(), 'recade-ln-')), 'api');
  symlinkSync(wt.api, link);
  assert.equal(await write(link, 'implementer', join(wt.web, 'src', 'b.ts')), '');
  assert.ok(ws.includes('Projets Clients'));
});

test('guard: a slice that touches only api cannot write into repos/web (review focus 4)', async () => {
  const { wt } = makeWorkspace({ touches: ['api:src/**'] });
  assert.match(denied(await write(wt.api, 'implementer', join(wt.web, 'src', 'a.ts'))), /web/);
  denied(await write(wt.api, 'test-engineer', join(wt.web, 'tests', 'a.test.ts')));
  denied(await write(wt.api, 'implementer', join(wt.web, 'docs', 'suivi', 'S-01.md')));
  assert.equal(await write(wt.api, 'implementer', join(wt.api, 'src', 'a.ts')), '');
  // Through the shell as well.
  denied(await hook(wt.api, { agent_type: 'implementer', tool_name: 'Bash', tool_input: { command: `echo x > ${join(wt.web, 'src', 'a.ts')}` } }));
  denied(await hook(wt.api, { agent_type: 'implementer', tool_name: 'Bash', tool_input: { command: `cp a.ts ${join(wt.web, 'src')}/` } }));
  assert.equal(await hook(wt.api, { agent_type: 'implementer', tool_name: 'Bash', tool_input: { command: 'echo x > src/a.ts' } }), '');
});

test('guard: an agent writes the workspace only through its workspace: Writes lines', async () => {
  const { ws, wt } = makeWorkspace();
  mkdirSync(join(wt.api, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(wt.api, '.claude', 'agents', 'spec-writer.md'), '---\nname: spec-writer\n---\n\n## Writes\n\n- `workspace:slices/<S-nn>-*.md`\n');
  assert.equal(await write(wt.api, 'spec-writer', join(ws, 'slices', 'S-01-orders.md')), '');
  assert.match(denied(await write(wt.api, 'spec-writer', join(ws, 'BIBLE.md'))), /BIBLE\.md/);
  denied(await write(wt.api, 'spec-writer', join(ws, 'slices', 'S-02-other.md')));
  denied(await write(wt.api, 'spec-writer', join(wt.api, 'slices', 'S-01-orders.md')));
  // An unprefixed Writes line of a code session never reaches the workspace.
  denied(await write(wt.api, 'implementer', join(ws, 'docs', 'suivi', 'S-01.md')));
  // A session started in the workspace reads its unprefixed Writes lines in the workspace.
  assert.equal(await write(ws, 'spec-writer', join(ws, 'slices', 'S-02-other.md')), '');
  denied(await write(ws, 'spec-writer', join(ws, 'BIBLE.md')));
  denied(await write(ws, 'spec-writer', join(wt.api, 'slices', 'S-02-other.md')));
});

test('guard: <S-nn> in a workspace: Writes line is the slice of the session, found by the sheet branch, and any slice only in a workspace session', async () => {
  const { ws, repo, wt } = makeWorkspace();
  const agents = (dir) => {
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'spec-writer.md'), '---\nname: spec-writer\n---\n\n## Writes\n\n- `workspace:slices/<S-nn>-*.md`\n- `workspace:design/ux/<S-nn>/**`\n');
  };
  agents(ws);
  agents(wt.api);
  // A session started in the workspace has no slice: <S-nn> stands for any slice, and nothing else opens.
  assert.equal(await write(ws, 'spec-writer', join(ws, 'slices', 'S-02-other.md')), '');
  assert.equal(await write(ws, 'spec-writer', join(ws, 'design', 'ux', 'S-03', 'a.md')), '');
  denied(await write(ws, 'spec-writer', join(ws, 'slices', 'STATUS.md')));
  denied(await write(ws, 'spec-writer', join(ws, 'slices', 'notes.md')));
  denied(await write(ws, 'spec-writer', join(ws, 'design', 'ui', 'S-03', 'a.md')));
  denied(await write(ws, 'spec-writer', join(ws, 'BIBLE.md')));
  // A slice session keeps the tight reading: its own slice only.
  assert.equal(await write(wt.api, 'spec-writer', join(ws, 'slices', 'S-01-orders.md')), '');
  denied(await write(wt.api, 'spec-writer', join(ws, 'slices', 'S-02-other.md')));
  denied(await write(wt.api, 'spec-writer', join(ws, 'design', 'ux', 'S-03', 'a.md')));
  // The slice of a session is the one whose sheet names its branch, whatever the branch is called.
  writeFileSync(join(ws, 'slices', 'S-04-odd.md'), '---\nid: S-04\nbranch: work/odd\ntouches:\n  - "api:src/**"\n---\n# S-04\n');
  const odd = join(repo.api, '.claude', 'worktrees', 'S-04');
  git(repo.api, 'worktree', 'add', '-q', '-b', 'work/odd', odd, 'main');
  agents(odd);
  assert.equal(await write(odd, 'spec-writer', join(ws, 'slices', 'S-04-odd.md')), '');
  denied(await write(odd, 'spec-writer', join(ws, 'slices', 'S-01-orders.md')));
});

test('guard: no agent runs recade workspace commit, and the main session may', async () => {
  const { ws, wt } = makeWorkspace();
  const command = `node "${plugin}/bin/recade.js" workspace commit --paths slices/S-01-orders.md -m 'docs(slices): S-01'`;
  for (const [cwd, agent] of [[wt.api, 'implementer'], [wt.api, 'spec-writer'], [ws, 'spec-writer'], [wt.api, 'general-purpose']]) {
    const why = denied(await hook(cwd, { agent_type: agent, tool_name: 'Bash', tool_input: { command } }));
    assert.match(why, /recade workspace commit/, agent);
  }
  assert.equal(await hook(wt.api, { tool_name: 'Bash', tool_input: { command } }), '');
});

test('guard: two sheets that name the same branch leave <S-nn> unresolved, so the session writes neither sheet', async () => {
  const { ws, wt } = makeWorkspace();
  mkdirSync(join(wt.api, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(wt.api, '.claude', 'agents', 'spec-writer.md'), '---\nname: spec-writer\n---\n\n## Writes\n\n- `workspace:slices/<S-nn>-*.md`\n');
  // The worktree is on slice/S-01-orders. A second sheet names that branch as well.
  writeFileSync(join(ws, 'slices', 'S-01-orders.md'), '---\nid: S-01\nbranch: slice/S-01-orders\ntouches:\n  - "api:src/**"\n---\n# S-01\n');
  assert.equal(await write(wt.api, 'spec-writer', join(ws, 'slices', 'S-01-orders.md')), '');
  writeFileSync(join(ws, 'slices', 'S-02-twin.md'), '---\nid: S-02\nbranch: slice/S-01-orders\ntouches:\n  - "api:src/**"\n---\n# S-02\n');
  const reason = denied(await write(wt.api, 'spec-writer', join(ws, 'slices', 'S-01-orders.md')));
  assert.match(reason, /two sheets name the branch slice\/S-01-orders: S-01, S-02/);
  denied(await write(wt.api, 'spec-writer', join(ws, 'slices', 'S-02-twin.md')));
  // A workspace session has no slice and is not affected.
  mkdirSync(join(ws, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(ws, '.claude', 'agents', 'spec-writer.md'), '---\nname: spec-writer\n---\n\n## Writes\n\n- `workspace:slices/<S-nn>-*.md`\n');
  assert.equal(await write(ws, 'spec-writer', join(ws, 'slices', 'S-02-twin.md')), '');
});

test('guard: the harness keys of the workspace state are refused from every session', async () => {
  const { ws, wt } = makeWorkspace();
  const state = join(ws, 'recade', 'state.yaml');
  for (const cwd of [wt.api, ws]) {
    for (const agent of [null, 'spec-writer']) {
      denied(await hook(cwd, { ...(agent ? { agent_type: agent } : {}), tool_name: 'Edit', tool_input: { file_path: state, old_string: 'version: 1', new_string: 'version: 1\nharness:\n  required_gates: []' } }));
      denied(await write(cwd, agent, state));
    }
    denied(await hook(cwd, { tool_name: 'Bash', tool_input: { command: `echo x >> ${state}` } }));
  }
});

test('guard: a write outside the workspace and its code repositories is refused', async () => {
  const { ws, wt } = makeWorkspace();
  // Not under the temp folder of the system, which agents may use (fix round 1, F1).
  const out = join('/opt', `recade-out-${process.pid}`, 'a.md');
  for (const cwd of [wt.api, ws]) {
    assert.match(denied(await write(cwd, null, out)), /outside/);
    assert.match(denied(await write(cwd, 'implementer', out)), /outside/);
    denied(await write(cwd, null, join(ws, 'repos', 'new', 'a.ts')));
  }
  denied(await hook(wt.api, { agent_type: 'implementer', tool_name: 'Bash', tool_input: { command: `echo x > ${out}` } }));
  denied(await hook(wt.api, { agent_type: 'implementer', tool_name: 'Bash', tool_input: { command: `npm test 2>&1 | tee ${out}` } }));
  assert.equal(await hook(wt.api, { agent_type: 'implementer', tool_name: 'Bash', tool_input: { command: 'npm test > /dev/null 2>&1' } }), '');
  assert.equal(existsSync(out), false);
  // The main session keeps its notes and plans in the Claude Code folder; an agent does not, nor anything else there.
  const home = mkdtempSync(join(tmpdir(), 'recade-home-'));
  const call = (agent, file) => handleHook(JSON.stringify({ cwd: wt.api, ...(agent ? { agent_type: agent } : {}), tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }), { pluginRoot: plugin, home, tmp: [] });
  assert.equal(await call(null, join(home, '.claude', 'projects', 'x', 'memory', 'a.md')), '');
  assert.equal(await call(null, join(home, '.claude', 'plans', 'a.md')), '');
  denied(await call('implementer', join(home, '.claude', 'projects', 'x', 'memory', 'a.md')));
  denied(await call(null, join(home, '.claude', 'plugins', 'recade', 'src', 'harness', 'guard.js')));
  denied(await call(null, join(home, '.claude', 'settings.json')));
});

test('guard: a code repository whose link is missing, stale or elsewhere refuses every write with recade repo sync (review focus 1)', async () => {
  const { ws, repo, wt } = makeWorkspace();
  const linkFile = join(repo.api, '.recade', 'workspace');
  const target = join(wt.api, 'src', 'new.ts');
  const calls = [
    ['Write', { file_path: target, content: 'x' }],
    ['Edit', { file_path: target, old_string: 'a', new_string: 'b' }],
    ['Bash', { command: 'ls' }],
    ['Bash', { command: 'echo x > src/a.ts' }],
  ];
  const other = makeWorkspace();
  const breakers = {
    'link missing': () => rmSync(linkFile),
    'workspace moved': () => writeFileSync(linkFile, `${join(ws, '..', 'gone-workspace')}\n`),
    'link points elsewhere': () => writeFileSync(linkFile, `${other.ws}\n`),
  };
  for (const [reason, breakLink] of Object.entries(breakers)) {
    linkRepo(ws, repo.api);
    breakLink();
    for (const cwd of [wt.api, repo.api]) {
      for (const agent of [null, 'implementer']) {
        for (const [tool, input] of calls) {
          const why = denied(await hook(cwd, { ...(agent ? { agent_type: agent } : {}), tool_name: tool, tool_input: input }));
          assert.match(why, /recade repo sync/, `${reason} ${tool}`);
          assert.match(why, new RegExp(reason), `${reason} ${tool}`);
        }
      }
      assert.equal(await hook(cwd, { tool_name: 'Read', tool_input: { file_path: target } }), '');
    }
    // The way out stays open: the sync itself, and nothing chained to it.
    assert.equal(await hook(wt.api, { tool_name: 'Bash', tool_input: { command: `node "${plugin}/bin/recade.js" repo sync --project '${ws}'` } }), '');
    denied(await hook(wt.api, { tool_name: 'Bash', tool_input: { command: `node "${plugin}/bin/recade.js" repo sync --project '${ws}'; rm -rf src` } }));
    denied(await hook(wt.api, { tool_name: 'Bash', tool_input: { command: `node ./evil/bin/recade.js repo sync --project '${ws}'` } }));
  }
  assert.equal(existsSync(target), false);
  // A code repository (its harness settings say so) with no workspace around it and no link is held the same way.
  const lone = makeRepo();
  mkdirSync(join(lone, '.claude'));
  writeFileSync(join(lone, '.claude', 'recade.yaml'), 'harness:\n  required_gates: []\n');
  assert.match(denied(await write(lone, null, join(lone, 'src', 'a.js'))), /recade repo sync/);
});

test('the launcher refuses writes in a slice worktree whose link is missing, with recade repo sync', () => {
  const { repo, wt } = makeWorkspace();
  mkdirSync(join(repo.api, '.recade'), { recursive: true });
  writeFileSync(join(repo.api, '.recade', 'plugin-root'), `${plugin}\n`);
  const ev = (tool, input) => JSON.stringify({ cwd: wt.api, tool_name: tool, tool_input: input });
  const ok = runLauncher(wt.api, ev('Write', { file_path: join(wt.api, 'src', 'a.ts'), content: 'x' }));
  assert.equal(ok.stdout, '', ok.stderr);
  rmSync(join(repo.api, '.recade', 'workspace'));
  for (const [tool, input] of [['Write', { file_path: join(wt.api, 'src', 'a.ts'), content: 'x' }], ['Bash', { command: 'ls' }]]) {
    const r = runLauncher(wt.api, ev(tool, input));
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(j.permissionDecision, 'deny');
    assert.match(j.permissionDecisionReason, /recade repo sync/);
  }
});

test('guard: the agent and command files of the harness are protected in every repository and in the workspace', async () => {
  const w = (file) => decide({ tool: 'Write', input: { file_path: file, content: 'x' }, allow: null, root: '/p' }).allow;
  for (const f of ['/p/.claude/agents/reviewer.md', '/p/.claude/commands/slice.md', '/p/.claude/agents/new/x.md', '/p/.claude/recade.yaml', '/p/.recade/workspace']) assert.equal(w(f), false, f);
  for (const c of [
    'cp a .claude/agents/reviewer.md',
    'echo x > .claude/commands/slice.md',
    'rm -rf .claude/agents',
    'cp a .cl*/agents/',
    "sed -i 's/a/b/' .claude/agents/reviewer.md",
    'mv x .claude/commands',
    'cp x .claude//commands/a.md',
    'echo x > .claude/recade.yaml',
    'echo x > .recade/workspace',
  ]) assert.ok(checkBash(c), `should refuse: ${c}`);
  for (const c of [
    `node "/x/bin/recade.js" harness models --dir '/p/.claude/agents'`,
    'node /x/bin/recade.js harness models --check --dir .claude/agents',
    'cat .claude/agents/reviewer.md',
    'ls .claude/commands',
  ]) assert.equal(checkBash(c), null, `should allow: ${c}`);
  const { ws, wt } = makeWorkspace();
  for (const [cwd, file] of [[wt.api, join(wt.api, '.claude', 'agents', 'reviewer.md')], [wt.api, join(wt.web, '.claude', 'commands', 'slice.md')], [ws, join(ws, '.claude', 'commands', 'slice.md')], [ws, join(ws, '.claude', 'agents', 'board-keeper.md')]]) {
    assert.match(denied(await write(cwd, null, file)), /\.claude\/(agents|commands)/);
  }
  const legacy = makeRepo();
  denied(await write(legacy, null, join(legacy, '.claude', 'agents', 'reviewer.md')));
  denied(await write(legacy, null, join(legacy, '.claude', 'commands', 'slice.md')));
});

test('guard: the threshold files of a code repository come from its own .claude/recade.yaml', async () => {
  const { wt } = makeWorkspace();
  mkdirSync(join(wt.web, '.claude'));
  mkdirSync(join(wt.api, '.claude'));
  writeFileSync(join(wt.web, '.claude', 'recade.yaml'), 'harness:\n  threshold_files:\n    - tsconfig.json\n');
  assert.match(denied(await write(wt.api, null, join(wt.web, 'tsconfig.json'))), /threshold/);
  assert.equal(await write(wt.api, null, join(wt.api, 'tsconfig.json')), '');
  writeFileSync(join(wt.api, '.claude', 'recade.yaml'), 'harness: {threshold_files: [x]}\n');
  assert.match(denied(await write(wt.api, null, join(wt.api, 'src', 'a.ts'))), /could not be read/);
});

test('guard: a slice worktree of a moved workspace is held, not judged as a plain folder (Task 1 review N3)', async () => {
  const { ws, wt } = makeWorkspace();
  const moved = `${ws}-moved`;
  renameSync(ws, moved);
  const stale = join(moved, 'repos', 'api', '.claude', 'worktrees', 'S-01');
  assert.ok(existsSync(join(stale, '.git')));
  for (const agent of [null, 'implementer']) {
    assert.match(denied(await write(stale, agent, join(stale, 'src', 'a.ts'))), /recade repo sync/);
    assert.match(denied(await hook(stale, { ...(agent ? { agent_type: agent } : {}), tool_name: 'Bash', tool_input: { command: 'ls' } })), /recade repo sync/);
  }
  assert.equal(existsSync(wt.api), false);
});

/* ---------- plan 5b Task 4, fix round 1: the review probes, as tests ---------- */

const sh = (cwd, agent, command, opts) => hook(cwd, { ...(agent ? { agent_type: agent } : {}), tool_name: 'Bash', tool_input: { command } }, opts);
const recadeCli = join(plugin, 'bin', 'recade.js');

test('C1: a workspace planted inside a worktree, with symlinks to the real repositories, is no workspace', async () => {
  const { ws, repo, wt } = makeWorkspace({ touches: ['api:src/**'] });
  const A = wt.api;
  const fake = join(A, 'src', 'fake');
  mkdirSync(join(fake, 'recade'), { recursive: true });
  mkdirSync(join(fake, 'slices'));
  mkdirSync(join(fake, 'repos'));
  writeFileSync(join(fake, 'recade', 'state.yaml'), 'version: 1\nkind: workspace\nrepos:\n  - name: api\n    path: repos/api\n  - name: web\n    path: repos/web\n');
  writeFileSync(join(fake, 'slices', 'S-01-x.md'), '---\nid: S-01\ntouches:\n  - "api:**"\n  - "web:**"\n---\n');
  // The steps an agent would take are refused: the symlinks and the sync.
  denied(await sh(A, 'implementer', `ln -s ${repo.api} src/fake/repos/api`));
  denied(await sh(A, 'implementer', `node ${recadeCli} repo sync --project src/fake`));
  denied(await sh(A, 'implementer', `node ${recadeCli} repo add evil --new`));
  denied(await sh(A, 'general-purpose', `node ${recadeCli} repo sync`));
  // Even when they are done by hand, the links that name the planted workspace hold nothing.
  symlinkSync(repo.api, join(fake, 'repos', 'api'));
  symlinkSync(repo.web, join(fake, 'repos', 'web'));
  writeFileSync(join(repo.api, '.recade', 'workspace'), `${realpathSync(fake)}\n`);
  writeFileSync(join(repo.web, '.recade', 'workspace'), `${realpathSync(fake)}\n`);
  assert.match(denied(await write(A, 'implementer', join(wt.web, 'src', 'a.ts'))), /recade repo sync/);
  assert.match(denied(await write(A, 'implementer', join(A, 'README.md'))), /recade repo sync/);
  assert.match(denied(await sh(A, 'implementer', `echo x > ${join(wt.web, 'src', 'a.ts')}`)), /recade repo sync/);
  const t = { out: [], err: [] };
  const io = { stdout: { write: (x) => t.out.push(x) }, stderr: { write: (x) => t.err.push(x) }, cwd: A, env: {} };
  assert.equal(await run(['workspace', 'root'], io), 1);
  assert.equal(t.out.join(''), '');
  assert.match(t.err.join(''), /recade repo sync/);
  // A real workspace whose repos/<name> is a symlink to a repository elsewhere does not hold it either.
  const other = makeWorkspace();
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'recade-far-')), 'api');
  renameSync(other.repo.api, elsewhere);
  symlinkSync(elsewhere, other.repo.api);
  linkRepo(other.ws, elsewhere);
  denied(await write(elsewhere, null, join(elsewhere, 'src', 'a.ts')));
  assert.ok(ws !== other.ws);
});

test('M1: with a bad link only the main session may sync, and only its own workspace', async () => {
  const { ws, repo, wt } = makeWorkspace();
  const A = wt.api;
  const other = makeWorkspace();
  writeFileSync(join(repo.api, '.recade', 'workspace'), `${other.ws}\n`);
  assert.equal(await sh(A, null, `node ${recadeCli} repo sync --project ${ws}`), '');
  assert.equal(await sh(A, null, `node "${recadeCli}" repo sync --project '${ws}'`), '');
  for (const c of [
    `node ${recadeCli} repo sync --project /`,
    `node ${recadeCli} repo sync --project ${other.ws}`,
    `node ${recadeCli} repo sync --project ${ws}/../../${basename(dirname(other.ws))}/fern-workspace`,
    `node ${recadeCli} repo sync --project ${join(A, 'src')}`,
  ]) denied(await sh(A, null, c));
  denied(await sh(A, 'implementer', `node ${recadeCli} repo sync --project ${ws}`));
  denied(await sh(A, 'general-purpose', `node ${recadeCli} repo sync --project ${ws}`));
});

test('I1: the shell of an agent cannot reach a repository outside its slice through cd, symlinks, git -C or >|', async () => {
  const { ws, repo, wt } = makeWorkspace({ touches: ['api:src/**'] });
  const A = wt.api;
  const webF = join(wt.web, 'src', 'a.ts');
  symlinkSync(join(wt.web, 'src'), join(A, 'src', 'weblink'));
  symlinkSync(join(ws, 'recade'), join(A, 'src', 'wsrecade'));
  symlinkSync(join(repo.api, '.recade'), join(A, 'src', 'dotrecade'));
  for (const c of [
    'cd ../../../../web && echo x > src/a.ts',
    `cd ${repo.web} && echo x > src/a.ts`,
    `cd ${repo.web}; sed -i s/a/b/ src/a.ts`,
    `(cd ${repo.web} && cp ${join(A, 'src', 'a.ts')} src/a.ts)`,
    `cd ${wt.web} && echo x > src/a.ts`,
    `pushd ${wt.web}; echo x > src/a.ts`,
    'cd "$OTHER" && echo x > src/a.ts',
    `ln -s ${join(wt.web, 'src')} src/web && echo x > src/web/a.ts`,
    `ln -s ${join(ws, 'slices')} src/sl`,
    `ln ${webF} src/hard.ts`,
    'echo x > src/weblink/a.ts',
    'cp src/a.ts src/weblink/a.ts',
    'echo "harness: {required_gates: []}" >> src/wsrecade/state.yaml',
    'echo /elsewhere > src/dotrecade/workspace',
    `git -C ${wt.web} checkout -- src/a.ts`,
    `git -C ${wt.web} commit -am x`,
    `git -C ${repo.web} reset --hard HEAD~0`,
    `git -C ${wt.web} apply p.diff`,
    `git --work-tree=${wt.web} checkout HEAD -- src/a.ts`,
    `git --work-tree ${wt.web} checkout HEAD -- src/a.ts`,
    `git --git-dir=${join(repo.web, '.git')} commit -m x`,
    `echo x >| ${webF}`,
  ]) denied(await sh(A, 'implementer', c));
  // Ordinary slice work still runs.
  for (const c of [
    'echo x > src/x.ts',
    'mkdir -p src/orders && echo x > src/orders/a.ts',
    'cd src && echo x > b.ts',
    `echo x >> ${join(ws, 'tmp', 'S-01', 'journal.md')}`,
    'git add src/x.ts && git commit -m "feat(api): x"',
    `git -C ${A} status`,
    'npm test 2>&1 | tail -5',
    'ls 2>/dev/null',
    'ln -s a.ts src/alias.ts',
  ]) assert.equal(await sh(A, 'implementer', c), '', c);
  // A slice on api and web may use the web worktree.
  const two = makeWorkspace({ touches: ['api:src/**', 'web:src/**'] });
  for (const c of [
    `cp src/a.ts ${join(two.wt.web, 'src', 'b.ts')}`,
    `git -C ${two.wt.web} add src/a.ts && git -C ${two.wt.web} commit -m "feat(web): a"`,
  ]) assert.equal(await sh(two.wt.api, 'implementer', c), '', c);
  // cd into a slice worktree is refused by the shell scan (its path holds .claude); git -C is the way, and it holds.
  denied(await sh(two.wt.api, 'implementer', `cd ${two.wt.web} && echo x > README.md`));
  denied(await sh(two.wt.api, 'implementer', `git -C ${join(two.repo.web)} checkout -- README.md`));
  // From the workspace: a symlink into a code repository and git -C are refused.
  mkdirSync(join(ws, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(ws, '.claude', 'agents', 'spec-writer.md'), '---\nname: spec-writer\n---\n\n## Writes\n\n- `workspace:slices/*.md`\n- `docs/**`\n');
  denied(await sh(ws, 'spec-writer', `ln -s ${join(repo.web, 'src')} docs/w`));
  denied(await sh(ws, 'spec-writer', 'ln -s ../repos/web/src docs/w'));
  // A relative target is read from the folder of the link: this one points at docs/repos/web/src, inside docs/.
  assert.equal(await sh(ws, 'spec-writer', 'ln -s repos/web/src docs/w'), '');
  denied(await sh(ws, 'spec-writer', 'git -C repos/web commit --allow-empty -m x'));
  assert.equal(await sh(ws, 'spec-writer', 'echo x > docs/a.md'), '');
});

test('I2: no path named .git is written, and a planted .git does not move the root of a protected path', async () => {
  const { ws, repo, wt } = makeWorkspace({ touches: ['api:**'] });
  const A = wt.api;
  for (const agent of [null, 'implementer']) {
    for (const f of [join(A, '.claude', '.git'), join(A, 'src', 'evil', '.git'), join(repo.api, '.recade', '.git'), join(ws, 'recade', '.git'), join(A, 'src', '.git', 'config')]) {
      assert.match(denied(await write(A, agent, f)), /\.git/, `${agent} ${f}`);
    }
    denied(await sh(A, agent, `echo "gitdir: x" > ${join(ws, 'recade', '.git')}`));
    denied(await sh(A, agent, 'mkdir -p .claude && echo "gitdir: x" > .claude/.git'));
  }
  // Planted by hand, it does not unlock what is behind it.
  mkdirSync(join(A, '.claude'), { recursive: true });
  writeFileSync(join(A, '.claude', '.git'), `${readFileSync(join(A, '.git'), 'utf8').trim()}\n`);
  writeFileSync(join(repo.api, '.recade', '.git'), `gitdir: ${join(repo.api, '.git')}\n`);
  writeFileSync(join(ws, 'recade', '.git'), `gitdir: ${join(ws, '.git')}\n`);
  for (const agent of [null, 'implementer']) {
    for (const f of [join(A, '.claude', 'agents', 'implementer.md'), join(A, '.claude', 'hooks', 'launcher.mjs'), join(A, '.claude', 'recade.yaml'), join(A, '.claude', 'commands', 'slice.md'), join(repo.api, '.recade', 'workspace')]) {
      denied(await write(A, agent, f));
    }
    denied(await hook(A, { ...(agent ? { agent_type: agent } : {}), tool_name: 'Edit', tool_input: { file_path: join(ws, 'recade', 'state.yaml'), old_string: 'version: 1', new_string: 'version: 1\nharness:\n  required_gates: []' } }));
  }
});

test('M3: an agent with no Writes section writes only the touches of its own repository', async () => {
  const { ws, wt } = makeWorkspace({ touches: ['api:src/**', 'web:src/**'] });
  for (const agent of ['general-purpose', 'my-custom-agent']) {
    assert.equal(await write(wt.api, agent, join(wt.api, 'src', 'a.ts')), '');
    denied(await write(wt.api, agent, join(wt.api, 'README.md')));
    denied(await write(wt.api, agent, join(wt.web, 'src', 'a.ts')));
    denied(await write(wt.api, agent, join(ws, 'BIBLE.md')));
    denied(await sh(wt.api, agent, `echo x > ${join(wt.web, 'src', 'a.ts')}`));
    assert.equal(await sh(wt.api, agent, 'echo x > src/b.ts'), '');
    denied(await write(ws, agent, join(ws, 'BIBLE.md')));
  }
});

test('F1: agents may write the temp folder of the system, unless a symlink leads out of it', async () => {
  const { ws, wt } = makeWorkspace({ touches: ['api:src/**'] });
  const A = wt.api;
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'recade-scratch-')));
  for (const agent of [null, 'implementer']) {
    assert.equal(await write(A, agent, join(scratch, 'notes.md')), '', `${agent}`);
    assert.equal(await sh(A, agent, `npx vitest run > ${join(scratch, 'out.txt')}`), '', `${agent}`);
    assert.equal(await sh(A, agent, 'npx vitest run > /tmp/recade-out.txt'), '', `${agent}`);
  }
  symlinkSync(join(wt.web, 'src'), join(scratch, 'to-web'));
  denied(await write(A, 'implementer', join(scratch, 'to-web', 'a.ts')));
  denied(await sh(A, 'implementer', `echo x > ${join(scratch, 'to-web', 'a.ts')}`));
  // The workspace itself sits in the temp folder here: its paths keep their own rules.
  denied(await write(A, 'implementer', join(ws, 'repos', 'new', 'a.ts')));
  denied(await write(A, 'implementer', join(ws, 'BIBLE.md')));
  denied(await write(A, 'implementer', join(wt.web, 'src', 'a.ts')));
  // Without a temp folder, the rule of the workspace holds.
  denied(await hook(A, { agent_type: 'implementer', tool_name: 'Write', tool_input: { file_path: join(scratch, 'n.md'), content: 'x' } }, { tmp: [] }));
});

/* ---------- plan 5b Task 4, fix round 2: hard links, cd anywhere, nested shells, the audit ---------- */

test('R1: hard links into another repository are refused, and a file with more than one link is not written', async () => {
  const { wt } = makeWorkspace({ touches: ['api:src/**'] });
  const A = wt.api;
  const WF = join(wt.web, 'src', 'a.ts');
  for (const c of [
    `ln ${WF} src/h.ts`,
    'ln src/a.ts src/h.ts',
    `cp -l ${WF} src/h2.ts`,
    `cp --link ${WF} src/h3.ts`,
    `cp -al ${join(wt.web, 'src')} src/hdir`,
    `rsync --link-dest=${join(wt.web, 'src')} -a ${join(wt.web, 'src')}/ src/r/`,
  ]) denied(await sh(A, 'implementer', c));
  linkSync(WF, join(A, 'src', 'hard.ts'));
  for (const agent of [null, 'implementer']) {
    assert.match(denied(await write(A, agent, join(A, 'src', 'hard.ts'))), /link/);
    denied(await hook(A, { ...(agent ? { agent_type: agent } : {}), tool_name: 'Edit', tool_input: { file_path: join(A, 'src', 'hard.ts'), old_string: 'web', new_string: 'x' } }));
  }
  denied(await sh(A, 'implementer', 'echo x > src/hard.ts'));
  denied(await sh(A, 'implementer', 'echo x >> src/hard.ts'));
  assert.equal(readFileSync(WF, 'utf8'), 'web\n');
});

test('R2: a cd anywhere in a command is followed or refused', async () => {
  const { ws, repo, wt } = makeWorkspace({ touches: ['api:src/**'] });
  const A = wt.api;
  const W = repo.web;
  for (const c of [
    `{ cd ${W}; echo x > src/a.ts; }`,
    `if cd ${W}; then echo x > src/a.ts; fi`,
    `for d in x; do cd ${W}; echo x > src/a.ts; done`,
    `time cd ${W}; echo x > src/a.ts`,
    `builtin cd ${W} && echo x > src/a.ts`,
    `command cd ${W} && echo x > src/a.ts`,
    `CDPATH=${join(ws, 'repos')} cd web && echo x > src/a.ts`,
    `cd ${join(ws, 'repos')} && cd web && echo x > src/a.ts`,
    `cd ${W}; cd -; echo x > src/a.ts`,
    `while cd ${W}; do echo x > src/a.ts; break; done`,
  ]) denied(await sh(A, 'implementer', c));
  assert.equal(await sh(A, 'implementer', '{ cd src; echo x > b.ts; }'), '');
  assert.equal(await sh(A, 'implementer', 'cd /tmp && echo x > recade-o.txt'), '');
});

test('R3: nested shells, eval, env -C, git environment and git options are refused for agents', async () => {
  const { repo, wt } = makeWorkspace({ touches: ['api:src/**'] });
  const A = wt.api;
  const W = repo.web;
  const WF = join(W, 'src', 'a.ts');
  const outside = join(mkdtempSync(join(tmpdir(), 'recade-src-')), 'env.sh');
  writeFileSync(outside, 'echo x\n');
  for (const c of [
    `sh -c 'echo x > ${WF}'`,
    `bash -lc "echo x > ${WF}"`,
    `bash -c 'echo x > src/a.ts'`,
    `zsh -c 'true'`,
    `sh -c 'cd ${W} && echo x > src/a.ts'`,
    `eval 'echo x > ${WF}'`,
    'eval true',
    `echo "$(cd ${W} && echo x > src/a.ts)"`,
    `echo \`cd ${W} && echo x > src/a.ts\``,
    `env -C ${W} sh -c 'echo x > src/a.ts'`,
    `env --chdir=${W} tee src/a.ts < src/a.ts`,
    `env -C ${W} tee src/a.ts`,
    `git -c core.worktree=${W} checkout -- src/a.ts`,
    `GIT_WORK_TREE=${W} git checkout -- src/a.ts`,
    `GIT_DIR=${join(W, '.git')} git reset --hard`,
    `GIT_INDEX_FILE=/tmp/i git add src/a.ts`,
    'export GIT_DIR=/x',
    `git --git-dir ${join(W, '.git')} --work-tree ${W} checkout -- src/a.ts`,
    'git --git-dir=.git status',
    `git worktree add ${join(W, 'src', 'evil')}`,
    'git worktree add ../evil',
    `git clone . ${join(W, 'src', 'evil')}`,
    `xargs -I{} cp {} ${WF} <<< src/a.ts`,
    'ls | xargs rm',
    `find src -name a.ts -exec cp {} ${WF} \;`,
    `source ${outside}`,
    `. ${outside}`,
    `tar -xf x.tar -C ${W}`,
    `tar --directory=${W} -xf x.tar`,
    `unzip x.zip -d ${W}`,
  ]) denied(await sh(A, 'implementer', c));
  // The main session keeps them: its shell is held by the deny list only.
  assert.equal(await sh(A, null, `git -C ${wt.web} log -1`), '');
  assert.equal(await sh(A, null, 'git worktree list'), '');
});

test('R: .git is matched without case and with trailing dots or spaces', async () => {
  const { wt } = makeWorkspace();
  const A = wt.api;
  for (const p of ['.claude/.GIT', '.claude/.Git', '.claude/.git.', '.claude/.git ', 'src/.GIT/config']) {
    for (const agent of [null, 'implementer']) denied(await write(A, agent, join(A, p)));
  }
  for (const c of ['echo gitdir: x > .claude/.GIT', 'echo x > .claude/.Git.', 'cp f src/.GIT']) {
    denied(await sh(A, null, c));
    denied(await sh(A, 'implementer', c));
  }
});

test('R: ordinary slice work and read-only git in other repositories stay allowed', async () => {
  const { repo, wt } = makeWorkspace({ touches: ['api:src/**'] });
  const A = wt.api;
  const W = wt.web;
  writeFileSync(join(A, 'env.sh'), 'export A=1\n');
  for (const c of [
    'npm test', 'npm run build', 'npx tsc --noEmit', 'git add -A && git commit -m "feat(api): orders"', 'git push origin slice/S-01-orders',
    'git diff main...HEAD > /tmp/recade-d.patch', 'mkdir -p src/orders/dto && touch src/orders/dto/a.ts', 'cd src && echo x > orders/b.ts',
    'cd src/orders && ls && cd ../.. && echo x > src/c.ts', 'git -C . status', `git -C ${A} log --oneline -3`,
    `git -C ${W} log --oneline -1`, `git -C ${repo.web} status`, `git -C ${repo.web} diff`, `git -C ${W} show HEAD`, `git -C ${W} rev-parse HEAD`,
    `cat ${join(W, 'src', 'a.ts')}`, 'git stash list', 'cp src/a.ts src/b.ts', 'ln -s a.ts src/alias.ts', 'npm test > /tmp/recade-out.log 2>&1',
    'echo "$(date)"', 'git commit -m "$(cat <<\'EOF\'\nfeat(api): x\n\nbody\nEOF\n)"', 'source env.sh', '. ./env.sh', 'tar -xf x.tar -C src',
    `node "${plugin}/bin/recade.js" gate run 'unit' -- npm test`,
  ]) assert.equal(await sh(A, 'implementer', c), '', c);
});

test('recade guard snapshot and audit report every change outside the slice as BLOCKING', async () => {
  const { ws, repo, wt } = makeWorkspace({ touches: ['api:src/**', 'web:src/**'] });
  const io = (cwd) => {
    const t = { out: [], err: [] };
    return { t, io: { stdout: { write: (x) => t.out.push(x) }, stderr: { write: (x) => t.err.push(x) }, cwd, env: {} } };
  };
  const snap = io(wt.api);
  assert.equal(await run(['guard', 'snapshot'], snap.io), 0, snap.t.err.join(''));
  const file = snap.t.out.join('').trim().split('\n').at(-1);
  assert.ok(existsSync(file), file);
  assert.ok(file.startsWith(join(realpathSync(repo.api), '.recade')));
  // Allowed: the slice worktrees of api and web, and the status board of the workspace.
  writeFileSync(join(wt.api, 'src', 'a.ts'), 'slice api\n');
  writeFileSync(join(wt.web, 'src', 'a.ts'), 'slice web\n');
  writeFileSync(join(ws, 'slices', 'STATUS.md'), '| S-01 | in-progress |\n');
  const clean = io(wt.api);
  assert.equal(await run(['guard', 'audit', '--since', file], clean.io), 0, clean.t.out.join('') + clean.t.err.join(''));
  // Not allowed: the main checkout of web (a change and a commit), a new worktree, the BIBLE, a committed sheet of another slice.
  writeFileSync(join(repo.web, 'src', 'a.ts'), 'pwned\n');
  writeFileSync(join(repo.api, 'README.md'), 'pwned\n');
  git(repo.web, 'worktree', 'add', '-q', '-b', 'evil', join(mkdtempSync(join(tmpdir(), 'recade-evil-')), 'evil'), 'main');
  writeFileSync(join(ws, 'BIBLE.md'), 'pwned\n');
  writeFileSync(join(ws, 'slices', 'S-02-other.md'), '---\nid: S-02\n---\n');
  git(ws, 'add', 'slices/S-02-other.md');
  git(ws, 'commit', '-q', '-m', 'docs: other');
  const dirty = io(wt.api);
  assert.equal(await run(['guard', 'audit', '--since', file], dirty.io), 1);
  const out = dirty.t.out.join('');
  for (const what of [/BLOCKING: web .*src\/a\.ts/, /BLOCKING: api .*README\.md/, /BLOCKING: web .*evil/, /BLOCKING: workspace .*BIBLE\.md/, /BLOCKING: workspace .*S-02-other\.md/]) assert.match(out, what);
  assert.doesNotMatch(out, /STATUS\.md|slice api|slice web/);
  // A later commit in the main checkout is seen too, and so is a missing snapshot.
  git(repo.web, 'add', '.');
  git(repo.web, 'commit', '-q', '-m', 'x');
  const moved = io(wt.api);
  assert.equal(await run(['guard', 'audit', '--since', file], moved.io), 1);
  assert.match(moved.t.out.join(''), /BLOCKING: web .*HEAD/);
  const none = io(wt.api);
  assert.equal(await run(['guard', 'audit', '--since', join(ws, 'nope.json')], none.io), 2);
  const bad = io(wt.api);
  assert.equal(await run(['guard', 'audit'], bad.io), 2);
  // An agent cannot rewrite the snapshot.
  denied(await write(wt.api, 'implementer', file));
  denied(await write(wt.api, null, file));
});

/* ---------- final fix wave A: the review probes, as tests ---------- */

test('final A, I1, M1, M2: the main-session-only commands are refused for an agent, quoted or not', async () => {
  const { ws, wt } = makeWorkspace();
  const cli = `node ${recadeCli}`;
  const commands = [
    `${cli} re''po sync`,
    `${cli} repo a""dd evil --new`,
    `${cli} workspace co''mmit --paths BIBLE.md -m x`,
    `${cli} rep\\o sync`,
    `${cli} guard snapshot --slice S-01`,
    `${cli} guard snapshot`,
    `${cli} gu''ard snapshot --out x.json`,
    `${cli} guard "snapshot" --slice S-01`,
    `${cli} workspace auto-push on`,
    `${cli} work''space auto-push off`,
    `cd src && ${cli} guard snapshot --slice S-01`,
  ];
  for (const [cwd, agent] of [[wt.api, 'implementer'], [ws, 'spec-writer'], [wt.api, 'general-purpose']]) {
    for (const c of commands) denied(await sh(cwd, agent, c));
  }
  // The main session runs them, and an agent may still run the audit and read the root.
  assert.equal(await sh(wt.api, null, `${cli} guard snapshot --slice S-01`), '');
  assert.equal(await sh(ws, null, `${cli} workspace auto-push on`), '');
  assert.equal(await sh(wt.api, 'implementer', `${cli} guard audit --since /tmp/x.json`), '');
  assert.equal(await sh(wt.api, 'implementer', `${cli} workspace root`), '');
});

test('final A, residual: an agent cannot remove or reset the workspace or another registered repository', async () => {
  const { ws, repo, wt } = makeWorkspace();
  for (const [cwd, agent] of [[wt.api, 'implementer'], [ws, 'spec-writer']]) {
    for (const c of [
      `rm -rf ${ws}`,
      `rm -rf ${join(ws, 'repos')}`,
      `rm -rf ${join(ws, '.git')}`,
      `rm -r ${repo.web}`,
      `rm -fr ${ws}/*`,
      `rm --recursive --force ${dirname(ws)}`,
      `find ${ws} -delete`,
      `git -C ${ws} clean -ffdx`,
      `git -C ${ws} reset --hard HEAD~1`,
      `git -C ${repo.web} reset --hard`,
      `cd ${repo.web} && git clean -fd`,
    ]) assert.match(denied(await sh(cwd, agent, c)), /workspace|repository/, `${agent}: ${c}`);
  }
  // The session's own checkout keeps its ordinary commands.
  assert.equal(await sh(wt.api, 'implementer', 'git reset --hard HEAD'), '');
  assert.equal(await sh(wt.api, 'implementer', 'git clean -fd'), '');
  assert.equal(await sh(wt.api, 'implementer', 'rm -rf src/tmp'), '');
  // The main session is not held by this floor.
  assert.equal(await sh(ws, null, `git -C ${ws} reset --hard HEAD`), '');
});

test('final A, I1: guard snapshot never overwrites an existing snapshot without --replace', async () => {
  const { repo, wt } = makeWorkspace();
  const io = (cwd) => {
    const t = { out: [], err: [] };
    return { t, io: { stdout: { write: (x) => t.out.push(x) }, stderr: { write: (x) => t.err.push(x) }, cwd, env: {} } };
  };
  const first = io(wt.api);
  assert.equal(await run(['guard', 'snapshot', '--slice', 'S-01'], first.io), 0);
  const file = first.t.out.join('').trim().split('\n').at(-1);
  writeFileSync(join(repo.web, 'src', 'a.ts'), 'changed\n');
  const before = readFileSync(file, 'utf8');
  for (const args of [['--slice', 'S-01'], [], ['--out', file]]) {
    const again = io(wt.api);
    assert.equal(await run(['guard', 'snapshot', ...args], again.io), 2, args.join(' '));
    assert.match(again.t.err.join(''), /already exists.*--replace/);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
  const audit = io(wt.api);
  assert.equal(await run(['guard', 'audit', '--since', file], audit.io), 1);
  // The owner's explicit choice takes a new one.
  const replaced = io(wt.api);
  assert.equal(await run(['guard', 'snapshot', '--slice', 'S-01', '--replace'], replaced.io), 0, replaced.t.err.join(''));
  assert.notEqual(readFileSync(file, 'utf8'), before);
});

test('final B #2: with only the plugin root missing, the main session may resume: repo sync, repo check, config get', () => {
  const repo = makeRepo();
  const ev = (command, extra = {}) => JSON.stringify({ cwd: repo, tool_name: 'Bash', tool_input: { command }, ...extra });
  const allowed = [
    `node "${plugin}/bin/recade.js" repo sync`,
    `node "${plugin}/bin/recade.js" repo sync --project '/p'`,
    `node "${plugin}/bin/recade.js" repo check`,
    `node "${plugin}/bin/recade.js" repo check --json --project /p`,
    `node "${plugin}/bin/recade.js" repo list --json`,
    `node "${plugin}/bin/recade.js" config get languages.chat`,
  ];
  for (const c of allowed) assert.equal(runLauncher(repo, ev(c)).stdout, '', c);
  const deny = (r, c) => assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny', c);
  for (const c of allowed) deny(runLauncher(repo, ev(c, { agent_type: 'implementer' })), c);
  for (const c of [
    `node "${plugin}/bin/recade.js" repo add x --new`,
    `node "${plugin}/bin/recade.js" repo sync --json`,
    `node "${plugin}/bin/recade.js" config set languages.chat fr`,
    `node "${plugin}/bin/recade.js" config get 'a b'`,
    `node "${plugin}/bin/recade.js" config get`,
    `node "${plugin}/bin/recade.js" repo sync; id`,
  ]) deny(runLauncher(repo, ev(c)), c);
  // A guard that is there but broken is not a fresh clone: only the reinstall commands pass.
  const broken = mkdtempSync(join(tmpdir(), 'recade-broken-'));
  mkdirSync(join(broken, 'harness', 'hooks'), { recursive: true });
  writeFileSync(join(broken, 'harness', 'hooks', 'guard.mjs'), 'export async function runGuard() { throw new Error("broken"); }\n');
  mkdirSync(join(repo, '.recade'), { recursive: true });
  writeFileSync(join(repo, '.recade', 'plugin-root'), `${broken}\n`);
  deny(runLauncher(repo, ev(allowed[0])), allowed[0]);
});
