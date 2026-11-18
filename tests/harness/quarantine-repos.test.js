import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { createWorkspace } from '../../src/workspace/layout.js';
import { defaultExec as asyncExec } from '../../src/doctor.js';
import { checkQuarantine, dueForIncrementAll, listAllQuarantine } from '../../src/harness/quarantine.js';
import { retro } from '../../src/harness/cost.js';
import { run } from '../../src/cli.js';
import { git, makeIO } from './fixture-project.js';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'recade-quarantine-repos-')));

function sheet(id, increment) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['api'], branch: `slice/${id.toLowerCase()}-x`, format: 'small', lane: 'standard',
    implementer: 'implementer', increment, depends_on: [], blocks: [], external_prerequisite: 'none',
    provisionals_used: [], size: 'M', touches: [`api:src/${id.toLowerCase()}/**`],
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n`;
}

/** A workspace with two code repositories, api and web, and slices S-01 and S-02 (INC-1) and S-03 (INC-2). */
async function workspace() {
  const parent = join(tmp(), 'Projets Clients');
  mkdirSync(parent);
  const { dir } = await createWorkspace(parent, 'Ete', { exec: asyncExec });
  writeFileSync(join(dir, 'recade', 'state.yaml'), stringify({ version: 1, kind: 'workspace', mode: 'scratch', languages: { work: 'en' } }));
  mkdirSync(join(dir, 'slices'), { recursive: true });
  for (const [id, inc] of [['S-01', 'INC-1'], ['S-02', 'INC-1'], ['S-03', 'INC-2']]) writeFileSync(join(dir, 'slices', `${id}-x.md`), sheet(id, inc));
  for (const name of ['api', 'web']) {
    const t = makeIO(dir);
    assert.equal(await run(['repo', 'add', name, '--new'], t.io), 0, t.err.join(''));
  }
  return dir;
}

const call = async (cwd, ...args) => {
  const t = makeIO(cwd);
  const code = await run(args, t.io);
  return { code, out: t.out.join(''), err: t.err.join('') };
};
const file = (dir) => join(dir, 'tests', 'quarantine.json');
const entries = (dir) => JSON.parse(readFileSync(file(dir), 'utf8'));

test('in a code repository, recade quarantine uses the tests/quarantine.json of that repository, with the slices of the workspace', async () => {
  const ws = await workspace();
  const api = join(ws, 'repos', 'api');
  const r = await call(api, 'quarantine', 'add', 'schedule export order', '--reason', 'flaky on the shared runner', '--slice', 'S-01');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /in tests\/quarantine\.json of api\. Commit that file in api\./);
  assert.deepEqual(entries(api).map((e) => [e.test, e.slice]), [['schedule export order', 'S-01']]);
  assert.equal(existsSync(file(ws)), false, 'nothing is written in the workspace');
  assert.equal(existsSync(file(join(ws, 'repos', 'web'))), false);
  assert.equal((await call(api, 'quarantine', 'list', '--names')).out, 'schedule export order\n');
  assert.equal((await call(join(ws, 'repos', 'web'), 'quarantine', 'list', '--names')).out, '', 'web has its own, empty, list');
  const unknown = await call(api, 'quarantine', 'add', 'other', '--reason', 'x', '--slice', 'S-09');
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /S-09.*no sheet/);
  const gone = await call(api, 'quarantine', 'remove', 'schedule export order');
  assert.equal(gone.code, 0, gone.err);
  assert.deepEqual(entries(api), []);
});

test('in a slice worktree, the file is the one of the worktree, so the change travels with the branch', async () => {
  const ws = await workspace();
  const api = join(ws, 'repos', 'api');
  const wt = join(api, '.claude', 'worktrees', 'S-01');
  mkdirSync(join(api, '.claude', 'worktrees'), { recursive: true });
  assert.equal(git(api, 'worktree', 'add', '-q', '-b', 'slice/s-01-x', wt, 'main').status, 0);
  const r = await call(wt, 'quarantine', 'add', 'login redirect', '--reason', 'timing', '--slice', 'S-01');
  assert.equal(r.code, 0, r.err);
  assert.equal(existsSync(file(wt)), true);
  assert.equal(existsSync(file(api)), false, 'the main checkout is not touched');
});

test('from the workspace, a repository is named with --repo, and without it the command says so', async () => {
  const ws = await workspace();
  for (const args of [['list'], ['add', 'x', '--reason', 'r', '--slice', 'S-01'], ['remove', 'x'], ['check']]) {
    const r = await call(ws, 'quarantine', ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /Name the code repository: --repo <name>/);
  }
  const added = await call(ws, 'quarantine', 'add', 'web smoke', '--reason', 'slow', '--slice', 'S-03', '--repo', 'web');
  assert.equal(added.code, 0, added.err);
  assert.deepEqual(entries(join(ws, 'repos', 'web')).map((e) => e.test), ['web smoke']);
  assert.equal((await call(ws, 'quarantine', 'list', '--names', '--repo', 'web')).out, 'web smoke\n');
  const bad = await call(ws, 'quarantine', 'list', '--repo', 'nope');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /No code repository nope/);
  const mismatch = await call(join(ws, 'repos', 'api'), 'quarantine', 'list', '--repo', 'web');
  assert.equal(mismatch.code, 2);
  assert.match(mismatch.err, /This folder is the repository api/);
  assert.equal((await call(ws, 'quarantine', 'list', '--repo', '../x')).code, 2);
});

test('check judges a repository file against the increments of the workspace sheets', async () => {
  const ws = await workspace();
  const api = join(ws, 'repos', 'api');
  mkdirSync(join(api, 'tests'), { recursive: true });
  writeFileSync(file(api), `${JSON.stringify([{ test: 'old flaky', reason: 'r', since: '2026-01-01', slice: 'S-01' }, { test: 'new flaky', reason: 'r', since: '2026-02-01', slice: 'S-03' }])}\n`);
  assert.equal(checkQuarantine(ws, { inc: 'INC-1', dir: api }).ok, true);
  assert.deepEqual(checkQuarantine(ws, { inc: 'INC-2', dir: api }).expired.map((e) => e.test), ['old flaky']);
  const r = await call(api, 'quarantine', 'check', '--inc', 'INC-2');
  assert.equal(r.code, 1);
  assert.match(r.err, /old flaky/);
});

test('outside a workspace, in a repository whose link cannot be read (a CI checkout), list and check read the file and judge no increment', async () => {
  const dir = tmp();
  assert.equal(git(dir, 'init', '-q', '-b', 'main').status, 0);
  mkdirSync(join(dir, 'tests'));
  writeFileSync(file(dir), `${JSON.stringify([{ test: 'flaky one', reason: 'r', since: '2026-01-01', slice: 'S-01' }])}\n`);
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'recade.yaml'), 'harness:\n  required_gates: [test]\n');
  const list = await call(dir, 'quarantine', 'list', '--names');
  assert.deepEqual([list.code, list.out], [0, 'flaky one\n'], list.err);
  const check = await call(dir, 'quarantine', 'check');
  assert.equal(check.code, 0, check.err);
  assert.match(check.out, /1 quarantined test\. No workspace here, so no increment is judged: \/retro judges them in the workspace\./);
  writeFileSync(file(dir), '{ not json');
  assert.equal((await call(dir, 'quarantine', 'check')).code, 2, 'an unreadable file still fails');
  const add = await call(dir, 'quarantine', 'add', 'x', '--reason', 'r', '--slice', 'S-01');
  assert.equal(add.code, 1, 'adding needs the sheets of the workspace');
});

test('the retro side: the entries of every repository are listed with their repository, and the ones due stop the increment', async () => {
  const ws = await workspace();
  await call(join(ws, 'repos', 'api'), 'quarantine', 'add', 'api flaky', '--reason', 'r', '--slice', 'S-01');
  await call(ws, 'quarantine', 'add', 'web flaky', '--reason', 'r', '--slice', 'S-03', '--repo', 'web');
  assert.deepEqual(listAllQuarantine(ws).map((e) => [e.repo, e.test]), [['api', 'api flaky'], ['web', 'web flaky']]);
  assert.deepEqual(dueForIncrementAll(ws, 'INC-1').map((e) => `${e.repo}:${e.test}`), ['api:api flaky']);
  assert.deepEqual(dueForIncrementAll(ws, 'INC-2').map((e) => `${e.repo}:${e.test}`), ['api:api flaky', 'web:web flaky']);
});

test('the retro refuses to close an increment while a repository holds a quarantined test of it, and names the repository', async () => {
  const ws = await workspace();
  await call(join(ws, 'repos', 'api'), 'quarantine', 'add', 'api flaky', '--reason', 'r', '--slice', 'S-01');
  assert.throws(() => retro(ws, 'INC-1', { exec: () => { throw new Error('no gh before the quarantine check'); } }), /cannot close with 1 quarantined test: api: api flaky \(S-01\)\. Fix each one, then run recade quarantine remove '<test>' --repo <name> and commit tests\/quarantine\.json in that repository\./);
});
