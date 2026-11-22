import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, chmodSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createProject, slugify } from '../../src/project/scaffold.js';
import { GATES } from '../../src/project/state.js';
import { run } from '../../src/cli.js';

const CONFIG = {
  voice: 'randall-munroe',
  languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] },
};
const TODAY = '2026-11-13';
const tmp = () => mkdtempSync(join(tmpdir(), 'recade-scaffold-'));
const noGit = async () => ({ code: 0, stdout: '', stderr: '' });
const make = (name, opts = {}) =>
  createProject(name, { root: tmp(), mode: 'scratch', config: CONFIG, exec: noGit, today: TODAY, ...opts });

test('slugify folds accents, case and punctuation', () => {
  assert.equal(slugify('Fernhill Lending'), 'fernhill-lending');
  assert.equal(slugify('  Café  Éclair!! v2 '), 'cafe-eclair-v2');
  assert.equal(slugify('///'), '');
});

test('createProject builds the project tree, state and questionnaire', async () => {
  const root = tmp();
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const r = await createProject('Fernhill Lending', { root, mode: 'scratch', config: CONFIG, exec, today: TODAY });
  assert.equal(r.dir, join(root, 'fernhill-lending-workspace'));
  assert.deepEqual(r.copied, []);
  assert.deepEqual(r.unsupported, []);
  for (const d of [
    'recade', 'intake/attachments', 'team', 'design', 'docs/figures', 'docs/deliverables', 'decisions', 'slices', 'retros',
  ]) {
    assert.ok(statSync(join(r.dir, d)).isDirectory(), d);
  }
  assert.deepEqual(calls, [
    ['git', '--version'], ['git', '-C', r.dir, 'init', '-b', 'main'],
    ['git', '-C', r.dir, 'add', '-A'], ['git', '-C', r.dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'chore: create the workspace'],
  ]);
  const ignore = readFileSync(join(r.dir, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('node_modules/'));
  assert.ok(ignore.includes('.recade-cache/'));
  assert.ok(ignore.includes('intake/.provisionals.lock'));
  assert.ok(ignore.includes('decisions/.decisions.lock'));
  assert.ok(ignore.includes('spikes/'));
  assert.ok(!ignore.some((l) => l.includes('deliverables')));
  const q = readFileSync(join(r.dir, 'intake', 'questionnaire.md'), 'utf8');
  assert.match(q, /title: "Fernhill Lending, intake questionnaire"/);
  assert.ok(!q.includes('{{'));
  const p = readFileSync(join(r.dir, 'intake', 'provisionals.md'), 'utf8');
  assert.ok(!p.includes('{{') && !p.includes('PRV-01'));
});

test('createProject writes a normalised state: phase 0, every gate null', async () => {
  const r = await make('Fernhill Lending', { mode: 'from-docs' });
  const state = parse(readFileSync(join(r.dir, 'recade', 'state.yaml'), 'utf8'));
  assert.equal(state.mode, 'from-docs');
  assert.equal(state.phase, 0);
  assert.deepEqual(Object.keys(state.gates), GATES);
  assert.ok(GATES.every((g) => state.gates[g] === null));
  assert.equal(state.next_action, 'Run /recade:new to finish the intake (G0 is open).');
  assert.equal(state.voice, 'randall-munroe');
  assert.equal(state.slicing, 'mixed');
  assert.equal(state.kind, 'workspace');
});

test('createProject returns the workspace: the five ignored entries come first, the tree has docs/source', async () => {
  const r = await make('Fernhill Lending');
  const ignore = readFileSync(join(r.dir, '.gitignore'), 'utf8').split('\n');
  assert.deepEqual(ignore.slice(0, 5), ['repos/', 'worktrees/', 'artifacts/', 'tmp/', '.recade/']);
  assert.ok(statSync(join(r.dir, 'docs', 'source')).isDirectory());
  assert.ok(!existsSync(join(r.dir, 'repos')));
});

test('createProject refuses a non-empty folder and accepts an empty one', async () => {
  const root = tmp();
  mkdirSync(join(root, 'fernhill-lending-workspace'));
  const opts = { root, mode: 'scratch', config: CONFIG, exec: noGit, today: TODAY };
  await createProject('Fernhill Lending', opts);
  await assert.rejects(createProject('Fernhill Lending', opts), /already exists and is not empty/);
  rmSync(join(root, 'other'), { recursive: true, force: true });
  await assert.rejects(createProject('///', opts), /Invalid project name/);
});

test('createProject fails with one line when git init fails', async () => {
  const exec = async (cmd, args) => (args.includes('init')
    ? { code: 1, stdout: '', stderr: 'fatal: nope\nmore' }
    : { code: 0, stdout: '', stderr: '' });
  await assert.rejects(make('Fernhill Lending', { exec }), /git init failed: fatal: nope/);
});

test('--from copies a nested folder, keeps names with spaces and accents, lists unsupported files', async () => {
  const from = tmp();
  mkdirSync(join(from, 'Contrats', 'Été 2026'), { recursive: true });
  writeFileSync(join(from, 'brief client.docx'), 'a');
  writeFileSync(join(from, 'Contrats', 'Été 2026', 'tarifs révisés.PDF'), 'b');
  writeFileSync(join(from, 'Contrats', 'notes.md'), 'c');
  writeFileSync(join(from, 'Contrats', 'logo.svg'), 'd');
  writeFileSync(join(from, 'maquette.pages'), 'e');
  writeFileSync(join(from, 'Contrats', 'archive.zip'), 'f');
  writeFileSync(join(from, '.DS_Store'), 'g');
  const r = await make('Fernhill Lending', { mode: 'from-docs', from });
  const att = join(r.dir, 'intake', 'attachments');
  assert.equal(readFileSync(join(att, 'brief client.docx'), 'utf8'), 'a');
  assert.equal(readFileSync(join(att, 'Contrats', 'Été 2026', 'tarifs révisés.PDF'), 'utf8'), 'b');
  assert.deepEqual(r.copied, [
    'Contrats/logo.svg', 'Contrats/notes.md', 'Contrats/Été 2026/tarifs révisés.PDF', 'brief client.docx',
  ]);
  assert.deepEqual(r.unsupported, ['Contrats/archive.zip', 'maquette.pages']);
  assert.ok(!existsSync(join(att, 'maquette.pages')));
  const gaps = readFileSync(join(r.dir, 'intake', 'gaps.md'), 'utf8');
  assert.match(gaps, /## Unsupported files/);
  assert.match(gaps, /^- maquette\.pages$/m);
  assert.match(gaps, /^- Contrats\/archive\.zip$/m);
  assert.ok(!gaps.includes('.DS_Store'));
});

test('--from with only supported files writes no gaps file; a missing folder is an error', async () => {
  const from = tmp();
  writeFileSync(join(from, 'a.txt'), 'x');
  const r = await make('Fernhill Lending', { from });
  assert.ok(!existsSync(join(r.dir, 'intake', 'gaps.md')));
  const root = tmp();
  await assert.rejects(
    make('Fernhill Lending', { root, from: join(root, 'nope') }),
    /Cannot read the folder/,
  );
  assert.deepEqual(readdirSync(root), []);
});

function makeIO(env) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd: tmp(), env,
      exec: noGit, now: () => new Date(2026, 10, 13) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('recade new creates the project under projects_root and prints a summary', async () => {
  const root = tmp();
  const cfg = tmp();
  writeFileSync(join(cfg, 'config.yaml'), `projects_root: ${root}\n`);
  const t = makeIO({ RECADE_CONFIG_DIR: cfg, HOME: root });
  assert.equal(await run(['new', 'Fernhill Lending'], t.io), 0);
  assert.ok(existsSync(join(root, 'fernhill-lending-workspace', 'recade', 'state.yaml')));
  assert.match(t.stdout(), /Created .*fernhill-lending-workspace/);
  const j = makeIO({ RECADE_CONFIG_DIR: cfg, HOME: root });
  assert.equal(await run(['new', 'Fernhill Lending', '--json'], j.io), 1);
  assert.match(j.stderr(), /already exists and is not empty/);
});

test('recade new --json prints dir, copied and unsupported; usage errors exit 2', async () => {
  const root = tmp();
  const cfg = tmp();
  const from = tmp();
  writeFileSync(join(from, 'a.pdf'), 'x');
  writeFileSync(join(from, 'b.pages'), 'y');
  writeFileSync(join(cfg, 'config.yaml'), `projects_root: ${root}\n`);
  const t = makeIO({ RECADE_CONFIG_DIR: cfg });
  assert.equal(await run(['new', 'Fernhill Lending', '--from', from, '--json'], t.io), 0);
  const out = JSON.parse(t.stdout());
  assert.equal(out.dir, join(root, 'fernhill-lending-workspace'));
  assert.deepEqual(out.copied, ['a.pdf']);
  assert.deepEqual(out.unsupported, ['b.pages']);
  for (const args of [['new'], ['new', 'A', 'B'], ['new', 'A', '--from'], ['new', 'A', '--parent'], ['new', 'A', '--bogus']]) {
    const u = makeIO({ RECADE_CONFIG_DIR: cfg });
    assert.equal(await run(args, u.io), 2, args.join(' '));
    assert.match(u.stderr(), /^Usage: recade new <name> \[--parent <dir>\] \[--from <dir>\] \[--json\]/);
  }
});

test('recade new --parent creates the workspace in that folder, whatever projects_root says, with a space and an accent', async () => {
  const root = tmp();
  const cfg = tmp();
  const parent = join(tmp(), 'Projets Clients', 'Été');
  mkdirSync(parent, { recursive: true });
  writeFileSync(join(cfg, 'config.yaml'), `projects_root: ${root}\n`);
  const t = makeIO({ RECADE_CONFIG_DIR: cfg });
  assert.equal(await run(['new', 'Fernhill Lending', '--parent', parent, '--json'], t.io), 0);
  assert.equal(JSON.parse(t.stdout()).dir, join(parent, 'fernhill-lending-workspace'));
  assert.ok(existsSync(join(parent, 'fernhill-lending-workspace', 'recade', 'state.yaml')));
  assert.deepEqual(readdirSync(root), [], 'projects_root is not touched');
  // A relative parent is read from where the command was typed, and a parent that does not exist is created.
  const rel = makeIO({ RECADE_CONFIG_DIR: cfg });
  rel.io.cwd = parent;
  assert.equal(await run(['new', 'Other', '--parent', 'sub/dir'], rel.io), 0);
  assert.ok(existsSync(join(parent, 'sub', 'dir', 'other-workspace', 'recade', 'state.yaml')));
});

test('a failed git init leaves no folder behind, and an empty folder that was there stays empty', async () => {
  const root = tmp();
  const failInit = async (cmd, args) =>
    args.includes('init') ? { code: 1, stdout: '', stderr: 'fatal: nope' } : { code: 0, stdout: '', stderr: '' };
  await assert.rejects(make('Fernhill Lending', { root, exec: failInit }), /git init failed/);
  assert.deepEqual(readdirSync(root), []);
  mkdirSync(join(root, 'fernhill-lending-workspace'));
  await assert.rejects(make('Fernhill Lending', { root, exec: failInit }), /git init failed/);
  assert.deepEqual(readdirSync(join(root, 'fernhill-lending-workspace')), []);
});

test('git is checked before anything is created', async () => {
  const root = tmp();
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(args[0]);
    return { code: 127, stdout: '', stderr: '' };
  };
  await assert.rejects(make('Fernhill Lending', { root, exec }), /Git is not installed/);
  assert.deepEqual(calls, ['--version']);
  assert.deepEqual(readdirSync(root), []);
});

test('a copy failure removes what was created', { skip: process.getuid?.() === 0 }, async () => {
  const from = tmp();
  writeFileSync(join(from, 'a.pdf'), 'x');
  writeFileSync(join(from, 'b.pdf'), 'y');
  chmodSync(join(from, 'b.pdf'), 0o000);
  const root = tmp();
  try {
    await assert.rejects(make('Fernhill Lending', { root, from }));
  } finally {
    chmodSync(join(from, 'b.pdf'), 0o644);
  }
  assert.deepEqual(readdirSync(root), []);
});

test('--from accepts .jpeg and .markdown, skips Office lock files, reports links, flags large files', async () => {
  const from = tmp();
  writeFileSync(join(from, 'photo.JPEG'), 'a');
  writeFileSync(join(from, 'notes.markdown'), 'b');
  writeFileSync(join(from, '~$brief.docx'), 'lock');
  writeFileSync(join(from, 'big #1 [final].pdf'), 'x'.repeat(100));
  writeFileSync(join(from, 'small.pdf'), 'x');
  symlinkSync(join(from, 'small.pdf'), join(from, 'link.pdf'));
  const r = await make('Fernhill Lending', { from, maxBytes: 50 });
  assert.deepEqual(r.copied, ['big #1 [final].pdf', 'notes.markdown', 'photo.JPEG', 'small.pdf']);
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(r.links, ['link.pdf']);
  assert.deepEqual(r.large, ['big #1 [final].pdf']);
  const gaps = readFileSync(join(r.dir, 'intake', 'gaps.md'), 'utf8');
  assert.match(gaps, /## Skipped links\n[\s\S]*^- link\.pdf$/m);
  assert.match(gaps, /## Large files\n[\s\S]*^- big #1 \[final\]\.pdf$/m);
  assert.ok(!gaps.includes('~$brief'));
  assert.ok(!gaps.includes('## Unsupported files'));
  const ignore = readFileSync(join(r.dir, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignore.includes('/intake/attachments/big \\#1 \\[final\\].pdf'));
  assert.ok(existsSync(join(r.dir, 'intake', 'attachments', 'big #1 [final].pdf')));
});

test('recade new --parent that is a file says so, and creates nothing', async () => {
  const cfg = tmp();
  const base = tmp();
  const file = join(base, 'a-file');
  writeFileSync(file, 'x');
  for (const parent of [file, join(file, 'deeper')]) {
    const t = makeIO({ RECADE_CONFIG_DIR: cfg });
    assert.equal(await run(['new', 'Fernhill', '--parent', parent], t.io), 1);
    assert.match(t.stderr(), /is a file, not a folder/);
    assert.doesNotMatch(t.stderr(), /ENOTDIR/);
  }
});
