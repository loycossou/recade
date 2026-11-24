import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { spawnSync } from 'node:child_process';
import { LOCAL_HOOK_MARK, SPEC_LINE, InstallError, cleanSettings, genericOf, install, lineDiff, mergeMarkdown, mergeSettings, publishedSha, resolveRef } from '../../src/harness/install.js';
import { STACK, cli, fakePlugin, git, makeProject, plugin } from './fixture-project.js';
import { fingerprint } from '../../src/harness/history.js';
import { parseWrites } from '../../src/harness/guard.js';

const read = (root, f) => readFileSync(join(root, f), 'utf8');
const hooksPath = (root) => git(root, 'config', '--get', 'core.hooksPath').stdout.trim();
/** An exec that answers the git questions of resolveRef from a table, and runs nothing else. */
const gitAnswers = ({ tag = false, sha = null, top = null, contained = 'origin/main' }) => (cmd) => {
  const args = cmd.join(' ');
  if (args.includes('branch -r --contains')) return { code: 0, stdout: contained === null ? '' : `  ${contained}\n`, stderr: '' };
  if (args.includes('tag --contains')) return { code: 0, stdout: '', stderr: '' };
  if (args.includes('--verify -q refs/tags/')) return tag ? { code: 0, stdout: 'x\n', stderr: '' } : { code: 1, stdout: '', stderr: '' };
  if (args.includes('--show-toplevel')) return top === null ? { code: 128, stdout: '', stderr: 'no' } : { code: 0, stdout: `${top}\n`, stderr: '' };
  if (args.includes('--verify -q HEAD')) return sha === null ? { code: 128, stdout: '', stderr: '' } : { code: 0, stdout: `${sha}\n`, stderr: '' };
  if (cmd[1] === 'config') return { code: 0, stdout: '', stderr: '' };
  throw new Error(`unexpected ${args}`);
};

test('install copies the template into the project: agents, commands, protocol, the CI once, and the local git hooks', () => {
  const root = makeProject();
  const r = install(root, { pluginRoot: plugin });
  assert.equal(readdirSync(join(root, '.claude', 'agents')).length, readdirSync(join(plugin, 'harness', 'agents')).filter((f) => f.endsWith('.md')).length);
  assert.equal(readdirSync(join(root, '.claude', 'commands')).length, readdirSync(join(plugin, 'harness', 'commands')).filter((f) => f.endsWith('.md')).length);
  for (const f of ['.claude/protocol.md', '.github/workflows/ci.yml', '.github/dependabot.yml', '.recade/plugin-root']) assert.ok(existsSync(join(root, f)), f);
  // Nothing that runs only with Recade is written in the tree: the guard is a hook of the plugin, the git hooks are local.
  for (const f of ['.claude/settings.json', '.claude/hooks/recade-guard.mjs', '.githooks', '.github/workflows/conflicts.yml', '.github/workflows/second-opinion.yml']) assert.equal(existsSync(join(root, f)), false, f);
  assert.equal(r.written.every((w) => w.status === 'created'), true);
  for (const name of ['pre-commit', 'commit-msg']) {
    const hook = join(root, '.git', 'hooks', name);
    assert.ok((statSync(hook).mode & 0o111) !== 0, `${name} is executable`);
    assert.match(readFileSync(hook, 'utf8'), new RegExp(LOCAL_HOOK_MARK));
  }
  assert.equal(r.hooksPath, true);
  assert.equal(r.version, JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version);
});

test('install writes .recade/plugin-root, commits no path of the machine, and keeps its own files out of git by .git/info/exclude', () => {
  const root = makeProject();
  git(root, 'config', 'core.hooksPath', '.githooks');
  const r = install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.recade/plugin-root'), `${plugin}\n`);
  for (const dir of ['.claude', '.github']) {
    for (const e of readdirSync(join(root, dir), { recursive: true, withFileTypes: true }).filter((x) => x.isFile())) {
      const text = readFileSync(join(e.parentPath ?? e.path, e.name), 'utf8');
      assert.doesNotMatch(text, /__RECADE_/, e.name);
      assert.equal(text.includes(plugin), false, `${e.name} holds the plugin folder of this machine`);
    }
  }
  // The core.hooksPath of an older install pointed at the committed copies: it goes, so the local hooks run.
  assert.equal(hooksPath(root), '');
  assert.equal(r.hooksPath, true);
  assert.equal(existsSync(join(root, '.gitignore')), false, 'the .gitignore of the project is not written');
  const exclude = read(root, '.git/info/exclude');
  for (const line of ['/.recade/', '/.claude/worktrees/', '/.claude/settings.local.json']) assert.ok(exclude.split('\n').includes(line), line);
  install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.git/info/exclude'), exclude, 'a second install adds no line');
  assert.equal(git(root, 'status', '--porcelain', '--', '.recade').stdout, '', '.recade/ stays out of git');
});

test('the worktrees of the slices are ignored, so git add .claude does not take them', () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'chore: start');
  const wt = git(root, 'worktree', 'add', '-q', '-b', 'slice/S-01-accounts', join(root, '.claude', 'worktrees', 'S-01'));
  assert.equal(wt.status, 0, wt.stderr);
  writeFileSync(join(root, '.claude', 'settings.local.json'), '{}\n');
  git(root, 'add', '.claude');
  assert.equal(git(root, 'diff', '--cached', '--name-only').stdout, '');
});

test('a plugin folder given with a trailing slash is recorded without it', () => {
  const root = makeProject();
  install(root, { pluginRoot: `${plugin}/` });
  assert.equal(read(root, '.recade/plugin-root'), `${plugin}\n`);
});

test('a re-install over an older settings file takes out the committed plugin folder and the old guard entry, and keeps the rest', () => {
  const root = makeProject();
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
    env: { RECADE_PLUGIN_ROOT: '/home/someone/plugin', MY_VAR: '1' },
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node "$RECADE_PLUGIN_ROOT/harness/hooks/guard.mjs"' }] }] },
  }));
  const r = install(root, { pluginRoot: plugin });
  assert.deepEqual(JSON.parse(read(root, '.claude/settings.json')), { env: { MY_VAR: '1' } });
  assert.equal(r.written.find((w) => w.file === '.claude/settings.json').status, 'updated');
  assert.equal(mergeSettings(JSON.stringify({ env: { RECADE_PLUGIN_ROOT: '/x' } }), {}).includes('"env"'), false);
});

test('a settings file that held only what an older install wrote is removed', () => {
  const root = makeProject();
  const template = JSON.parse(readFileSync(join(plugin, 'harness', 'settings.json'), 'utf8'));
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), mergeSettings(null, template));
  const r = install(root, { pluginRoot: plugin });
  assert.equal(existsSync(join(root, '.claude', 'settings.json')), false);
  assert.equal(r.written.find((w) => w.file === '.claude/settings.json').status, 'removed');
});

test('cleanSettings takes out the launcher hooks, the template deny rules and RECADE_PLUGIN_ROOT, and only them', () => {
  const template = JSON.parse(readFileSync(join(plugin, 'harness', 'settings.json'), 'utf8'));
  const older = JSON.parse(mergeSettings(JSON.stringify({
    model: 'sonnet',
    permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(rm -rf *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }), template));
  older.env = { RECADE_PLUGIN_ROOT: '/x' };
  const text = JSON.stringify(older, null, 2);
  const out = JSON.parse(cleanSettings(text, template));
  assert.deepEqual(out, {
    model: 'sonnet',
    permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(rm -rf *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  });
  assert.equal(cleanSettings(mergeSettings(null, template), template), null, 'nothing of the project left: the file can go');
  const own = '{\n  "model": "opus"\n}\n';
  assert.equal(cleanSettings(own, template), own, 'a file with nothing of Recade is returned byte for byte');
  assert.throws(() => cleanSettings('{ not json', template), InstallError);
});

test('the SessionStart hook of the launcher is merged like the guard: once, first, and the project keeps its own', () => {
  const template = JSON.parse(readFileSync(join(plugin, 'harness', 'settings.json'), 'utf8'));
  const own = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hello' }] };
  const once = JSON.parse(mergeSettings(JSON.stringify({ hooks: { SessionStart: [own] } }), template));
  const twice = JSON.parse(mergeSettings(JSON.stringify(once), template));
  assert.deepEqual(twice, once, 'a second install changes nothing');
  assert.equal(once.hooks.SessionStart.length, 2);
  assert.match(once.hooks.SessionStart[0].hooks[0].command, /recade-guard\.mjs" --session-start \|\| true$/);
  assert.deepEqual(once.hooks.SessionStart[1], own);
});

test('publishedSha warns about a commit that no remote branch and no tag holds, and suggests --ref <tag>', () => {
  const sha = 'b'.repeat(40);
  assert.equal(publishedSha('/p', sha, gitAnswers({})), null);
  assert.match(publishedSha('/p', sha, gitAnswers({ contained: null })), /--ref <tag>/);
});

test('install is idempotent: a second run changes nothing', () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  const again = install(root, { pluginRoot: plugin });
  assert.deepEqual([...new Set(again.written.map((w) => w.status))], ['unchanged']);
  assert.deepEqual(again.diffs, []);
});

test('every Markdown file carries the version header and the specialisation line', () => {
  const root = makeProject();
  const r = install(root, { pluginRoot: plugin });
  for (const w of r.written.filter((x) => x.file.endsWith('.md'))) {
    const text = read(root, w.file);
    assert.match(text, /^(?:---\n[\s\S]*?\n---\n)?<!-- recade-harness v\d+\.\d+\.\d+: specialise below the line -->$/m, w.file);
    assert.ok(text.endsWith(`${SPEC_LINE}\n`), w.file);
    assert.equal(text.split(SPEC_LINE).length, 2, `${w.file}: one line`);
  }
  assert.match(read(root, '.claude/agents/reviewer.md'), /^---\nname: reviewer\n/);
});

test('resolveRef gives a tag or a commit of the plugin folder, never main', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(resolveRef('/p', '1.2.3', gitAnswers({ tag: true })), { ref: 'v1.2.3', assumed: false });
  assert.deepEqual(resolveRef(plugin, '1.2.3', gitAnswers({ sha, top: plugin })), { ref: sha, assumed: false });
  // A plugin folder inside another repository must not borrow that repository's commit.
  assert.deepEqual(resolveRef(plugin, '1.2.3', gitAnswers({ sha, top: '/elsewhere' })), { ref: 'v1.2.3', assumed: true });
  assert.deepEqual(resolveRef(plugin, '1.2.3', gitAnswers({})), { ref: 'v1.2.3', assumed: true });
});

test('the CI of the project never fetches Recade: no ref, no tool, no deploy key, and --ref changes nothing', () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin, ref: 'v2.0.1' });
  const ci = read(root, '.github/workflows/ci.yml');
  assert.doesNotMatch(ci, /recade/i);
  assert.equal(parseDocument(ci).toJS().env, undefined);
  assert.doesNotMatch(read(root, '.github/dependabot.yml'), /recade/i);
});

test('ci.yml and dependabot.yml are written once from STACK, then belong to the project', () => {
  const root = makeProject();
  const r = install(root, { pluginRoot: plugin });
  const ci = read(root, '.github/workflows/ci.yml');
  assert.doesNotMatch(ci, /^# Generated by recade harness/m);
  assert.match(ci, /npm run test:contract/);
  assert.equal(parseDocument(ci).errors.length, 0);
  assert.match(read(root, '.github/dependabot.yml'), /package-ecosystem: npm/);
  assert.deepEqual(r.missing, []);
  // A hand edit stays: the file is the project's now.
  writeFileSync(join(root, '.github/workflows/ci.yml'), `${ci}\n# my edit\n`);
  const again = install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.github/workflows/ci.yml'), `${ci}\n# my edit\n`);
  assert.equal(again.written.find((w) => w.file === '.github/workflows/ci.yml').status, 'unchanged');
});

test('a STACK sheet with unfilled rows warns and lists them, and CI still fails on those rows', () => {
  const stack = STACK.split('\n').filter((l) => !/^\| (SAST|Secret scan) \|/.test(l)).join('\n');
  const root = makeProject({ stack });
  const r = install(root, { pluginRoot: plugin });
  assert.deepEqual(r.missing.sort(), ['SAST', 'Secret scan']);
  assert.ok(r.warnings.some((w) => w.includes('SAST, Secret scan') || (w.includes('SAST') && w.includes('Secret scan'))));
  assert.match(read(root, '.github/workflows/ci.yml'), /No command is set for SAST yet[^\n]*exit 1/);
});

test('with no STACK at all the install still runs, warns, and skips dependabot', () => {
  const root = makeProject({ stack: null });
  const r = install(root, { pluginRoot: plugin });
  assert.ok(r.missing.includes('Runtime') && r.missing.includes('Install'));
  assert.ok(r.warnings.some((w) => w.includes('dependabot.yml was not written')));
  assert.equal(existsSync(join(root, '.github', 'dependabot.yml')), false);
});

test('re-install keeps everything below the specialisation line byte for byte, updates the generic part and shows a diff (review focus 5)', () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  const mine = `\n## Project invariants\n\n- A balance is never negative. Checked by: npm run test:invariants.\n  trailing spaces   \n\n\tTab line\r\nlast line without a newline`;
  const files = ['.claude/agents/reviewer.md', '.claude/agents/domain-reviewer.md', '.claude/commands/slice.md', '.claude/protocol.md'];
  for (const f of files) writeFileSync(join(root, f), `${read(root, f)}${mine}`);
  const before = Object.fromEntries(files.map((f) => [f, read(root, f)]));

  const newer = fakePlugin('9.9.9', (p) => {
    const file = join(p, 'harness', 'agents', 'reviewer.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('## Role', '## Role\n\nA new sentence of the next version.'));
  });
  const r = install(root, { pluginRoot: newer, ref: 'v9.9.9' });

  for (const f of files) {
    const text = read(root, f);
    assert.ok(text.endsWith(`${SPEC_LINE}\n${mine}`), `${f}: the text below the line is byte-identical`);
    assert.match(text, /recade-harness v9\.9\.9: specialise below the line/, `${f}: the header moved to the new version`);
  }
  assert.match(read(root, '.claude/agents/reviewer.md'), /A new sentence of the next version\./);
  assert.notEqual(read(root, '.claude/agents/reviewer.md'), before['.claude/agents/reviewer.md']);
  const reviewerDiff = r.diffs.find((d) => d.file === '.claude/agents/reviewer.md').diff;
  assert.match(reviewerDiff, /^\+A new sentence of the next version\.$/m);
  const current = JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version.replaceAll('.', '\\.');
  assert.match(reviewerDiff, new RegExp(`^-<!-- recade-harness v${current}`, 'm'));
  assert.match(reviewerDiff, /^\+<!-- recade-harness v9\.9\.9/m);
  assert.equal(r.written.find((w) => w.file === '.claude/agents/reviewer.md').status, 'updated');
  // The plugin root recorded is the new one.
  assert.equal(read(root, '.recade/plugin-root'), `${newer}\n`);
});

test('a Markdown file without a specialisation line is left as it is, with a warning', () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  writeFileSync(join(root, '.claude/agents/explorer.md'), '---\nname: explorer\ndescription: My own explorer that I wrote by hand for this project.\n---\n\nMine.\n');
  const r = install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.claude/agents/explorer.md').includes('Mine.'), true);
  assert.equal(r.written.find((w) => w.file === '.claude/agents/explorer.md').status, 'kept');
  assert.ok(r.warnings.some((w) => w.includes('explorer.md') && w.includes('specialisation line')));
  assert.ok(r.diffs.some((d) => d.file === '.claude/agents/explorer.md'));
});

test('mergeMarkdown, genericOf and lineDiff on small texts', () => {
  const generic = genericOf('---\nname: a\n---\n\n## Role\n\nText.\n', '1.0.0');
  assert.equal(generic, '---\nname: a\n---\n<!-- recade-harness v1.0.0: specialise below the line -->\n\n## Role\n\nText.\n');
  // A template that already carries the header and the line is not doubled.
  assert.equal(genericOf(`<!-- recade-harness v0.0.1: specialise below the line -->\n\n# T\n\n${SPEC_LINE}\n`, '1.0.0'), '<!-- recade-harness v1.0.0: specialise below the line -->\n\n# T\n');
  const first = mergeMarkdown(generic, null);
  assert.equal(first.status, 'created');
  assert.equal(mergeMarkdown(generic, first.text).status, 'unchanged');
  assert.equal(lineDiff('a\nb\nc\n', 'a\nb\nc\n'), '');
  assert.equal(lineDiff('a\nb\nc\n', 'a\nx\nc\n'), '@@\n a\n-b\n+x\n c\n \n');
});

test('settings.json: the project keeps its own keys, rules and hooks, and Recade adds nothing', () => {
  const root = makeProject();
  mkdirSync(join(root, '.claude'));
  const own = {
    model: 'sonnet',
    env: { MY_VAR: '1' },
    permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(rm -rf *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [] },
  };
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify(own));
  install(root, { pluginRoot: plugin });
  const s = JSON.parse(read(root, '.claude/settings.json'));
  assert.equal(s.model, 'sonnet');
  assert.deepEqual(s.env, { MY_VAR: '1' });
  assert.deepEqual(s.permissions, { allow: ['Bash(npm test:*)'], deny: ['Bash(rm -rf *)'] });
  assert.deepEqual(s.hooks.PreToolUse, own.hooks.PreToolUse);
  install(root, { pluginRoot: plugin });
  assert.deepEqual(JSON.parse(read(root, '.claude/settings.json')), s);
});

test('a settings file that is not JSON is refused, and nothing is written', () => {
  assert.throws(() => mergeSettings('{ nope', { env: {} }), InstallError);
  assert.throws(() => mergeSettings('[]', { env: {} }), InstallError);
  const root = makeProject();
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), '{ nope');
  assert.throws(() => install(root, { pluginRoot: plugin }), InstallError);
  assert.equal(existsSync(join(root, '.claude', 'agents')), false);
  assert.equal(existsSync(join(root, '.recade')), false);
});

test('a git hook or a workflow of the project is never overwritten, and an own local hook stays with a warning', () => {
  const root = makeProject();
  mkdirSync(join(root, '.githooks'), { recursive: true });
  writeFileSync(join(root, '.githooks', 'pre-commit'), '#!/bin/sh\necho mine\n');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: Mine\n');
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
  writeFileSync(join(root, '.git', 'hooks', 'commit-msg'), '#!/bin/sh\necho own\n', { mode: 0o755 });
  const r = install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.githooks/pre-commit'), '#!/bin/sh\necho mine\n');
  assert.equal(read(root, '.github/workflows/ci.yml'), 'name: Mine\n');
  assert.equal(read(root, '.git/hooks/commit-msg'), '#!/bin/sh\necho own\n');
  assert.match(read(root, '.git/hooks/pre-commit'), new RegExp(LOCAL_HOOK_MARK));
  assert.equal(r.hooksPath, false);
  assert.ok(r.warnings.some((w) => /commit-msg is a git hook of yours/.test(w)));
});

test('a core.hooksPath set by the owner is kept: no local hook is written, and a warning says so', () => {
  const root = makeProject();
  git(root, 'config', 'core.hooksPath', '.husky');
  const r = install(root, { pluginRoot: plugin });
  assert.equal(hooksPath(root), '.husky');
  assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-commit')), false);
  assert.equal(r.hooksPath, false);
  assert.ok(r.warnings.some((w) => /core\.hooksPath is \.husky/.test(w)));
});

test('the local hook runs the hook of the plugin, and lets the commit through when the plugin is not on the machine', () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  writeFileSync(join(root, 'a.md'), `# A\n\nOne ${String.fromCharCode(0x2014)} two.\n`);
  git(root, 'add', 'a.md');
  const refused = git(root, 'commit', '-q', '-m', 'docs: a');
  assert.notEqual(refused.status, 0, 'the style check of the plugin ran');
  writeFileSync(join(root, '.recade', 'plugin-root'), '/nowhere\n');
  const env = { ...process.env };
  delete env.RECADE_PLUGIN_ROOT;
  const passed = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', 'commit', '-q', '-m', 'docs: a'], { cwd: root, encoding: 'utf8', env });
  assert.equal(passed.status, 0, passed.stderr);
});

test('install refuses a folder that is not a plugin and a relative plugin folder', () => {
  const root = makeProject();
  assert.throws(() => install(root, { pluginRoot: '/nowhere/at/all' }), InstallError);
  assert.throws(() => install(root, { pluginRoot: 'relative/path' }), InstallError);
});

test('recade harness install and recade harness cases through the CLI', async () => {
  const root = makeProject();
  const a = await cli(root, ['harness', 'install']);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /Harness v\d+\.\d+\.\d+ installed\./);
  assert.match(a.stdout, /created/);
  const c = await cli(root, ['harness', 'install', 'extra']);
  assert.equal(c.code, 2);
  const d = await cli(root, ['harness', 'install', '--project', root, '--force']);
  assert.equal(d.code, 0);
  const outside = await cli(join(root, '..'), ['harness', 'install']);
  assert.equal(outside.code, 1);
  assert.match(outside.stderr, /No Recade project here/);
});

test('mergeSettings drops only the guard hook of an entry and keeps the other hooks of that entry', () => {
  const existing = JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash|Write', hooks: [{ type: 'command', command: 'node "$RECADE_PLUGIN_ROOT/harness/hooks/guard.mjs"' }, { type: 'command', command: 'echo mine' }] }] },
  });
  const template = JSON.parse(readFileSync(join(plugin, 'harness', 'settings.json'), 'utf8'));
  const out = JSON.parse(mergeSettings(existing, template));
  const commands = out.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
  assert.ok(commands.includes('echo mine'));
  assert.equal(commands.filter((c) => c.includes('guard.mjs')).length, 1);
  assert.equal(out.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command === 'echo mine')).matcher, 'Bash|Write');
  assert.deepEqual(JSON.parse(mergeSettings(JSON.stringify(out), template)), out, 'a second merge changes nothing');
});

test('mergeMarkdown moves a path the team added to the generic Writes list below the line, only when that text is not one Recade wrote', () => {
  const generic = genericOf('---\nname: a\n---\n\n## Writes\n\n- `tests/**`\n\n## Rules\n\n- Be brief.\n', '9.9.9');
  const edited = `${generic.replace('- `tests/**`', '- `tests/**`\n- `**/src/test/**`')}\n${SPEC_LINE}\n\nOur own text.\n`;
  const known = new Set();
  const moved = mergeMarkdown(generic, edited, { known });
  assert.deepEqual(moved.moved, ['**/src/test/**']);
  const below = moved.text.split(SPEC_LINE)[1];
  assert.match(below, /^\n\nOur own text\.\n\n## Writes\n\n- `\*\*\/src\/test\/\*\*`\n$/);
  assert.equal(moved.text.split(SPEC_LINE)[0], `${generic}\n`, 'the generic part is the template again');
  // Run again: the path is below the line already, nothing moves twice.
  assert.deepEqual(mergeMarkdown(generic, moved.text, { known }).moved ?? [], []);
  // A generic text Recade once wrote (an older template that listed the path) keeps the path dropped.
  const older = edited.split(SPEC_LINE)[0];
  const fromRecade = mergeMarkdown(generic, edited, { known: new Set([fingerprint(older)]) });
  assert.deepEqual(fromRecade.moved, []);
  assert.doesNotMatch(fromRecade.text, /src\/test/);
  // A Writes section below the line already gets the path added to it.
  const withSection = `${generic.replace('- `tests/**`', '- `tests/**`\n- `e2e/**`')}\n${SPEC_LINE}\n\n## Writes\n\n- \`docs/**\`\n`;
  assert.deepEqual(parseWrites(mergeMarkdown(generic, withSection, { known }).text.split(SPEC_LINE)[1]), ['e2e/**', 'docs/**']);
});
