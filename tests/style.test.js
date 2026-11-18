import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { lintText, lintFiles } from '../src/style/lint.js';

const DASH = '\u2014';

function makeIO(cwd) {
  const out = [];
  const err = [];
  return {
    io: {
      stdout: { write: (s) => out.push(s) },
      stderr: { write: (s) => err.push(s) },
      cwd,
      env: {},
    },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

function tmpProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'recade-style-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

test('em dash is an error with line and column', () => {
  const f = lintText(`ok\nA ${DASH} B`, 'x.md');
  assert.deepEqual(
    f.map((x) => [x.rule, x.severity, x.line, x.column]),
    [['em-dash', 'error', 2, 3]],
  );
  assert.equal(f[0].file, 'x.md');
  assert.equal(typeof f[0].message, 'string');
});

test('em dash inside a code fence is still an error', () => {
  const f = lintText(`\`\`\`js\nconst a = "x ${DASH} y";\n\`\`\``, 'x.md');
  assert.deepEqual(f.map((x) => [x.rule, x.line]), [['em-dash', 2]]);
});

test('recade-style-ignore skips the line', () => {
  const f = lintText(`A ${DASH} B <!-- recade-style-ignore -->\nrobust ${DASH}`, 'x.md');
  assert.deepEqual(f.map((x) => [x.rule, x.line]), [['tic-robust', 2], ['em-dash', 2]]); // recade-style-ignore
});

test('tics are warnings, case-insensitive', () => {
  const cases = {
    Robust: 'tic-robust', // recade-style-ignore
    'We DELVE here': 'tic-delve', // recade-style-ignore
    delving: 'tic-delve', // recade-style-ignore
    leverages: 'tic-leverage', // recade-style-ignore
    Seamlessly: 'tic-seamless', // recade-style-ignore
    "It's important to note that": 'tic-important-to-note', // recade-style-ignore
    'Its important to note': 'tic-important-to-note', // recade-style-ignore
    "Let's dive in": 'tic-dive-in', // recade-style-ignore
    'Lets dive in': 'tic-dive-in', // recade-style-ignore
    'Unlock the power of x': 'tic-unlock', // recade-style-ignore
  };
  for (const [text, rule] of Object.entries(cases)) {
    const f = lintText(text, 'x.md');
    assert.deepEqual(f.map((x) => [x.rule, x.severity]), [[rule, 'warn']], text);
  }
});

test('tic words match whole words only', () => {
  assert.deepEqual(lintText('robustness and delved', 'x.md'), []);
});

test('en dash and hyphen are fine', () => {
  assert.deepEqual(lintText('a \u2013 b - c', 'x.md'), []);
});

test('lintFiles walks directories, skips fixtures, reports relative paths', () => {
  const root = tmpProject({
    'a.md': `x ${DASH} y\n`,
    'docs/b.txt': 'robust\n', // recade-style-ignore
    'src/c.js': '// fine\n',
    'img.png': `${DASH}`,
    'tests/fixtures/bad.md': `${DASH}\n`,
    'node_modules/m/x.md': `${DASH}\n`,
    'package-lock.json': 'robust\n', // recade-style-ignore
  });
  try {
    const f = lintFiles(root, ['.']);
    assert.deepEqual(f.map((x) => [x.file, x.rule]), [
      ['a.md', 'em-dash'],
      ['docs/b.txt', 'tic-robust'], // recade-style-ignore
    ]);
    const g = lintFiles(root, ['docs', 'a.md']);
    assert.deepEqual(g.map((x) => x.file), ['docs/b.txt', 'a.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lint-style takes --project <dir> and reads the paths from that folder', async () => {
  const bad = tmpProject({ 'docs/a.md': `x ${DASH} y\n` });
  const elsewhere = tmpProject({});
  try {
    const t = makeIO(elsewhere);
    assert.equal(await run(['lint-style', 'docs/a.md', '--project', bad], t.io), 1);
    assert.match(t.stdout(), /^docs\/a\.md:1:3 em-dash /m);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('CLI exits 1 on error, 0 on warnings only', async () => {
  const bad = tmpProject({ 'a.md': `x ${DASH} y\n` });
  const warn = tmpProject({ 'a.md': 'a robust plan\n' }); // recade-style-ignore
  try {
    const t1 = makeIO(bad);
    assert.equal(await run(['lint-style'], t1.io), 1);
    assert.match(t1.stdout(), /^a\.md:1:3 em-dash /m);
    const t2 = makeIO(warn);
    assert.equal(await run(['lint-style', '.'], t2.io), 0);
    assert.match(t2.stdout(), /^a\.md:1:3 tic-robust /m); // recade-style-ignore
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(warn, { recursive: true, force: true });
  }
});
