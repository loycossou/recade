import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanForNames } from '../src/guard.js';
import { run } from '../src/cli.js';

test('guard flags a private name as a whole word only', () => {
  const files = [{ path: 'a.md', text: 'We work with Acme today.\nThe Acmes are fine.\nacme, ACME.' }];
  const findings = scanForNames(files, ['Acme']);
  assert.deepEqual(
    findings.map((f) => [f.line, f.column]),
    [[1, 14], [3, 1], [3, 7]],
  );
  for (const f of findings) {
    assert.equal(f.file, 'a.md');
    assert.equal(f.rule, 'private-name');
    assert.equal(f.severity, 'error');
    assert.ok(!f.message.toLowerCase().includes('acme'));
  }
});

test('guard treats names literally, handles several names and ignores blanks', () => {
  const files = [{ path: 'b.txt', text: 'Mr. Foo (Bar) and a.b' }];
  assert.equal(scanForNames(files, ['(Bar)', '']).length, 1);
  assert.equal(scanForNames(files, ['Bar', 'Foo']).length, 2);
  assert.equal(scanForNames(files, ['a.b']).length, 1);
  assert.equal(scanForNames(files, ['axb']).length, 0);
  assert.equal(scanForNames(files, []).length, 0);
});

test('guard does not match inside accented words', () => {
  assert.equal(scanForNames([{ path: 'c.md', text: 'Acmé et Acme_x' }], ['Acme']).length, 0);
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'recade-guard-'));
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'docs', 'one.md'), 'Hello Acme.\n');
  writeFileSync(join(root, 'two.js'), '// nothing here\n');
  writeFileSync(join(root, 'three.bin'), 'Acme');
  const out = [];
  const err = [];
  const mk = (env = {}) => ({
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd: root, env },
    out: () => out.join(''),
    err: () => err.join(''),
    reset: () => {
      out.length = 0;
      err.length = 0;
    },
  });
  return { root, mk };
}

test('recade guard-names --list reads names, skips blank and comment lines, exits 1 on a hit', async () => {
  const { root, mk } = setup();
  const list = join(root, 'names.txt');
  writeFileSync(list, '# private names\n\nAcme\n');
  const t = mk();
  const code = await run(['guard-names', '--list', list], t.io);
  assert.equal(code, 1);
  assert.equal(t.out(), 'docs/one.md:1:7 private-name Private name in a public file. Remove or replace it.\n');
});

test('guard-names does not scan the list file itself or non-text files', async () => {
  const { root, mk } = setup();
  writeFileSync(join(root, 'docs', 'one.md'), 'clean\n');
  writeFileSync(join(root, 'names.txt'), 'Acme\n');
  const t = mk();
  assert.equal(await run(['guard-names', '--list=names.txt'], t.io), 0);
  assert.equal(t.out(), '');
});

test('guard-names expands ~ in the list path', async () => {
  const { root, mk } = setup();
  mkdirSync(join(root, 'home'));
  writeFileSync(join(root, 'home', 'names.txt'), 'Acme\n');
  const t = mk({ HOME: join(root, 'home') });
  assert.equal(await run(['guard-names', '--list', '~/names.txt'], t.io), 1);
});

test('guard-names falls back to RECADE_PRIVATE_NAMES, comma separated', async () => {
  const { mk } = setup();
  const t = mk({ RECADE_PRIVATE_NAMES: 'Nobody, Acme' });
  assert.equal(await run(['guard-names'], t.io), 1);
  assert.match(t.out(), /docs\/one\.md:1:7 private-name/);
});


test('guard-names skips third-party files: the Mermaid bundle and the lock file quote words such as words of their own', async () => {
  const { root, mk } = setup();
  mkdirSync(join(root, 'render', 'vendor'), { recursive: true });
  writeFileSync(join(root, 'render', 'vendor', 'mermaid.min.js'), 'x("\\\\Acme")\n');
  writeFileSync(join(root, 'package-lock.json'), '{"name":"Acme"}\n');
  writeFileSync(join(root, 'docs', 'one.md'), 'clean\n');
  const t = mk({ RECADE_PRIVATE_NAMES: 'Acme' });
  assert.equal(await run(['guard-names'], t.io), 0);
  assert.equal(t.out(), '');
});

test('guard-names with no list and no env is skipped with exit 0', async () => {
  const { mk } = setup();
  const t = mk();
  assert.equal(await run(['guard-names'], t.io), 0);
  assert.equal(t.out(), 'No private name list; skipped.\n');
});

test('guard-names: unreadable list or bad usage exits 2', async () => {
  const { mk } = setup();
  const t = mk();
  assert.equal(await run(['guard-names', '--list', 'nope.txt'], t.io), 2);
  assert.match(t.err(), /Cannot read name list/);
  t.reset();
  assert.equal(await run(['guard-names', '--list'], t.io), 2);
  assert.equal(await run(['guard-names', '--wat'], t.io), 2);
});
