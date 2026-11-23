import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { listFiles } from '../src/files.js';

function makeIO() {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      cwd: process.cwd(),
      env: {},
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('recade version prints 1.2.0 and exits 0', async () => {
  const t = makeIO();
  const code = await run(['version'], t.io);
  assert.equal(code, 0);
  assert.equal(t.stdout().trim(), '1.2.0');
});

test('unknown command exits 2 with a hint on stderr', async () => {
  const t = makeIO();
  const code = await run(['nope'], t.io);
  assert.equal(code, 2);
  assert.equal(t.stderr().trim(), 'Unknown command: nope. Try: recade help');
  assert.equal(t.stdout(), '');
});

test('listFiles ignores .git, node_modules and .superpowers and returns sorted relative paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-files-'));
  try {
    for (const rel of [
      'b.md',
      'a.md',
      'sub/c.md',
      'sub/skip.txt',
      'custom/d.md',
      '.git/e.md',
      'node_modules/f.md',
      'sub/node_modules/g.md',
      '.superpowers/h.md',
    ]) {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), 'x');
    }
    assert.deepEqual(listFiles(root, { exts: ['.md'] }), ['a.md', 'b.md', 'custom/d.md', 'sub/c.md']);
    assert.deepEqual(listFiles(root, { exts: ['.md'], ignore: ['custom'] }), ['a.md', 'b.md', 'sub/c.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade version fails with ERR_MODULE_NOT_FOUND when a dependency is missing, so the setup runs npm ci', async () => {
  const { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = mkdtempSync(join(tmpdir(), 'recade-deps-'));
  try {
    for (const p of ['package.json', 'src', 'bin', 'render', 'harness', 'templates', 'skills', 'commands', 'agents', 'tools']) cpSync(join(root, p), join(dir, p), { recursive: true });
    mkdirSync(join(dir, 'node_modules'));
    for (const name of readdirSync(join(root, 'node_modules'))) if (name !== 'pptxgenjs') symlinkSync(join(root, 'node_modules', name), join(dir, 'node_modules', name));
    const r = spawnSync(process.execPath, [join(dir, 'bin', 'recade.js'), 'version'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ERR_MODULE_NOT_FOUND.*missing: pptxgenjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
