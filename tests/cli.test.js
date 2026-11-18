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

test('recade version prints 1.0.0 and exits 0', async () => {
  const t = makeIO();
  const code = await run(['version'], t.io);
  assert.equal(code, 0);
  assert.equal(t.stdout().trim(), '1.0.0');
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
