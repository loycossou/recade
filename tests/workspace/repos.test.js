import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createWorkspace, linkRepo, checkLink, findWorkspace } from '../../src/workspace/layout.js';
import { addRepo, listRepos, checkRepos, syncRepos, prefixTouches, stripCredentials } from '../../src/workspace/repos.js';
import { defaultExec } from '../../src/doctor.js';
import { git, cli } from '../harness/fixture-project.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'recade-repos-')));
const must = (r) => {
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const ok = { code: 0, stdout: '', stderr: '' };
const state = (ws) => parse(readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8'));

async function workspace(parent = tmp()) {
  const { dir } = await createWorkspace(parent, 'fernhill', { exec: defaultExec });
  return dir;
}

/** A real repository with one commit, usable as a clone source. */
function source(name = 'src') {
  const dir = join(tmp(), name);
  mkdirSync(dir, { recursive: true });
  must(git(dir, 'init', '-q', '-b', 'main'));
  must(git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore: start'));
  return dir;
}

/** A clone source whose `origin` is a bare repository: what `repo add` records. Returns `{dir, bare}`. */
function sourceWithOrigin(name = 'src') {
  const dir = source(name);
  const bare = join(tmp(), `${name}.git`);
  must(git(tmp(), 'clone', '-q', '--bare', dir, bare));
  must(git(dir, 'remote', 'add', 'origin', bare));
  return { dir, bare };
}

function sheet(ws, file, touches, status, quote = '"') {
  mkdirSync(join(ws, 'slices'), { recursive: true });
  const list = Array.isArray(touches) ? touches.map((t) => `  - ${quote}${t}${quote}`).join('\n') : touches;
  writeFileSync(join(ws, 'slices', file), `---\nid: ${file.slice(0, 4)}\nlane: standard\ntouches:\n${list}\n---\n\n## Goal\n\nx\n`);
  const id = file.slice(0, 4);
  const path = join(ws, 'slices', 'STATUS.md');
  const rows = existsSync(path) ? readFileSync(path, 'utf8').trimEnd().split('\n') : ['| Slice | State |', '|---|---|'];
  rows.push(`| ${id} | ${status} |`);
  writeFileSync(path, `${rows.join('\n')}\n`);
}

test('addRepo --new runs git init -b main, links the repository first, records the entry', async () => {
  const ws = await workspace();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return defaultExec(cmd, args);
  };
  const entry = await addRepo(ws, 'api', { new: true, role: 'api' }, { exec });
  assert.deepEqual(calls, [
    ['git', '-C', join(ws, 'repos', 'api'), 'init', '-b', 'main'],
    ['git', '-C', join(ws, 'repos', 'api'), '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'chore: initial commit'],
  ]);
  assert.deepEqual({ ...entry, prefixed: undefined, prefixedHotspots: undefined }, {
    name: 'api', path: 'repos/api', remote: 'none', default_branch: 'main', role: 'api', visibility: 'private', prefixed: undefined, prefixedHotspots: undefined,
  });
  assert.deepEqual(state(ws).repos, [{ name: 'api', path: 'repos/api', remote: 'none', default_branch: 'main', role: 'api', visibility: 'private' }]);
  assert.deepEqual(listRepos(ws), state(ws).repos);
  // The link names the workspace, and not the workspace of the folder above (a folder that was no repository yet).
  assert.deepEqual(checkLink(join(ws, 'repos', 'api')), { ok: true });
  assert.equal(readFileSync(join(ws, 'repos', 'api', '.recade', 'workspace'), 'utf8').trim(), ws);
  assert.equal(existsSync(join(ws, '.recade', 'workspace')), false);
  assert.equal(findWorkspace(join(ws, 'repos', 'api')).via, 'link');
});

test('addRepo refuses a bad name, a used name, a non-empty folder and a missing source, and leaves nothing behind', async () => {
  const ws = await workspace();
  await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
  for (const bad of ['Api', 'my_repo', '-x', 'x-', 'a--b', '../x', '', 'a/b']) {
    await assert.rejects(addRepo(ws, bad, { new: true }, { exec: defaultExec }), /repository name/, bad);
  }
  await assert.rejects(addRepo(ws, 'api', { new: true }, { exec: defaultExec }), /already in the registry/);
  mkdirSync(join(ws, 'repos', 'web'));
  writeFileSync(join(ws, 'repos', 'web', 'a.txt'), 'x');
  await assert.rejects(addRepo(ws, 'web', { new: true }, { exec: defaultExec }), /not empty/);
  await assert.rejects(addRepo(ws, 'mobile', { clone: join(tmp(), 'nothing-here') }, { exec: defaultExec }), /git clone failed/);
  assert.equal(existsSync(join(ws, 'repos', 'mobile')), false);
  await assert.rejects(addRepo(ws, 'mobile', {}, { exec: defaultExec }), /exactly one/);
  assert.deepEqual(listRepos(ws).map((r) => r.name), ['api']);
});

test('addRepo --clone passes the url as one argv element after --, in a path with a space and an accent', async () => {
  const ws = await workspace(join(tmp(), 'Projets Clients Été'));
  const url = 'https://example.test/some org/ex ample.git';
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'clone') mkdirSync(join(args[3], '.git'), { recursive: true });
    return args.includes('symbolic-ref') ? { ...ok, stdout: 'trunk\n' } : ok;
  };
  const entry = await addRepo(ws, 'api', { clone: url, visibility: 'public' }, { exec });
  assert.deepEqual(calls[0], ['git', 'clone', '--', url, join(ws, 'repos', 'api')]);
  assert.equal(entry.remote, url);
  assert.equal(entry.default_branch, 'trunk');
  assert.equal(entry.visibility, 'public');
  assert.equal(state(ws).repos[0].remote, url);
});

test('addRepo --clone of a local path clones for real and records it; spec.remote overrides the recorded remote', async () => {
  const ws = await workspace();
  const src = source();
  const entry = await addRepo(ws, 'api', { clone: src, remote: 'none' }, { exec: defaultExec });
  assert.equal(entry.remote, 'none');
  assert.equal(entry.default_branch, 'main');
  assert.deepEqual(checkLink(join(ws, 'repos', 'api')), { ok: true });
});

test('the second repo add prefixes the unprefixed globs of the sheets that are not done, and returns each change', async () => {
  const ws = await workspace();
  sheet(ws, 'S-01-todo.md', ['src/orders/**', 'docs/**'], 'todo');
  sheet(ws, 'S-02-spec.md', ['src/b/**'], 'spec', "'");
  sheet(ws, 'S-03-done.md', ['src/old/**'], 'done');
  sheet(ws, 'S-04-mixed.md', ['web:src/x/**', 'src/y/**'], 'todo');
  sheet(ws, 'S-05-inline.md', '', 'todo');
  writeFileSync(join(ws, 'slices', 'S-05-inline.md'), '---\nid: S-05\ntouches: [src/a/**, "src/{b,c}/**", api:keep/**] # note\n---\n\nbody\n');
  const done = readFileSync(join(ws, 'slices', 'S-03-done.md'), 'utf8');
  const first = await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
  assert.deepEqual(first.prefixed, []);
  assert.equal(readFileSync(join(ws, 'slices', 'S-01-todo.md'), 'utf8').includes('src/orders'), true);
  assert.equal(readFileSync(join(ws, 'slices', 'S-01-todo.md'), 'utf8').includes('api:'), false);
  const second = await addRepo(ws, 'web', { new: true }, { exec: defaultExec });
  assert.deepEqual(second.prefixed.map((c) => c.sheet), ['slices/S-01-todo.md', 'slices/S-02-spec.md', 'slices/S-04-mixed.md', 'slices/S-05-inline.md']);
  assert.deepEqual(second.prefixed[0], { sheet: 'slices/S-01-todo.md', before: ['src/orders/**', 'docs/**'], after: ['api:src/orders/**', 'api:docs/**'] });
  assert.deepEqual(second.prefixed[2].after, ['web:src/x/**', 'api:src/y/**']);
  assert.deepEqual(second.prefixed[3].after, ['api:src/a/**', 'api:src/{b,c}/**', 'api:keep/**']);
  assert.match(readFileSync(join(ws, 'slices', 'S-02-spec.md'), 'utf8'), /touches:\n {2}- 'api:src\/b\/\*\*'\n---/);
  assert.match(readFileSync(join(ws, 'slices', 'S-05-inline.md'), 'utf8'), /^touches: \[api:src\/a\/\*\*, "api:src\/\{b,c\}\/\*\*", api:keep\/\*\*\] # note$/m);
  assert.equal(readFileSync(join(ws, 'slices', 'S-03-done.md'), 'utf8'), done);
  // A third repository prefixes nothing.
  const third = await addRepo(ws, 'mobile', { new: true }, { exec: defaultExec });
  assert.deepEqual(third.prefixed, []);
  assert.deepEqual(prefixTouches(ws, 'api'), []);
});

test('recade repo add / list: exit 1 on a bad name or a duplicate, 2 on usage, and the touches changes are printed', async () => {
  const ws = await workspace();
  sheet(ws, 'S-01-todo.md', ['src/orders/**'], 'todo');
  const a = await cli(ws, ['repo', 'add', 'api', '--new', '--role', 'api']);
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /Added api/);
  const b = await cli(ws, ['repo', 'add', 'web', '--new']);
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, /slices\/S-01-todo\.md: src\/orders\/\*\* -> api:src\/orders\/\*\*/);
  assert.equal((await cli(ws, ['repo', 'add', 'Web', '--new'])).code, 1);
  assert.equal((await cli(ws, ['repo', 'add', 'api', '--new'])).code, 1);
  assert.equal((await cli(ws, ['repo', 'add', 'x'])).code, 2);
  assert.equal((await cli(ws, ['repo', 'add', 'x', '--new', '--clone', 'u'])).code, 2);
  assert.equal((await cli(ws, ['repo', 'add', 'x', '--new', '--visibility', 'secret'])).code, 2);
  assert.equal((await cli(ws, ['repo'])).code, 2);
  assert.equal((await cli(ws, ['repo', 'frob'])).code, 2);
  const list = await cli(join(ws, 'repos', 'api'), ['repo', 'list']);
  assert.equal(list.code, 0);
  assert.match(list.stdout, /api\s+repos\/api\s+none\s+main\s+private\s+api/);
  const json = await cli(ws, ['repo', 'list', '--json']);
  assert.deepEqual(JSON.parse(json.stdout).map((r) => r.name), ['api', 'web']);
  assert.equal((await cli(tmp(), ['repo', 'list'])).code, 1);
});

test('checkRepos reports each of the five problems', async () => {
  const ws = await workspace();
  for (const n of ['gone', 'plain', 'unlinked', 'elsewhere', 'bare']) await addRepo(ws, n, { new: true }, { exec: defaultExec });
  // A repository with its harness launcher: the only one with no problem.
  await addRepo(ws, 'fine', { new: true }, { exec: defaultExec });
  mkdirSync(join(ws, 'repos', 'fine', '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(ws, 'repos', 'fine', '.claude', 'hooks', 'recade-guard.mjs'), '// launcher\n');
  rmSync(join(ws, 'repos', 'gone'), { recursive: true, force: true });
  rmSync(join(ws, 'repos', 'plain', '.git'), { recursive: true, force: true });
  rmSync(join(ws, 'repos', 'unlinked', '.recade'), { recursive: true, force: true });
  const other = await workspace();
  linkRepo(other, join(ws, 'repos', 'elsewhere'));
  // `bare` keeps a good link and has no harness.
  const found = checkRepos(ws).findings;
  const of = (repo) => found.filter((f) => f.repo === repo).map((f) => f.problem);
  assert.deepEqual(of('gone'), ['missing']);
  assert.deepEqual(of('plain'), ['not a git repository']);
  assert.deepEqual(of('unlinked'), ['link missing', 'no harness']);
  assert.deepEqual(of('elsewhere'), ['link points elsewhere', 'no harness']);
  assert.deepEqual(of('bare'), ['no harness']);
  assert.deepEqual(of('fine'), []);
  const cmd = await cli(ws, ['repo', 'check']);
  assert.equal(cmd.code, 1);
  assert.match(cmd.stdout, /gone: missing/);
  assert.match(cmd.stdout, /unlinked: link missing/);
  assert.match(cmd.stdout, /recade repo sync/);
});

test('checkRepos: a repository deleted from disk is missing, an invalid registry name is not followed', async () => {
  const ws = await workspace();
  await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
  writeFileSync(join(ws, 'recade', 'state.yaml'), `${readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8')}  - {name: ../../etc, path: x}\n`);
  rmSync(join(ws, 'repos', 'api'), { recursive: true, force: true });
  assert.deepEqual(checkRepos(ws).findings.map((f) => `${f.repo}:${f.problem}`), ['api:missing', '../../etc:invalid entry']);
  const r = await syncRepos(ws, { exec: async () => { throw new Error('no clone for an invalid entry'); } });
  assert.deepEqual(r.skipped.map((x) => x.repo).sort(), ['../../etc', 'api']);
});

test('syncRepos on a fresh clone of the workspace clones two entries and writes their links and plugin-root', async () => {
  const ws = await workspace();
  const { dir: apiDir, bare: apiSrc } = sourceWithOrigin('api-src');
  const { dir: webDir, bare: webSrc } = sourceWithOrigin('web-src');
  await addRepo(ws, 'api', { clone: apiDir }, { exec: defaultExec });
  await addRepo(ws, 'web', { clone: webDir }, { exec: defaultExec });
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'chore: registry'));
  const parent = join(tmp(), 'Projets Clients');
  mkdirSync(parent);
  const fresh = join(parent, 'Été-workspace');
  must(git(parent, 'clone', '-q', ws, fresh));
  assert.equal(existsSync(join(fresh, 'repos')), false);
  const pluginRoot = tmp();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return defaultExec(cmd, args);
  };
  const r = await syncRepos(fresh, { exec, pluginRoot });
  assert.deepEqual(r.cloned, ['api', 'web']);
  assert.deepEqual(r.linked, ['api', 'web']);
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(calls.filter((c) => c[1] === 'clone'), [
    ['git', 'clone', '--', apiSrc, join(fresh, 'repos', 'api')],
    ['git', 'clone', '--', webSrc, join(fresh, 'repos', 'web')],
  ]);
  for (const n of ['api', 'web']) {
    assert.deepEqual(checkLink(join(fresh, 'repos', n)), { ok: true });
    assert.equal(readFileSync(join(fresh, 'repos', n, '.recade', 'plugin-root'), 'utf8'), `${pluginRoot}\n`);
  }
  // A second run clones nothing and keeps the links.
  const again = await syncRepos(fresh, { exec: defaultExec, pluginRoot });
  assert.deepEqual(again.cloned, []);
  assert.deepEqual(again.linked, ['api', 'web']);
});

test('syncRepos skips a missing repository with no remote, a failed clone, and a folder that is no repository', async () => {
  const ws = await workspace();
  await addRepo(ws, 'local', { new: true }, { exec: defaultExec });
  await addRepo(ws, 'remote', { clone: sourceWithOrigin().dir }, { exec: defaultExec });
  await addRepo(ws, 'plain', { new: true }, { exec: defaultExec });
  rmSync(join(ws, 'repos', 'local'), { recursive: true, force: true });
  rmSync(join(ws, 'repos', 'remote'), { recursive: true, force: true });
  rmSync(join(ws, 'repos', 'plain', '.git'), { recursive: true, force: true });
  const exec = async (cmd, args) => (args[0] === 'clone' ? { code: 128, stdout: '', stderr: 'fatal: unreachable\nmore' } : defaultExec(cmd, args));
  const r = await syncRepos(ws, { exec });
  assert.deepEqual(r.cloned, []);
  assert.deepEqual(r.linked, []);
  assert.deepEqual(r.skipped.map((s) => s.repo), ['local', 'remote', 'plain']);
  assert.match(r.skipped[0].reason, /no remote/);
  assert.match(r.skipped[1].reason, /git clone failed: fatal: unreachable$/);
  assert.match(r.skipped[2].reason, /not a git repository/);
  assert.equal(existsSync(join(ws, 'repos', 'remote')), false);
});

test('syncRepos runs git worktree repair after the workspace moved, so a slice worktree is found again', async () => {
  const parent = tmp();
  const ws = await workspace(parent);
  await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
  const repo = join(ws, 'repos', 'api');
  must(git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: start'));
  const wt = join(repo, '.claude', 'worktrees', 'S-01');
  must(git(repo, 'worktree', 'add', '-q', '-b', 'slice/s-01-x', wt));
  const moved = join(parent, 'Été Clients-workspace');
  renameSync(ws, moved);
  const movedWt = join(moved, 'repos', 'api', '.claude', 'worktrees', 'S-01');
  assert.deepEqual(checkLink(movedWt), { ok: false, reason: 'not a git repository' });
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return defaultExec(cmd, args);
  };
  const r = await syncRepos(moved, { exec });
  assert.deepEqual(r.linked, ['api']);
  assert.deepEqual(r.repaired, ['api']);
  assert.deepEqual(calls.find((c) => c.includes('repair')), ['git', '-C', join(moved, 'repos', 'api'), 'worktree', 'repair', movedWt]);
  assert.deepEqual(checkLink(movedWt), { ok: true });
  assert.equal(must(git(movedWt, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'slice/s-01-x');
});

test('recade help lists the workspace and repo commands', async () => {
  const h = await cli(tmp(), ['help']);
  assert.match(h.stdout, /^recade workspace +Find the project workspace/m);
  assert.match(h.stdout, /^recade repo +Register the code repositories/m);
});

test('F1: --new makes an empty initial commit on main, so a slice worktree works right away', async () => {
  const ws = await workspace();
  await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
  const repo = join(ws, 'repos', 'api');
  assert.equal(must(git(repo, 'log', '--format=%s')).stdout.trim(), 'chore: initial commit');
  assert.equal(must(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim(), 'main');
  const wt = join(repo, '.claude', 'worktrees', 'S-01');
  must(git(repo, 'worktree', 'add', '-q', '-b', 'slice/s-01-x', wt, 'main'));
  assert.equal(must(git(wt, 'merge-base', 'HEAD', 'main')).stdout.trim(), must(git(repo, 'rev-parse', 'main')).stdout.trim());
});

test('F1: with no git identity the initial commit uses a local placeholder identity, and is named when git still refuses', async () => {
  const ws = await workspace();
  const keep = { ...process.env };
  const home = tmp();
  Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' });
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[k];
  try {
    await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
    const repo = join(ws, 'repos', 'api');
    const who = (await defaultExec('git', ['-C', repo, 'log', '-1', '--format=%an|%ae'])).stdout.trim();
    assert.match(who, /^Recade\|[^@\s]+@[^@\s]+$/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
    Object.assign(process.env, keep);
  }
  const refusing = async (cmd, args) => (args.includes('commit') ? { code: 128, stdout: '', stderr: 'fatal: Author identity unknown\n' } : defaultExec(cmd, args));
  await assert.rejects(addRepo(ws, 'web', { new: true }, { exec: refusing }), /initial commit failed.*user\.name and user\.email/s);
  assert.equal(existsSync(join(ws, 'repos', 'web')), false);
  assert.deepEqual(listRepos(ws).map((r) => r.name), ['api']);
});

test('F2: addRepo keeps what another writer saved while git ran, and checks the name again', async () => {
  const ws = await workspace();
  const writer = (extra) => async (cmd, args) => {
    if (args[0] === 'clone') {
      mkdirSync(join(args[3], '.git'), { recursive: true });
      const now = state(ws);
      writeFileSync(join(ws, 'recade', 'state.yaml'), `${readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8')}${extra(now)}`);
    }
    return ok;
  };
  await addRepo(ws, 'api', { clone: 'https://example.test/api.git' }, { exec: writer(() => 'hotspots:\n  - src/routes.ts\ngates:\n  G0:\n    passed: 2026-11-18\n') });
  const s = state(ws);
  assert.deepEqual(s.hotspots, ['src/routes.ts']);
  assert.equal(s.gates.G0.passed, '2026-11-18');
  assert.deepEqual(s.repos.map((r) => r.name), ['api']);
  await assert.rejects(addRepo(ws, 'web2', { clone: 'https://example.test/web.git' }, { exec: async (cmd, args) => {
    if (args[0] === 'clone') {
      mkdirSync(join(args[3], '.git'), { recursive: true });
      writeFileSync(join(ws, 'recade', 'state.yaml'), `${readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8').replace(/repos:[\s\S]*$/, '')}repos:\n  - {name: web2, path: repos/web2}\n`);
    }
    return ok;
  } }), /already in the registry/);
  assert.deepEqual(listRepos(ws).map((r) => r.name), ['web2']);
});

test('F3: worktree repair gets only real worktrees, and a failure reports the error line', async () => {
  const parent = tmp();
  const ws = await workspace(parent);
  await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
  const repo = join(ws, 'repos', 'api');
  const wt = join(repo, '.claude', 'worktrees', 'S-02');
  must(git(repo, 'worktree', 'add', '-q', '-b', 'slice/s-02-x', wt, 'main'));
  mkdirSync(join(repo, '.claude', 'worktrees', 'junkdir'));
  writeFileSync(join(repo, '.claude', 'worktrees', 'junkdir', 'a.txt'), 'x');
  writeFileSync(join(repo, '.claude', 'worktrees', 'notes.txt'), 'x');
  const moved = join(parent, 'moved-workspace');
  renameSync(ws, moved);
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return defaultExec(cmd, args);
  };
  const r = await syncRepos(moved, { exec });
  assert.deepEqual(r.skipped, []);
  assert.deepEqual(r.repaired, ['api']);
  assert.deepEqual(calls.find((c) => c.includes('repair')).slice(-1), [join(moved, 'repos', 'api', '.claude', 'worktrees', 'S-02')]);
  assert.deepEqual(calls.find((c) => c.includes('repair')).filter((a) => a.includes('junk') || a.includes('notes')), []);
  assert.deepEqual(checkLink(join(moved, 'repos', 'api', '.claude', 'worktrees', 'S-02')), { ok: true });
  const failing = async (cmd, args) => (args.includes('repair')
    ? { code: 1, stdout: '', stderr: 'repair: gitdir incorrect: x\nerror: unable to locate repository; .git file broken: y\n' }
    : defaultExec(cmd, args));
  const f = await syncRepos(moved, { exec: failing });
  assert.deepEqual(f.skipped, [{ repo: 'api', reason: 'git worktree repair failed: error: unable to locate repository; .git file broken: y' }]);
});

test('F4: the name workspace is reserved, in addRepo, checkRepos and syncRepos', async () => {
  const ws = await workspace();
  await assert.rejects(addRepo(ws, 'workspace', { new: true }, { exec: defaultExec }), /reserved/);
  assert.equal(existsSync(join(ws, 'repos', 'workspace')), false);
  writeFileSync(join(ws, 'recade', 'state.yaml'), `${readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8')}repos:\n  - {name: workspace, path: repos/workspace}\n`);
  assert.deepEqual(checkRepos(ws).findings, [{ repo: 'workspace', problem: 'invalid entry' }]);
  const r = await syncRepos(ws, { exec: async () => { throw new Error('no exec'); } });
  assert.deepEqual(r.skipped.map((x) => x.repo), ['workspace']);
  assert.equal((await cli(ws, ['repo', 'add', 'workspace', '--new'])).code, 1);
});

test('M1: a relative local clone source is cloned as an absolute path, and no machine path is recorded', async () => {
  const ws = await workspace();
  const src = source('rel src');
  const base = join(src, '..');
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    return defaultExec(cmd, args);
  };
  const entry = await addRepo(ws, 'api', { clone: 'rel src' }, { exec, cwd: base });
  assert.equal(entry.remote, 'none');
  assert.deepEqual(calls[0], ['git', 'clone', '--', src, join(ws, 'repos', 'api')]);
});

test('M2: block lists with no indent and a scalar touches are prefixed too', async () => {
  const ws = await workspace();
  writeFileSync(join(ws, 'slices', 'S-01-flat.md'), '---\nid: S-01\ntouches:\n- src/a/**\n- "api:b/**"\nlane: standard\n---\n\nbody\n');
  writeFileSync(join(ws, 'slices', 'S-02-scalar.md'), '---\nid: S-02\ntouches: src/z/** # one\n---\n\nbody\n');
  const changes = prefixTouches(ws, 'api');
  assert.deepEqual(changes, [
    { sheet: 'slices/S-01-flat.md', before: ['src/a/**', 'api:b/**'], after: ['api:src/a/**', 'api:b/**'] },
    { sheet: 'slices/S-02-scalar.md', before: ['src/z/**'], after: ['api:src/z/**'] },
  ]);
  assert.match(readFileSync(join(ws, 'slices', 'S-01-flat.md'), 'utf8'), /touches:\n- api:src\/a\/\*\*\n- "api:b\/\*\*"\nlane: standard/);
  assert.match(readFileSync(join(ws, 'slices', 'S-02-scalar.md'), 'utf8'), /^touches: api:src\/z\/\*\* # one$/m);
});

test('the hotspots of state.yaml are prefixed when the second repository arrives', async () => {
  const ws = await workspace();
  await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
  writeFileSync(join(ws, 'recade', 'state.yaml'), `${readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8')}hotspots:\n  - src/routes.ts\n  - "web:src/app.tsx"\n`);
  const web = await addRepo(ws, 'web', { new: true }, { exec: defaultExec });
  assert.deepEqual(state(ws).hotspots, ['api:src/routes.ts', 'web:src/app.tsx']);
  assert.deepEqual(web.prefixedHotspots, [{ before: 'src/routes.ts', after: 'api:src/routes.ts' }]);
  const mobile = await addRepo(ws, 'mobile', { new: true }, { exec: defaultExec });
  assert.deepEqual(mobile.prefixedHotspots, []);
  assert.deepEqual(state(ws).hotspots, ['api:src/routes.ts', 'web:src/app.tsx']);
});

test('a clone that fails shows the fatal line of git', async () => {
  const ws = await workspace();
  const exec = async () => ({ code: 128, stdout: '', stderr: "Cloning into 'x'...\nfatal: repository 'u' not found\n" });
  await assert.rejects(addRepo(ws, 'api', { clone: 'https://example.test/u.git' }, { exec }), /git clone failed: fatal: repository 'u' not found/);
});

test('a source that starts with a dash is not read as an option, and clone works into an existing empty folder', async () => {
  const ws = await workspace();
  await assert.rejects(addRepo(ws, 'api', { clone: '--upload-pack=touch pwned' }, { exec: defaultExec }), /git clone failed/);
  assert.equal(existsSync(join(ws, 'repos', 'api')), false);
  mkdirSync(join(ws, 'repos', 'web'), { recursive: true });
  await addRepo(ws, 'web', { clone: source() }, { exec: defaultExec });
  assert.deepEqual(checkLink(join(ws, 'repos', 'web')), { ok: true });
});

test('recade repo add prints the prefixed hotspots and clones a relative clone source from its absolute path', async () => {
  const ws = await workspace();
  const src = source('rel-src');
  const a = await cli(ws, ['repo', 'add', 'api', '--clone', src]);
  assert.equal(a.code, 0, a.stderr);
  writeFileSync(join(ws, 'recade', 'state.yaml'), `${readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8')}hotspots:\n  - src/routes.ts\n`);
  // The owner's own edit, committed: a step refuses to commit someone else's uncommitted edit of its files.
  must(git(ws, 'add', '-A'));
  must(git(ws, 'commit', '-q', '-m', 'docs: hotspots'));
  const here = join(src, '..');
  const b = await cli(here, ['repo', 'add', 'web', '--clone', 'rel-src', '--project', ws]);
  assert.equal(b.code, 0, b.stderr);
  assert.match(b.stdout, /Prefixed hotspots: src\/routes\.ts -> api:src\/routes\.ts/);
  assert.equal(listRepos(ws)[1].remote, 'none');
});

/** An at sign, so that no URL of these tests reads as an e-mail address. */
const AT = '@';

/* ---------- final fix wave A ---------- */

test('final A, I2: stripCredentials drops a password or token, and keeps the ssh user', () => {
  assert.equal(stripCredentials(`https://bob:ghp_SECRET${AT}example.invalid/x.git`), 'https://example.invalid/x.git');
  assert.equal(stripCredentials(`https://ghp_SECRET${AT}github.com/o/x.git`), 'https://github.com/o/x.git');
  assert.equal(stripCredentials(`ssh://git:pw${AT}host/x.git`), `ssh://git${AT}host/x.git`);
  for (const kept of [`ssh://git${AT}host/x.git`, `git${AT}github.com:o/x.git`, 'https://github.com/o/x.git', '/srv/git/x.git', 'none']) {
    assert.equal(stripCredentials(kept), kept);
  }
});

test('final A, I2: repo add refuses a clone URL with a password or token and never shows it', async () => {
  const ws = await workspace();
  for (const url of [`https://bob:ghp_SECRET123${AT}example.invalid/x.git`, `https://ghp_SECRET123${AT}example.invalid/x.git`]) {
    const calls = [];
    const exec = async (cmd, args) => {
      calls.push(args);
      return ok;
    };
    await assert.rejects(addRepo(ws, 'web', { clone: url }, { exec }), (err) => {
      assert.match(err.message, /password or a token/);
      assert.doesNotMatch(err.message, /SECRET/);
      return true;
    });
    assert.deepEqual(calls, []);
    const r = await cli(ws, ['repo', 'add', 'web', '--clone', url]);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stdout + r.stderr, /SECRET/);
  }
  assert.equal(existsSync(join(ws, 'repos', 'web')), false);
  assert.deepEqual(listRepos(ws), []);
  // An ssh user is a user name, not a secret.
  const exec = async (cmd, args) => {
    if (args[0] === 'clone') mkdirSync(join(args[3], '.git'), { recursive: true });
    return ok;
  };
  const entry = await addRepo(ws, 'api', { clone: `git${AT}github.com:fern/api.git` }, { exec });
  assert.equal(entry.remote, `git${AT}github.com:fern/api.git`);
});

test('final A, M3: repo add --clone <local path> records the origin of that folder, or none, never the machine path', async () => {
  const ws = await workspace();
  // A folder with no remote: remote none, and the clone does not keep the folder as origin.
  const lone = source('lone');
  const a = await cli(ws, ['repo', 'add', 'api', '--clone', lone]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(listRepos(ws)[0].remote, 'none');
  assert.match(a.stdout, /no remote/);
  assert.equal(git(join(ws, 'repos', 'api'), 'remote').stdout.trim(), '');
  // A folder with an origin: that origin, without its token, and the clone's origin is it.
  const withOrigin = source('with-origin');
  must(git(withOrigin, 'remote', 'add', 'origin', `https://bob:ghp_SECRET${AT}example.invalid/fern/web.git`));
  const b = await cli(ws, ['repo', 'add', 'web', '--clone', withOrigin]);
  assert.equal(b.code, 0, b.stderr);
  assert.equal(listRepos(ws)[1].remote, 'https://example.invalid/fern/web.git');
  assert.doesNotMatch(b.stdout + b.stderr, /SECRET/);
  assert.equal(git(join(ws, 'repos', 'web'), 'remote', 'get-url', 'origin').stdout.trim(), `https://bob:ghp_SECRET${AT}example.invalid/fern/web.git`);
  const committed = readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8');
  assert.doesNotMatch(committed, new RegExp(lone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(committed, /SECRET/);
});

test('final A, I2: repo list never prints a token that an older registry still holds', async () => {
  const ws = await workspace();
  writeFileSync(join(ws, 'recade', 'state.yaml'), `version: 1\nkind: workspace\nrepos:\n  - name: api\n    path: repos/api\n    remote: https://bob:ghp_SECRET${AT}example.invalid/api.git\n`);
  for (const args of [['repo', 'list'], ['repo', 'list', '--json']]) {
    const r = await cli(ws, args);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /SECRET/);
    assert.match(r.stdout, /https:\/\/example\.invalid\/api\.git/);
  }
});

test('final B #2, #3: repo sync writes the plugin root of the workspace and turns the Recade git hooks on, like install', async () => {
  const ws = await workspace();
  const pluginRoot = tmp();
  const hook = '#!/bin/sh\n# Recade harness pre-commit: test\nexit 0\n';
  const { dir: apiDir } = sourceWithOrigin('api-src');
  await addRepo(ws, 'api', { clone: apiDir }, { exec: defaultExec });
  await addRepo(ws, 'own', { new: true }, { exec: defaultExec });
  for (const d of [ws, join(ws, 'repos', 'api')]) {
    mkdirSync(join(d, '.githooks'), { recursive: true });
    writeFileSync(join(d, '.githooks', 'pre-commit'), hook);
  }
  mkdirSync(join(ws, 'repos', 'own', '.githooks'), { recursive: true });
  writeFileSync(join(ws, 'repos', 'own', '.githooks', 'pre-commit'), '#!/bin/sh\n# the owner hook\n');
  // Before: check names the code repository whose Recade hooks are off.
  assert.ok(checkRepos(ws).findings.some((f) => f.repo === 'api' && f.problem === 'git hooks off'), JSON.stringify(checkRepos(ws).findings));
  assert.ok(!checkRepos(ws).findings.some((f) => f.repo === 'own' && f.problem === 'git hooks off'));
  await syncRepos(ws, { exec: defaultExec, pluginRoot });
  assert.equal(readFileSync(join(ws, '.recade', 'plugin-root'), 'utf8'), `${pluginRoot}\n`);
  const hooksPath = (d) => git(d, 'config', '--get', 'core.hooksPath').stdout.trim();
  assert.equal(hooksPath(join(ws, 'repos', 'api')), '.githooks');
  assert.equal(hooksPath(ws), '.githooks');
  assert.equal(hooksPath(join(ws, 'repos', 'own')), '', 'an owner hook folder is not turned on silently');
  assert.ok(!checkRepos(ws).findings.some((f) => f.problem === 'git hooks off'));
  // A hooks folder the owner set is left as it is.
  must(git(join(ws, 'repos', 'api'), 'config', 'core.hooksPath', 'my-hooks'));
  await syncRepos(ws, { exec: defaultExec, pluginRoot });
  assert.equal(hooksPath(join(ws, 'repos', 'api')), 'my-hooks');
});

test('final B #3: recade repo check exits 1 and names a repository whose git hooks are off', async () => {
  const ws = await workspace();
  await addRepo(ws, 'api', { new: true }, { exec: defaultExec });
  mkdirSync(join(ws, 'repos', 'api', '.githooks'), { recursive: true });
  writeFileSync(join(ws, 'repos', 'api', '.githooks', 'pre-commit'), '#!/bin/sh\n# Recade harness pre-commit\n');
  const r = await cli(ws, ['repo', 'check']);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /api: git hooks off/);
  assert.match(r.stdout, /recade repo sync/);
});
