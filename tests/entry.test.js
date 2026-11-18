import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectEntryMode } from '../src/entry.js';
import { run } from '../src/cli.js';

/** Fake filesystem: a directory listing, where names ending in "/" are directories. */
function fake(entries) {
  const names = entries.map((e) => e.replace(/\/$/, ''));
  return {
    readdir: () => names,
    exists: (p) => names.includes(p.split('/').pop()),
  };
}

test('entry mode: git + package.json -> adopt; docx only -> from-docs; empty -> new', () => {
  assert.equal(detectEntryMode('/p', fake(['.git/', 'package.json'])), 'adopt');
  assert.equal(detectEntryMode('/p', fake(['brief.docx'])), 'from-docs');
  assert.equal(detectEntryMode('/p', fake([])), 'new');
});

test('adopt needs .git and a project marker', () => {
  for (const marker of ['pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'src/']) {
    assert.equal(detectEntryMode('/p', fake(['.git/', marker])), 'adopt', marker);
  }
  assert.equal(detectEntryMode('/p', fake(['package.json'])), 'new');
  assert.equal(detectEntryMode('/p', fake(['.git/'])), 'new');
});

test('adopt wins over from-docs', () => {
  assert.equal(detectEntryMode('/p', fake(['.git/', 'src/', 'notes.md'])), 'adopt');
});

test('from-docs: documents count, README.md alone does not', () => {
  for (const f of ['a.pdf', 'a.xlsx', 'a.pptx', 'a.docx', 'notes.md']) {
    assert.equal(detectEntryMode('/p', fake([f])), 'from-docs', f);
  }
  assert.equal(detectEntryMode('/p', fake(['README.md'])), 'new');
  assert.equal(detectEntryMode('/p', fake(['README.md', 'brief.md'])), 'from-docs');
  assert.equal(detectEntryMode('/p', fake(['photo.png'])), 'new');
});

test('a missing directory is a new project', () => {
  const readdir = () => {
    throw Object.assign(new Error('x'), { code: 'ENOENT' });
  };
  assert.equal(detectEntryMode('/p', { readdir, exists: () => false }), 'new');
});

test('detectEntryMode works on the real filesystem by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-entry-'));
  assert.equal(detectEntryMode(dir), 'new');
  writeFileSync(join(dir, 'spec.pdf'), '');
  assert.equal(detectEntryMode(dir), 'from-docs');
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, 'src'));
  assert.equal(detectEntryMode(dir), 'adopt');
});

test('recade entry-mode [dir] prints the mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-entry-cli-'));
  writeFileSync(join(dir, 'brief.docx'), '');
  const out = [];
  const io = { stdout: { write: (s) => out.push(s) }, stderr: { write() {} }, cwd: dir, env: {} };
  assert.equal(await run(['entry-mode'], io), 0);
  assert.equal(out.join(''), 'from-docs\n');
  out.length = 0;
  assert.equal(await run(['entry-mode', '.'], io), 0);
  assert.equal(out.join(''), 'from-docs\n');
});

test('recade entry-mode rejects extra arguments with exit 2', async () => {
  const err = [];
  const io = { stdout: { write() {} }, stderr: { write: (s) => err.push(s) }, cwd: '.', env: {} };
  assert.equal(await run(['entry-mode', 'a', 'b'], io), 2);
  assert.match(err.join(''), /Usage: recade entry-mode/);
});
