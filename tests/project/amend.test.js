import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { impactOf } from '../../src/project/amend.js';
import { run } from '../../src/cli.js';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'recade-amend-'));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const FILES = {
  'recade/state.yaml': 'version: 1\nlots: [PAY]\n',
  'docs/D1.md': '# D1\n\n| ID | Title |\n|---|---|\n| FR-LN-01 | Apply for a loan |\n',
  'docs/D2.md': '# D2\n\nThe loan form meets FR-LN-01 and DEC-02.\n\n```\nFR-LN-01 in code\n```\n\nUse `FR-LN-01` inline? No.\n',
  'docs/PLAN.md': '# PLAN\n\nM1 delivers FR-LN-01.\nPAY-01 follows FR-LN-01 too.\n',
  'BIBLE.md': '---\nnote: FR-LN-01 in front matter\n---\n# BIBLE\n\nSee DEC-02.\n',
  'slices/S-01.md': '# S-01 Loan form\n\nImplements FR-LN-01 (apply).\n',
  'INDEX.md': '| FR-LN-01 | docs/D1.md |\n',
  'docs/deliverables/D1.md': 'FR-LN-01 rendered\n',
  'node_modules/pkg/README.md': 'FR-LN-01\n',
  '.git/notes.md': 'FR-LN-01\n',
  'docs/notes.txt': 'FR-LN-01 not markdown\n',
};

test('impactOf lists every citation across documents and slices, sorted, skipping code and front matter', () => {
  const root = tree(FILES);
  try {
    const got = impactOf(['FR-LN-01'], root);
    assert.deepEqual(got, [
      { file: 'docs/D2.md', line: 3, id: 'FR-LN-01' },
      { file: 'docs/PLAN.md', line: 3, id: 'FR-LN-01' },
      { file: 'docs/PLAN.md', line: 4, id: 'FR-LN-01' },
      { file: 'slices/S-01.md', line: 3, id: 'FR-LN-01' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('impactOf takes several ids and sorts by file, line, then id', () => {
  const root = tree(FILES);
  try {
    const got = impactOf(['DEC-02', 'FR-LN-01'], root);
    assert.deepEqual(got.map((c) => `${c.file}:${c.line}:${c.id}`), [
      'BIBLE.md:6:DEC-02',
      'docs/D2.md:3:DEC-02',
      'docs/D2.md:3:FR-LN-01',
      'docs/PLAN.md:3:FR-LN-01',
      'docs/PLAN.md:4:FR-LN-01',
      'slices/S-01.md:3:FR-LN-01',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('impactOf knows the backlog lots of the project and ignores an unknown id', () => {
  const root = tree(FILES);
  try {
    assert.deepEqual(impactOf(['PAY-01'], root), []);
    assert.deepEqual(impactOf(['PAY-01'], root, { lots: ['PAY'] }), [{ file: 'docs/PLAN.md', line: 4, id: 'PAY-01' }]);
    assert.deepEqual(impactOf([], root), []);
    assert.deepEqual(impactOf(['FR-ZZ-99'], root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeIO(cwd) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {} },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('recade amend impact prints file:line id, one per line, reading lots from the state', async () => {
  const root = tree(FILES);
  try {
    const t = makeIO(root);
    assert.equal(await run(['amend', 'impact', 'FR-LN-01', 'PAY-01'], t.io), 0);
    assert.equal(t.stdout(), [
      'docs/D2.md:3 FR-LN-01',
      'docs/PLAN.md:3 FR-LN-01',
      'docs/PLAN.md:4 FR-LN-01',
      'docs/PLAN.md:4 PAY-01',
      'slices/S-01.md:3 FR-LN-01',
      '',
    ].join('\n'));
    const none = makeIO(root);
    assert.equal(await run(['amend', 'impact', 'FR-ZZ-99'], none.io), 0);
    assert.equal(none.stdout(), 'No file cites FR-ZZ-99.\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recade amend impact works with --project and rejects bad usage', async () => {
  const root = tree(FILES);
  const elsewhere = mkdtempSync(join(tmpdir(), 'recade-amend-cwd-'));
  try {
    const t = makeIO(elsewhere);
    assert.equal(await run(['amend', 'impact', 'DEC-02', '--project', root], t.io), 0);
    assert.equal(t.stdout(), 'BIBLE.md:6 DEC-02\ndocs/D2.md:3 DEC-02\n');
    for (const args of [[], ['impact'], ['other', 'FR-LN-01'], ['impact', 'not-an-id']]) {
      const bad = makeIO(root);
      assert.equal(await run(['amend', ...args], bad.io), 2, args.join(' '));
      assert.match(bad.stderr(), /Usage: recade amend impact <ID\.\.\.> \[--project <dir>\]/);
    }
    const none = makeIO(elsewhere);
    assert.equal(await run(['amend', 'impact', 'DEC-02'], none.io), 1);
    assert.match(none.stderr(), /No Recade project/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('recade amend impact exits 1 when state.yaml is corrupt', async () => {
  const root = tree({ ...FILES, 'recade/state.yaml': 'version: 1\nlots: [unclosed\n' });
  try {
    const t = makeIO(root);
    assert.equal(await run(['amend', 'impact', 'FR-LN-01'], t.io), 1);
    assert.notEqual(t.stderr(), '');
    assert.equal(t.stdout(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
