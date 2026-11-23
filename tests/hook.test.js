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

test('hooks.json runs bin/recade-hook.js on SessionStart with matcher startup', () => {
  const hooks = JSON.parse(readFileSync(join(repo, 'hooks', 'hooks.json'), 'utf8'));
  const entries = hooks.hooks.SessionStart;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].matcher, 'startup');
  assert.deepEqual(entries[0].hooks, [
    { type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/bin/recade-hook.js"' },
  ]);
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
