import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { LOCAL_HOOK_MARK, install } from '../../src/harness/install.js';
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

test('adopted repository with its own ci.yml, dependabot.yml, CLAUDE.md and settings: all kept, no workflow of Recade written, verify passes', async () => {
  const root = await adopted();
  const before = hashes(root);
  const settings = read(root, '.claude/settings.json');
  const r = install(root, { pluginRoot: plugin });
  const after = hashes(root);
  for (const f of ['package.json', 'src/index.js', '.github/workflows/ci.yml', '.github/dependabot.yml', 'CLAUDE.md', 'docs/STACK.md', 'docs/guide.md']) {
    assert.equal(after[f], before[f], `${f} is byte for byte what it was`);
  }
  assert.equal(read(root, '.claude/settings.json'), settings, 'the settings of the owner are not touched');
  for (const f of ['recade.yml', 'recade-conflicts.yml', 'recade-second-opinion.yml', 'conflicts.yml', 'second-opinion.yml']) {
    assert.equal(existsSync(join(root, '.github/workflows', f)), false, `${f} is not written`);
  }
  assert.ok(r.notes.some((n) => /Adopted repository: its own CI stays/.test(n)));
  assert.equal(existsSync(join(root, '.githooks')), false, 'no git hook is committed');
  assert.equal(existsSync(join(root, '.claude/hooks/recade-guard.mjs')), false, 'no guard launcher');
  assert.equal('ref' in r, false);
  const v = await verify(root, { pluginRoot: plugin });
  assert.deepEqual(v.findings.filter((f) => f.severity === 'error'), []);
});

test('the settings of the owner are never rewritten, and what an older install put there is taken out', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.claude/settings.json'), OWNER_SETTINGS, 'byte for byte');
  // An older install merged its guard hook and its deny rules into the settings of the owner: they go, the owner's stay.
  const template = JSON.parse(readFileSync(join(plugin, 'harness', 'settings.json'), 'utf8'));
  const old = JSON.parse(OWNER_SETTINGS);
  old.permissions.deny.push(...template.permissions.deny);
  old.hooks.PreToolUse.unshift({ matcher: 'Write|Edit|Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/recade-guard.mjs"' }] });
  put(root, '.claude/settings.json', `${JSON.stringify(old, null, 2)}\n`);
  install(root, { pluginRoot: plugin });
  const s = JSON.parse(read(root, '.claude/settings.json'));
  assert.deepEqual(s.permissions.allow, ['Bash(make:*)']);
  assert.deepEqual(s.permissions.deny, ['Bash(rm -rf:*)'], 'the owner deny rule stays, the harness rules go');
  assert.equal(s.env.TEAM, 'fernhill');
  const hooks = s.hooks.PreToolUse;
  assert.ok(hooks.some((h) => h.hooks.some((x) => x.command === 'echo team-hook')), 'the owner hook stays');
  assert.equal(hooks.some((h) => h.hooks.some((x) => /recade-guard\.mjs/.test(x.command))), false, 'the guard hook of the older install goes');
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
  for (const f of created) assert.ok(f.startsWith('.claude/'), `${f}: only the agents, the commands and the protocol`);
  for (const f of ['.github/workflows/ci.yml', '.github/dependabot.yml', 'CLAUDE.md', 'docs/STACK.md', 'docs/guide.md', 'package.json']) assert.equal(paths.includes(f), false, `${f} is the owner's`);
  assert.equal(paths.includes('.claude/settings.json'), false, 'the settings of the owner are not Recade\'s file');
  assert.equal(paths.includes('.recade/plugin-root'), false, 'the plugin folder of this machine is not recorded');
  assert.ok(existsSync(join(root, '.recade/plugin-root')));
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
  for (const f of ['.claude/agents/reviewer.md', '.claude/commands/status.md']) assert.equal(r.written.find((w) => w.file === f).status, 'kept', f);
  // A git hook and a workflow of the owner are not Recade's to write any more: the install does not even list them.
  for (const f of ['.githooks/pre-commit', '.github/workflows/recade.yml']) assert.equal(r.written.some((w) => w.file === f), false, f);
  assert.ok(r.warnings.some((w) => /\.claude\/agents\/reviewer\.md is yours/.test(w)));
  assert.equal(readCreated(root).some((p) => Object.keys(before).includes(p)), false, 'none of them is recorded');
});

test('the CI fill reads the sheet of docs/STACK.md, and a docs/recade/STACK.md is never read', async () => {
  const root = await adopted();
  assert.equal(readStack(root), ADOPT_STACK);
  put(root, 'docs/recade/STACK.md', ADOPT_STACK.replace('npm run lint', 'not this one'));
  assert.equal(readStack(root), ADOPT_STACK);
  assert.equal(fillCi('x __RECADE_LINT__', readStack(root)).text, 'x npm run lint');
  // The CI of an adopted repository is the owner's: nothing is filled into it.
  install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.github/workflows/ci.yml'), OWNER_CI);
  assert.equal(existsSync(join(root, '.github/workflows/recade.yml')), false);
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

test('install keeps .recade/ out of git by .git/info/exclude, and never touches the .gitignore of the owner', async () => {
  const root = await adopted();
  const ignore = read(root, '.gitignore');
  install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.gitignore'), ignore, 'byte for byte');
  const exclude = read(root, '.git/info/exclude').split('\n');
  assert.equal(exclude.filter((l) => l === '/.recade/').length, 1);
  install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.git/info/exclude').split('\n').filter((l) => l === '/.recade/').length, 1, 'once');
  assert.equal(git(root, 'status', '--porcelain', '--', '.recade').stdout, '', 'git does not see .recade/');
  assert.equal(readCreated(root).includes('.gitignore'), false);
});

test('a repository with no .gitignore gets none, and .recade/ stays out of git', async () => {
  const root = await adopted();
  git(root, 'rm', '-q', '.gitignore');
  git(root, 'commit', '-q', '-m', 'no ignore');
  install(root, { pluginRoot: plugin });
  assert.equal(existsSync(join(root, '.gitignore')), false);
  assert.equal(readCreated(root).includes('.gitignore'), false);
  assert.equal(git(root, 'status', '--porcelain', '--', '.recade').stdout, '');
});

test('an adopted repository with no .claude/settings.json gets none: the guard is a hook of the plugin', async () => {
  const root = await adopted();
  git(root, 'rm', '-q', '.claude/settings.json');
  git(root, 'commit', '-q', '-m', 'no settings');
  const r = install(root, { pluginRoot: plugin });
  assert.equal(existsSync(join(root, '.claude/settings.json')), false);
  assert.equal(r.written.some((w) => w.file === '.claude/settings.json'), false);
  assert.equal(readCreated(root).includes('.claude/settings.json'), false);
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

test('an adopted repository has no required check of Recade: its CI and its checks are the owner\'s', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  assert.deepEqual(requiredChecks(root), []);
  assert.equal(parse(read(root, '.github/workflows/ci.yml')).jobs.build.name, undefined, 'the owner workflow is untouched');
});

test('verify in adopt mode needs no CI file at all, neither the owner\'s nor one of Recade', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  git(root, 'rm', '-q', '.github/workflows/ci.yml', '.github/dependabot.yml');
  const v = await verify(root, { pluginRoot: plugin });
  assert.deepEqual(v.findings.filter((f) => f.severity === 'error'), []);
  assert.equal(v.findings.some((f) => /recade\.yml|ci\.yml|dependabot/.test(f.message)), false);
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
  assert.match(r.stdout, /Adopted repository: its own CI stays/);
  assert.doesNotMatch(r.stdout, /\.github\/workflows\//);
  for (const f of ['.github/workflows/ci.yml', '.github/dependabot.yml', 'CLAUDE.md', 'docs/STACK.md']) assert.equal(sha(join(root, f)), ownerBefore[f]);
  const v = await cli(root, ['harness', 'verify']);
  assert.equal(v.code, 0, v.stdout + v.stderr);
});

test('a re-install merges a Markdown file Recade wrote, the team text below the line kept, and writes no workflow, hook or launcher', async () => {
  const root = await adopted();
  install(root, { pluginRoot: plugin });
  const agent = join(root, '.claude/agents/reviewer.md');
  writeFileSync(agent, `${readFileSync(agent, 'utf8')}\nOur rule.\n`);
  const r = install(root, { pluginRoot: plugin });
  assert.equal(r.written.find((w) => w.file === '.claude/agents/reviewer.md').status, 'unchanged');
  assert.match(readFileSync(agent, 'utf8'), /Our rule\./);
  assert.equal(r.written.some((w) => /^\.github\/|^\.githooks\/|recade-guard\.mjs$/.test(w.file)), false);
});

test('a git hook of the owner is never replaced: the local Recade hooks go beside the others, and an own pre-commit stays with a warning', async () => {
  const root = await adopted();
  put(root, '.git/hooks/pre-push', '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, '.git/hooks/pre-push'), 0o755);
  const r = install(root, { pluginRoot: plugin });
  assert.equal(r.hooksPath, true, 'pre-push is not a hook Recade writes: its hooks go in beside it');
  assert.equal(readFileSync(join(root, '.git/hooks/pre-push'), 'utf8'), '#!/bin/sh\nexit 0\n');
  assert.match(readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8'), new RegExp(LOCAL_HOOK_MARK));
  // An own pre-commit in .git/hooks stays, byte for byte, and the warning names it.
  const own = await adopted();
  put(own, '.git/hooks/pre-commit', '#!/bin/sh\necho mine\n');
  chmodSync(join(own, '.git/hooks/pre-commit'), 0o755);
  const r2 = install(own, { pluginRoot: plugin });
  assert.equal(r2.hooksPath, false);
  assert.equal(readFileSync(join(own, '.git/hooks/pre-commit'), 'utf8'), '#!/bin/sh\necho mine\n');
  assert.ok(r2.warnings.some((w) => /pre-commit is a git hook of yours/.test(w)));
  // The core.hooksPath=.githooks of an older install is unset, so the local hooks run.
  const older = await adopted();
  git(older, 'config', 'core.hooksPath', '.githooks');
  assert.equal(install(older, { pluginRoot: plugin }).hooksPath, true);
  assert.equal(git(older, 'config', '--get', 'core.hooksPath').stdout.trim(), '');
});

test('the STACK path is the real one: CLAUDE.md names it, the agents and commands do not hard-code docs/STACK.md, the refresh names it', async () => {
  const root = await adopted();
  const block = refresh(root).next;
  assert.match(block, /- Stack and harness technical sheet: `docs\/STACK\.md`/);
  for (const dir of ['agents', 'commands']) {
    for (const f of readdirSync(join(plugin, 'harness', dir))) {
      assert.equal(readFileSync(join(plugin, 'harness', dir, f), 'utf8').includes('docs/STACK.md'), false, `${dir}/${f}`);
    }
  }
  assert.ok(readFileSync(join(plugin, 'harness/agents/implementer.md'), 'utf8').includes('the path named in CLAUDE.md'));
  const noRow = await adopted();
  put(noRow, 'docs/STACK.md', ADOPT_STACK.replace(/\| Lint \|.*\n/, ''));
  const c = await cli(noRow, ['claude-md', 'refresh']);
  assert.match(c.stderr, /harness tech sheet of docs\/STACK\.md has no value for Lint/);
});

