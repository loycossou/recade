import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionStartOutput } from '../src/hook.js';
import { isStarted } from '../src/started.js';
import { run } from '../src/cli.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const hookBin = join(repo, 'bin', 'recade-hook.js');
const MESSAGE = 'Recade is installed but not set up. Run /recade:start (about two minutes).';

function runHook(env) {
  const res = spawnSync(process.execPath, [hookBin], { env, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

test('isStarted accepts the YAML spellings of true for a top-level started key', () => {
  for (const value of ['true', 'True', 'TRUE', '"true"', "'true'", 'true # done', 'true   #done', '"true" # x']) {
    assert.equal(isStarted(`voice: munroe\nstarted: ${value}\n`), true, value);
  }
  assert.equal(isStarted('started: true'), true);
  assert.equal(isStarted('started: true\r\nvoice: x\r\n'), true);
  assert.equal(isStarted('---\nstarted:   true\n'), true);
});

test('isStarted rejects everything else, nested and commented keys included', () => {
  for (const text of [
    '', 'started: false\n', 'started: yes\n', 'started: 1\n', 'started:\n', 'started: truely\n',
    'started: true#x\n', 'started: "true\n', 'started: [true]\n', '# started: true\n',
    'languages:\n  started: true\n', '  started: true\n', 'xstarted: true\n', 'started_at: true\n',
    'note: |\n  started: true\n',
  ]) {
    assert.equal(isStarted(text), false, JSON.stringify(text));
  }
  assert.equal(isStarted(undefined), false);
  assert.equal(isStarted(null), false);
});

test('sessionStartOutput takes the raw config text and prints the reminder until started', () => {
  const expected = JSON.stringify({ systemMessage: MESSAGE });
  assert.equal(sessionStartOutput(''), expected);
  assert.equal(sessionStartOutput(undefined), expected);
  assert.equal(sessionStartOutput('started: false\n'), expected);
  assert.equal(sessionStartOutput('started: "true"\n'), '');
  assert.equal(sessionStartOutput('voice: x\nstarted: True # ok\n'), '');
  assert.deepEqual(JSON.parse(expected), { systemMessage: MESSAGE });
});

test('hook prints the reminder until started is true, then nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-hook-'));
  try {
    const env = { RECADE_CONFIG_DIR: dir, PATH: process.env.PATH };
    // No config file.
    let res = runHook(env);
    assert.equal(res.code, 0);
    assert.deepEqual(JSON.parse(res.stdout), { systemMessage: MESSAGE });
    // Config present, not started.
    writeFileSync(join(dir, 'config.yaml'), 'started: false\nvoice: munroe\n');
    res = runHook(env);
    assert.deepEqual(JSON.parse(res.stdout), { systemMessage: MESSAGE });
    // Started.
    writeFileSync(join(dir, 'config.yaml'), 'voice: munroe\nstarted: true\n');
    res = runHook(env);
    assert.equal(res.code, 0);
    assert.equal(res.stdout, '');
    // A nested or commented key does not count.
    writeFileSync(join(dir, 'config.yaml'), '# started: true\nlanguages:\n  started: true\n');
    res = runHook(env);
    assert.deepEqual(JSON.parse(res.stdout), { systemMessage: MESSAGE });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook binary and recade hook session-start agree on every accepted form', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-hook-agree-'));
  try {
    for (const [text, started] of [
      ['started: true\n', true], ['started: True\n', true], ['started: TRUE\n', true],
      ['started: "true"\n', true], ["started: 'true'\n", true], ['started: true # ok\n', true],
      ['started: false\n', false], ['languages:\n  started: true\n', false], ['started: yes\n', false],
    ]) {
      writeFileSync(join(dir, 'config.yaml'), text);
      const bin = runHook({ RECADE_CONFIG_DIR: dir, PATH: process.env.PATH });
      const out = [];
      const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, cwd: dir, env: { RECADE_CONFIG_DIR: dir } };
      assert.equal(await run(['hook', 'session-start'], io), 0);
      assert.equal(bin.stdout === '', started, `bin ${JSON.stringify(text)}`);
      assert.equal(out.join('') === '', started, `cli ${JSON.stringify(text)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook finds the config through XDG_CONFIG_HOME and HOME like configDir', () => {
  const base = mkdtempSync(join(tmpdir(), 'recade-hook-xdg-'));
  try {
    mkdirSync(join(base, 'xdg', 'recade'), { recursive: true });
    writeFileSync(join(base, 'xdg', 'recade', 'config.yaml'), 'started: true\n');
    let res = runHook({ XDG_CONFIG_HOME: join(base, 'xdg'), PATH: process.env.PATH });
    assert.equal(res.stdout, '');
    mkdirSync(join(base, 'home', '.config', 'recade'), { recursive: true });
    writeFileSync(join(base, 'home', '.config', 'recade', 'config.yaml'), 'started: true\n');
    res = runHook({ HOME: join(base, 'home'), PATH: process.env.PATH });
    assert.equal(res.stdout, '');
    res = runHook({ HOME: join(base, 'empty'), PATH: process.env.PATH });
    assert.deepEqual(JSON.parse(res.stdout), { systemMessage: MESSAGE });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('bin/recade-hook.js imports only node: builtins and relative files without dependencies', () => {
  const src = readFileSync(hookBin, 'utf8');
  const specs = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const spec of specs) {
    assert.ok(
      spec.startsWith('node:') || ['../src/hook-message.js', '../src/hook.js', '../src/paths.js', '../src/started.js', '../src/stophook.js'].includes(spec),
      `unexpected import ${spec}`,
    );
  }
  for (const file of ['hook-message.js', 'hook.js', 'paths.js', 'started.js', 'stophook.js']) {
    const text = readFileSync(join(repo, 'src', file), 'utf8');
    const imports = [...text.matchAll(/(?:^|\n)\s*import\b[^\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(spec.startsWith('node:') || ['./hook-message.js', './started.js'].includes(spec), `${file} imports ${spec}`);
    }
  }
  assert.equal(/function configDir/.test(src), false, 'the hook uses configDir from src/paths.js');
});

test('recade hook session-start prints the reminder, then nothing once started', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-hook-cli-'));
  try {
    const out = [];
    const io = { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, cwd: dir, env: { RECADE_CONFIG_DIR: dir } };
    assert.equal(await run(['hook', 'session-start'], io), 0);
    assert.deepEqual(JSON.parse(out.join('')), { systemMessage: MESSAGE });
    writeFileSync(join(dir, 'config.yaml'), 'started: true\n');
    out.length = 0;
    assert.equal(await run(['hook', 'session-start'], io), 0);
    assert.equal(out.join(''), '');
    assert.equal(await run(['hook', 'nope'], io), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hooks.json runs bin/recade-hook.js on SessionStart with matcher startup, with time for the harness sync', () => {
  const hooks = JSON.parse(readFileSync(join(repo, 'hooks', 'hooks.json'), 'utf8'));
  const entries = hooks.hooks.SessionStart;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, 'startup');
  assert.deepEqual(entries[0].hooks, [
    { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/recade-hook.js"', timeout: 120 },
  ]);
});

test('hooks.json runs the guard of the plugin before Write, Edit, MultiEdit, NotebookEdit and Bash', () => {
  const hooks = JSON.parse(readFileSync(join(repo, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks.PreToolUse, [{ matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/recade-guard.js"' }] }]);
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop']);
});

test('bin/recade-guard.js imports only node: builtins and src/hookscope.js before it knows it is in a Recade project', () => {
  const src = readFileSync(join(repo, 'bin', 'recade-guard.js'), 'utf8');
  const specs = [...src.matchAll(/^import\b[^\n]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const spec of specs) assert.ok(spec.startsWith('node:') || spec === '../src/hookscope.js', `unexpected import ${spec}`);
  const scope = readFileSync(join(repo, 'src', 'hookscope.js'), 'utf8');
  for (const m of scope.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.ok(m[1].startsWith('node:'), `hookscope.js imports ${m[1]}`);
});

test('recadeProject finds a Recade project by recade/state.yaml or a linked code repository, and nothing elsewhere', async () => {
  const { recadeProject } = await import('../src/hookscope.js');
  const files = new Set(['/w/recade/state.yaml', '/c/.recade/workspace']);
  const exists = (f) => files.has(f);
  assert.deepEqual(recadeProject('/w/worktrees/api/S-01/src', { exists }), { root: '/w', kind: 'project' });
  assert.deepEqual(recadeProject('/w', { exists }), { root: '/w', kind: 'project' });
  assert.deepEqual(recadeProject('/c/src/deep', { exists }), { root: '/c', kind: 'code' });
  assert.equal(recadeProject('/elsewhere/x', { exists }), null);
  assert.equal(recadeProject('', { exists }), null);
  assert.equal(recadeProject(undefined, { exists }), null);
});

test('workspaceAt answers only for a state that says kind: workspace, from the folder or below it', async () => {
  const { workspaceAt } = await import('../src/stophook.js');
  const texts = { '/w/recade/state.yaml': 'version: 1\nkind: workspace\n', '/p/recade/state.yaml': 'version: 1\nmode: scratch\n', '/q/recade/state.yaml': "kind: 'workspace'\n" };
  const fs = { exists: (f) => f in texts, read: (f) => texts[f] };
  assert.equal(workspaceAt('/w/slices', fs), '/w');
  assert.equal(workspaceAt('/q', fs), '/q');
  assert.equal(workspaceAt('/p/src', fs), null, 'a project in one folder is not a workspace');
  assert.equal(workspaceAt('/none', fs), null);
  const broken = { exists: () => true, read: () => { throw new Error('unreadable'); } };
  assert.equal(workspaceAt('/w', broken), null);
});

test('the SessionStart hook in a workspace runs the harness sync and adds its report to the welcome, or shows it alone', () => {
  const base = mkdtempSync(join(tmpdir(), 'recade-start-'));
  try {
    const ws = join(base, 'ws');
    mkdirSync(join(ws, 'recade'), { recursive: true });
    mkdirSync(join(ws, '.recade'), { recursive: true });
    writeFileSync(join(ws, 'recade', 'state.yaml'), 'version: 1\nkind: workspace\n');
    const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
    writeFileSync(join(ws, '.recade', 'installed.json'), JSON.stringify({ version, files: {} }));
    // Not a git checkout: the sync cannot install the local git hooks there, and its report says so.
    const start = (configText) => {
      const cfg = join(base, `cfg-${configText === null ? 'none' : 'set'}`);
      mkdirSync(cfg, { recursive: true });
      if (configText !== null) writeFileSync(join(cfg, 'config.yaml'), configText);
      return spawnSync(process.execPath, [hookBin], { input: JSON.stringify({ cwd: ws, hook_event_name: 'SessionStart' }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: base, RECADE_CONFIG_DIR: cfg } });
    };
    const started = start('started: true\n');
    assert.equal(started.status, 0, started.stderr);
    const out = JSON.parse(started.stdout);
    assert.match(out.systemMessage, /^Recade: The git hooks folder was not found/);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(out.hookSpecificOutput.additionalContext, /^Recade, at the start of this session:\n/);
    const fresh = JSON.parse(start(null).stdout);
    assert.equal(fresh.systemMessage.split('\n')[0], MESSAGE, 'the welcome stays first');
    assert.match(fresh.systemMessage.split('\n')[1], /^Recade: /);
    // Outside a workspace the hook prints the welcome or nothing, as before.
    const outside = spawnSync(process.execPath, [hookBin], { input: JSON.stringify({ cwd: base }), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: base, RECADE_CONFIG_DIR: join(base, 'cfg-set') } });
    assert.equal(outside.stdout, '');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('hooks.json pushes the workspace at the end of each turn, through bin/recade-hook.js --stop', () => {
  const hooks = JSON.parse(readFileSync(join(repo, 'hooks', 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks.Stop, [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/recade-hook.js" --stop', timeout: 60 }] }]);
});

test('the Stop hook pushes the commits a step left in a workspace with auto-push on, and does nothing anywhere else', async () => {
  const { autoPushWorkspace } = await import('../src/stophook.js');
  const mail = ['t', 'example.invalid'].join('@');
  const git = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: mail, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: mail } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const base = mkdtempSync(join(tmpdir(), 'recade-stop-'));
  const origin = join(base, 'origin.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  const ws = join(base, 'ws');
  git(base, 'clone', '-q', origin, ws);
  git(ws, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(ws, 'recade'));
  const state = (on) => `version: 1\nkind: workspace\nworkspace:\n  auto_push: ${on}\n  auto_push_since: 2026-11-23\n`;
  writeFileSync(join(ws, 'recade', 'state.yaml'), state(true));
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'first');
  git(ws, 'push', '-q', 'origin', 'main');
  writeFileSync(join(ws, 'note.md'), 'x\n');
  git(ws, 'add', 'note.md');
  git(ws, 'commit', '-q', '-m', 'left behind');
  const fs = { exists: (f) => { try { readFileSync(f); return true; } catch { return false; } }, read: (f) => readFileSync(f, 'utf8') };
  mkdirSync(join(ws, 'worktrees', 'api'), { recursive: true });
  assert.equal(autoPushWorkspace(join(ws, 'worktrees', 'api'), fs), ws, 'found from a folder inside the workspace');
  assert.equal(autoPushWorkspace(base, fs), null, 'nothing outside a workspace');
  const stop = (cwd) => spawnSync('node', [join(repo, 'bin', 'recade-hook.js'), '--stop'], { cwd, input: JSON.stringify({ cwd }), encoding: 'utf8' });
  const r = stop(ws);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(git(ws, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'), 'the commit left behind reached origin');
  // Auto-push off: the hook finds no workspace to push, and nothing leaves.
  writeFileSync(join(ws, 'recade', 'state.yaml'), state(false));
  git(ws, 'commit', '-q', '-am', 'off');
  assert.equal(autoPushWorkspace(ws, fs), null);
  stop(ws);
  assert.notEqual(git(ws, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
  // A push that fails is told to the owner, and the turn ends normally.
  writeFileSync(join(ws, 'recade', 'state.yaml'), state(true));
  git(ws, 'commit', '-q', '-am', 'on again');
  git(ws, 'remote', 'set-url', 'origin', join(base, 'gone.git'));
  const failed = stop(ws);
  assert.equal(failed.status, 0);
  assert.match(JSON.parse(failed.stdout).systemMessage, /^Recade: workspace push failed/);
  rmSync(base, { recursive: true, force: true });
});

/* ---------- /exit: the session process ---------- */

test('isClaude knows the Claude Code CLI by its command line', async () => {
  const { isClaude } = await import('../src/session.js');
  for (const args of ['claude', 'claude --resume abc --remote-control x', '/home/u/.local/bin/claude -p hi', 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js']) assert.equal(isClaude(args), true, args);
  for (const args of ['bash', 'node /p/bin/recade.js session end', 'claude-rc-loop demo', 'vim claude.md', 'tmux -L rc-x']) assert.equal(isClaude(args), false, args);
});

test('sessionProcess walks up the parents to the Claude Code process, and stops at the top or after a missing row', async () => {
  const { sessionProcess, endSession } = await import('../src/session.js');
  const table = { 40: { ppid: 30, args: 'node /p/bin/recade.js session end' }, 30: { ppid: 20, args: '/bin/bash -c x' }, 20: { ppid: 10, args: 'claude --resume s' }, 10: { ppid: 1, args: 'tmux' } };
  const ps = (pid) => table[pid] ?? null;
  assert.equal(sessionProcess(40, { ps }), 20);
  assert.equal(sessionProcess(30, { ps }), 20);
  assert.equal(sessionProcess(10, { ps }), null, 'no Claude Code above');
  assert.equal(sessionProcess(99, { ps }), null, 'a process ps does not know');
  const loop = { 5: { ppid: 6, args: 'sh' }, 6: { ppid: 5, args: 'sh' } };
  assert.equal(sessionProcess(5, { ps: (p) => loop[p] ?? null }), null, 'a cycle ends');
  const scheduled = [];
  assert.equal(endSession({ ps: () => null, schedule: (pid) => scheduled.push(pid) }), null);
  assert.deepEqual(scheduled, [], 'nothing is stopped when no session is found');
});

test('recade session end and recade rebase leftovers refuse other forms, and session end says when no session is found', async () => {
  const io = (extra = {}) => {
    const out = [];
    const err = [];
    return { io: { cwd: repo, env: {}, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, ...extra }, out, err };
  };
  for (const args of [['session'], ['session', 'end', 'now'], ['session', 'start'], ['rebase'], ['rebase', 'abort'], ['rebase', 'leftovers', 'extra'], ['rebase', 'leftovers', '--nope']]) {
    const t = io();
    assert.equal(await run(args, t.io), 2, args.join(' '));
    assert.match(t.err.join(''), /^Usage: recade (session end|rebase leftovers)/, args.join(' '));
  }
  const none = io({ endSession: () => null });
  assert.equal(await run(['session', 'end'], none.io), 1);
  assert.match(none.err.join(''), /No Claude Code session was found/);
  const found = io({ endSession: () => 4242 });
  assert.equal(await run(['session', 'end'], found.io), 0);
  assert.match(found.out.join(''), /The session stops in a moment\./);
});

/* ---------- rebase: leftovers of an older Recade ---------- */

function rebaseRepo() {
  const mail = ['t', 'example.invalid'].join('@');
  const dir = mkdtempSync(join(tmpdir(), 'recade-rebase-'));
  const git = (...a) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', `user.email=${mail}`, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, '.githooks'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'settings.json'), '{"a":1}\n');
  writeFileSync(join(dir, '.githooks', 'pre-commit'), 'one\n');
  writeFileSync(join(dir, 'src', 'a.js'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: start');
  return { dir, git };
}

test('resolveLeftovers settles a rebase whose conflicts are only leftovers: kept as on the base branch, or removed with it', async () => {
  const { resolveLeftovers } = await import('../src/rebase.js');
  const { dir, git } = rebaseRepo();
  assert.equal(resolveLeftovers(dir).state, 'none', 'no rebase in progress');
  git('checkout', '-q', '-b', 'slice/s-01-x');
  writeFileSync(join(dir, '.claude', 'settings.json'), '{"a":2}\n');
  writeFileSync(join(dir, '.githooks', 'pre-commit'), 'slice\n');
  writeFileSync(join(dir, 'src', 'b.js'), 'work\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: work');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, '.claude', 'settings.json'), '{"a":3}\n');
  git('rm', '-q', '.githooks/pre-commit');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: clean');
  git('checkout', '-q', 'slice/s-01-x');
  assert.notEqual(git('rebase', 'main').status, 0, 'the rebase stops on the conflicts');
  const r = resolveLeftovers(dir);
  assert.equal(r.state, 'resolved', r.message);
  assert.deepEqual(r.resolved.sort(), ['.claude/settings.json', '.githooks/pre-commit']);
  assert.equal(git('-c', 'core.editor=true', 'rebase', '--continue').status, 0);
  assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), '{"a":3}\n', 'the version of the base branch');
  assert.equal(git('ls-files', '.githooks').stdout, '', 'removed as on the base branch');
  assert.equal(readFileSync(join(dir, 'src', 'b.js'), 'utf8'), 'work\n', 'the work of the slice stays');
  assert.equal(resolveLeftovers(dir).state, 'none');
  rmSync(dir, { recursive: true, force: true });
});

test('resolveLeftovers refuses when any other file conflicts, and changes nothing', async () => {
  const { resolveLeftovers } = await import('../src/rebase.js');
  const { dir, git } = rebaseRepo();
  git('checkout', '-q', '-b', 'slice/s-02-y');
  writeFileSync(join(dir, '.claude', 'settings.json'), '{"a":2}\n');
  writeFileSync(join(dir, 'src', 'a.js'), 'slice\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: y');
  git('checkout', '-q', 'main');
  writeFileSync(join(dir, '.claude', 'settings.json'), '{"a":3}\n');
  writeFileSync(join(dir, 'src', 'a.js'), 'main\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: main');
  git('checkout', '-q', 'slice/s-02-y');
  assert.notEqual(git('rebase', 'main').status, 0);
  const before = git('diff', '--name-only', '--diff-filter=U').stdout;
  const r = resolveLeftovers(dir);
  assert.equal(r.state, 'others');
  assert.deepEqual(r.others, ['src/a.js']);
  assert.equal(git('diff', '--name-only', '--diff-filter=U').stdout, before, 'nothing was resolved');
  const t = { out: [], err: [] };
  const code = await run(['rebase', 'leftovers', '--dir', dir], { cwd: repo, env: {}, stdout: { write: (s) => t.out.push(s) }, stderr: { write: (s) => t.err.push(s) } });
  assert.equal(code, 1);
  assert.match(t.err.join(''), /src\/a\.js/);
  git('rebase', '--abort');
  rmSync(dir, { recursive: true, force: true });
});

test('LEFTOVER names only the files an older Recade kept in a code repository', async () => {
  const { LEFTOVER } = await import('../src/rebase.js');
  for (const f of ['.claude/settings.json', '.claude/hooks/recade-guard.mjs', '.githooks/pre-commit', '.github/workflows/conflicts.yml', '.github/workflows/second-opinion.yml', '.github/workflows/recade.yml']) assert.ok(LEFTOVER.test(f), f);
  for (const f of ['.github/workflows/ci.yml', '.github/dependabot.yml', 'CLAUDE.md', 'src/.claude/x', 'tests/a.test.js']) assert.equal(LEFTOVER.test(f), false, f);
});
