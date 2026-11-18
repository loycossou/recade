import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { install } from '../../src/harness/install.js';
import { verify } from '../../src/harness/verify.js';
import { refresh } from '../../src/harness/claudemd.js';
import { fillCi, readStack } from '../../src/harness/ci.js';
import { requiredChecks } from '../../src/harness/protect.js';
import { readCreated, writeOwnFile, CREATED_FILE } from '../../src/project/adopt.js';
import { initState } from '../../src/state.js';
import { normalizeState } from '../../src/project/state.js';
import { stringify } from 'yaml';
import { STACK, cli, git, plugin } from './fixture-project.js';

const CONFIG = { voice: 'randall-munroe', languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] } };
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (root, f) => readFileSync(join(root, f), 'utf8');
const put = (root, rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const OWNER_CI = 'name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make test\n';
const OWNER_DEPENDABOT = 'version: 2\nupdates:\n  - package-ecosystem: pip\n    directory: /\n    schedule: { interval: monthly }\n';
const OWNER_CLAUDE_MD = '# Fernhill API\n\nRules written by the team: small commits.\n\n## Deploy\n\nNever on Fridays.\n';
const OWNER_SETTINGS = `${JSON.stringify({
  permissions: { allow: ['Bash(make:*)'], deny: ['Bash(rm -rf:*)'] },
  env: { TEAM: 'fernhill' },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo team-hook' }] }] },
}, null, 2)}\n`;
/** The stack document: always `docs/STACK.md` (there is no `docs/recade/`). */
const ADOPT_STACK = STACK.replace('doc_id: STACK\n', 'doc_id: STACK\nexisting: true\n');

/**
 * An adopted repository: committed files of the owner (CI, dependabot, CLAUDE.md, settings, STACK, .gitignore, hooks
 * folder), then the adopt state written through the own-files policy (the whole-harness install of one folder).
 */
async function adopted() {
  const root = mkdtempSync(join(tmpdir(), 'recade-adopt-install-'));
  git(root, 'init', '-q', '-b', 'main');
  put(root, 'package.json', '{"name":"fernhill-api"}\n');
  put(root, 'src/index.js', 'export const x = 1;\n');
  put(root, '.github/workflows/ci.yml', OWNER_CI);
  put(root, '.github/dependabot.yml', OWNER_DEPENDABOT);
  put(root, 'CLAUDE.md', OWNER_CLAUDE_MD);
  put(root, '.claude/settings.json', OWNER_SETTINGS);
  put(root, '.gitignore', 'node_modules/\ndist\n');
  put(root, 'docs/STACK.md', ADOPT_STACK);
  put(root, 'docs/guide.md', '# Guide\n\nOwner text.\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  writeOwnFile(root, 'recade/state.yaml', stringify(normalizeState({ ...initState(root, { mode: 'adopt' }, CONFIG), full: false })));
  return root;
}

const OWNER_FILES = ['package.json', 'src/index.js', '.github/workflows/ci.yml', '.github/dependabot.yml', 'CLAUDE.md', '.gitignore', 'docs/STACK.md', 'docs/guide.md'];
const hashes = (root, files = OWNER_FILES) => Object.fromEntries(files.map((f) => [f, sha(join(root, f))]));

/** The hashes of every file of the repository outside .git and .recade, to find a file nobody should have touched. */
function tree(root) {
  const out = {};
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const rel = join(e.parentPath ?? e.path, e.name).slice(root.length + 1);
    if (!e.isFile() || rel.startsWith('.git/') || rel.startsWith('.recade/')) continue;
    out[rel] = sha(join(root, rel));
  }
  return out;
}

test('adopted repository with its own ci.yml, dependabot.yml, CLAUDE.md and settings: all kept, recade.yml written, verify passes', async () => {
  const root = await adopted();
  const before = hashes(root);
  const r = install(root, { pluginRoot: plugin });
  const after = hashes(root);
  for (const f of ['package.json', 'src/index.js', '.github/workflows/ci.yml', '.github/dependabot.yml', 'CLAUDE.md', 'docs/STACK.md', 'docs/guide.md']) {
    assert.equal(after[f], before[f], `${f} is byte for byte what it was`);
  }
  assert.ok(existsSync(join(root, '.github/workflows/recade.yml')));
  assert.ok(existsSync(join(root, '.github/workflows/recade-conflicts.yml')));
  assert.ok(existsSync(join(root, '.github/workflows/recade-second-opinion.yml')));
  assert.equal(existsSync(join(root, '.github/workflows/conflicts.yml')), false);
  assert.equal(r.written.find((w) => w.file === '.github/dependabot.yml').status, 'kept');
  const recade = read(root, '.github/workflows/recade.yml');
  assert.match(recade, /^name: Recade CI$/m);
  assert.doesNotMatch(recade, /__RECADE_/);
  assert.equal(parse(recade).name, 'Recade CI');
  assert.equal(read(root, '.github/workflows/ci.yml').includes('Recade'), false);
  const v = await verify(root, { pluginRoot: plugin });
  assert.deepEqual(v.findings.filter((f) => f.severity === 'error'), []);
});

test('the settings of the owner are merged by the plan 4 rules, never replaced', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  const s = JSON.parse(read(root, '.claude/settings.json'));
  assert.deepEqual(s.permissions.allow, ['Bash(make:*)']);
  assert.ok(s.permissions.deny.includes('Bash(rm -rf:*)'), 'the owner deny rule stays');
  assert.ok(s.permissions.deny.length > 1, 'the harness rules are added');
  assert.equal(s.env.TEAM, 'fernhill');
  const hooks = s.hooks.PreToolUse;
  assert.ok(hooks.some((h) => h.hooks.some((x) => x.command === 'echo team-hook')), 'the owner hook stays');
  assert.ok(hooks.some((h) => h.hooks.some((x) => /recade-guard\.mjs/.test(x.command))), 'the guard hook is added');
});

test('every file the install creates in adopt mode is recorded with its sha256, and no owner file is recorded', async () => {
  const root = await adopted();
  const ownerBefore = hashes(root);
  const before = tree(root);
  install(root, { pluginRoot: plugin });
  const after = tree(root);
  const recorded = JSON.parse(read(root, CREATED_FILE)).files;
  const paths = recorded.map((f) => f.path);
  const created = Object.keys(after).filter((f) => !(f in before));
  assert.ok(created.length > 30, 'the harness created many files');
  for (const f of created) assert.ok(paths.includes(f), `${f} is recorded in created.json`);
  for (const f of created) assert.equal(recorded.find((x) => x.path === f).sha256, after[f], `${f} hash`);
  for (const f of ['.github/workflows/ci.yml', '.github/dependabot.yml', 'CLAUDE.md', 'docs/STACK.md', 'docs/guide.md', 'package.json']) assert.equal(paths.includes(f), false, `${f} is the owner's`);
  assert.equal(paths.includes('.claude/settings.json'), false, 'the merged settings of the owner are not Recade\'s file');
  assert.ok(paths.includes('.github/workflows/recade.yml'));
  assert.equal(paths.includes('.recade/plugin-root'), false, 'the plugin folder of this machine is not recorded');
  assert.ok(existsSync(join(root, '.recade/plugin-root')));
  assert.deepEqual(readCreated(root).filter((p) => !p.startsWith('.claude/') && !p.startsWith('.githooks/')).sort().slice(0, 3), ['.github/workflows/recade-conflicts.yml', '.github/workflows/recade-second-opinion.yml', '.github/workflows/recade.yml']);
  assert.equal(hashes(root)['docs/guide.md'], ownerBefore['docs/guide.md']);
});

test('a re-install is idempotent: nothing changes, even the created.json', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  const first = { files: tree(root), created: read(root, CREATED_FILE) };
  const r = install(root, { pluginRoot: plugin });
  assert.deepEqual(tree(root), first.files);
  assert.equal(read(root, CREATED_FILE), first.created);
  assert.deepEqual(r.written.filter((w) => !['unchanged', 'kept'].includes(w.status)), []);
  assert.equal((await verify(root, { pluginRoot: plugin })).findings.filter((f) => f.severity === 'error').length, 0);
});

test('a re-install keeps the team text below the line in the files Recade created', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  const agent = join(root, '.claude/agents/reviewer.md');
  writeFileSync(agent, `${readFileSync(agent, 'utf8')}\nOur rule: read the migration first.\n`);
  const r = install(root, { pluginRoot: plugin });
  assert.match(readFileSync(agent, 'utf8'), /Our rule: read the migration first\./);
  assert.equal(r.written.find((w) => w.file === '.claude/agents/reviewer.md').status, 'unchanged');
  assert.equal((await verify(root, { pluginRoot: plugin })).findings.filter((f) => f.severity === 'error').length, 0);
});

test('a harness file the owner already has is kept byte for byte, with a warning, also with --force', async () => {
  const root = await adopted();
  const mine = '# My reviewer\n\nWritten by the team.\n';
  put(root, '.claude/agents/reviewer.md', mine);
  put(root, '.claude/commands/status.md', 'my status\n');
  put(root, '.githooks/pre-commit', '#!/bin/sh\necho mine\n');
  put(root, '.github/workflows/recade.yml', 'name: Mine\non: [push]\njobs: {}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'owner files');
  const before = hashes(root, ['.claude/agents/reviewer.md', '.claude/commands/status.md', '.githooks/pre-commit', '.github/workflows/recade.yml']);
  const r = install(root, { pluginRoot: plugin, force: true });
  assert.deepEqual(hashes(root, Object.keys(before)), before);
  for (const f of Object.keys(before)) assert.equal(r.written.find((w) => w.file === f).status, 'kept', f);
  assert.ok(r.warnings.some((w) => /\.githooks\/pre-commit is yours/.test(w)));
  assert.equal(readCreated(root).some((p) => Object.keys(before).includes(p)), false, 'none of them is recorded');
});

test('the CI fill reads the sheet of docs/STACK.md, and a docs/recade/STACK.md is never read', async () => {
  const root = await adopted();
  assert.equal(readStack(root), ADOPT_STACK);
  put(root, 'docs/recade/STACK.md', ADOPT_STACK.replace('npm run lint', 'not this one'));
  install(root, { pluginRoot: plugin });
  const recade = read(root, '.github/workflows/recade.yml');
  assert.match(recade, /npm run lint/);
  assert.doesNotMatch(recade, /not this one/);
  assert.match(recade, /edit docs\/STACK\.md/);
  assert.equal(fillCi('x __RECADE_LINT__', readStack(root)).text, 'x npm run lint');
});

test('CLAUDE.md refresh reads the sheet of docs/STACK.md and keeps the text of the owner outside the markers', async () => {
  const root = await adopted();
  const r = refresh(root);
  assert.match(r.next, /- Lint: `npm run lint`/);
  assert.ok(r.next.includes('Rules written by the team: small commits.'));
  assert.ok(r.next.includes('Never on Fridays.'));
  assert.deepEqual(r.missing, []);
  writeFileSync(join(root, 'CLAUDE.md'), r.next);
  assert.equal(refresh(root).diff, '', 'a second refresh changes nothing');
  assert.ok(read(root, 'CLAUDE.md').endsWith(OWNER_CLAUDE_MD), 'the original text follows the block, byte for byte');
  const cliRun = await cli(root, ['claude-md', 'refresh']);
  assert.equal(cliRun.code, 0);
  assert.match(cliRun.stdout, /up to date/);
});

test('install adds .recade/ to .gitignore by appending only, once', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  const ignore = read(root, '.gitignore');
  assert.ok(ignore.startsWith('node_modules/\ndist\n'), 'the owner lines stay, in place');
  assert.match(ignore, /^\.recade\/$/m);
  assert.equal(ignore.split('\n').filter((l) => l === '.recade/').length, 1);
  install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.gitignore'), ignore);
  assert.equal(readCreated(root).includes('.gitignore'), false);
});

test('a repository with no .gitignore gets one, recorded; an owner ignore of .recade is not doubled', async () => {
  const root = await adopted();
  git(root, 'rm', '-q', '.gitignore');
  git(root, 'commit', '-q', '-m', 'no ignore');
  install(root, { pluginRoot: plugin });
  assert.ok(readCreated(root).includes('.gitignore'));
  assert.match(read(root, '.gitignore'), /^\.recade\/$/m);
  const other = await adopted();
  put(other, '.gitignore', '.recade\n');
  const before = read(other, '.gitignore');
  install(other, { pluginRoot: plugin });
  assert.ok(read(other, '.gitignore').startsWith(before));
  assert.equal(read(other, '.gitignore').split('\n').filter((l) => /^\.recade\/?$/.test(l)).length, 1);
});

test('an adopted repository with no .claude/settings.json gets one, recorded with its hash', async () => {
  const root = await adopted();
  git(root, 'rm', '-q', '.claude/settings.json');
  git(root, 'commit', '-q', '-m', 'no settings');
  install(root, { pluginRoot: plugin });
  const record = JSON.parse(read(root, CREATED_FILE)).files.find((f) => f.path === '.claude/settings.json');
  assert.equal(record.sha256, sha(join(root, '.claude/settings.json')));
  const again = install(root, { pluginRoot: plugin });
  assert.equal(again.written.find((w) => w.file === '.claude/settings.json').status, 'unchanged');
});

test('core.hooksPath set by the owner is not overridden in adopt mode, and a warning says so', async () => {
  const root = await adopted();
  git(root, 'config', 'core.hooksPath', '.husky');
  const r = install(root, { pluginRoot: plugin });
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').stdout.trim(), '.husky');
  assert.equal(r.hooksPath, false);
  assert.ok(r.warnings.some((w) => /core\.hooksPath is \.husky/.test(w)));
  const v = await verify(root, { pluginRoot: plugin, only: ['git'] });
  assert.ok(v.findings.some((f) => f.check === 'git' && /core\.hooksPath/.test(f.message)), 'verify still reports it');
});

test('the required checks of an adopted repository are the Recade workflows, not the owner CI', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  const checks = requiredChecks(root);
  assert.ok(checks.length >= 3);
  assert.equal(checks.includes('build'), false);
});

test('verify in adopt mode wants recade.yml and does not need the owner ci.yml or dependabot.yml', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  assert.equal(existsSync(join(root, '.github/workflows/recade.yml')), true);
  // Remove the owner files from the working tree: verify passes still.
  git(root, 'rm', '-q', '.github/workflows/ci.yml', '.github/dependabot.yml');
  assert.deepEqual((await verify(root, { pluginRoot: plugin })).findings.filter((f) => f.severity === 'error'), []);
  // Without Recade's CI file, verify says which file is missing.
  rmSync(join(root, '.github/workflows/recade.yml'));
  const missing = await verify(root, { pluginRoot: plugin, only: ['layout'] });
  assert.ok(missing.findings.some((f) => /\.github\/workflows\/recade\.yml is missing/.test(f.message)));
});

test('verify names the STACK file of the sheet when a sensitive slice has no confirmation test', async () => {
  const root = await adopted();
  put(root, 'docs/STACK.md', ADOPT_STACK.replace(/\| Confirmation tests \|.*\|/, '| Confirmation tests | not applicable |'));
  put(root, 'slices/S-01-pay.md', '---\nid: S-01\ntitle: Pay\nlane: sensitive\ntouches: [src/pay/**]\n---\n\n## Goal\n\nPay.\n');
  install(root, { pluginRoot: plugin });
  const v = await verify(root, { pluginRoot: plugin, only: ['ci'] });
  assert.ok(v.findings.some((f) => /docs\/STACK\.md/.test(f.message) && /Confirmation tests/.test(f.message)));
});

test('the install refuses nothing it cannot undo: a settings file that is not JSON stops it before any write', async () => {
  const root = await adopted();
  put(root, '.claude/settings.json', '{ nope');
  const before = tree(root);
  assert.throws(() => install(root, { pluginRoot: plugin }), /not valid JSON/);
  assert.deepEqual(tree(root), before);
});

test('through the CLI: recade harness install in an adopted repository', async () => {
  const root = await adopted();
  const ownerBefore = hashes(root);
  const r = await cli(root, ['harness', 'install']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /recade\.yml/);
  assert.equal(r.stdout.includes('.github/workflows/ci.yml'), false);
  for (const f of ['.github/workflows/ci.yml', '.github/dependabot.yml', 'CLAUDE.md', 'docs/STACK.md']) assert.equal(sha(join(root, f)), ownerBefore[f]);
  const v = await cli(root, ['harness', 'verify']);
  assert.equal(v.code, 0, v.stdout + v.stderr);
});

test('a workflow, a git hook and the launcher that Recade wrote and the owner edited survive a re-install, kept with a warning', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  const edited = ['.github/workflows/recade.yml', '.githooks/pre-commit', '.claude/hooks/recade-guard.mjs', '.github/workflows/recade-conflicts.yml'];
  for (const f of edited) writeFileSync(join(root, f), `${read(root, f)}\n# edited by the team\n`);
  const before = hashes(root, edited);
  const r = install(root, { pluginRoot: plugin });
  assert.deepEqual(hashes(root, edited), before, 'byte for byte');
  for (const f of edited) {
    assert.equal(r.written.find((w) => w.file === f).status, 'kept', f);
    assert.ok(r.warnings.some((w) => w.startsWith(`${f} was written by Recade and edited since`)), f);
  }
  // A Markdown file with its specialisation line is still merged, the team text below it kept.
  const agent = join(root, '.claude/agents/reviewer.md');
  writeFileSync(agent, `${readFileSync(agent, 'utf8')}\nOur rule.\n`);
  assert.equal(install(root, { pluginRoot: plugin }).written.find((w) => w.file === '.claude/agents/reviewer.md').status, 'unchanged');
  assert.match(readFileSync(agent, 'utf8'), /Our rule\./);
});

test('a hook of the owner in .git/hooks or an own .githooks/pre-commit stops core.hooksPath from being set, with a warning', async () => {
  const root = await adopted();
  put(root, '.git/hooks/pre-push', '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, '.git/hooks/pre-push'), 0o755);
  const r = install(root, { pluginRoot: plugin });
  assert.equal(git(root, 'config', '--get', 'core.hooksPath').stdout.trim(), '');
  assert.equal(r.hooksPath, false);
  assert.ok(r.warnings.some((w) => /git hooks of your own \(\.git\/hooks\/pre-push\)/.test(w)));
  assert.equal(readFileSync(join(root, '.git/hooks/pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n');
  const own = await adopted();
  put(own, '.githooks/pre-commit', '#!/bin/sh\necho mine\n');
  git(own, 'add', '-A');
  git(own, 'commit', '-q', '-m', 'hook');
  const r2 = install(own, { pluginRoot: plugin });
  assert.equal(git(own, 'config', '--get', 'core.hooksPath').stdout.trim(), '');
  assert.ok(r2.warnings.some((w) => /\.githooks\/pre-commit/.test(w) && /core\.hooksPath was not set/.test(w)));
  // A sample hook and a hook that is not executable are not a hook of the owner.
  const plain = await adopted();
  put(plain, '.git/hooks/pre-commit.sample', '#!/bin/sh\n');
  chmodSync(join(plain, '.git/hooks/pre-commit.sample'), 0o755);
  put(plain, '.git/hooks/commit-msg', 'not executable\n');
  chmodSync(join(plain, '.git/hooks/commit-msg'), 0o644);
  assert.equal(install(plain, { pluginRoot: plugin }).hooksPath, true);
});

test('the STACK path is the real one: CLAUDE.md names it, the agents and commands do not hard-code docs/STACK.md, the CI messages name it', async () => {
  const root = await adopted();
  const block = refresh(root).next;
  assert.match(block, /- Stack and harness technical sheet: `docs\/STACK\.md`/);
  for (const dir of ['agents', 'commands']) {
    for (const f of readdirSync(join(plugin, 'harness', dir))) {
      assert.equal(readFileSync(join(plugin, 'harness', dir, f), 'utf8').includes('docs/STACK.md'), false, `${dir}/${f}`);
    }
  }
  assert.ok(readFileSync(join(plugin, 'harness/agents/implementer.md'), 'utf8').includes('the path named in CLAUDE.md'));
  // A row missing from the sheet: the CI step and the warning name the file that holds the sheet.
  put(root, 'docs/STACK.md', ADOPT_STACK.replace(/\| Install \|.*\n/, ''));
  const r = install(root, { pluginRoot: plugin });
  assert.match(read(root, '.github/workflows/recade.yml'), /Fill it in docs\/STACK\.md/);
  assert.ok(r.warnings.some((w) => /sheet of docs\/STACK\.md has no value for Install/.test(w)));
  const noRow = await adopted();
  put(noRow, 'docs/STACK.md', ADOPT_STACK.replace(/\| Lint \|.*\n/, ''));
  const c = await cli(noRow, ['claude-md', 'refresh']);
  assert.match(c.stderr, /harness tech sheet of docs\/STACK\.md has no value for Lint/);
});

test('in adopt mode every job of the Recade workflows is named "Recade: ...", and the required checks follow', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  const names = [];
  for (const f of ['recade.yml', 'recade-conflicts.yml', 'recade-second-opinion.yml']) {
    const doc = parse(read(root, `.github/workflows/${f}`));
    for (const [key, job] of Object.entries(doc.jobs)) {
      assert.match(job.name, /^Recade: /, `${f} ${key}`);
      names.push(job.name);
    }
  }
  assert.ok(names.includes('Recade: Lint, types, unit and contract tests'));
  assert.ok(names.includes('Recade: conflicts'));
  assert.deepEqual(requiredChecks(root), names.filter((n) => !/second-opinion/.test(n)));
  assert.equal(parse(read(root, '.github/workflows/ci.yml')).jobs.build.name, undefined, 'the owner workflow is untouched');
});
