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

test('a settings file whose hook points nowhere is a bypass the real hook command exposes', async () => {
  for (const [command, expected] of [['true', /gh pr merge: the hook could not be run/], ['node "/nowhere/harness/hooks/guard.mjs"', /gh pr merge: the guard did not refuse it/]]) {
    const root = installed();
    const s = JSON.parse(read(root, '.claude/settings.json'));
    s.hooks.PreToolUse[0].hooks[0].command = command;
    write(root, '.claude/settings.json', JSON.stringify(s));
    const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['guard'] }), 'guard').map((f) => f.message);
    assert.ok(msgs.some((m) => expected.test(m)), command);
  }
});

test('settings: a deny rule removed, a committed plugin folder, a stale plugin-root, a missing hook', async () => {
  const root = installed();
  const s = JSON.parse(read(root, '.claude/settings.json'));
  s.permissions.deny = s.permissions.deny.filter((r) => !r.includes('gh pr merge'));
  s.env = { RECADE_PLUGIN_ROOT: '/nowhere/recade' };
  delete s.hooks;
  write(root, '.claude/settings.json', JSON.stringify(s));
  write(root, '.recade/plugin-root', '/nowhere/recade\n');
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['settings'] }), 'settings').map((f) => f.message).join('\n');
  assert.match(msgs, /The deny rule Bash\(gh pr merge:\*\) is missing/);
  assert.match(msgs, /sets env\.RECADE_PLUGIN_ROOT/);
  assert.match(msgs, /\.recade\/plugin-root points to \/nowhere\/recade/);
  assert.match(msgs, /No PreToolUse hook runs the guard launcher/);
});

test('settings: the old hook form, an edited hook command and an edited launcher are caught', async () => {
  const root = installed();
  const s = JSON.parse(read(root, '.claude/settings.json'));
  s.hooks.PreToolUse[0].hooks[0].command = 'node "$RECADE_PLUGIN_ROOT/harness/hooks/guard.mjs"';
  write(root, '.claude/settings.json', JSON.stringify(s));
  let msgs = errors(await verify(root, { pluginRoot: plugin, only: ['settings'] }), 'settings').map((f) => f.message).join('\n');
  assert.match(msgs, /the old form that fails open/);
  s.hooks.PreToolUse[0].hooks[0].command = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/recade-guard.mjs"';
  write(root, '.claude/settings.json', JSON.stringify(s));
  write(root, '.claude/hooks/recade-guard.mjs', '// Recade harness\n');
  msgs = errors(await verify(root, { pluginRoot: plugin, only: ['settings'] }), 'settings').map((f) => f.message).join('\n');
  assert.match(msgs, /command differs from the Recade one/);
  assert.match(msgs, /recade-guard\.mjs differs from the Recade launcher/);
});

test('the guard probes go through the launcher: a stale plugin-root refuses the harmless call, a missing launcher blocks', async () => {
  const root = installed();
  write(root, '.recade/plugin-root', '/nowhere/recade\n');
  let msgs = errors(await verify(root, { pluginRoot: plugin, only: ['guard'] }), 'guard').map((f) => f.message).join('\n');
  assert.doesNotMatch(msgs, /gh pr merge: the guard did not refuse it/);
  write(root, '.recade/plugin-root', `${plugin}\n`);
  rmSync(join(root, '.claude', 'hooks', 'recade-guard.mjs'));
  msgs = errors(await verify(root, { pluginRoot: plugin, only: ['guard'] }), 'guard').map((f) => f.message).join('\n');
  assert.doesNotMatch(msgs, /gh pr merge: the guard did not refuse it/);
});

test('git hooks switched off (core.hooksPath unset) are caught', async () => {
  const root = installed();
  git(root, 'config', '--unset', 'core.hooksPath');
  const e = errors(await verify(root, { pluginRoot: plugin, only: ['git'] }), 'git');
  assert.equal(e.length, 1);
  assert.match(e[0].message, /core\.hooksPath is not \.githooks/);
});

test('a pre-commit that accepts an em dash and a commit-msg that accepts one are caught', async () => {
  const root = installed();
  write(root, '.githooks/pre-commit', '#!/bin/sh\nexit 0\n');
  write(root, '.githooks/commit-msg', '#!/bin/sh\nexit 0\n');
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['pre-commit'] }), 'pre-commit').map((f) => f.message);
  assert.deepEqual(msgs, [
    'pre-commit accepts a file with an em dash.',
    'pre-commit lets a commit through when a required gate has no green stamp.',
    'commit-msg accepts a message with an em dash.',
  ]);
});

test('a pre-commit that refuses everything is caught: the refusal of the em dash would prove nothing', async () => {
  const root = installed();
  write(root, '.githooks/pre-commit', '#!/bin/sh\necho no >&2\nexit 1\n');
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['pre-commit'] }), 'pre-commit').map((f) => f.message);
  assert.ok(msgs.some((m) => m.startsWith('pre-commit refuses a clean file')));
});

test('a placeholder left in an installed file is caught', async () => {
  const root = installed();
  write(root, '.githooks/commit-msg', `${read(root, '.githooks/commit-msg')}\n# __RECADE_PLUGIN_ROOT__\n`);
  assert.ok(errors(await verify(root, { pluginRoot: plugin, only: ['layout'] }), 'layout').some((f) => /commit-msg still holds a placeholder/.test(f.message)));
});

test('an em dash written in a specialisation is caught by the style check', async () => {
  const root = installed();
  write(root, '.claude/protocol.md', `${read(root, '.claude/protocol.md')}\nOne \u2014 two.\n`);
  assert.ok(errors(await verify(root, { pluginRoot: plugin, only: ['style'] }), 'style').length >= 1);
});

test('CI: a workflow on main, an unfilled row and invalid YAML are caught', async () => {
  const stack = STACK.split('\n').filter((l) => !/^\| SAST \|/.test(l)).join('\n');
  const root = installed({ stack });
  const conflicts = read(root, '.github/workflows/conflicts.yml');
  write(root, '.github/workflows/conflicts.yml', conflicts.replace(/RECADE_REF: \S+/, 'RECADE_REF: main'));
  write(root, '.github/dependabot.yml', 'version: 2\nupdates: [\n');
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['ci'] }), 'ci').map((f) => f.message).join('\n');
  assert.match(msgs, /conflicts\.yml fetches the Recade tools at main/);
  assert.match(msgs, /the row SAST of the harness technical sheet is not filled/);
  assert.match(msgs, /dependabot\.yml is not valid YAML/);
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

test('a git hook that is not executable is caught, because git skips it in silence', async () => {
  const root = installed();
  chmodSync(join(root, '.githooks', 'pre-commit'), 0o644);
  chmodSync(join(root, '.githooks', 'commit-msg'), 0o644);
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['git'] }), 'git').map((f) => f.message);
  assert.equal(msgs.filter((m) => /is not executable/.test(m)).length, 2);
});

test('a git hook edited away from the Recade text is caught, for example one with the gate check removed', async () => {
  const root = installed();
  write(root, '.githooks/pre-commit', read(root, '.githooks/pre-commit').replace(/node "\$RECADE_PLUGIN_ROOT\/bin\/recade\.js" gate check[\s\S]*$/, ''));
  const msgs = errors(await verify(root, { pluginRoot: plugin, only: ['git', 'pre-commit'] })).map((f) => f.message).join('\n');
  assert.match(msgs, /\.githooks\/pre-commit differs from the Recade hook/);
  assert.match(msgs, /pre-commit lets a commit through when a required gate has no green stamp/);
});

test('disableAllHooks in the shared or the local settings is caught', async () => {
  const shared = installed();
  const s = JSON.parse(read(shared, '.claude/settings.json'));
  s.disableAllHooks = true;
  write(shared, '.claude/settings.json', JSON.stringify(s));
  assert.ok(errors(await verify(shared, { pluginRoot: plugin, only: ['settings'] }), 'settings').some((f) => /disableAllHooks is true in \.claude\/settings\.json/.test(f.message)));
  const local = installed();
  write(local, '.claude/settings.local.json', JSON.stringify({ disableAllHooks: true }));
  assert.ok(errors(await verify(local, { pluginRoot: plugin, only: ['settings'] }), 'settings').some((f) => /disableAllHooks is true in \.claude\/settings\.local\.json/.test(f.message)));
});

test('a local settings file that allows a denied command or moves the plugin folder is caught', async () => {
  const root = installed();
  write(root, '.claude/settings.local.json', JSON.stringify({
    env: { RECADE_PLUGIN_ROOT: '/elsewhere' },
    permissions: { allow: ['Bash(gh pr merge:*)', 'Bash(git push origin main)', 'Bash(npm test:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo ok' }] }] },
  }));
  const r = await verify(root, { pluginRoot: plugin, only: ['settings'] });
  const msgs = errors(r, 'settings').map((f) => f.message).join('\n');
  assert.match(msgs, /changes env\.RECADE_PLUGIN_ROOT/);
  assert.match(msgs, /allows Bash\(gh pr merge:\*\)/);
  assert.match(msgs, /allows Bash\(git push origin main\)/);
  assert.doesNotMatch(msgs, /npm test/);
  assert.ok(r.findings.some((f) => f.severity === 'warn' && /adds PreToolUse hooks/.test(f.message)));
  write(root, '.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'] } }));
  assert.deepEqual((await verify(root, { pluginRoot: plugin, only: ['settings'] })).findings, []);
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
