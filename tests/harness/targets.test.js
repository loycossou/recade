import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseWrites } from '../../src/harness/guard.js';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { InstallError, install } from '../../src/harness/install.js';
import { TARGETS, TARGET_NAMES, readRepoSettings, selectFor, thresholdCandidates } from '../../src/harness/targets.js';
import { verify } from '../../src/harness/verify.js';
import { readCreated } from '../../src/project/adopt.js';
import { loadState, saveState } from '../../src/state.js';
import { checkLink } from '../../src/workspace/layout.js';
import { LOCAL_HOOK_MARK } from '../../src/harness/install.js';
import { cli, git, makeWorkspace, perRepoStack, plugin } from './fixture-project.js';

const REF = 'v1.0.0';
const read = (root, f) => readFileSync(join(root, f), 'utf8');
const names = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
const harnessAgents = names(join(plugin, 'harness', 'agents')).map((f) => f.replace(/\.md$/, '')).sort();
const harnessCommands = names(join(plugin, 'harness', 'commands')).map((f) => f.replace(/\.md$/, ''));
const installWs = (ws, extra = {}) => install(ws.dir, { pluginRoot: plugin, target: 'workspace', ref: REF, ...extra });
const installCode = (ws, name, extra = {}) => install(ws.repo(name), { pluginRoot: plugin, target: 'code', workspace: ws.dir, ref: REF, ...extra });
const errors = (r, check) => r.findings.filter((f) => f.severity === 'error' && (check === undefined || f.check === check));
/** The git hooks folder of a checkout (shared by its worktrees). */
const hooksDir = (root) => join(root, git(root, 'rev-parse', '--git-path', 'hooks').stdout.trim());
const isExec = (file) => (statSync(file).mode & 0o111) !== 0;

test('TARGETS: the workspace gets every command and every agent, a code repository none of them', () => {
  assert.deepEqual(TARGET_NAMES, ['workspace', 'code']);
  const ws = selectFor('workspace', { commands: harnessCommands, agents: harnessAgents });
  // One entry point: every command and every agent of the plugin goes to the workspace, so nothing is left out.
  assert.deepEqual(ws.commands, harnessCommands);
  assert.deepEqual(ws.agents, harnessAgents);
  assert.equal(ws.protocol, true);
  assert.deepEqual(ws.pointers, []);
  const code = selectFor('code', { commands: harnessCommands, agents: harnessAgents });
  assert.deepEqual(code.commands, []);
  assert.deepEqual(code.agents, []);
  assert.deepEqual(code.pointers, [], 'a code repository holds no file of the harness, not even a pointer');
  assert.equal(code.protocol, false);
  assert.deepEqual([...TARGETS.code.pointers], []);
});

test('a workspace install moves repos/ and worktrees/ of an older .gitignore to .git/info/exclude, and git still ignores them', async () => {
  const ws = await makeWorkspace();
  writeFileSync(join(ws.dir, '.gitignore'), 'repos/\nworktrees/\nartifacts/\n');
  writeFileSync(join(ws.dir, '.git', 'info', 'exclude'), '# git ls-files --others --exclude-from=.git/info/exclude\n');
  const r = installWs(ws);
  assert.deepEqual(read(ws.dir, '.gitignore').split('\n').filter((l) => ['repos/', 'worktrees/'].includes(l)), []);
  assert.ok(read(ws.dir, '.gitignore').split('\n').includes('artifacts/'), 'the other lines stay');
  const exclude = read(ws.dir, '.git/info/exclude');
  assert.match(exclude, /^# git ls-files --others --exclude-from=\.git\/info\/exclude\n/, 'lines are only added: the first line stays');
  for (const line of ['/repos/', '/worktrees/', '/.recade/']) assert.ok(exclude.split('\n').includes(line), line);
  assert.match(r.warnings.join('\n'), /Commit \.gitignore/);
  mkdirSync(join(ws.dir, 'worktrees', 'api', 'S-01'), { recursive: true });
  writeFileSync(join(ws.dir, 'worktrees', 'api', 'S-01', 'build.gradle.kts'), 'x\n');
  assert.equal(git(ws.dir, 'status', '--porcelain', '--', 'worktrees', 'repos').stdout, '', 'git still ignores the checkouts');
  assert.equal(git(ws.dir, 'check-ignore', 'worktrees/api/S-01/build.gradle.kts').stdout.trim(), 'worktrees/api/S-01/build.gradle.kts');
});

test('a workspace install writes every command and every agent, sets up the local git hooks, and writes no hook, guard or workflow in git', async () => {
  const ws = await makeWorkspace();
  const r = installWs(ws);
  assert.deepEqual(names(join(ws.dir, '.claude', 'commands')), harnessCommands.map((c) => `${c}.md`).sort());
  assert.ok(existsSync(join(ws.dir, '.claude', 'commands', 'slice.md')), '/slice is typed at the root of the workspace');
  assert.match(read(ws.dir, '.claude/commands/slice.md'), /sensitive_model/, 'the real command, not the pointer');
  assert.deepEqual(names(join(ws.dir, '.claude', 'agents')).map((f) => f.replace(/\.md$/, '')).sort(), harnessAgents);
  for (const f of ['.claude/protocol.md', '.recade/plugin-root']) assert.ok(existsSync(join(ws.dir, f)), f);
  // The guard is a hook of the plugin and the git hooks are local: nothing that runs only with Recade is committed.
  for (const f of ['.claude/settings.json', '.claude/hooks/recade-guard.mjs', '.githooks', '.github/workflows/workspace.yml', '.github/workflows/ci.yml', '.github/dependabot.yml', '.recade/workspace']) {
    assert.equal(existsSync(join(ws.dir, f)), false, f);
  }
  assert.equal(read(ws.dir, '.recade/plugin-root'), `${plugin}\n`);
  for (const name of ['pre-commit', 'commit-msg']) {
    const hook = join(hooksDir(ws.dir), name);
    assert.ok(existsSync(hook), name);
    assert.ok(isExec(hook), `${name} is executable`);
    assert.match(read(hook, ''), new RegExp(LOCAL_HOOK_MARK));
  }
  assert.match(read(hooksDir(ws.dir), 'pre-commit'), /harness\/githooks\/pre-commit-workspace/, 'the workspace runs the hook of the documents');
  assert.notEqual(git(ws.dir, 'config', '--get', 'core.hooksPath').status, 0, 'no core.hooksPath: the local hooks run');
  assert.equal(r.hooksPath, true);
  assert.equal(r.written.every((w) => w.status === 'created'), true);
  const ignore = read(ws.dir, '.gitignore');
  for (const line of ['artifacts/', 'tmp/', '.recade/']) assert.ok(ignore.split('\n').includes(line), line);
  // The code checkouts are kept out by .git/info/exclude, which only git reads: a tool run in a checkout does not skip it.
  const exclude = read(ws.dir, '.git/info/exclude').split('\n');
  for (const line of ['repos/', 'worktrees/']) {
    assert.ok(exclude.includes(`/${line}`), `/${line}, anchored, so recade/repos/ stays tracked`);
    assert.equal(ignore.split('\n').includes(line), false, `${line} is not in .gitignore`);
  }
  assert.equal(installWs(ws).written.every((w) => w.status === 'unchanged'), true, 'a second install changes nothing');
  // The install record holds the hash of each file it wrote, and the version.
  const record = JSON.parse(read(ws.dir, '.recade/installed.json'));
  assert.match(record.files['.claude/commands/slice.md'], /^[0-9a-f]{64}$/);
  assert.equal(record.version, JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version);
});

test('a workspace install takes out what an older install committed: the hooks, the launcher, workspace.yml and its rules in settings.json', async () => {
  const ws = await makeWorkspace();
  mkdirSync(join(ws.dir, '.githooks'), { recursive: true });
  mkdirSync(join(ws.dir, '.claude', 'hooks'), { recursive: true });
  mkdirSync(join(ws.dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(ws.dir, '.githooks', 'pre-commit'), '#!/bin/sh\n# Recade harness pre-commit for the workspace\n');
  writeFileSync(join(ws.dir, '.githooks', 'commit-msg'), '#!/bin/sh\n# Recade harness commit-msg\n');
  writeFileSync(join(ws.dir, '.claude', 'hooks', 'recade-guard.mjs'), '// Recade harness: the launcher of the guard\n');
  writeFileSync(join(ws.dir, '.github', 'workflows', 'workspace.yml'), '# Generated by recade harness v1.5.3.\nname: Workspace\n');
  writeFileSync(join(ws.dir, '.github', 'workflows', 'mine.yml'), 'name: Mine\n');
  const template = JSON.parse(readFileSync(join(plugin, 'harness', 'settings.json'), 'utf8'));
  writeFileSync(join(ws.dir, '.claude', 'settings.json'), JSON.stringify({ ...template, permissions: { deny: [...template.permissions.deny, 'Bash(rm -rf:*)'] } }, null, 2));
  git(ws.dir, 'config', 'core.hooksPath', '.githooks');
  const r = installWs(ws);
  for (const f of ['.githooks', '.claude/hooks', '.github/workflows/workspace.yml']) assert.equal(existsSync(join(ws.dir, f)), false, f);
  assert.ok(existsSync(join(ws.dir, '.github', 'workflows', 'mine.yml')), 'a workflow of the team stays');
  const settings = JSON.parse(read(ws.dir, '.claude/settings.json'));
  assert.deepEqual(settings, { permissions: { deny: ['Bash(rm -rf:*)'] } }, 'only the rule of the team is left');
  assert.ok(r.written.some((w) => w.file === '.github/workflows/workspace.yml' && w.status === 'removed'));
  assert.notEqual(git(ws.dir, 'config', '--get', 'core.hooksPath').status, 0, 'the old core.hooksPath is unset');
  // With nothing of the team left, settings.json goes.
  writeFileSync(join(ws.dir, '.claude', 'settings.json'), `${JSON.stringify(template, null, 2)}\n`);
  installWs(ws);
  assert.equal(existsSync(join(ws.dir, '.claude', 'settings.json')), false);
});

test('a team path added to the generic Writes list of an agent moves below the specialisation line at the next install', async () => {
  const ws = await makeWorkspace();
  installWs(ws);
  const file = join(ws.dir, '.claude', 'agents', 'test-engineer.md');
  writeFileSync(file, read(ws.dir, '.claude/agents/test-engineer.md').replace('- `tests/**`', '- `tests/**`\n- `config/team-fixtures/**`'));
  const r = installWs(ws);
  const [above, below] = readFileSync(file, 'utf8').split('<!-- Project specialisation goes below this line. Re-install keeps it. -->');
  assert.doesNotMatch(above, /config\/team-fixtures/);
  assert.match(below, /## Writes\n\n- `config\/team-fixtures\/\*\*`/);
  assert.ok(parseWrites(readFileSync(file, 'utf8')).includes('config/team-fixtures/**'), 'the guard still allows it');
  assert.match(r.warnings.join('\n'), /config\/team-fixtures\/\*\* was added to its generic Writes list/);
  // A text Recade itself wrote is never read as the team's: a re-install moves nothing.
  const again = installWs(ws);
  assert.doesNotMatch(again.warnings.join('\n'), /generic Writes list/);
});

test('a code install writes only the CI of the project, once, and sets up this machine: link, local hooks, exclusions', async () => {
  const ws = await makeWorkspace({ repos: ['api', 'web'] });
  const r = installCode(ws, 'api');
  const api = ws.repo('api');
  for (const f of ['.claude', '.githooks', 'CLAUDE.md', '.github/workflows/conflicts.yml', '.github/workflows/second-opinion.yml', '.github/workflows/workspace.yml']) {
    assert.equal(existsSync(join(api, f)), false, `${f} is not written in a code repository`);
  }
  for (const f of ['.github/workflows/ci.yml', '.github/dependabot.yml', '.recade/plugin-root', '.recade/workspace']) assert.ok(existsSync(join(api, f)), f);
  assert.deepEqual(r.written.map((w) => w.file).sort(), ['.github/dependabot.yml', '.github/workflows/ci.yml']);
  assert.equal(read(api, '.recade/workspace'), `${ws.dir}\n`, 'the link is written through linkRepo');
  assert.deepEqual(checkLink(api), { ok: true });
  assert.deepEqual(git(api, 'status', '--porcelain').stdout.split('\n').filter(Boolean), ['?? .github/'], 'only the CI shows in git status');
  assert.match(read(hooksDir(api), 'pre-commit'), /harness\/githooks\/pre-commit"?/, 'the local pre-commit runs the hook of the code');
  assert.doesNotMatch(read(hooksDir(api), 'pre-commit'), /pre-commit-workspace/);
  assert.ok(isExec(join(hooksDir(api), 'commit-msg')));
  for (const line of ['/.recade/', '/.claude/settings.local.json', '/.claude/worktrees/']) assert.ok(read(api, '.git/info/exclude').split('\n').includes(line), line);
  assert.equal(existsSync(join(ws.repo('web'), '.github')), false, 'the other repository is untouched');
  // Written once: the CI belongs to the project from then on, and a later install never touches it.
  writeFileSync(join(api, '.github', 'workflows', 'ci.yml'), `${read(api, '.github/workflows/ci.yml')}# the team's step\n`);
  const again = installCode(ws, 'api');
  assert.match(read(api, '.github/workflows/ci.yml'), /# the team's step\n$/);
  assert.equal(again.written.find((w) => w.file === '.github/workflows/ci.yml').status, 'unchanged');
});

test('ci.yml of a code repository is the CI of the project: build, tests and security, nothing that fetches or names Recade', async () => {
  const ws = await makeWorkspace();
  installCode(ws, 'api');
  const code = read(ws.repo('api'), '.github/workflows/ci.yml');
  assert.equal(parseDocument(code).errors.length, 0);
  assert.doesNotMatch(code, /recade/i);
  assert.doesNotMatch(code, /__RECADE_|RECADE_REF|DEPLOY_KEY|index check|lint-style|quarantine check/);
  assert.deepEqual(Object.keys(parseDocument(code).toJS().jobs), ['code', 'quality', 'e2e', 'security']);
  assert.doesNotMatch(read(ws.repo('api'), '.github/dependabot.yml'), /recade/i);
});

test('each repository reads its own table of the sheet, and a single table serves a repository with none of its own', async () => {
  const ws = await makeWorkspace({
    repos: ['api', 'web', 'tools'],
    stack: perRepoStack({ api: { Test: 'npm run test:api', Runtime: 'python 3.12', Install: 'pip install -r requirements.txt' }, web: { Test: 'pnpm test:web' } }),
  });
  installCode(ws, 'api');
  installCode(ws, 'web');
  const api = read(ws.repo('api'), '.github/workflows/ci.yml');
  const web = read(ws.repo('web'), '.github/workflows/ci.yml');
  assert.match(api, /npm run test:api/);
  assert.doesNotMatch(api, /pnpm test:web/);
  assert.match(api, /python-version: "3\.12"/);
  assert.match(web, /pnpm test:web/);
  assert.doesNotMatch(web, /npm run test:api/);
  assert.match(web, /node-version: "22"/);
  assert.match(read(ws.repo('api'), '.github/dependabot.yml'), /pip/);
  // `tools` has no table of its own and the sheet has no shared rows: the install names the rows to fill.
  const r = installCode(ws, 'tools');
  assert.ok(r.missing.includes('Test'));
  assert.match(r.warnings.join('\n'), /no value for/);
  // A sheet with one table is used by every repository.
  const single = await makeWorkspace({ repos: ['api', 'web'] });
  assert.deepEqual(installCode(single, 'web').missing, []);
});

test('a code install proposes the threshold files that exist and writes none of them', async () => {
  const ws = await makeWorkspace();
  const api = ws.repo('api');
  for (const f of ['eslint.config.js', 'tsconfig.json', 'README.md', 'package.json']) writeFileSync(join(api, f), '{}\n');
  writeFileSync(join(api, 'tsconfig.build.json'), '{}\n');
  const r = installCode(ws, 'api');
  assert.deepEqual(r.thresholdCandidates, ['eslint.config.js', 'tsconfig.build.json', 'tsconfig.json']);
  assert.deepEqual(thresholdCandidates(api), r.thresholdCandidates);
  assert.equal(existsSync(join(api, '.claude', 'recade.yaml')), false, 'the owner chooses, the install adds nothing');
  assert.equal(loadState(ws.dir).harness, undefined);
  assert.deepEqual(installWs(ws).thresholdCandidates, []);
  const out = await cli(api, ['harness', 'install', '--ref', REF]);
  assert.match(out.stdout, /Threshold file candidates:.*eslint\.config\.js.*tsconfig\.json/);
});

test('a code install refuses a folder that is not a repository of the workspace, and a missing workspace', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  assert.throws(() => install(ws.repo('api'), { pluginRoot: plugin, target: 'code', ref: REF }), (e) => e instanceof InstallError && /workspace/.test(e.message));
  const stray = mkdtempSync(join(tmpdir(), 'recade-stray-'));
  git(stray, 'init', '-q', '-b', 'main');
  assert.throws(() => install(stray, { pluginRoot: plugin, target: 'code', workspace: ws.dir, ref: REF }), (e) => e instanceof InstallError && /repos\//.test(e.message));
  const plain = join(ws.dir, 'repos', 'plain');
  mkdirSync(plain);
  assert.throws(() => install(plain, { pluginRoot: plugin, target: 'code', workspace: ws.dir, ref: REF }), (e) => e instanceof InstallError && /git repository/.test(e.message));
  assert.equal(existsSync(join(plain, '.claude')), false, 'a refusal writes nothing');
  assert.throws(() => install(ws.dir, { pluginRoot: plugin, target: 'nowhere', ref: REF }), InstallError);
  assert.throws(() => install(stray, { pluginRoot: plugin, target: 'workspace', ref: REF }), (e) => e instanceof InstallError && /workspace/.test(e.message));
});

test('create, link, install and verify work in a workspace path with spaces and accents', async () => {
  const parent = join(mkdtempSync(join(tmpdir(), 'recade-acc-')), 'Projets Clients');
  mkdirSync(parent);
  const ws = await makeWorkspace({ parent, slug: 'Été', repos: ['api'] });
  assert.match(ws.dir, /Projets Clients\/Été-workspace$/);
  installWs(ws);
  installCode(ws, 'api');
  assert.equal(read(ws.repo('api'), '.recade/workspace'), `${ws.dir}\n`);
  assert.deepEqual(errors(await verify(ws.dir, { pluginRoot: plugin, target: 'workspace' })), []);
  assert.deepEqual(errors(await verify(ws.repo('api'), { pluginRoot: plugin, target: 'code' })), []);
  const check = await cli(ws.dir, ['repo', 'check']);
  assert.equal(check.code, 0, check.stdout + check.stderr);
  // The git hook of the workspace runs with that path.
  writeFileSync(join(ws.dir, 'notes.md'), '# Notes\n\nPlain text.\n');
  git(ws.dir, 'add', 'notes.md');
  const commit = git(ws.dir, 'commit', '-q', '-m', 'docs: notes');
  assert.equal(commit.status, 0, commit.stderr);
});

test('verify passes on both targets, and catches local hooks that are missing, not executable or bypassed, and hooks switched off', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  installWs(ws);
  installCode(ws, 'api');
  // The second opinion in the reviewer's family is a warning, allowed by second_opinion.same_family: warn.
  const real = (r) => r.findings.filter((f) => !(f.severity === 'warn' && /same model family/.test(f.message)));
  assert.deepEqual(real(await verify(ws.dir, { pluginRoot: plugin, target: 'workspace' })), []);
  assert.deepEqual(real(await verify(ws.repo('api'), { pluginRoot: plugin, target: 'code' })), []);
  const git_ = (root) => verify(root, { pluginRoot: plugin, target: root === ws.dir ? 'workspace' : 'code', only: ['git', 'settings'] });
  rmSync(join(hooksDir(ws.dir), 'pre-commit'));
  assert.match(errors(await git_(ws.dir), 'git')[0].message, /local git hook pre-commit is missing.*recade repo sync/);
  chmodSync(join(hooksDir(ws.repo('api')), 'commit-msg'), 0o644);
  assert.match(errors(await git_(ws.repo('api')), 'git')[0].message, /commit-msg is not executable/);
  git(ws.repo('api'), 'config', 'core.hooksPath', '.githooks');
  assert.ok(errors(await git_(ws.repo('api')), 'git').some((f) => /core\.hooksPath is \.githooks/.test(f.message)));
  writeFileSync(join(ws.dir, '.claude', 'settings.local.json'), '{"disableAllHooks": true}\n');
  assert.ok(errors(await git_(ws.dir), 'settings').some((f) => /disableAllHooks is true in \.claude\/settings\.local\.json/.test(f.message)));
  // The workspace does not need a code workflow, and a code repository needs no command.
  assert.deepEqual(errors(await verify(ws.dir, { pluginRoot: plugin, target: 'workspace', only: ['layout'] })), []);
  assert.deepEqual(errors(await verify(ws.repo('api'), { pluginRoot: plugin, target: 'code', only: ['layout'] })), []);
});

test('verify of a code repository fails when its link is missing or points elsewhere, and names recade repo sync', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  installCode(ws, 'api');
  rmSync(join(ws.repo('api'), '.recade', 'workspace'));
  const missing = errors(await verify(ws.repo('api'), { pluginRoot: plugin, target: 'code' }), 'layout');
  assert.ok(missing.some((f) => /link missing/.test(f.message) && /recade repo sync/.test(f.message)), JSON.stringify(missing));
  const other = await makeWorkspace({ repos: ['zz'] });
  writeFileSync(join(ws.repo('api'), '.recade', 'workspace'), `${other.dir}\n`);
  const elsewhere = errors(await verify(ws.repo('api'), { pluginRoot: plugin, target: 'code' }), 'layout');
  assert.ok(elsewhere.some((f) => /link points elsewhere/.test(f.message) && /recade repo sync/.test(f.message)), JSON.stringify(elsewhere));
});

test('the CLI: install and verify infer the code target inside a code repository, and take --target and --repo', async () => {
  const ws = await makeWorkspace({ repos: ['api', 'web'] });
  const inside = await cli(ws.repo('api'), ['harness', 'install', '--ref', REF]);
  assert.equal(inside.code, 0, inside.stderr);
  assert.ok(existsSync(join(ws.repo('api'), '.github', 'workflows', 'ci.yml')));
  assert.equal(existsSync(join(ws.repo('api'), '.claude')), false);
  assert.equal(existsSync(join(ws.dir, '.claude')), false, 'the workspace was not installed');
  const verified = await cli(ws.repo('api'), ['harness', 'verify']);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  const wt = join(ws.dir, 'worktrees', 'api', 'S-01');
  mkdirSync(join(ws.dir, 'worktrees', 'api'), { recursive: true });
  git(ws.repo('api'), 'worktree', 'add', '-q', '-b', 'slice/S-01', wt);
  const fromWorktree = await cli(wt, ['harness', 'verify']);
  assert.equal(fromWorktree.code, 0, fromWorktree.stdout + fromWorktree.stderr);
  const asWs = await cli(ws.dir, ['harness', 'install', '--target', 'workspace', '--ref', REF]);
  assert.equal(asWs.code, 0, asWs.stderr);
  assert.match(read(ws.dir, '.claude/commands/slice.md'), /sensitive_model/, 'the workspace has the real /slice');
  const byName = await cli(ws.dir, ['harness', 'install', '--target', 'code', '--repo', 'web', '--ref', REF]);
  assert.equal(byName.code, 0, byName.stderr);
  assert.ok(existsSync(join(ws.repo('web'), '.github', 'workflows', 'ci.yml')));
  const viaProject = await cli(mkdtempSync(join(tmpdir(), 'recade-cwd-')), ['harness', 'verify', '--target', 'workspace', '--project', ws.dir]);
  assert.equal(viaProject.code, 0, viaProject.stdout + viaProject.stderr);
});

test('the CLI refuses what it cannot place: no repository for --target code, an unknown target, a workspace that is not one', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  const noRepo = await cli(ws.dir, ['harness', 'install', '--target', 'code', '--ref', REF]);
  assert.equal(noRepo.code, 1);
  assert.match(noRepo.stderr, /--repo <name>/);
  const unknown = await cli(ws.dir, ['harness', 'install', '--target', 'both', '--ref', REF]);
  assert.equal(unknown.code, 2);
  const missing = await cli(ws.dir, ['harness', 'install', '--target', 'code', '--repo', 'nope', '--ref', REF]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /nope/);
  const stray = mkdtempSync(join(tmpdir(), 'recade-notws-'));
  git(stray, 'init', '-q', '-b', 'main');
  mkdirSync(join(stray, 'recade'));
  writeFileSync(join(stray, 'recade', 'state.yaml'), 'version: 1\nmode: scratch\n');
  const notWs = await cli(stray, ['harness', 'install', '--target', 'workspace', '--ref', REF]);
  assert.equal(notWs.code, 1);
  assert.match(notWs.stderr, /not a workspace/);
  // Without --target, a project that is not in a code repository keeps the whole harness, as before.
  const legacy = await cli(stray, ['harness', 'install', '--ref', REF]);
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.ok(existsSync(join(stray, '.claude', 'commands', 'slice.md')) && existsSync(join(stray, '.claude', 'commands', 'status.md')));
});

test('with no --target at the root of a workspace, install, verify and claude-md refresh mean the workspace target, never the whole harness', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  const first = await cli(ws.dir, ['harness', 'install', '--ref', REF]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(existsSync(join(ws.dir, '.github', 'workflows', 'workspace.yml')), false, 'no workflow in the workspace: its checks run in the local git hooks');
  assert.equal(existsSync(join(ws.dir, '.github', 'workflows', 'ci.yml')), false, 'no CI of a code repository in the workspace');
  assert.ok(existsSync(join(ws.dir, '.claude', 'commands', 'slice.md')), '/slice is in the workspace');
  assert.ok(existsSync(join(ws.dir, '.claude', 'agents', 'implementer.md')), 'every agent is in the workspace');
  assert.ok(existsSync(join(ws.dir, '.claude', 'commands', 'status.md')));
  const verified = await cli(ws.dir, ['harness', 'verify']);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  const refreshed = await cli(ws.dir, ['claude-md', 'refresh']);
  assert.equal(refreshed.code, 0, refreshed.stderr);
  assert.match(refreshed.stdout, /repos\/<name>\/.*stack sheet, section 12/, 'the workspace block points to the code repositories and to the stack sheet');
  assert.doesNotMatch(refreshed.stdout, /TODO|Test: /, 'no build, test or lint command of a code repository in the workspace');
  // A second install changes nothing, still as the workspace target.
  const again = await cli(ws.dir, ['harness', 'install', '--ref', REF]);
  assert.match(again.stdout, /0 created, 0 updated/);
});

test('recade gate check and harness set read and write the settings of the repository, kept in the workspace', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  const api = ws.repo('api');
  installCode(ws, 'api');
  const set = await cli(api, ['harness', 'set', '--required-gates', 'lint,test', '--threshold-files', 'eslint.config.js,tsconfig.json']);
  assert.equal(set.code, 0, set.stderr);
  assert.deepEqual(readRepoSettings(api), { required_gates: ['lint', 'test'], threshold_files: ['eslint.config.js', 'tsconfig.json'] });
  assert.match(read(ws.dir, 'recade/repos/api.yaml'), /^harness:\n {2}required_gates: \[lint, test\]\n {2}threshold_files: \[eslint\.config\.js, tsconfig\.json\]\n$/);
  assert.equal(existsSync(join(api, '.claude', 'recade.yaml')), false, 'nothing is written in the code repository');
  assert.equal(loadState(ws.dir).harness, undefined, 'the gates of a repository are not in the state of the workspace');
  const check = await cli(api, ['gate', 'check']);
  assert.equal(check.code, 1);
  assert.match(check.stdout, /^lint: missing\ntest: missing\n/);
  const wip = await cli(api, ['harness', 'set', '--wip-limit', '3']);
  assert.equal(wip.code, 0, wip.stderr);
  assert.equal(loadState(ws.dir).harness.wip_limit, 3, 'the WIP limit belongs to the project');
  assert.deepEqual(readRepoSettings(api), { required_gates: ['lint', 'test'], threshold_files: ['eslint.config.js', 'tsconfig.json'] });
  const none = await cli(api, ['harness', 'set', '--required-gates', 'none']);
  assert.equal(none.code, 0);
  assert.match((await cli(api, ['gate', 'check'])).stdout, /No required gates in .*recade\/repos\/api\.yaml/);
  const bad = await cli(api, ['harness', 'set', '--threshold-files', '../escape,/etc/passwd']);
  assert.equal(bad.code, 2);
  // A repository without its own settings file falls back to the project state, as before.
  const state = loadState(ws.dir);
  saveState(ws.dir, { ...state, harness: { ...state.harness, required_gates: ['fallback'] } });
  rmSync(join(ws.dir, 'recade', 'repos', 'api.yaml'));
  assert.match((await cli(api, ['gate', 'check'])).stdout, /^fallback: missing/);
});

test('readRepoSettings: absent, malformed and partial files, the workspace file first and the older file of the repository after', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-settings-'));
  assert.deepEqual(readRepoSettings(dir), {});
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'recade.yaml'), 'harness:\n  required_gates: [a]\n');
  assert.deepEqual(readRepoSettings(dir), { required_gates: ['a'] }, 'an older install kept them in the repository');
  writeFileSync(join(dir, '.claude', 'recade.yaml'), 'harness: [not, a, map]\n');
  assert.equal(readRepoSettings(dir).error, true);
  writeFileSync(join(dir, '.claude', 'recade.yaml'), 'harness:\n  required_gates: nope\n');
  assert.equal(readRepoSettings(dir).error, true);
  const ws = await makeWorkspace({ repos: ['api'] });
  installCode(ws, 'api');
  mkdirSync(join(ws.repo('api'), '.claude'), { recursive: true });
  writeFileSync(join(ws.repo('api'), '.claude', 'recade.yaml'), 'harness:\n  required_gates: [old]\n');
  assert.deepEqual(readRepoSettings(ws.repo('api')), { required_gates: ['old'] });
  mkdirSync(join(ws.dir, 'recade', 'repos'), { recursive: true });
  writeFileSync(join(ws.dir, 'recade', 'repos', 'api.yaml'), 'harness:\n  required_gates: [new]\n');
  assert.deepEqual(readRepoSettings(ws.repo('api')), { required_gates: ['new'] }, 'the workspace file wins');
});

test('adopt: a code repository installed from an adopted workspace keeps every file of the owner, and Recade writes none in it', async () => {
  const ws = await makeWorkspace({ repos: ['api'], mode: 'adopt' });
  const api = ws.repo('api');
  const OWNER_CI = 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n';
  const OWNER_SETTINGS = `${JSON.stringify({ permissions: { allow: ['Bash(make:*)'] } }, null, 2)}\n`;
  mkdirSync(join(api, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(api, '.claude'), { recursive: true });
  writeFileSync(join(api, '.github', 'workflows', 'ci.yml'), OWNER_CI);
  writeFileSync(join(api, '.github', 'dependabot.yml'), 'version: 2\nupdates: []\n');
  writeFileSync(join(api, '.claude', 'settings.json'), OWNER_SETTINGS);
  writeFileSync(join(api, '.gitignore'), 'node_modules/\n');
  const r = installCode(ws, 'api');
  assert.equal(read(api, '.github/workflows/ci.yml'), OWNER_CI, 'the owner CI is kept');
  assert.equal(read(api, '.github/dependabot.yml'), 'version: 2\nupdates: []\n');
  assert.equal(read(api, '.claude/settings.json'), OWNER_SETTINGS);
  assert.equal(read(api, '.gitignore'), 'node_modules/\n', 'the .gitignore of the owner is not touched: the exclusions are local');
  for (const f of ['.github/workflows/recade.yml', '.github/workflows/workspace.yml', '.githooks', '.claude/commands', '.claude/hooks']) assert.equal(existsSync(join(api, f)), false, f);
  assert.deepEqual(r.written, []);
  assert.match(r.notes.join('\n'), /Adopted repository: its own CI stays as it is, and Recade writes none/);
  assert.deepEqual(readCreated(api), [], 'nothing of Recade to record in the repository');
  // The workspace of an adopted project is Recade's own: nothing there is the owner's, and it holds no workflow either.
  installWs(ws);
  assert.equal(existsSync(join(ws.dir, '.github', 'workflows', 'workspace.yml')), false);
  assert.equal(existsSync(join(ws.dir, '.recade', 'created.json')), false);
});

test('the ID index reads the documents of the workspace only: not the harness prompts, not the code repositories under repos/', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  installWs(ws);
  writeFileSync(join(ws.dir, 'decisions', 'DEC-01.md'), '# Decision\n\nWe keep it small. See S-09.\n');
  mkdirSync(join(ws.repo('api'), 'docs'), { recursive: true });
  writeFileSync(join(ws.repo('api'), 'docs', 'notes.md'), '# Notes\n\nSee S-77 and DEC-42.\n');
  const out = await cli(ws.dir, ['index', 'check', '.']);
  assert.doesNotMatch(out.stdout, /\.claude\/|repos\//, out.stdout);
  assert.match(out.stdout, /S-09/, 'a document of the workspace is still read');
});

test('a link to another workspace stops install, verify and set with the sync advice, and nothing is written', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  const other = await makeWorkspace({ repos: ['zz'] });
  const api = ws.repo('api');
  writeFileSync(join(api, '.recade', 'workspace'), `${other.dir}\n`);
  for (const args of [['harness', 'install', '--ref', REF], ['harness', 'verify'], ['harness', 'set', '--required-gates', 'lint'], ['claude-md', 'refresh', '--write']]) {
    const r = await cli(api, args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /recade repo sync/, args.join(' '));
  }
  assert.equal(existsSync(join(api, '.claude')), false);
  assert.equal(existsSync(join(api, 'CLAUDE.md')), false);
  assert.equal(existsSync(join(other.dir, '.claude')), false, 'the other workspace was not touched either');
});

test('the settings of a code repository live in the workspace, committed there, and an older .claude/recade.yaml is carried over', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  const api = ws.repo('api');
  installCode(ws, 'api');
  mkdirSync(join(api, '.claude'), { recursive: true });
  writeFileSync(join(api, '.claude', 'recade.yaml'), 'harness:\n  threshold_files: [eslint.config.js]\n');
  assert.equal((await cli(api, ['harness', 'set', '--required-gates', 'lint'])).code, 0);
  assert.deepEqual(readRepoSettings(api), { required_gates: ['lint'], threshold_files: ['eslint.config.js'] }, 'the older value is carried over');
  assert.match(read(ws.dir, 'recade/repos/api.yaml'), /threshold_files: \[eslint\.config\.js\]/);
  assert.notEqual(git(ws.dir, 'check-ignore', '-q', 'recade/repos/api.yaml').status, 0, 'a tracked file of the workspace');
});

test('verify of a code repository reads the workspace sheet and checks the confirmation tests row of its own table', async () => {
  const sens = (repo) => `---\nid: S-02\ntitle: Refunds\nlane: sensitive\ntouches: [${repo}:src/refunds/**]\n---\n\n## Goal\n\nRefunds.\n`;
  const ws = await makeWorkspace({
    repos: ['api', 'web'],
    stack: perRepoStack({ api: { 'Confirmation tests': 'not applicable' }, web: { 'Confirmation tests': 'not applicable' } }),
  });
  writeFileSync(join(ws.dir, 'slices', 'S-02-refunds.md'), sens('api'));
  installCode(ws, 'api');
  installCode(ws, 'web');
  const api = errors(await verify(ws.repo('api'), { pluginRoot: plugin, target: 'code' }), 'ci');
  assert.equal(api.length, 1, JSON.stringify(api));
  assert.match(api[0].message, /Confirmation tests is "not applicable"/);
  assert.match(api[0].message, /table of api/);
  assert.match(api[0].message, /S-02/);
  // The sensitive slice touches api only: web has no such slice, so its "not applicable" is fine.
  assert.deepEqual(errors(await verify(ws.repo('web'), { pluginRoot: plugin, target: 'code' }), 'ci'), []);
  // A command in the api table clears it.
  writeFileSync(join(ws.dir, 'docs', 'STACK.md'), perRepoStack({ api: {}, web: { 'Confirmation tests': 'not applicable' } }));
  installCode(ws, 'api');
  assert.deepEqual(errors(await verify(ws.repo('api'), { pluginRoot: plugin, target: 'code' }), 'ci'), []);
});

test('gate check inside a code repository with no required_gates of its own names its settings file of the workspace', async () => {
  const ws = await makeWorkspace({ repos: ['api'] });
  const api = ws.repo('api');
  installCode(ws, 'api');
  const none = await cli(api, ['gate', 'check']);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No required gates/);
  assert.match(none.stdout, /recade\/repos\/api\.yaml/);
  assert.match(none.stdout, /recade harness set --required-gates/);
  // Outside a code repository the message still names the project state, as before.
  const root = mkdtempSync(join(tmpdir(), 'recade-gate-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'recade'));
  writeFileSync(join(root, 'recade', 'state.yaml'), 'version: 1\nmode: scratch\n');
  assert.match((await cli(root, ['gate', 'check'])).stdout, /No required gates in recade\/state\.yaml/);
});

test('the CI template of a code repository fetches nothing of Recade: no tools, no ref, no deploy key', () => {
  const text = readFileSync(join(plugin, 'harness', 'ci', 'ci.yml'), 'utf8');
  assert.doesNotMatch(text, /Fetch the Recade tools|RECADE_REF|RECADE_REPOSITORY|RECADE_DEPLOY_KEY|RECADE_BIN/);
});

test('the pre-commit hook passes each staged path whole to the style check, a space included, and never sets IFS', () => {
  for (const name of ['pre-commit', 'pre-commit-workspace']) {
    assert.equal(/^\s*IFS=/m.test(readFileSync(new URL(`../../harness/githooks/${name}`, import.meta.url), 'utf8')), false, `${name}: IFS is never assigned`);
  }
  const root = mkdtempSync(join(tmpdir(), 'recade-hook-'));
  const fake = join(root, 'plugin');
  mkdirSync(join(fake, 'bin'), { recursive: true });
  // The fake CLI records its arguments, then fails the style check.
  writeFileSync(join(fake, 'bin', 'recade.js'), `require('fs').writeFileSync(${JSON.stringify(join(root, 'args.json'))}, JSON.stringify(process.argv.slice(2))); process.exit(process.argv[2] === 'lint-style' ? 1 : 0);\n`);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a b.md'), 'x\n');
  writeFileSync(join(repo, 'c.md'), 'y\n');
  git(repo, 'add', '.');
  const r = spawnSync('sh', [new URL('../../harness/githooks/pre-commit', import.meta.url).pathname], { cwd: repo, encoding: 'utf8', env: { ...process.env, RECADE_PLUGIN_ROOT: fake } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /style errors in the staged files/);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'args.json'), 'utf8')), ['lint-style', 'a b.md', 'c.md']);
  rmSync(root, { recursive: true, force: true });
});

test('a Writes section the team adds below the specialisation line survives a re-install, and the guard reads it', async () => {
  const ws = await makeWorkspace();
  installWs(ws);
  const file = join(ws.dir, '.claude', 'agents', 'test-engineer.md');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n## Writes\n\n- \`config/fixtures/**\`\n`);
  installWs(ws);
  const writes = parseWrites(readFileSync(file, 'utf8'));
  assert.ok(writes.includes('config/fixtures/**'), 'the team path is kept');
  assert.ok(writes.includes('tests/**'), 'the generic paths are still read');
});

test('the workspace pre-commit hook of a worktree finds the plugin folder of the main checkout', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-wshook-'));
  const fake = join(root, 'plugin');
  mkdirSync(join(fake, 'bin'), { recursive: true });
  writeFileSync(join(fake, 'bin', 'recade.js'), `require('fs').appendFileSync(${JSON.stringify(join(root, 'calls'))}, process.argv.slice(2)[0] + '\\n');\n`);
  const main = join(root, 'ws');
  mkdirSync(join(main, '.recade'), { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, '.recade', 'plugin-root'), `${fake}\n`);
  writeFileSync(join(main, '.gitignore'), '.recade/\n');
  git(main, 'add', '.gitignore');
  git(main, 'commit', '-q', '--no-verify', '-m', 'chore: first');
  const tree = join(root, 'trial');
  git(main, 'worktree', 'add', '-q', '-b', 'trial', tree);
  writeFileSync(join(tree, 'a.md'), 'x\n');
  git(tree, 'add', 'a.md');
  const env = { ...process.env };
  delete env.RECADE_PLUGIN_ROOT;
  const r = spawnSync('sh', [new URL('../../harness/githooks/pre-commit-workspace', import.meta.url).pathname], { cwd: tree, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(join(root, 'calls'), 'utf8').trim().split('\n'), ['lint-style', 'index']);
  rmSync(root, { recursive: true, force: true });
});
