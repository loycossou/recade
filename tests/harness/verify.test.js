import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { install } from '../../src/harness/install.js';
import { verify, formatVerify, frontMatter } from '../../src/harness/verify.js';
import { STACK, cli, fakePlugin, git, makeProject, plugin } from './fixture-project.js';

const read = (root, f) => readFileSync(join(root, f), 'utf8');
const write = (root, f, text) => writeFileSync(join(root, f), text);
const errors = (r, check) => r.findings.filter((f) => f.severity === 'error' && (check === undefined || f.check === check));
/** The git hooks folder of a checkout, where the local hooks are. */
const hooksDir = (root) => join(root, git(root, 'rev-parse', '--git-path', 'hooks').stdout.trim());
const installed = (opts) => {
  const root = makeProject(opts);
  install(root, { pluginRoot: plugin });
  return root;
};
/** A guard that lets everything through, the bypass that verify must catch. */
const allowAll = () => '';

test('verify passes on a fictional project installed in a temp dir (done when, plan 4 task 11)', async () => {
  const root = installed();
  const r = await verify(root, { pluginRoot: plugin });
  // The only findings are the warnings of the second opinion in the reviewer's family (second_opinion.same_family: warn).
  assert.deepEqual(r.findings, ['standard', 'sensitive'].map((lane) => ({
    severity: 'warn',
    check: 'models',
    message: `second-opinion ${lane}: same model family (opus) as the reviewer, allowed by second_opinion.same_family: warn.`,
  })));
  assert.deepEqual(r.checks, ['layout', 'agents', 'commands', 'models', 'settings', 'git', 'guard', 'pre-commit', 'stamps', 'style', 'ci']);
  assert.match(formatVerify(r), /^Harness verified: layout, agents/m);
});

test('recade harness verify through the CLI: install, then exit 0; damage, then exit 1', async () => {
  const root = makeProject();
  assert.equal((await cli(root, ['harness', 'install'])).code, 0);
  const ok = await cli(root, ['harness', 'verify']);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Harness verified/);
  rmSync(join(root, '.claude', 'agents', 'reviewer.md'));
  const bad = await cli(root, ['harness', 'verify']);
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /error layout: \.claude\/agents\/reviewer\.md is missing/);
  assert.match(bad.stdout, /Harness verification failed: 1 error\./);
  assert.equal((await cli(root, ['harness', 'verify', 'x'])).code, 2);
});

test('a broken agent is caught: bad front matter, wrong name, no protocol, no Writes', async () => {
  const root = installed();
  write(root, '.claude/agents/explorer.md', 'no front matter here\n');
  const text = read(root, '.claude/agents/reviewer.md');
  write(root, '.claude/agents/reviewer.md', text.replace('name: reviewer', 'name: someone-else'));
  const sec = read(root, '.claude/agents/security-reviewer.md');
  write(root, '.claude/agents/security-reviewer.md', sec.replaceAll('.claude/protocol.md', 'the protocol'));
  const doc = read(root, '.claude/agents/doc-writer.md');
  write(root, '.claude/agents/doc-writer.md', doc.replace('## Writes', '## Files'));
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['agents'] }), 'agents').map((f) => f.message).join('\n');
  assert.match(msgs, /explorer\.md: the front matter does not parse/);
  assert.match(msgs, /reviewer\.md: name is "someone-else"/);
  assert.match(msgs, /security-reviewer\.md: it does not name \.claude\/protocol\.md/);
  assert.match(msgs, /doc-writer\.md: it has no ## Writes section/);
});

test('a broken command is caught: no tools, a merge-capable tool list, no plugin root step', async () => {
  const root = installed();
  const slice = read(root, '.claude/commands/slice.md');
  write(root, '.claude/commands/slice.md', slice.replace(/^allowed-tools: .*$/m, 'allowed-tools: Bash(gh:*), Read'));
  write(root, '.claude/commands/status.md', read(root, '.claude/commands/status.md').replaceAll('RECADE_PLUGIN_ROOT', 'ROOT'));
  write(root, '.claude/commands/board.md', 'nothing\n');
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['commands'] }), 'commands').map((f) => f.message).join('\n');
  assert.match(msgs, /slice\.md: allowed-tools lets the command run gh/);
  assert.match(msgs, /status\.md: it does not find the plugin folder/);
  assert.match(msgs, /board\.md: the front matter does not parse/);
});

test('model drift is caught', async () => {
  const root = installed();
  write(root, '.claude/agents/reviewer.md', read(root, '.claude/agents/reviewer.md').replace(/^model: opus$/m, 'model: sonnet'));
  const e = errors(await verify(root, { pluginRoot: plugin, only: ['models'] }), 'models');
  assert.equal(e.length, 1);
  assert.match(e[0].message, /reviewer\.md/);
});

test('a guard bypass is caught: a hook that lets every call through fails every probe', async () => {
  const root = installed();
  const r = await verify(root, { pluginRoot: plugin, runHook: allowAll, only: ['guard'] });
  const msgs = errors(r, 'guard').map((f) => f.message);
  for (const label of ['gh pr merge', 'push to main', 'commit with --no-verify', 'hooks path switched off', 'write to the stamps', 'write outside the paths of']) {
    assert.ok(msgs.some((m) => m.includes(label) && m.includes('did not refuse')), label);
  }
  assert.ok(msgs.length >= 7);
});

test('a guard that refuses everything is caught too, because the harness would be unusable', async () => {
  const root = installed();
  const deny = () => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
  const msgs = errors(await verify(root, { pluginRoot: plugin, runHook: deny, only: ['guard'] }), 'guard').map((f) => f.message);
  assert.deepEqual(msgs, ['a harmless command: the guard refused a harmless call.']);
});

test('the guard probes run the hook of the plugin, as Claude Code runs it: a plugin with no guard script is a bypass and is caught', async () => {
  const root = installed();
  const broken = fakePlugin('1.0.0');
  const msgs = errors(await verify(root, { pluginRoot: broken, only: ['guard'] }), 'guard').map((f) => f.message);
  assert.ok(msgs.some((m) => /gh pr merge: the guard did not refuse it/.test(m)), msgs.join('\n'));
});

test('settings: a stale plugin-root, a plugin with no guard hook, and the launcher of an older Recade are caught', async () => {
  const root = installed();
  write(root, '.recade/plugin-root', '/nowhere/recade\n');
  write(root, '.claude/settings.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/recade-guard.mjs"' }] }] } }));
  const r = await verify(root, { pluginRoot: plugin, only: ['settings'] });
  assert.match(errors(r, 'settings').map((f) => f.message).join('\n'), /\.recade\/plugin-root points to \/nowhere\/recade/);
  assert.ok(r.findings.some((f) => f.severity === 'warn' && /\.claude\/settings\.json still runs the guard launcher of an older Recade/.test(f.message)));
  const bare = fakePlugin('1.0.0');
  write(root, '.recade/plugin-root', `${plugin}\n`);
  assert.match(errors(await verify(root, { pluginRoot: bare, only: ['settings'] }), 'settings').map((f) => f.message).join('\n'), /The plugin has no PreToolUse hook that runs bin\/recade-guard\.js/);
});

test('the guard is the hook of the plugin: a stale plugin-root of the project does not open it', async () => {
  const root = installed();
  write(root, '.recade/plugin-root', '/nowhere/recade\n');
  assert.deepEqual(errors(await verify(root, { pluginRoot: plugin, only: ['guard'] }), 'guard'), []);
});

test('local git hooks that are missing, or bypassed by a core.hooksPath, are caught', async () => {
  const root = installed();
  git(root, 'config', 'core.hooksPath', '.githooks');
  let e = errors(await verify(root, { pluginRoot: plugin, only: ['git'] }), 'git');
  assert.ok(e.some((f) => /core\.hooksPath is \.githooks, so the local git hooks of Recade do not run/.test(f.message)), JSON.stringify(e));
  git(root, 'config', '--unset', 'core.hooksPath');
  rmSync(join(hooksDir(root), 'commit-msg'));
  e = errors(await verify(root, { pluginRoot: plugin, only: ['git'] }), 'git');
  assert.equal(e.length, 1);
  assert.match(e[0].message, /The local git hook commit-msg is missing\. Run: recade repo sync/);
});

test('a plugin whose pre-commit and commit-msg accept an em dash is caught', async () => {
  const root = installed();
  const lax = fakePlugin('1.0.0', (dir) => {
    writeFileSync(join(dir, 'harness', 'githooks', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(dir, 'harness', 'githooks', 'commit-msg'), '#!/bin/sh\nexit 0\n');
  });
  const msgs = errors(await verify(root, { pluginRoot: lax, only: ['pre-commit'] }), 'pre-commit').map((f) => f.message);
  assert.deepEqual(msgs, [
    'pre-commit accepts a file with an em dash.',
    'pre-commit lets a commit through when a required gate has no green stamp.',
    'commit-msg accepts a message with an em dash.',
  ]);
});

test('a plugin whose pre-commit refuses everything is caught: the refusal of the em dash would prove nothing', async () => {
  const root = installed();
  const strict = fakePlugin('1.0.0', (dir) => writeFileSync(join(dir, 'harness', 'githooks', 'pre-commit'), '#!/bin/sh\necho no >&2\nexit 1\n'));
  const msgs = errors(await verify(root, { pluginRoot: strict, only: ['pre-commit'] }), 'pre-commit').map((f) => f.message);
  assert.ok(msgs.some((m) => m.startsWith('pre-commit refuses a clean file')));
});

test('a placeholder left in an installed file is caught', async () => {
  const root = installed();
  write(root, '.claude/commands/status.md', `${read(root, '.claude/commands/status.md')}\n__RECADE_PLUGIN_ROOT__\n`);
  write(root, '.github/workflows/ci.yml', `${read(root, '.github/workflows/ci.yml')}# __RECADE_TEST__\n`);
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['layout'] }), 'layout').map((f) => f.message).join('\n');
  assert.match(msgs, /status\.md still holds a placeholder/);
  assert.match(msgs, /ci\.yml still holds a placeholder/);
});

test('an em dash written in a specialisation is caught by the style check', async () => {
  const root = installed();
  write(root, '.claude/protocol.md', `${read(root, '.claude/protocol.md')}\nOne \u2014 two.\n`);
  assert.ok(errors(await verify(root, { pluginRoot: plugin, only: ['style'] }), 'style').length >= 1);
});

test('CI: an unfilled row is a warning that names it, and invalid YAML is an error', async () => {
  const stack = STACK.split('\n').filter((l) => !/^\| SAST \|/.test(l)).join('\n');
  const root = installed({ stack });
  write(root, '.github/dependabot.yml', 'version: 2\nupdates: [\n');
  const r = await verify(root, { pluginRoot: plugin, only: ['ci'] });
  assert.ok(r.findings.some((f) => f.severity === 'warn' && /ci\.yml: no command is set for SAST, so CI fails on it/.test(f.message)), JSON.stringify(r.findings));
  assert.match(errors(r, 'ci').map((f) => f.message).join('\n'), /dependabot\.yml is not valid YAML/);
});

test('a sensitive lane with "Confirmation tests: not applicable" is flagged, a standard lane is not', async () => {
  const na = STACK.replace(/^\| Confirmation tests \| .*$/m, '| Confirmation tests | not applicable |');
  const flagged = errors(await verify(installed({ stack: na, lane: 'sensitive' }), { pluginRoot: plugin, only: ['ci'] }), 'ci');
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].message, /Confirmation tests is "not applicable".*S-01/);
  assert.deepEqual(errors(await verify(installed({ stack: na, lane: 'standard' }), { pluginRoot: plugin, only: ['ci'] }), 'ci'), []);
  assert.deepEqual(errors(await verify(installed({ lane: 'sensitive' }), { pluginRoot: plugin, only: ['ci'] }), 'ci'), []);
});

test('verify never touches the index or the stamps of the project', async () => {
  const root = installed();
  git(root, 'add', '-A');
  const before = git(root, 'status', '--porcelain').stdout;
  await verify(root, { pluginRoot: plugin });
  assert.equal(git(root, 'status', '--porcelain').stdout, before);
  assert.equal(readdirSync(join(root, '.recade')).includes('stamps.json'), false);
});

test('frontMatter reads strict YAML and the lenient form Claude Code accepts', async () => {
  assert.deepEqual(frontMatter('---\nname: a\ntags: [x, y]\n---\nbody'), { name: 'a', tags: ['x', 'y'] });
  assert.deepEqual(frontMatter('---\nname: a\ndescription: Does this: and that\n---\nbody'), { name: 'a', description: 'Does this: and that' });
  assert.equal(frontMatter('no front matter'), null);
});

test('a local git hook that is not executable is caught, because git skips it in silence', async () => {
  const root = installed();
  chmodSync(join(hooksDir(root), 'pre-commit'), 0o644);
  chmodSync(join(hooksDir(root), 'commit-msg'), 0o644);
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['git'] }), 'git').map((f) => f.message);
  assert.equal(msgs.filter((m) => /is not executable/.test(m)).length, 2);
});

test('a local git hook edited away from the Recade text is an error, and a hook of the owner is a warning', async () => {
  const root = installed();
  const hook = join(hooksDir(root), 'pre-commit');
  writeFileSync(hook, `${readFileSync(hook, 'utf8')}# edited\n`);
  assert.match(errors(await verify(root, { pluginRoot: plugin, only: ['git'] }), 'git').map((f) => f.message).join('\n'), /The local git hook pre-commit differs from the Recade one/);
  writeFileSync(hook, '#!/bin/sh\nexec npx lint-staged\n');
  const r = await verify(root, { pluginRoot: plugin, only: ['git'] });
  assert.deepEqual(errors(r, 'git'), []);
  assert.ok(r.findings.some((f) => f.severity === 'warn' && /The git hook pre-commit is your own/.test(f.message)));
});

test('disableAllHooks in the shared or the local settings is caught: it turns the hooks of the plugin off too', async () => {
  const shared = installed();
  write(shared, '.claude/settings.json', JSON.stringify({ disableAllHooks: true }));
  assert.ok(errors(await verify(shared, { pluginRoot: plugin, only: ['settings'] }), 'settings').some((f) => /disableAllHooks is true in \.claude\/settings\.json/.test(f.message)));
  const local = installed();
  write(local, '.claude/settings.local.json', JSON.stringify({ disableAllHooks: true }));
  assert.ok(errors(await verify(local, { pluginRoot: plugin, only: ['settings'] }), 'settings').some((f) => /disableAllHooks is true in \.claude\/settings\.local\.json/.test(f.message)));
});

test('a local settings file with rules of its own is fine, one that runs the launcher of an older Recade is a warning, one that does not parse an error', async () => {
  const root = installed();
  write(root, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }));
  assert.deepEqual((await verify(root, { pluginRoot: plugin, only: ['settings'] })).findings, []);
  write(root, '.claude/settings.local.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node .claude/hooks/recade-guard.mjs' }] }] } }));
  assert.ok((await verify(root, { pluginRoot: plugin, only: ['settings'] })).findings.some((f) => f.severity === 'warn' && /settings\.local\.json still runs the guard launcher/.test(f.message)));
  write(root, '.claude/settings.local.json', '{ nope');
  assert.match(errors(await verify(root, { pluginRoot: plugin, only: ['settings'] }), 'settings')[0].message, /settings\.local\.json does not parse/);
});

test('a plugin folder with a dollar sequence is written as it is, not as a replacement pattern', () => {
  const root = makeProject();
  const odd = fakePlugin('1.0.0');
  const weird = `${odd}-$&-$1`;
  renameSync(odd, weird);
  install(root, { pluginRoot: weird, ref: 'v1.0.0' });
  assert.equal(read(root, '.recade/plugin-root'), `${weird}\n`);
});

test('a slice command that does not dispatch with the sensitive values is caught', async () => {
  const root = installed();
  write(root, '.claude/commands/slice.md', read(root, '.claude/commands/slice.md').replaceAll('sensitive_model', 'other_key'));
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['models'] }), 'models').map((f) => f.message).join('\n');
  assert.match(msgs, /slice\.md does not dispatch with sensitive_model/);
});

test('the second-opinion choice: an install with fable puts the copy on Fable 5.2, verify reads it from the copy and warns no more', async () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin, secondOpinion: 'fable' });
  const copy = read(root, '.claude/agents/second-opinion.md');
  assert.match(copy, /^model: claude-fable-5-2$/m);
  assert.doesNotMatch(read(join(plugin, 'harness'), 'agents/second-opinion.md'), /claude-fable-5-2/, 'the plugin keeps the table');
  const fable = (await verify(root, { pluginRoot: plugin, only: ['models'] })).findings.filter((f) => f.check === 'models');
  assert.deepEqual(fable, [], 'another family: no error and no warning');
  const opus = (await verify(installed(), { pluginRoot: plugin, only: ['models'] })).findings.filter((f) => f.check === 'models');
  assert.ok(opus.length > 0 && opus.every((f) => f.severity === 'warn' && /same model family/.test(f.message)), 'opus keeps the warning of today');
  write(root, '.claude/agents/second-opinion.md', copy.replace(/^model: claude-fable-5-2$/m, 'model: sonnet'));
  assert.equal(errors(await verify(root, { pluginRoot: plugin, only: ['models'] }), 'models').length, 1, 'any other model is drift');
});
