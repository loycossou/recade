import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync, lstatSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  preflight, initAdopt, ownFile, writeOwnFile, readCreated, AdoptError, CREATED_FILE,
} from '../../src/project/adopt.js';
import { loadState } from '../../src/state.js';
import { normalizeState, ADOPT_GATES, gatesOf, phasesOf, canStart, passGate, nextAction, phaseCommand, resetFrom, GATES } from '../../src/project/state.js';
import { checkLink, findWorkspace } from '../../src/workspace/layout.js';
import { defaultExec } from '../../src/doctor.js';
import { run } from '../../src/cli.js';

const PLUGIN = fileURLToPath(new URL('../../', import.meta.url));
const CONFIG = { voice: 'randall-munroe', languages: { chat: 'en', work: 'en', deliverables: ['en'], code: 'en', product_ui: ['en'] } };

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A committed repository on `main` with a small codebase. `files` are added to the first commit. */
function repo(files = {}, branch = 'main') {
  const dir = mkdtempSync(join(tmpdir(), 'recade-adopt-'));
  git(dir, 'init', '-b', branch);
  git(dir, 'config', 'user.email', 'dev-example-test');
  git(dir, 'config', 'user.name', 'Dev');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const all = { 'package.json': '{"name":"fernhill-api"}\n', 'src/index.js': 'export const x = 1;\n', ...files };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Hash of every file under `dir` except `.git`, `recade/` and `.recade/`: what adopt must not touch. */
function tree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel === '' ? e.name : `${rel}/${e.name}`;
      if (p === '.git' || p === 'recade' || p === '.recade') continue;
      if (e.isDirectory()) walk(p);
      else out[p] = sha(join(dir, p));
    }
  };
  walk('');
  return out;
}

const EXISTING = {
  '.claude/settings.json': '{"permissions":{"allow":["Bash(npm test)"]}}\n',
  '.claude/agents/mine.md': '---\nname: mine\n---\nMy own agent.\n',
  'CLAUDE.md': '# Rules\n\nBe kind.\n',
  'docs/architecture.md': '# Architecture\n\nA monolith.\n',
  '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs: {}\n',
};

function makeIO(cwd, extra = {}) {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {}, ...extra },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('preflight accepts a clean repository on its default branch', async () => {
  const dir = repo();
  try {
    const r = await preflight(dir, { exec: defaultExec });
    assert.deepEqual(r, { ok: true, dirty: [], branch: 'main', defaultBranch: 'main', reasons: [], remote: null, unpushed: 0 });
  } finally { cleanup(dir); }
});

test('preflight lists every dirty file: modified, staged, deleted, untracked and renamed', async () => {
  const dir = repo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  try {
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    git(dir, 'rm', '-q', 'b.txt');
    git(dir, 'mv', 'c.txt', 'd.txt');
    mkdirSync(join(dir, 'notes'));
    writeFileSync(join(dir, 'notes', 'todo.md'), 'x\n');
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.deepEqual(r.dirty, ['a.txt', 'b.txt', 'd.txt', 'notes/todo.md']);
    assert.match(r.reasons[0], /uncommitted/);
    assert.match(r.reasons[0], /a\.txt/);
    assert.match(r.reasons[0], /notes\/todo\.md/);
  } finally { cleanup(dir); }
});

test('preflight refuses a branch that is not the default one', async () => {
  const dir = repo();
  try {
    git(dir, 'checkout', '-q', '-b', 'feature/login');
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.equal(r.branch, 'feature/login');
    assert.equal(r.defaultBranch, 'main');
    assert.deepEqual(r.dirty, []);
    assert.match(r.reasons.join('\n'), /feature\/login/);
    assert.match(r.reasons.join('\n'), /main/);
  } finally { cleanup(dir); }
});

test('preflight reads the default branch from origin/HEAD, then main, then master', async () => {
  const dir = repo({}, 'trunk');
  try {
    git(dir, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.defaultBranch, 'trunk');
    assert.equal(r.ok, true);
  } finally { cleanup(dir); }
  const old = repo({}, 'master');
  try {
    const r = await preflight(old, { exec: defaultExec });
    assert.equal(r.defaultBranch, 'master');
    assert.equal(r.ok, true);
  } finally { cleanup(old); }
  const odd = repo({}, 'develop');
  try {
    git(odd, 'config', 'init.defaultBranch', 'develop');
    const r = await preflight(odd, { exec: defaultExec });
    assert.equal(r.defaultBranch, 'develop');
    assert.equal(r.ok, true);
  } finally { cleanup(odd); }
});

test('preflight refuses a detached HEAD, a folder that is not a repository and a subfolder of one', async () => {
  const dir = repo();
  try {
    git(dir, 'checkout', '-q', '--detach');
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.equal(r.branch, null);
    assert.match(r.reasons.join('\n'), /detached/);
    git(dir, 'checkout', '-q', 'main');
    mkdirSync(join(dir, 'packages', 'web'), { recursive: true });
    const sub = await preflight(join(dir, 'packages', 'web'), { exec: defaultExec });
    assert.equal(sub.ok, false);
    assert.match(sub.reasons.join('\n'), /root of the repository/);
  } finally { cleanup(dir); }
  const plain = mkdtempSync(join(tmpdir(), 'recade-adopt-plain-'));
  try {
    const r = await preflight(plain, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /not a Git repository/);
  } finally { cleanup(plain); }
});

test('preflight says so when Git is missing or the exec fails', async () => {
  const r = await preflight('/p', { exec: async () => ({ code: 127, stdout: '', stderr: 'spawn git ENOENT' }) });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join('\n'), /Git/);
  const t = await preflight('/p', { exec: async () => { throw new Error('boom'); } });
  assert.equal(t.ok, false);
});

test('ownFile is true only for recorded files and survives a missing or corrupt record', async () => {
  const dir = repo();
  try {
    assert.equal(ownFile(dir, 'recade/state.yaml'), false);
    assert.deepEqual(readCreated(dir), []);
    mkdirSync(join(dir, '.recade'));
    writeFileSync(join(dir, CREATED_FILE), 'not json');
    assert.equal(ownFile(dir, 'recade/state.yaml'), false);
    assert.deepEqual(readCreated(dir), []);
    const sum = (t) => createHash('sha256').update(t).digest('hex');
    mkdirSync(join(dir, 'docs', 'recade'), { recursive: true });
    writeFileSync(join(dir, 'docs/RULES.md'), 'rules\n');
    writeFileSync(join(dir, CREATED_FILE), JSON.stringify({ version: 1, files: [
      { path: 'docs/RULES.md', sha256: sum('rules\n') }, 'docs/OLD.md', 3, { path: '../x', sha256: sum('x') }, { path: 'src/index.js', sha256: sum('export const x = 1;\n') },
    ] }));
    assert.equal(ownFile(dir, 'docs/RULES.md'), true);
    assert.equal(ownFile(dir, './docs/RULES.md'), true);
    assert.equal(ownFile(dir, 'docs/OTHER.md'), false);
    assert.equal(ownFile(dir, '../x'), false);
    assert.equal(ownFile(dir, '/etc/passwd'), false);
    assert.equal(ownFile(dir, 'src/index.js'), false, 'outside the allow-list, even when recorded');
    assert.deepEqual(readCreated(dir), ['docs/RULES.md']);
    writeFileSync(join(dir, 'docs/RULES.md'), 'edited\n');
    assert.equal(ownFile(dir, 'docs/RULES.md'), false, 'a file that no longer matches what Recade wrote is the owner file');
  } finally { cleanup(dir); }
});

test('writeOwnFile creates a file and records it, then updates only its own files', async () => {
  const dir = repo({ 'docs/architecture.md': '# Mine\n' });
  try {
    assert.equal(writeOwnFile(dir, 'docs/RULES.md', 'one\n'), 'created');
    assert.equal(ownFile(dir, 'docs/RULES.md'), true);
    assert.equal(readFileSync(join(dir, 'docs/RULES.md'), 'utf8'), 'one\n');
    assert.equal(writeOwnFile(dir, 'docs/RULES.md', 'one\n'), 'unchanged');
    assert.equal(writeOwnFile(dir, 'docs/RULES.md', 'two\n'), 'updated');
    assert.equal(readFileSync(join(dir, 'docs/RULES.md'), 'utf8'), 'two\n');
    assert.deepEqual(readCreated(dir), ['docs/RULES.md']);
    assert.throws(() => writeOwnFile(dir, 'docs/architecture.md', 'replaced\n'), (err) => err instanceof AdoptError && /not created by Recade/.test(err.message));
    assert.equal(readFileSync(join(dir, 'docs/architecture.md'), 'utf8'), '# Mine\n');
    assert.equal(ownFile(dir, 'docs/architecture.md'), false);
  } finally { cleanup(dir); }
});

test('writeOwnFile refuses a file recorded as ours that the owner replaced by a symbolic link, and paths outside its folders', async () => {
  const dir = repo({ 'CLAUDE.md': '# Rules\n', 'src/app.js': 'x\n' });
  try {
    writeOwnFile(dir, 'docs/RULES.md', 'one\n');
    rmSync(join(dir, 'docs/RULES.md'));
    symlinkSync(join(dir, 'src', 'app.js'), join(dir, 'docs/RULES.md'));
    assert.throws(() => writeOwnFile(dir, 'docs/RULES.md', 'two\n'), AdoptError);
    assert.equal(readFileSync(join(dir, 'src/app.js'), 'utf8'), 'x\n');
    assert.equal(lstatSync(join(dir, 'docs/RULES.md')).isSymbolicLink(), true);
    for (const rel of ['src/app.js', 'CLAUDE.md', 'package.json', '../escape.md', '/tmp/x.md', 'docs/../src/app.js', '.github/workflows/ci.yml', '.git/hooks/pre-commit', '']) {
      assert.throws(() => writeOwnFile(dir, rel, 'x'), AdoptError, rel);
    }
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '# Rules\n');
    for (const rel of ['recade/x.md', 'docs/x.md', 'slices/S-01.md', '.recade/x.json', '.claude/agents/x.md', '.githooks/pre-commit', '.github/workflows/recade.yml']) {
      assert.equal(writeOwnFile(dir, rel, 'x'), 'created', rel);
    }
  } finally { cleanup(dir); }
});

test('adopt mode state: G0-inventory replaces G0, the other gates and phases are those of plan 3', () => {
  assert.deepEqual(ADOPT_GATES, ['G0-inventory', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5']);
  assert.deepEqual(GATES, ['G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5']);
  const s = normalizeState({ mode: 'adopt' });
  assert.deepEqual(gatesOf(s), ADOPT_GATES);
  assert.deepEqual(gatesOf({ mode: 'scratch' }), GATES);
  assert.equal(phasesOf(s)[0].command, 'adopt');
  assert.equal(phasesOf(s)[0].name, 'Inventory');
  assert.deepEqual(phasesOf(s).slice(1).map((p) => p.gates), [['G1'], ['G2-stack', 'G2'], ['G3'], ['G4'], ['G5']]);
  assert.deepEqual(canStart(s, 1), { ok: false, missing: 'G0-inventory' });
  assert.throws(() => passGate(s, 'G0', '2026-11-14'), /Unknown gate: G0\. Use G0-inventory/);
  const one = passGate(s, 'G0-inventory', '2026-11-14');
  assert.equal(one.phase, 1);
  assert.equal(nextAction(one), 'Run /recade:team (G0-inventory passed on 2026-11-14).');
  assert.equal(resetFrom(one, 'G0-inventory').gates['G0-inventory'], null);
  assert.throws(() => resetFrom(one, 'G0'), /Unknown gate/);
});

test('recade adopt rejects bad usage with exit 2', async () => {
  for (const args of [[], ['nope'], ['init', '--bogus'], ['init', 'x'], ['preflight', '--full']]) {
    const t = makeIO(process.cwd());
    assert.equal(await run(['adopt', ...args], t.io), 2, args.join(' '));
    assert.match(t.stderr(), /Usage: recade adopt init --parent <dir> --repo <path\|url> \[--repo/);
  }
});

test('recade adopt preflight reports without writing anything: exit 0 when ready, 1 with the reasons otherwise', async () => {
  const dir = repo();
  try {
    let t = makeIO(dir);
    assert.equal(await run(['adopt', 'preflight'], t.io), 0);
    assert.match(t.stdout(), /^Ready: no uncommitted work, on main, no remote\. Nothing was written\.$/m);
    t = makeIO(dir);
    assert.equal(await run(['adopt', 'preflight', '--json'], t.io), 0);
    assert.deepEqual(JSON.parse(t.stdout()), { ok: true, dirty: [], branch: 'main', defaultBranch: 'main', reasons: [], remote: null, unpushed: 0 });
    writeFileSync(join(dir, 'wip.js'), 'x\n');
    git(dir, 'checkout', '-q', '-b', 'topic');
    t = makeIO(dir);
    assert.equal(await run(['adopt', 'preflight'], t.io), 1);
    assert.match(t.stderr(), /wip\.js/);
    assert.match(t.stderr(), /topic/);
    t = makeIO(dir);
    assert.equal(await run(['adopt', 'preflight', '--json'], t.io), 1);
    assert.equal(JSON.parse(t.stdout()).ok, false);
    assert.equal(existsSync(join(dir, 'recade')), false);
    assert.equal(existsSync(join(dir, '.recade')), false);
  } finally { cleanup(dir); }
});

test('writeOwnFile refuses a symbolic link inside the repository that leads out of the allowed folder', async () => {
  const dir = repo({ 'src/keep.js': 'k\n' });
  try {
    symlinkSync(join(dir, 'src'), join(dir, 'docs'));
    assert.throws(() => writeOwnFile(dir, 'docs/x.md', 'x'), AdoptError);
    assert.equal(existsSync(join(dir, 'src', 'x.md')), false);
    rmSync(join(dir, 'docs'));
    symlinkSync(join(dir, '.git'), join(dir, 'docs'));
    assert.throws(() => writeOwnFile(dir, 'docs/x.md', 'x'), AdoptError);
    assert.equal(existsSync(join(dir, '.git', 'x.md')), false);
    rmSync(join(dir, 'docs'));
    mkdirSync(join(dir, 'docs'));
    symlinkSync(join(dir, 'src'), join(dir, 'docs', 'sub'));
    assert.throws(() => writeOwnFile(dir, 'docs/sub/x.md', 'x'), AdoptError);
    assert.equal(existsSync(join(dir, 'src', 'x.md')), false);
    rmSync(join(dir, 'docs'), { recursive: true });
    symlinkSync(join(dir, '.git'), join(dir, '.recade'));
    assert.throws(() => writeOwnFile(dir, 'docs/x.md', 'x'), AdoptError);
    assert.equal(existsSync(join(dir, '.git', 'created.json')), false);
    assert.equal(existsSync(join(dir, 'docs', 'x.md')), false);
    rmSync(join(dir, '.recade'));
    mkdirSync(join(dir, '.github'));
    symlinkSync(join(dir, 'src'), join(dir, '.github', 'workflows'));
    assert.throws(() => writeOwnFile(dir, '.github/workflows/recade.yml', 'x'), AdoptError);
    assert.equal(existsSync(join(dir, 'src', 'recade.yml')), false);
    rmSync(join(dir, '.github', 'workflows'));
    assert.equal(writeOwnFile(dir, '.github/workflows/recade.yml', 'x'), 'created');
  } finally { cleanup(dir); }
});

test('a created.json that was not written by Recade is not trusted: it cannot own or hide the owner files', async () => {
  const dir = repo({ 'docs/own.md': 'owner text\n' });
  try {
    const sum = (t) => createHash('sha256').update(t).digest('hex');
    mkdirSync(join(dir, '.recade'));
    writeFileSync(join(dir, CREATED_FILE), JSON.stringify({ version: 1, files: [
      { path: 'docs/own.md', sha256: sum('something else') }, { path: 'src/index.js', sha256: sum('edited\n') }, 'docs/own.md',
    ] }));
    assert.throws(() => writeOwnFile(dir, 'docs/own.md', 'replaced\n'), AdoptError);
    assert.equal(readFileSync(join(dir, 'docs/own.md'), 'utf8'), 'owner text\n');
    writeFileSync(join(dir, 'src', 'index.js'), 'edited\n');
    assert.deepEqual((await preflight(dir, { exec: defaultExec })).dirty, ['src/index.js']);
  } finally { cleanup(dir); }
});

test('an own file the owner committed and then edited is never overwritten and shows as dirty', async () => {
  const dir = repo();
  try {
    writeOwnFile(dir, 'docs/RULES.md', 'rules\n');
    git(dir, 'add', '-f', 'docs/RULES.md');
    git(dir, 'commit', '-q', '-m', 'add recade rules');
    assert.deepEqual((await preflight(dir, { exec: defaultExec })).dirty, []);
    assert.equal(writeOwnFile(dir, 'docs/RULES.md', 'rules v2\n'), 'updated');
    writeFileSync(join(dir, 'docs/RULES.md'), 'owner edit\n');
    assert.deepEqual((await preflight(dir, { exec: defaultExec })).dirty, ['docs/RULES.md']);
    assert.throws(() => writeOwnFile(dir, 'docs/RULES.md', 'rules v3\n'), (err) => err instanceof AdoptError && /changed since Recade wrote it/.test(err.message));
    assert.equal(readFileSync(join(dir, 'docs/RULES.md'), 'utf8'), 'owner edit\n');
  } finally { cleanup(dir); }
});

test('preflight says when it cannot tell the default branch, and takes the owner answer', async () => {
  const dir = repo({}, 'trunk');
  try {
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.equal(r.defaultBranch, null);
    assert.equal(r.needsDefaultBranch, true);
    assert.deepEqual(r.candidates, ['trunk']);
    assert.match(r.reasons.join('\n'), /Cannot tell the default branch/);
    assert.match(r.reasons.join('\n'), /--default-branch/);
    assert.equal(r.reasons.join('\n').includes('Check out main'), false);
    const answered = await preflight(dir, { exec: defaultExec, defaultBranch: 'trunk' });
    assert.deepEqual(answered, { ok: true, dirty: [], branch: 'trunk', defaultBranch: 'trunk', reasons: [], remote: null, unpushed: 0 });
    const other = await preflight(dir, { exec: defaultExec, defaultBranch: 'main' });
    assert.equal(other.ok, false);
    assert.match(other.reasons.join('\n'), /not the default branch main/);
  } finally { cleanup(dir); }
});

test('preflight reports the ambiguity when main and master both exist and nothing says which is the default', async () => {
  const dir = repo();
  try {
    git(dir, 'branch', 'master');
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.equal(r.needsDefaultBranch, true);
    assert.deepEqual(r.candidates, ['main', 'master']);
    assert.match(r.reasons.join('\n'), /both main and master/);
    assert.equal((await preflight(dir, { exec: defaultExec, defaultBranch: 'main' })).ok, true);
    git(dir, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/master');
    const viaOrigin = await preflight(dir, { exec: defaultExec });
    assert.equal(viaOrigin.defaultBranch, 'master');
    assert.equal(viaOrigin.ok, false);
  } finally { cleanup(dir); }
});

test('preflight in a repository without a commit asks for the default branch instead of inventing one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-adopt-'));
  try {
    git(dir, 'init', '-b', 'trunk');
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.equal(r.needsDefaultBranch, true);
    assert.equal(r.branch, 'trunk');
    assert.equal((await preflight(dir, { exec: defaultExec, defaultBranch: 'trunk' })).ok, true);
  } finally { cleanup(dir); }
});

test('recade adopt write puts stdin through the own-files policy: created, updated, then refused outside it or over an owner file', async () => {
  const dir = repo({ 'docs/guide.md': 'owner text\n' });
  try {
    const write = async (rel, text) => {
      const t = makeIO(dir, { readStdin: async () => text });
      const code = await run(['adopt', 'write', rel], t.io);
      return { code, out: t.stdout(), err: t.stderr() };
    };
    const a = await write('docs/inventory.md', '# Inventory\n');
    assert.deepEqual([a.code, a.out], [0, 'Created: docs/inventory.md\n']);
    assert.equal(readFileSync(join(dir, 'docs/inventory.md'), 'utf8'), '# Inventory\n');
    assert.ok(readCreated(dir).includes('docs/inventory.md'));
    assert.deepEqual([(await write('docs/inventory.md', '# Inventory\n')).out], ['Unchanged: docs/inventory.md\n']);
    assert.deepEqual([(await write('docs/inventory.md', '# Inventory 2\n')).out], ['Updated: docs/inventory.md\n']);
    for (const rel of ['src/index.js', '../x.md', '/etc/passwd', 'docs/guide.md']) {
      const r = await write(rel, 'x\n');
      assert.equal(r.code, 1, rel);
      assert.match(r.err, /Refused/);
    }
    assert.equal(readFileSync(join(dir, 'docs/guide.md'), 'utf8'), 'owner text\n');
    for (const args of [['write'], ['write', 'a', 'b'], ['write', 'docs/a.md', '--json']]) {
      const t = makeIO(dir, { readStdin: async () => 'x' });
      assert.equal(await run(['adopt', ...args], t.io), 2, args.join(' '));
      assert.match(t.stderr(), /write <path> \(content on stdin\)/);
    }
  } finally { cleanup(dir); }
});

test('writeOwnFile creates .github/dependabot.yml and .gitignore only when absent, and refuses them once they are the owner\'s', () => {
  const dir = repo();
  try {
    assert.equal(writeOwnFile(dir, '.github/dependabot.yml', 'version: 2\n'), 'created');
    assert.equal(writeOwnFile(dir, '.gitignore', '.recade/\n'), 'created');
    assert.deepEqual(readCreated(dir).sort(), ['.github/dependabot.yml', '.gitignore']);
    const owner = repo({ '.github/dependabot.yml': 'mine\n', '.gitignore': 'dist\n' });
    try {
      assert.throws(() => writeOwnFile(owner, '.github/dependabot.yml', 'x\n'), AdoptError);
      assert.throws(() => writeOwnFile(owner, '.gitignore', 'x\n'), AdoptError);
      assert.throws(() => writeOwnFile(owner, '.github/other.yml', 'x\n'), AdoptError);
      assert.equal(readFileSync(join(owner, '.gitignore'), 'utf8'), 'dist\n');
    } finally {
      cleanup(owner);
    }
  } finally {
    cleanup(dir);
  }
});

test('writeOwnFile keepEdits rewrites a recorded file the owner edited, and still refuses an unrecorded one', () => {
  const dir = repo({ 'docs/mine.md': 'mine\n' });
  try {
    writeOwnFile(dir, '.claude/a.md', 'one\n');
    writeFileSync(join(dir, '.claude/a.md'), 'one\nteam text\n');
    assert.throws(() => writeOwnFile(dir, '.claude/a.md', 'two\n'), /changed since Recade wrote it/);
    assert.equal(writeOwnFile(dir, '.claude/a.md', 'two\n', { keepEdits: true }), 'updated');
    assert.throws(() => writeOwnFile(dir, 'docs/mine.md', 'x\n', { keepEdits: true }), /not created by Recade/);
  } finally {
    cleanup(dir);
  }
});

// ---- adopt into a workspace (plan 5b task 9) ----

/** `dir` gets an origin: a bare clone of it (its path is the remote URL), with the upstream of `main` set. */
function withRemote(dir, { upstream = true } = {}) {
  const bare = mkdtempSync(join(tmpdir(), 'recade-adopt-remote-'));
  rmSync(bare, { recursive: true });
  const r = spawnSync('git', ['clone', '-q', '--bare', dir, bare], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'fetch', '-q', 'origin');
  if (upstream) git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  return bare;
}

const parentDir = () => mkdtempSync(join(tmpdir(), 'recade-adopt-parent-'));
const options = (parent, repos, extra = {}) => ({ parent, repos, exec: defaultExec, config: CONFIG, pluginRoot: PLUGIN, name: 'fernhill-desk', ...extra });

/** Hash of every file of `dir`, `.git` included: the original must come out of adopt exactly as it went in. */
function fullTree(dir) {
  const out = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const rel = join(e.parentPath ?? e.path, e.name).slice(dir.length + 1);
    out[rel] = sha(join(dir, rel));
  }
  return out;
}

test('preflight refuses commits that are not pushed to the upstream, with their number', async () => {
  const dir = repo();
  const bare = withRemote(dir);
  try {
    assert.equal((await preflight(dir, { exec: defaultExec })).ok, true);
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'one');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'two');
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.equal(r.unpushed, 2);
    assert.match(r.reasons.join('\n'), /2 commits are not pushed to origin\/main/);
  } finally { cleanup(dir); cleanup(bare); }
});

test('preflight refuses a repository with a remote and no upstream, and reports the remote URL when it is ready', async () => {
  const dir = repo();
  const bare = withRemote(dir, { upstream: false });
  try {
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.match(r.reasons.join('\n'), /no upstream/);
    git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    const ok = await preflight(dir, { exec: defaultExec });
    assert.equal(ok.ok, true);
    assert.equal(ok.remote, bare);
    assert.equal(ok.unpushed, 0);
  } finally { cleanup(dir); cleanup(bare); }
});

test('preflight tells the dirty files of a repository, not the files Recade wrote in it earlier', async () => {
  const dir = repo();
  try {
    writeOwnFile(dir, '.claude/agents/x.md', 'rules\n');
    assert.deepEqual((await preflight(dir, { exec: defaultExec })).dirty, []);
    writeFileSync(join(dir, 'src', 'index.js'), 'edited\n');
    mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'agents', 'mine.md'), 'owner file next to ours\n');
    assert.deepEqual((await preflight(dir, { exec: defaultExec })).dirty, ['.claude/agents/mine.md', 'src/index.js']);
  } finally { cleanup(dir); }
});

test('initAdopt with a remote: the workspace is created, the clone has the remote URL of the original as origin, the registry notes it', async () => {
  const dir = repo(EXISTING);
  const bare = withRemote(dir);
  const parent = parentDir();
  try {
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }], { full: true }));
    assert.equal(r.dir, join(parent, 'fernhill-desk-workspace'));
    assert.deepEqual(r.repos.map((x) => [x.name, x.remote]), [['api', bare]]);
    const code = join(r.dir, 'repos', 'api');
    assert.equal(git(code, 'remote', 'get-url', 'origin').trim(), bare, 'origin is the remote of the original, not its folder');
    const state = loadState(r.dir);
    assert.equal(state.kind, 'workspace');
    assert.equal(state.mode, 'adopt');
    assert.equal(state.full, true);
    assert.equal(state.phase, 0);
    assert.deepEqual(Object.keys(state.gates), ['G0-inventory', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5']);
    assert.equal(state.next_action, 'Run /recade:adopt to finish the inventory (G0-inventory is open).');
    assert.deepEqual(state.repos.map((x) => [x.name, x.path, x.remote]), [['api', 'repos/api', bare]]);
    assert.deepEqual(checkLink(code), { ok: true });
    assert.equal(findWorkspace(code).dir, r.dir);
    assert.equal(r.warnings.some((w) => /no remote/i.test(w)), false);
    // the workspace starts clean, with its first commit
    assert.equal(git(r.dir, 'status', '--porcelain').trim(), '');
    assert.equal(git(r.dir, 'rev-list', '--count', 'HEAD').trim(), '1');
  } finally { cleanup(dir); cleanup(bare); cleanup(parent); }
});

test('initAdopt of a repository with no remote clones the local path, notes remote: none and warns', async () => {
  const dir = repo();
  const parent = parentDir();
  try {
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }]));
    assert.equal(r.repos[0].remote, 'none');
    assert.ok(r.warnings.some((w) => /api/.test(w) && /no remote/i.test(w)), r.warnings.join('\n'));
    assert.equal(loadState(r.dir).repos[0].remote, 'none');
    const code = join(r.dir, 'repos', 'api');
    assert.equal(git(code, 'remote').trim(), '', 'the clone does not keep the folder of the original as origin');
    assert.equal(readFileSync(join(code, 'src', 'index.js'), 'utf8'), 'export const x = 1;\n');
  } finally { cleanup(dir); cleanup(parent); }
});

test('the original folder is never written: its whole tree hash is the same after adopt', async () => {
  const dir = repo(EXISTING);
  const bare = withRemote(dir);
  const parent = parentDir();
  try {
    const before = fullTree(dir);
    await initAdopt(options(parent, [{ source: dir, name: 'api' }]));
    assert.deepEqual(fullTree(dir), before);
    assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all').trim(), '');
    assert.equal(existsSync(join(dir, 'recade')), false);
    assert.equal(existsSync(join(dir, '.recade')), false);
  } finally { cleanup(dir); cleanup(bare); cleanup(parent); }
});

test('two repositories give two registry entries, two clones and two links', async () => {
  const api = repo({ 'package.json': '{"name":"fernhill-api"}\n' });
  const web = repo({ 'package.json': '{"name":"fernhill-web"}\n' });
  const parent = parentDir();
  try {
    const r = await initAdopt(options(parent, [{ source: api, name: 'api' }, { source: web, name: 'web' }]));
    assert.deepEqual(r.repos.map((x) => x.name), ['api', 'web']);
    assert.deepEqual(loadState(r.dir).repos.map((x) => x.name), ['api', 'web']);
    for (const n of ['api', 'web']) assert.deepEqual(checkLink(join(r.dir, 'repos', n)), { ok: true }, n);
  } finally { cleanup(api); cleanup(web); cleanup(parent); }
});

test('a code repository gets only the harness: created.json lists harness paths and no document, and docs/recade/ exists nowhere', async () => {
  const dir = repo(EXISTING);
  const parent = parentDir();
  try {
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }]));
    const code = join(r.dir, 'repos', 'api');
    const created = readCreated(code);
    assert.ok(created.length > 20, 'the harness was installed');
    for (const f of created) assert.match(f, /^(\.claude\/|\.githooks\/|\.github\/workflows\/recade[^/]*\.ya?ml$|\.github\/dependabot\.yml$|\.gitignore$|\.recade\/)/, f);
    assert.ok(created.includes('.github/workflows/recade.yml'));
    for (const f of ['recade', 'docs/recade', 'slices', 'docs/inventory.md']) assert.equal(existsSync(join(code, f)), false, `${f} is not written in a code repository`);
    // what the owner had stays byte for byte
    assert.equal(readFileSync(join(code, 'CLAUDE.md'), 'utf8'), EXISTING['CLAUDE.md']);
    assert.equal(readFileSync(join(code, '.github/workflows/ci.yml'), 'utf8'), EXISTING['.github/workflows/ci.yml']);
    assert.ok(r.repos[0].kept.includes('CLAUDE.md') && r.repos[0].kept.includes('.claude'));
    assert.equal(existsSync(join(r.dir, 'docs', 'recade')), false);
    assert.equal(existsSync(join(r.dir, '.claude')), false, 'the workspace harness is the harness phase, not adopt init');
  } finally { cleanup(dir); cleanup(parent); }
});

test('a refusal on any repository creates nothing: no workspace folder, nothing cloned', async () => {
  const ok = repo();
  const dirty = repo();
  const parent = parentDir();
  try {
    writeFileSync(join(dirty, 'wip.js'), 'x\n');
    await assert.rejects(initAdopt(options(parent, [{ source: ok, name: 'api' }, { source: dirty, name: 'web' }])), (err) => {
      assert.ok(err instanceof AdoptError);
      assert.deepEqual(err.dirty, ['wip.js']);
      assert.match(err.message, /web/);
      assert.match(err.message, /wip\.js/);
      return true;
    });
    assert.deepEqual(readdirSync(parent), []);
    assert.equal(git(dirty, 'stash', 'list'), '');
    assert.equal(readFileSync(join(dirty, 'wip.js'), 'utf8'), 'x\n');
    git(dirty, 'checkout', '-q', '-b', 'wip');
    await assert.rejects(initAdopt(options(parent, [{ source: dirty, name: 'web' }])), (err) => err instanceof AdoptError && /wip/.test(err.message));
    assert.deepEqual(readdirSync(parent), []);
  } finally { cleanup(ok); cleanup(dirty); cleanup(parent); }
});

test('unpushed commits refuse adopt, with the count, and nothing is created', async () => {
  const dir = repo();
  const bare = withRemote(dir);
  const parent = parentDir();
  try {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'local only');
    await assert.rejects(initAdopt(options(parent, [{ source: dir, name: 'api' }])), (err) => err instanceof AdoptError && /1 commit is not pushed/.test(err.message));
    assert.deepEqual(readdirSync(parent), []);
  } finally { cleanup(dir); cleanup(bare); cleanup(parent); }
});

test('the default branch the owner names is used, and a missing answer is asked for', async () => {
  const dir = repo({}, 'trunk');
  const parent = parentDir();
  try {
    await assert.rejects(initAdopt(options(parent, [{ source: dir, name: 'api' }])), (err) => err instanceof AdoptError && err.needsDefaultBranch === true && /--default-branch/.test(err.message));
    assert.deepEqual(readdirSync(parent), []);
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }], { defaultBranch: 'trunk' }));
    assert.equal(loadState(r.dir).repos[0].default_branch, 'trunk');
  } finally { cleanup(dir); cleanup(parent); }
});

test('a URL is cloned as it is, with no preflight, and is the remote of the registry', async () => {
  const dir = repo();
  const bare = withRemote(dir);
  const parent = parentDir();
  try {
    const url = `file://${bare}`;
    const r = await initAdopt(options(parent, [{ source: url, name: 'api' }]));
    assert.equal(r.repos[0].remote, url);
    assert.equal(git(join(r.dir, 'repos', 'api'), 'remote', 'get-url', 'origin').trim(), url);
  } finally { cleanup(dir); cleanup(bare); cleanup(parent); }
});

test('a clone that fails removes the workspace this call created', async () => {
  const parent = parentDir();
  try {
    await assert.rejects(initAdopt(options(parent, [{ source: 'file:///nonexistent/recade-missing.git', name: 'api' }])), /clone/);
    assert.deepEqual(readdirSync(parent), []);
  } finally { cleanup(parent); }
});

test('a workspace folder that already exists and is not empty is refused, and left as it is', async () => {
  const dir = repo();
  const parent = parentDir();
  try {
    mkdirSync(join(parent, 'fernhill-desk-workspace'));
    writeFileSync(join(parent, 'fernhill-desk-workspace', 'mine.txt'), 'x\n');
    await assert.rejects(initAdopt(options(parent, [{ source: dir, name: 'api' }])), (err) => err instanceof AdoptError && /already exists/.test(err.message));
    assert.deepEqual(readdirSync(join(parent, 'fernhill-desk-workspace')), ['mine.txt']);
  } finally { cleanup(dir); cleanup(parent); }
});

test('repository names are checked before anything is created: kebab-case, unique, derived from the source when not given', async () => {
  const a = repo();
  const b = repo();
  const parent = parentDir();
  try {
    for (const repos of [[{ source: a, name: 'Bad_Name' }], [{ source: a, name: 'api' }, { source: b, name: 'api' }], []]) {
      await assert.rejects(initAdopt(options(parent, repos)), AdoptError);
      assert.deepEqual(readdirSync(parent), []);
    }
    const r = await initAdopt(options(parent, [{ source: a }, { source: b, name: 'web' }], { name: undefined }));
    assert.match(r.repos[0].name, /^recade-adopt-[a-z0-9]+$/, 'the name comes from the folder of the source');
    assert.match(r.dir, /-workspace$/);
  } finally { cleanup(a); cleanup(b); cleanup(parent); }
});

test('initAdopt needs a config and the plugin folder', async () => {
  const dir = repo();
  const parent = parentDir();
  try {
    await assert.rejects(initAdopt(options(parent, [{ source: dir }], { config: undefined })), /config/);
    await assert.rejects(initAdopt(options(parent, [{ source: dir }], { pluginRoot: undefined })), /plugin/i);
    assert.deepEqual(readdirSync(parent), []);
  } finally { cleanup(dir); cleanup(parent); }
});

test('recade adopt init --parent --repo creates the workspace, prints it, and --json says the same', async () => {
  const dir = repo(EXISTING);
  const bare = withRemote(dir);
  const parent = parentDir();
  const cfg = mkdtempSync(join(tmpdir(), 'recade-adopt-cfg-'));
  try {
    const env = { RECADE_CONFIG_DIR: cfg };
    let t = makeIO(parent, { env });
    assert.equal(await run(['adopt', 'init', '--parent', parent, '--repo', dir, '--repo-name', 'api', '--name', 'Fernhill Desk', '--full'], t.io), 0, t.stderr());
    assert.match(t.stdout(), /Created the workspace .*fernhill-desk-workspace/);
    assert.match(t.stdout(), /^repos\/api cloned from /m);
    assert.match(t.stdout(), /^Kept as they are in api: .*CLAUDE\.md/m);
    assert.doesNotMatch(t.stdout(), /has no value for/, 'the warnings about the stack that is not written yet are left for the harness phase');
    assert.match(t.stdout(), /Next action: Run \/recade:adopt/);
    const ws = join(parent, 'fernhill-desk-workspace');
    assert.equal(loadState(ws).full, true);
    assert.equal(loadState(ws).repos[0].remote, bare);
    cleanup(ws);
    t = makeIO(parent, { env });
    assert.equal(await run(['adopt', 'init', '--parent', parent, '--repo', dir, '--name', 'Fernhill Desk', '--json'], t.io), 0, t.stderr());
    const json = JSON.parse(t.stdout());
    assert.equal(json.dir, ws);
    assert.equal(json.repos[0].remote, bare);
  } finally { cleanup(dir); cleanup(bare); cleanup(parent); cleanup(cfg); }
});

test('recade adopt init takes --repo more than once and --default-branch', async () => {
  const a = repo({}, 'trunk');
  const b = repo();
  const parent = parentDir();
  const cfg = mkdtempSync(join(tmpdir(), 'recade-adopt-cfg-'));
  try {
    const env = { RECADE_CONFIG_DIR: cfg };
    let t = makeIO(parent, { env });
    assert.equal(await run(['adopt', 'init', '--parent', parent, '--repo', a, '--repo', b, '--name', 'desk'], t.io), 1);
    assert.match(t.stderr(), /--default-branch/);
    assert.deepEqual(readdirSync(parent), []);
    git(b, 'branch', '-m', 'trunk');
    t = makeIO(parent, { env });
    assert.equal(await run(['adopt', 'init', '--parent', parent, '--repo', a, '--repo', b, '--name', 'desk', '--default-branch', 'trunk'], t.io), 0, t.stderr());
    assert.equal(loadState(join(parent, 'desk-workspace')).repos.length, 2);
  } finally { cleanup(a); cleanup(b); cleanup(parent); cleanup(cfg); }
});

test('recade adopt init on a dirty repository exits 1, names the files, and creates nothing', async () => {
  const dir = repo();
  const parent = parentDir();
  const cfg = mkdtempSync(join(tmpdir(), 'recade-adopt-cfg-'));
  try {
    writeFileSync(join(dir, 'wip.js'), 'x\n');
    const t = makeIO(parent, { env: { RECADE_CONFIG_DIR: cfg } });
    assert.equal(await run(['adopt', 'init', '--parent', parent, '--repo', dir], t.io), 1);
    assert.match(t.stderr(), /wip\.js/);
    assert.equal(t.stdout(), '');
    assert.deepEqual(readdirSync(parent), []);
    const j = makeIO(parent, { env: { RECADE_CONFIG_DIR: cfg } });
    assert.equal(await run(['adopt', 'init', '--parent', parent, '--repo', dir, '--json'], j.io), 1);
    assert.deepEqual(JSON.parse(j.stdout()).dirty, ['wip.js']);
  } finally { cleanup(dir); cleanup(parent); cleanup(cfg); }
});

test('recade adopt rejects bad usage with exit 2', async () => {
  for (const args of [[], ['nope'], ['init'], ['init', '--parent', '/tmp'], ['init', '--repo', '/tmp'], ['init', '--bogus'], ['init', 'x', '--parent', '/tmp', '--repo', '/tmp'], ['preflight', '--full']]) {
    const t = makeIO(process.cwd());
    assert.equal(await run(['adopt', ...args], t.io), 2, args.join(' '));
    assert.match(t.stderr(), /Usage: recade adopt init --parent <dir> --repo <path\|url> \[--repo/);
  }
});

test('recade state show works in the adopted workspace and names G0-inventory', async () => {
  const dir = repo();
  const parent = parentDir();
  const cfg = mkdtempSync(join(tmpdir(), 'recade-adopt-cfg-'));
  try {
    const env = { RECADE_CONFIG_DIR: cfg };
    assert.equal(await run(['adopt', 'init', '--parent', parent, '--repo', dir, '--name', 'desk'], makeIO(parent, { env }).io), 0);
    const ws = join(parent, 'desk-workspace');
    let t = makeIO(ws, { env });
    assert.equal(await run(['state', 'show'], t.io), 0);
    assert.match(t.stdout(), /^Mode: adopt$/m);
    assert.match(t.stdout(), /^G0-inventory +open$/m);
    assert.match(t.stdout(), /^Command: \/recade:adopt$/m);
    t = makeIO(ws, { env, now: () => new Date(2026, 10, 14, 12) });
    assert.equal(await run(['state', 'pass', 'G0-inventory'], t.io), 0, t.stderr());
    assert.match(t.stdout(), /G0-inventory passed on 2026-11-14\. Run \/recade:team/);
  } finally { cleanup(dir); cleanup(parent); cleanup(cfg); }
});

test('recade adopt preflight takes the folder it runs in, reports the remote, and writes nothing', async () => {
  const dir = repo();
  const bare = withRemote(dir);
  try {
    const t = makeIO(dir);
    assert.equal(await run(['adopt', 'preflight', '--json'], t.io), 0);
    assert.deepEqual(JSON.parse(t.stdout()), { ok: true, dirty: [], branch: 'main', defaultBranch: 'main', reasons: [], remote: bare, unpushed: 0 });
  } finally { cleanup(dir); cleanup(bare); }
});

test('a parent folder and a repository folder with spaces and accents work end to end', async () => {
  const base = mkdtempSync(join(tmpdir(), 'recade-adopt-sp-'));
  const parent = join(base, 'Projets Clients');
  mkdirSync(parent);
  const src = join(base, 'Dépôt Été');
  mkdirSync(src);
  const dir = repo();
  try {
    cleanup(src);
    const r = spawnSync('git', ['clone', '-q', dir, src], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = await initAdopt(options(parent, [{ source: src, name: 'api' }], { name: 'Été Désk' }));
    assert.equal(out.dir, join(parent, 'ete-desk-workspace'));
    assert.deepEqual(checkLink(join(out.dir, 'repos', 'api')), { ok: true });
    assert.ok(readCreated(join(out.dir, 'repos', 'api')).includes('.github/workflows/recade.yml'));
  } finally { cleanup(base); cleanup(dir); }
});

test('recade adopt init needs as many --repo-name as --repo when any is given', async () => {
  const t = makeIO(process.cwd());
  assert.equal(await run(['adopt', 'init', '--parent', '/tmp', '--repo', '/a', '--repo', '/b', '--repo-name', 'one'], t.io), 2);
  assert.match(t.stderr(), /Usage: recade adopt init/);
});

// ---- review fixes: the original index, relative remotes, leftovers, what is not carried ----

test('preflight and initAdopt never write the index of the original, even when a tracked file has a stale stat', async () => {
  const dir = repo();
  const bare = withRemote(dir);
  const parent = parentDir();
  try {
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(join(dir, 'package.json'), old, old);
    const before = fullTree(dir);
    assert.equal((await preflight(dir, { exec: defaultExec })).ok, true);
    assert.deepEqual(fullTree(dir), before, 'preflight leaves .git/index as it was');
    utimesSync(join(dir, 'src', 'index.js'), old, old);
    const again = fullTree(dir);
    await initAdopt(options(parent, [{ source: dir, name: 'api' }]));
    assert.deepEqual(fullTree(dir), again, 'adopt leaves the whole folder as it was');
  } finally { cleanup(dir); cleanup(bare); cleanup(parent); }
});

test('every git call on the original runs with --no-optional-locks', async () => {
  const dir = repo();
  const parent = parentDir();
  const calls = [];
  const exec = (cmd, args, timeout) => {
    if (cmd === 'git' && args.includes('-C') && args.includes(dir)) calls.push(args);
    return defaultExec(cmd, args, timeout);
  };
  try {
    await initAdopt(options(parent, [{ source: dir, name: 'api' }], { exec }));
    assert.ok(calls.length > 5);
    assert.deepEqual(calls.filter((a) => a[0] !== '--no-optional-locks'), []);
  } finally { cleanup(dir); cleanup(parent); }
});

test('a relative remote of the original is resolved against the original folder, and the registry records the absolute path', async () => {
  const dir = repo();
  const bare = join(dirname(dir), `${basename(dir)}.git`);
  const parent = parentDir();
  try {
    assert.equal(spawnSync('git', ['clone', '-q', '--bare', dir, bare], { encoding: 'utf8' }).status, 0);
    git(dir, 'remote', 'add', 'origin', `../${basename(bare)}`);
    git(dir, 'fetch', '-q', 'origin');
    git(dir, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
    const check = await preflight(dir, { exec: defaultExec });
    assert.equal(check.ok, true);
    assert.equal(check.remote, bare);
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }], { cwd: parent }));
    assert.equal(r.repos[0].remote, bare);
    assert.equal(loadState(r.dir).repos[0].remote, bare);
    assert.equal(git(join(r.dir, 'repos', 'api'), 'remote', 'get-url', 'origin').trim(), bare);
  } finally { cleanup(dir); cleanup(bare); cleanup(parent); }
});

test('a failure removes the parent folders this call created, and only those', async () => {
  const base = parentDir();
  try {
    mkdirSync(join(base, 'kept'));
    const deep = join(base, 'kept', 'a', 'b');
    await assert.rejects(initAdopt(options(deep, [{ source: 'file:///nonexistent/recade-missing.git', name: 'api' }])), /clone/);
    assert.deepEqual(readdirSync(join(base, 'kept')), [], 'a and b are gone, kept stays');
  } finally { cleanup(base); }
});

test('.recade/plugin-root is per machine: it exists in the code repository and is not in created.json', async () => {
  const dir = repo();
  const parent = parentDir();
  try {
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }]));
    const code = join(r.dir, 'repos', 'api');
    assert.ok(existsSync(join(code, '.recade', 'plugin-root')));
    assert.equal(readCreated(code).includes('.recade/plugin-root'), false);
  } finally { cleanup(dir); cleanup(parent); }
});

test('the unpushed check compares with the remote that is cloned (origin), not with another upstream', async () => {
  const dir = repo();
  const origin = withRemote(dir);
  const other = mkdtempSync(join(tmpdir(), 'recade-adopt-other-'));
  rmSync(other, { recursive: true });
  try {
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'only on the other remote');
    assert.equal(spawnSync('git', ['clone', '-q', '--bare', dir, other], { encoding: 'utf8' }).status, 0);
    git(dir, 'remote', 'add', 'other', other);
    git(dir, 'fetch', '-q', 'other');
    git(dir, 'branch', '-q', '--set-upstream-to=other/main', 'main');
    const r = await preflight(dir, { exec: defaultExec });
    assert.equal(r.ok, false);
    assert.equal(r.unpushed, 1);
    assert.match(r.reasons.join('\n'), /not pushed to origin\/main/);
  } finally { cleanup(dir); cleanup(origin); cleanup(other); }
});

test('what the clone does not carry is reported: local-only branches, stashes and ignored files', async () => {
  const dir = repo({ '.gitignore': '*.log\n' });
  const bare = withRemote(dir);
  const parent = parentDir();
  try {
    git(dir, 'branch', 'wip');
    writeFileSync(join(dir, 'a.log'), 'x\n');
    writeFileSync(join(dir, 'src', 'index.js'), 'changed\n');
    git(dir, 'stash', 'push', '-q');
    assert.equal((await preflight(dir, { exec: defaultExec })).ok, true, 'they are reported, not refused');
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }]));
    assert.deepEqual(r.repos[0].notCarried, { branches: ['wip'], stashes: 1, ignored: 1 });
    assert.ok(r.warnings.some((w) => /api/.test(w) && /wip/.test(w) && /1 stash/.test(w) && /1 ignored file/.test(w)), r.warnings.join('\n'));
    assert.equal(git(join(r.dir, 'repos', 'api'), 'branch', '--list', 'wip').trim(), '');
    const clean = repo();
    try {
      const c = await initAdopt(options(parent, [{ source: clean, name: 'web' }], { name: 'other-desk' }));
      assert.deepEqual(c.repos[0].notCarried, { branches: [], stashes: 0, ignored: 0 });
      assert.equal(c.warnings.some((w) => /not carried/i.test(w)), false);
    } finally { cleanup(clean); }
  } finally { cleanup(dir); cleanup(bare); cleanup(parent); }
});

/* ---------- task 10 review: the parent folder ---------- */

test('adopt init --parent expands ~ like recade new, and never makes a folder named ~ in the original', async () => {
  const dir = repo();
  const home = mkdtempSync(join(tmpdir(), 'recade-adopt-home-'));
  const cfg = mkdtempSync(join(tmpdir(), 'recade-adopt-cfg-'));
  try {
    const t = makeIO(dir, { env: { RECADE_CONFIG_DIR: cfg, HOME: home } });
    assert.equal(await run(['adopt', 'init', '--parent', '~/projects', '--repo', dir, '--repo-name', 'api', '--name', 'tilde'], t.io), 0, t.stderr());
    assert.ok(existsSync(join(home, 'projects', 'tilde-workspace', 'recade', 'state.yaml')));
    assert.equal(existsSync(join(dir, '~')), false, 'the original repository is untouched');
    assert.equal(git(dir, 'status', '--porcelain'), '');
  } finally { cleanup(dir); cleanup(home); cleanup(cfg); }
});

test('initAdopt refuses a parent folder inside a repository it adopts, and a parent that is a file, and creates nothing', async () => {
  const dir = repo();
  const parent = parentDir();
  try {
    for (const inside of [join(dir, 'sub'), dir, join(dir, 'a', 'b')]) {
      await assert.rejects(initAdopt(options(inside, [{ source: dir, name: 'api' }])), /inside the repository/);
    }
    assert.equal(existsSync(join(dir, 'sub')), false);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    // A relative parent that lands in the original is the same thing.
    await assert.rejects(initAdopt({ ...options('sub', [{ source: dir, name: 'api' }]), cwd: dir }), /inside the repository/);
    const file = join(parent, 'a-file');
    writeFileSync(file, 'x');
    await assert.rejects(initAdopt(options(file, [{ source: dir, name: 'api' }])), /is a file, not a folder/);
    await assert.rejects(initAdopt(options(join(file, 'deeper'), [{ source: dir, name: 'api' }])), /is a file, not a folder/);
  } finally { cleanup(dir); cleanup(parent); }
});

test('--repo . takes the name of the current folder, and an empty repository name says to give one with --repo-name', async () => {
  const base = parentDir();
  const dir = join(base, 'ledger-api');
  const made = repo();
  const cloned = spawnSync('git', ['clone', '-q', made, dir], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stderr);
  const parent = parentDir();
  try {
    const r = await initAdopt({ ...options(parent, [{ source: '.' }]), name: undefined, cwd: dir });
    assert.equal(r.repos[0].name, 'ledger-api');
    await assert.rejects(initAdopt(options(parentDir(), [{ source: 'https://example.invalid/%%%/' }])), /--repo-name/);
  } finally { cleanup(base); cleanup(made); cleanup(parent); }
});

/** An at sign, so that no URL of these tests reads as an e-mail address. */
const AT = '@';

test('final A, I2: an origin URL with a token is cloned, but never recorded, printed or committed with it', async () => {
  const dir = repo();
  const bare = withRemote(dir);
  const secret = `https://x-access-token:ghp_SECRET123${AT}example.invalid/fern/api.git`;
  git(dir, 'remote', 'set-url', 'origin', secret);
  const parent = parentDir();
  const saved = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: secret });
  try {
    const check = await preflight(dir, { exec: defaultExec });
    assert.equal(check.remote, 'https://example.invalid/fern/api.git');
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }]));
    // What the CLI prints comes from this result.
    assert.equal(r.repos[0].remote, 'https://example.invalid/fern/api.git');
    assert.doesNotMatch(JSON.stringify(r), /SECRET/);
    assert.doesNotMatch(readFileSync(join(r.dir, 'recade', 'state.yaml'), 'utf8'), /SECRET|x-access-token/);
    assert.doesNotMatch(git(r.dir, 'log', '-p', '--all'), /SECRET/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    cleanup(dir); cleanup(bare); cleanup(parent);
  }
});

test('final A (from B, item 8): in adopt mode the documents and harness phases point back to /recade:adopt', () => {
  const at = (passed) => {
    let s = normalizeState({ version: 1, kind: 'workspace', mode: 'adopt' });
    for (const g of passed) s = passGate(s, g, '2026-11-18');
    return s;
  };
  const docs = at(['G0-inventory', 'G1']);
  assert.equal(phaseCommand(docs), 'adopt');
  assert.match(nextAction(docs), /^Run \/recade:adopt /);
  const harness = at(['G0-inventory', 'G1', 'G2-stack', 'G2', 'G3', 'G4']);
  assert.equal(phaseCommand(harness), 'adopt');
  assert.match(nextAction(harness), /^Run \/recade:adopt /);
  // The team, bible and slices phases keep their own commands, and a new project is unchanged.
  assert.match(nextAction(at(['G0-inventory'])), /^Run \/recade:team /);
  assert.match(nextAction(at(['G0-inventory', 'G1', 'G2-stack', 'G2'])), /^Run \/recade:bible /);
  const fresh = passGate(passGate(normalizeState({ version: 1 }), 'G0', '2026-11-18'), 'G1', '2026-11-18');
  assert.match(nextAction(fresh), /^Run \/recade:docs /);
});

test('final A (from B, item 8): an adopted workspace tracks decisions/ from its first commit', async () => {
  const dir = repo();
  const parent = parentDir();
  try {
    const r = await initAdopt(options(parent, [{ source: dir, name: 'api' }]));
    assert.ok(existsSync(join(r.dir, 'decisions')));
    assert.match(git(r.dir, 'ls-files', 'decisions'), /decisions\/\.gitkeep/);
  } finally { cleanup(dir); cleanup(parent); }
});
