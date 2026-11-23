import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { SPEC_LINE, InstallError, genericOf, install, lineDiff, mergeMarkdown, mergeSettings, publishedSha, resolveRef } from '../../src/harness/install.js';
import { STACK, cli, fakePlugin, git, makeProject, plugin } from './fixture-project.js';

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

test('install copies the template into the project: agents, commands, protocol, settings, hooks, workflows', () => {
  const root = makeProject();
  const r = install(root, { pluginRoot: plugin });
  assert.equal(readdirSync(join(root, '.claude', 'agents')).length, readdirSync(join(plugin, 'harness', 'agents')).filter((f) => f.endsWith('.md')).length);
  assert.equal(readdirSync(join(root, '.claude', 'commands')).length, readdirSync(join(plugin, 'harness', 'commands')).filter((f) => f.endsWith('.md')).length);
  for (const f of ['.claude/protocol.md', '.claude/settings.json', '.githooks/pre-commit', '.githooks/commit-msg', '.github/workflows/ci.yml', '.github/workflows/conflicts.yml', '.github/workflows/second-opinion.yml', '.github/dependabot.yml', '.recade/plugin-root']) {
    assert.ok(existsSync(join(root, f)), f);
  }
  assert.equal(r.written.every((w) => w.status === 'created'), true);
  assert.ok((statSync(join(root, '.githooks', 'pre-commit')).mode & 0o111) !== 0, 'the hooks are executable');
  assert.equal(r.version, JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version);
});

test('install writes .recade/plugin-root, commits no path of the machine, writes the launcher and sets core.hooksPath', () => {
  const root = makeProject();
  const r = install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.recade/plugin-root'), `${plugin}\n`);
  const settings = JSON.parse(read(root, '.claude/settings.json'));
  assert.equal(settings.env, undefined);
  assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /^node "\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/recade-guard\.mjs"/);
  assert.equal(read(root, '.claude/hooks/recade-guard.mjs'), readFileSync(join(plugin, 'harness', 'hooks', 'launcher.mjs'), 'utf8'));
  for (const dir of ['.claude', '.githooks', '.github']) {
    for (const e of readdirSync(join(root, dir), { recursive: true, withFileTypes: true }).filter((x) => x.isFile())) {
      const text = readFileSync(join(e.parentPath ?? e.path, e.name), 'utf8');
      assert.doesNotMatch(text, /__RECADE_/, e.name);
      assert.equal(text.includes(plugin), false, `${e.name} holds the plugin folder of this machine`);
    }
  }
  assert.equal(hooksPath(root), '.githooks');
  assert.equal(r.hooksPath, true);
  const ignore = read(root, '.gitignore');
  assert.match(ignore, /^\.recade\/$/m);
  assert.match(ignore, /^\.claude\/worktrees\/$/m);
  assert.match(ignore, /^\.claude\/settings\.local\.json$/m);
  install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.gitignore'), ignore, 'a second install adds no line');
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

test('a re-install over an older settings file drops the committed plugin folder and the old guard entry', () => {
  const root = makeProject();
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
    env: { RECADE_PLUGIN_ROOT: '/home/someone/plugin', MY_VAR: '1' },
    hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node "$RECADE_PLUGIN_ROOT/harness/hooks/guard.mjs"' }] }] },
  }));
  install(root, { pluginRoot: plugin });
  const s = JSON.parse(read(root, '.claude/settings.json'));
  assert.deepEqual(s.env, { MY_VAR: '1' });
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.match(s.hooks.PreToolUse[0].hooks[0].command, /recade-guard\.mjs/);
  assert.equal(mergeSettings(JSON.stringify({ env: { RECADE_PLUGIN_ROOT: '/x' } }), {}).includes('"env"'), false);
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

test('a pinned commit that no remote branch and no tag holds gives a warning that suggests --ref <tag>', () => {
  const sha = 'b'.repeat(40);
  assert.equal(publishedSha('/p', sha, gitAnswers({})), null);
  assert.match(publishedSha('/p', sha, gitAnswers({ contained: null })), /--ref <tag>/);
  const local = install(makeProject(), { pluginRoot: plugin, exec: gitAnswers({ sha, top: plugin, contained: null }) });
  assert.ok(local.warnings.some((w) => w.includes(sha) && /no remote branch and no tag/.test(w) && w.includes('--ref <tag>')));
  const pushed = install(makeProject(), { pluginRoot: plugin, exec: gitAnswers({ sha, top: plugin }) });
  assert.equal(pushed.warnings.some((w) => w.includes(sha)), false);
  const explicit = install(makeProject(), { pluginRoot: plugin, ref: sha, exec: gitAnswers({ contained: null }) });
  assert.ok(explicit.warnings.some((w) => w.includes(sha)));
  const tagged = install(makeProject(), { pluginRoot: plugin, ref: 'v1.0.0', exec: gitAnswers({ contained: null }) });
  assert.equal(tagged.warnings.some((w) => /pinned commit/.test(w)), false);
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

test('the CI tools ref is a tag or a commit of the installed plugin, never main (spec of Task 6)', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(resolveRef('/p', '1.2.3', gitAnswers({ tag: true })), { ref: 'v1.2.3', assumed: false });
  assert.deepEqual(resolveRef(plugin, '1.2.3', gitAnswers({ sha, top: plugin })), { ref: sha, assumed: false });
  // A plugin folder inside another repository must not borrow that repository's commit.
  assert.deepEqual(resolveRef(plugin, '1.2.3', gitAnswers({ sha, top: '/elsewhere' })), { ref: 'v1.2.3', assumed: true });
  assert.deepEqual(resolveRef(plugin, '1.2.3', gitAnswers({})), { ref: 'v1.2.3', assumed: true });
  for (const how of [{ tag: true }, { sha, top: plugin }, {}]) {
    const root = makeProject();
    const r = install(root, { pluginRoot: plugin, exec: gitAnswers(how.tag ? how : { ...how }) });
    for (const f of ['conflicts.yml', 'ci.yml']) {
      const doc = parseDocument(read(root, `.github/workflows/${f}`)).toJS();
      assert.match(doc.env.RECADE_REF, /^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+)$/, f);
      assert.notEqual(doc.env.RECADE_REF, 'main');
      assert.equal(doc.env.RECADE_REF, r.ref);
    }
  }
});

test('an assumed tag is a warning, and an explicit ref must be a tag or a commit', () => {
  const root = makeProject();
  const r = install(root, { pluginRoot: plugin, exec: gitAnswers({}) });
  assert.ok(r.warnings.some((w) => /tag v\d+\.\d+\.\d+/.test(w)));
  for (const bad of ['main', 'master', 'HEAD', 'feature/x', 'abc', '$(id)']) {
    assert.throws(() => install(makeProject(), { pluginRoot: plugin, ref: bad }), InstallError, bad);
  }
  const ok = makeProject();
  install(ok, { pluginRoot: plugin, ref: 'v2.0.1' });
  assert.match(read(ok, '.github/workflows/conflicts.yml'), /RECADE_REF: v2\.0\.1/);
});

test('ci.yml and dependabot.yml are generated from STACK, whole, with a generated comment', () => {
  const root = makeProject();
  const r = install(root, { pluginRoot: plugin });
  const ci = read(root, '.github/workflows/ci.yml');
  assert.match(ci, /^# Generated by recade harness v\d/);
  assert.match(ci, /npm run test:contract/);
  assert.equal(parseDocument(ci).errors.length, 0);
  assert.match(read(root, '.github/dependabot.yml'), /package-ecosystem: npm/);
  assert.deepEqual(r.missing, []);
  // A hand edit is gone at the next install: there is no specialisation zone in these files.
  writeFileSync(join(root, '.github/workflows/ci.yml'), `${ci}\n# my edit\n`);
  const again = install(root, { pluginRoot: plugin });
  assert.equal(read(root, '.github/workflows/ci.yml'), ci);
  assert.equal(again.written.find((w) => w.file === '.github/workflows/ci.yml').status, 'updated');
});

test('a STACK sheet with unfilled rows warns and lists them, and CI still fails on those rows', () => {
  const stack = STACK.split('\n').filter((l) => !/^\| (SAST|Secret scan) \|/.test(l)).join('\n');
  const root = makeProject({ stack });
  const r = install(root, { pluginRoot: plugin });
  assert.deepEqual(r.missing.sort(), ['SAST', 'Secret scan']);
  assert.ok(r.warnings.some((w) => w.includes('SAST, Secret scan') || (w.includes('SAST') && w.includes('Secret scan'))));
  assert.match(read(root, '.github/workflows/ci.yml'), /The row SAST of the harness technical sheet is not filled/);
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
  assert.match(reviewerDiff, /^-<!-- recade-harness v1\.4\.1/m);
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

test('settings.json: the project keeps its own keys, rules and hooks, the harness adds its own', () => {
  const root = makeProject();
  mkdirSync(join(root, '.claude'));
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({
    model: 'sonnet',
    env: { MY_VAR: '1' },
    permissions: { allow: ['Bash(npm test:*)'], deny: ['Bash(rm -rf *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [] },
  }));
  install(root, { pluginRoot: plugin });
  const s = JSON.parse(read(root, '.claude/settings.json'));
  assert.equal(s.model, 'sonnet');
  assert.equal(s.env.MY_VAR, '1');
  assert.equal(s.env.RECADE_PLUGIN_ROOT, undefined);
  assert.deepEqual(s.permissions.allow, ['Bash(npm test:*)']);
  assert.ok(s.permissions.deny.includes('Bash(rm -rf *)') && s.permissions.deny.includes('Bash(gh pr merge:*)'));
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.ok(s.hooks.PreToolUse.some((e) => e.hooks[0].command === 'echo mine'));
  // A second install does not stack the guard hook or the deny rules.
  install(root, { pluginRoot: plugin });
  const t = JSON.parse(read(root, '.claude/settings.json'));
  assert.deepEqual(t, s);
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

test('a git hook or a workflow that Recade did not write is not overwritten without --force', () => {
  const root = makeProject();
  mkdirSync(join(root, '.githooks'), { recursive: true });
  writeFileSync(join(root, '.githooks', 'pre-commit'), '#!/bin/sh\necho mine\n');
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'name: Mine\n');
  assert.throws(() => install(root, { pluginRoot: plugin }), (err) => err instanceof InstallError && /pre-commit/.test(err.message) && /ci\.yml/.test(err.message));
  assert.equal(existsSync(join(root, '.claude')), false, 'a refusal leaves the project untouched');
  install(root, { pluginRoot: plugin, force: true });
  assert.match(read(root, '.githooks/pre-commit'), /Recade harness pre-commit/);
  assert.match(read(root, '.github/workflows/ci.yml'), /^# Generated by recade harness/);
});

test('install refuses a folder that is not a plugin and a relative plugin folder', () => {
  const root = makeProject();
  assert.throws(() => install(root, { pluginRoot: '/nowhere/at/all' }), InstallError);
  assert.throws(() => install(root, { pluginRoot: 'relative/path' }), InstallError);
});

test('recade harness install and recade harness cases through the CLI', async () => {
  const root = makeProject();
  const a = await cli(root, ['harness', 'install', '--ref', 'v1.0.0']);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /Harness v\d+\.\d+\.\d+ installed \(CI tools pinned to v1\.0\.0\)\./);
  assert.match(a.stdout, /43 created|created/);
  const b = await cli(root, ['harness', 'install', '--ref', 'main']);
  assert.equal(b.code, 1);
  assert.match(b.stderr, /tag such as v1\.2\.3/);
  const c = await cli(root, ['harness', 'install', 'extra']);
  assert.equal(c.code, 2);
  const d = await cli(root, ['harness', 'install', '--project', root, '--force', '--ref', 'v1.0.0']);
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
