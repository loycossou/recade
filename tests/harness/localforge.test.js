import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { run } from '../../src/cli.js';
import { FORGES, SETTINGS, forgeOf, normalizeState, setSetting } from '../../src/project/state.js';
import { cleanup, formatReconcile, reconcile } from '../../src/harness/board.js';
import { mergeOrder } from '../../src/harness/merge.js';
import { doraMetrics } from '../../src/harness/cost.js';
import { planLocalMerge, runLocalMerge } from '../../src/harness/localmerge.js';
import { findMerge, localMerges, mergeCommand, reviewPath } from '../../src/harness/localforge.js';
import { install } from '../../src/harness/install.js';
import { defaultExec } from '../../src/harness/stamps.js';

// The local forge (docs/design.md, section 6.8): no GitHub, git on this machine only, a local review request and the
// owner's merge with --no-ff. Every path that branches on the forge is checked here, and none of them may call gh.

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** An exec that runs git for real (with an identity) and fails the test on any gh call. */
function noGh() {
  const calls = [];
  const exec = (cmd, opts) => {
    calls.push(cmd);
    assert.notEqual(cmd[0], 'gh', `gh was called: ${cmd.join(' ')}`);
    const argv = cmd[0] === 'git' ? ['git', '-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...cmd.slice(1)] : cmd;
    return defaultExec(argv, opts);
  };
  return { exec, calls };
}

const DOD = (done) => `| # | Command (counts tests) | Expected | Done |\n|---|---|---|---|\n| 1 | \`make test\` (3 tests) | All green | [${done ? 'x' : ' '}] |\n`;

function sheet(id, { touches, done = true, depends = [] }) {
  return `---\ndoc_id: ${id}\ntitle: "Slice ${id}"\nbranch: slice/${id.toLowerCase()}-x\nformat: small\nlane: standard\nimplementer: implementer\nincrement: INC-1\ndepends_on: [${depends.join(', ')}]\nblocks: []\nexternal_prerequisite: none\nprovisionals_used: []\nsize: S\ntouches:\n${touches.map((t) => `  - "${t}"`).join('\n')}\n---\n\n# ${id}: Slice ${id}\n\n## Scope\n\n- LOAN-01 (the gist)\n\n## Definition of Done\n\n${DOD(done)}\n## Work order\n\n1. Build it.\n`;
}

const STATUS = (rows) => `# Slice status\n\n| Slice | Title | Format | Lane | Increment | State | Depends on | Size | Note |\n|---|---|---|---|---|---|---|---|---|\n${rows.map(([id, st]) => `| ${id} | Slice ${id} | small | standard | INC-1 | ${st} | | S | |`).join('\n')}\n`;

/**
 * A workspace on the local forge with the code repositories `api` and `web`, each with a main commit and, for each slice,
 * a branch `slice/<id>-x` with one commit of its own. `slices` is `{ 'S-01': {status, done, review, touches} }`.
 */
function workspace(slices, { forge = 'local' } = {}) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'recade-local-')));
  for (const d of ['recade', 'slices', 'docs']) mkdirSync(join(ws, d));
  writeFileSync(join(ws, 'recade', 'state.yaml'), stringify({
    version: 1, kind: 'workspace', mode: 'scratch', lots: ['LOAN'], ...(forge === null ? {} : { forge }),
    repos: ['api', 'web'].map((name) => ({ name, path: `repos/${name}`, remote: 'none', default_branch: 'main' })),
  }));
  writeFileSync(join(ws, '.gitignore'), 'repos/\nartifacts/\ntmp/\n.recade/\n');
  const rows = [];
  for (const [id, s] of Object.entries(slices)) {
    writeFileSync(join(ws, 'slices', `${id}-x.md`), sheet(id, { touches: s.touches ?? ['api:src/**', 'web:src/**'], done: s.done ?? true, depends: s.depends }));
    rows.push([id, s.status ?? 'ready-to-merge']);
    if (s.review !== false) {
      mkdirSync(join(ws, 'slices', 'reviews'), { recursive: true });
      writeFileSync(join(ws, reviewPath(id)), `# Review request: ${id}\n\n## api\n\nSlice issue: local, see slices/STATUS.md\n`);
    }
  }
  writeFileSync(join(ws, 'slices', 'STATUS.md'), STATUS(rows));
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '.');
  git(ws, 'commit', '-q', '-m', 'chore: start');
  const repos = {};
  for (const name of ['api', 'web']) {
    const dir = join(ws, 'repos', name);
    mkdirSync(join(dir, 'src'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), `${name}\n`);
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'chore: start');
    for (const id of Object.keys(slices)) {
      const branch = `slice/${id.toLowerCase()}-x`;
      git(dir, 'checkout', '-q', '-b', branch);
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', `${id.toLowerCase()}.js`), `export const id = '${id}';\n`);
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `feat(${name}): ${id}`);
      git(dir, 'checkout', '-q', 'main');
    }
    repos[name] = dir;
  }
  return { ws, repos };
}

const io = (cwd, extra = {}) => {
  const out = [];
  const err = [];
  return {
    io: { cwd, env: { ...process.env, RECADE_CONFIG_DIR: join(cwd, '.config-test') }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, ...extra },
    out: () => out.join(''),
    err: () => err.join(''),
  };
};

const statusOf = (ws, id) => new RegExp(`^\\| ${id} \\|.*$`, 'm').exec(readFileSync(join(ws, 'slices', 'STATUS.md'), 'utf8'))[0].split('|')[6].trim();

// ---------------------------------------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------------------------------------

test('forge: a missing or unknown key reads as github, set takes github or local only, and fill adds nothing', () => {
  assert.deepEqual(FORGES, ['github', 'local']);
  assert.ok(SETTINGS.includes('forge'));
  assert.equal(forgeOf({}), 'github');
  assert.equal(forgeOf(undefined), 'github');
  assert.equal(forgeOf({ forge: 'gitlab' }), 'github');
  assert.equal(forgeOf({ forge: 'local' }), 'local');
  assert.equal(setSetting({}, 'forge', 'local').forge, 'local');
  assert.equal(setSetting({ forge: 'local' }, 'forge', 'github').forge, 'github');
  assert.throws(() => setSetting({}, 'forge', 'gitlab'), /Invalid forge: gitlab\. Use github, local/);
  assert.equal('forge' in normalizeState({ gates: {} }), false, 'an older project keeps its state file as it was');
});

test('recade state set forge, then state show prints it, and --json says whether the owner chose', async () => {
  const { ws } = workspace({}, { forge: null });
  const a = io(ws);
  assert.equal(await run(['state', 'show', '--json'], a.io), 0);
  const before = JSON.parse(a.out());
  assert.equal(before.forge, 'github');
  assert.equal(before.forge_asked, false);
  assert.equal(await run(['state', 'set', 'forge', 'local'], io(ws).io), 0);
  assert.equal(parse(readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8')).forge, 'local');
  const b = io(ws);
  await run(['state', 'show', '--json'], b.io);
  assert.equal(JSON.parse(b.out()).forge_asked, true);
  const c = io(ws);
  await run(['state', 'show'], c.io);
  assert.match(c.out(), /^Forge: local \(git on this machine only, the board is slices\/STATUS\.md\)$/m);
  assert.equal(await run(['state', 'set', 'forge', 'gitlab'], io(ws).io), 2);
});

// ---------------------------------------------------------------------------------------------------------
// Commands that need GitHub refuse on the local forge, before any gh call
// ---------------------------------------------------------------------------------------------------------

test('github init, harness protect and adopt board refuse on the local forge and call nothing', async () => {
  const { ws } = workspace({});
  for (const args of [['github', 'init', '--dry-run', '--owner', 'fernhill'], ['github', 'init', '--owner', 'fernhill'], ['harness', 'protect'], ['adopt', 'board']]) {
    if (args[0] === 'adopt') {
      // `adopt board` runs only in an adopted workspace.
      const state = parse(readFileSync(join(ws, 'recade', 'state.yaml'), 'utf8'));
      writeFileSync(join(ws, 'recade', 'state.yaml'), stringify({ ...state, mode: 'adopt' }));
    }
    const calls = [];
    const fake = (...a) => {
      calls.push(a);
      return { code: 1, stdout: '', stderr: 'called' };
    };
    const t = io(ws, { exec: fake, run: fake });
    assert.equal(await run(args, t.io), 1, args.join(' '));
    assert.match(t.err(), /needs GitHub, and this project works on the local forge/, args.join(' '));
    assert.match(t.err(), /recade state set forge github/);
    assert.deepEqual(calls, [], `${args.join(' ')} called nothing`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Reconcile and cleanup read git, never gh
// ---------------------------------------------------------------------------------------------------------

test('reconcile (local): a branch with its review request waits, a --no-ff merge makes it done with merged:, and gh is never called', () => {
  const { ws, repos } = workspace({ 'S-01': {}, 'S-02': { status: 'implementation', review: false } });
  const g = noGh();
  const before = reconcile(ws, { exec: g.exec });
  assert.deepEqual(before.errors, []);
  const row = before.rows.find((r) => r.id === 'S-01');
  assert.equal(row.pr, 'api review requested; web review requested');
  assert.equal(row.action, 'keep');
  assert.equal(before.rows.find((r) => r.id === 'S-02').pr, 'api no review request; web no review request');
  assert.match(formatReconcile(before), /^Item +STATUS\.md +Review +Action$/m);

  // Merged in api only: not done yet.
  git(repos.api, 'merge', '-q', '--no-ff', '--no-edit', 'slice/s-01-x');
  const half = reconcile(ws, { exec: g.exec, apply: true });
  assert.equal(statusOf(ws, 'S-01'), 'ready-to-merge');
  assert.equal(half.rows.find((r) => r.id === 'S-01').pr, 'api merged locally; web review requested');

  git(repos.web, 'merge', '-q', '--no-ff', '--no-edit', 'slice/s-01-x');
  const done = reconcile(ws, { exec: g.exec, apply: true });
  assert.deepEqual(done.errors, []);
  assert.equal(statusOf(ws, 'S-01'), 'done');
  const text = readFileSync(join(ws, 'slices', 'S-01-x.md'), 'utf8');
  for (const name of ['api', 'web']) assert.match(text, new RegExp(`\\n  ${name}: ${git(repos[name], 'rev-parse', 'main')}\\n`));
  assert.match(formatReconcile(done), /local forge: no gh call/);
  assert.equal(g.calls.some((c) => c[0] === 'gh'), false);

  // Once the branch is gone, the merged: record still proves the merge.
  git(repos.api, 'branch', '-D', 'slice/s-01-x');
  const after = reconcile(ws, { exec: g.exec });
  assert.match(after.rows.find((r) => r.id === 'S-01').pr, /^api merged locally/);
});

test('reconcile (local): a fast-forward merge proves nothing, and a ticked DoD is still needed for done', () => {
  const { ws, repos } = workspace({ 'S-01': { done: false } });
  git(repos.api, 'merge', '-q', '--ff-only', 'slice/s-01-x');
  git(repos.web, 'merge', '-q', '--no-ff', '--no-edit', 'slice/s-01-x');
  const r = reconcile(ws, { exec: noGh().exec, apply: true });
  assert.equal(statusOf(ws, 'S-01'), 'ready-to-merge');
  assert.match(r.rows.find((x) => x.id === 'S-01').pr, /^api review requested; web merged locally$/);
});

test('cleanup (local): the worktree and branch of a --no-ff merge go, an unmerged one stays with its reason, and no remote is touched', () => {
  const { ws, repos } = workspace({ 'S-01': {}, 'S-02': {} });
  for (const name of ['api', 'web']) {
    git(repos[name], 'worktree', 'add', '-q', join('.claude', 'worktrees', 'S-02'), 'slice/s-02-x');
    git(repos[name], 'merge', '-q', '--no-ff', '--no-edit', 'slice/s-01-x');
  }
  const g = noGh();
  const dry = cleanup(ws, { exec: g.exec });
  assert.deepEqual(dry.errors, []);
  assert.deepEqual(dry.candidates.map((c) => `${c.repo} ${c.branch}`).sort(), ['api slice/s-01-x', 'web slice/s-01-x']);
  assert.ok(dry.kept.every((k) => k.slice === 'S-02' && /not merged into main with a merge commit/.test(k.reasons.join(' '))));
  const applied = cleanup(ws, { exec: g.exec, apply: true });
  assert.equal(applied.removed.length, 2);
  for (const name of ['api', 'web']) {
    assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/slice/s-01-x'], { cwd: repos[name] }).status, 1);
    assert.ok(existsSync(join(repos[name], '.claude', 'worktrees', 'S-02')));
  }
  assert.equal(g.calls.some((c) => c[0] === 'gh' || c.includes('ls-remote') || c.includes('push')), false);
});

// ---------------------------------------------------------------------------------------------------------
// Merge order and DORA from git
// ---------------------------------------------------------------------------------------------------------

test('merge-order (local): the slice branches with a review request, in order, named by branch, with no gh call', () => {
  const { ws } = workspace({ 'S-01': {}, 'S-02': { depends: ['S-01'] }, 'S-03': { review: false } });
  const order = mergeOrder(ws, { exec: noGh().exec });
  assert.deepEqual(order.map((o) => `${o.repo} ${o.branch}`).sort(), ['api slice/s-01-x', 'api slice/s-02-x', 'web slice/s-01-x', 'web slice/s-02-x']);
  assert.ok(order.every((o) => o.waiting === false));
  assert.ok(order.every((o) => o.pr === null && o.review === reviewPath(o.slice)));
  const api = order.filter((o) => o.repo === 'api').map((o) => o.slice);
  assert.deepEqual(api, ['S-01', 'S-02'], 'a branch comes after the one it depends on');
  assert.match(order.find((o) => o.repo === 'api' && o.slice === 'S-02').reason, /after slice\/s-01-x \(S-01\)/);
  assert.equal(order.some((o) => o.slice === 'S-03'), false, 'a branch with no review request is still in work');
});

test('retro (local): the merges come from git merge commits, with no gh call', () => {
  const { ws, repos } = workspace({ 'S-01': {} });
  for (const name of ['api', 'web']) git(repos[name], 'merge', '-q', '--no-ff', '--no-edit', 'slice/s-01-x');
  const m = doraMetrics(ws, 'INC-1', { exec: noGh().exec });
  assert.deepEqual(m.merges.map((x) => x.slice).sort(), ['S-01', 'S-01']);
  assert.ok(m.merges.every((x) => x.pr === null && /^[0-9a-f]{40}$/.test(x.oid)));
});

test('retro and board (local): one rule, the tip of the branch as a parent, so an edited merge message still counts', async () => {
  const { ws, repos } = workspace({ 'S-01': {} });
  for (const name of ['api', 'web']) git(repos[name], 'merge', '-q', '--no-ff', '-m', 'Bring in the orders', 'slice/s-01-x');
  // A merge commit whose subject names the slice but that does not merge its tip is no merge of it.
  git(repos.api, 'checkout', '-q', '-b', 'side', 'main~1');
  git(repos.api, 'commit', '-q', '--allow-empty', '-m', 'chore: side');
  git(repos.api, 'checkout', '-q', 'main');
  git(repos.api, 'merge', '-q', '--no-ff', '-m', "Merge branch 'slice/s-02-x'", 'side');
  const m = doraMetrics(ws, 'INC-1', { exec: noGh().exec });
  assert.deepEqual(m.merges.map((x) => `${x.repo} ${x.slice}`).sort(), ['api S-01', 'web S-01']);
  assert.equal(await run(['board', 'reconcile', '--apply'], io(ws, { run: noGh().exec }).io), 0);
  assert.equal(statusOf(ws, 'S-01'), 'done');
});

// ---------------------------------------------------------------------------------------------------------
// The owner's merge
// ---------------------------------------------------------------------------------------------------------

test('slices merge: the dry run prints the exact git command for each repository, in order, and what still waits', async () => {
  const { ws, repos } = workspace({ 'S-01': { status: 'audit', done: false } });
  const plan = planLocalMerge(ws, 'S-01', { exec: noGh().exec });
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.steps.map((s) => s.command), [mergeCommand(repos.api, 'slice/s-01-x'), mergeCommand(repos.web, 'slice/s-01-x')]);
  assert.equal(plan.steps[0].command, `git -C '${repos.api}' merge --no-ff slice/s-01-x`);
  assert.equal(plan.waits.length, 2, 'the status and the DoD');
  const t = io(ws);
  assert.equal(await run(['slices', 'merge', 'S-01', '--dry-run'], t.io), 0);
  assert.ok(t.out().includes(`git -C '${repos.api}' merge --no-ff slice/s-01-x\ngit -C '${repos.web}' merge --no-ff slice/s-01-x\n`));
  assert.match(t.out(), /Before the merge: S-01 is audit, not ready-to-merge/);
  const refused = io(ws);
  assert.equal(await run(['slices', 'merge', 'S-01'], refused.io), 1, 'without the waits settled nothing runs');
  assert.equal(git(repos.api, 'log', '-1', '--format=%s', 'main'), 'chore: start');
});

test('slices merge: it merges each repository with a merge commit, skips the ones already merged, and /board then marks the slice done', async () => {
  const { ws, repos } = workspace({ 'S-01': {} });
  git(repos.api, 'merge', '-q', '--no-ff', '--no-edit', 'slice/s-01-x');
  const r = runLocalMerge(ws, 'S-01', { exec: noGh().exec });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.done, ['web'], 'api was merged already');
  for (const name of ['api', 'web']) {
    const merges = localMerges(defaultExec, repos[name], 'main');
    assert.notEqual(findMerge(merges, { tip: git(repos[name], 'rev-parse', 'slice/s-01-x') }), null, `${name} is merged with a merge commit`);
  }
  assert.equal(await run(['board', 'reconcile', '--apply'], io(ws, { run: noGh().exec }).io), 0);
  assert.equal(statusOf(ws, 'S-01'), 'done');
});

test('slices merge: refused on GitHub, on a dirty or switched checkout, and a conflict is aborted', () => {
  const gh = workspace({ 'S-01': {} }, { forge: null });
  assert.match(planLocalMerge(gh.ws, 'S-01', { exec: noGh().exec }).errors.join(' '), /works on GitHub/);

  const dirty = workspace({ 'S-01': {} });
  writeFileSync(join(dirty.repos.web, 'README.md'), 'changed\n');
  assert.match(runLocalMerge(dirty.ws, 'S-01', { exec: noGh().exec }).errors.join(' '), /web: the main checkout has uncommitted changes/);
  git(dirty.repos.web, 'checkout', '-q', 'README.md');
  git(dirty.repos.web, 'checkout', '-q', 'slice/s-01-x');
  assert.match(runLocalMerge(dirty.ws, 'S-01', { exec: noGh().exec }).errors.join(' '), /web: the main checkout is on slice\/s-01-x, not on main/);

  const clash = workspace({ 'S-01': {} });
  mkdirSync(join(clash.repos.api, 'src'), { recursive: true });
  writeFileSync(join(clash.repos.api, 'src', 's-01.js'), 'export const id = 1;\n');
  git(clash.repos.api, 'add', '.');
  git(clash.repos.api, 'commit', '-q', '-m', 'feat: clash');
  const r = runLocalMerge(clash.ws, 'S-01', { exec: noGh().exec });
  assert.match(r.errors.join(' '), /api: git merge failed and was aborted/);
  assert.deepEqual(r.done, []);
  assert.equal(git(clash.repos.api, 'status', '--porcelain'), '', 'the conflict was aborted, the checkout is clean');
});

// ---------------------------------------------------------------------------------------------------------
// The harness leaves out the GitHub-only files
// ---------------------------------------------------------------------------------------------------------

test('install (local): a code repository gets ci.yml but not the conflicts and second-opinion workflows nor dependabot.yml', () => {
  const { ws, repos } = workspace({});
  const pluginRoot = new URL('../../', import.meta.url).pathname;
  const r = install(repos.api, { pluginRoot, target: 'code', workspace: ws, ref: 'v1.0.0' });
  assert.ok(existsSync(join(repos.api, '.github', 'workflows', 'ci.yml')));
  for (const f of ['workflows/conflicts.yml', 'workflows/second-opinion.yml', 'dependabot.yml']) assert.equal(existsSync(join(repos.api, '.github', f)), false, f);
  assert.deepEqual(r.notes, ['Local forge: conflicts.yml, second-opinion.yml, dependabot.yml not written (GitHub only).']);
});

// ---------------------------------------------------------------------------------------------------------
// The prompts follow the forge
// ---------------------------------------------------------------------------------------------------------

const prompt = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

test('prompts: /board shows the dry run and merges only on the yes, /slice never merges, and the harness skips the GitHub-only parts', () => {
  const board = prompt('harness/commands/board.md');
  const local = board.slice(board.indexOf("### The owner's merge on the local forge"), board.indexOf('## Step 2.'));
  const at = (s) => local.indexOf(s);
  assert.ok(at("recade slices merge '<S-nn>' --dry-run") >= 0 && at("recade slices merge '<S-nn>' --dry-run") < at('Merge <S-nn> now with these commands?'));
  assert.ok(at('Merge <S-nn> now with these commands?') < at("Only after the answer `Yes, merge it`, run `recade slices merge '<S-nn>' --project '<home>'`"));
  assert.match(local, /`Not yet` \(recommended, the default, the safest\)/);
  assert.match(local, /Never run `git merge` yourself/);
  const slice = prompt('harness/commands/slice.md');
  assert.match(slice, /Do not run the merge from this session/);
  assert.match(slice, /<home>\/slices\/reviews\/<S-nn>\.md/);
  assert.match(prompt('commands/harness.md'), /On the local forge \(`forge` is `local`\), skip this step/);
  assert.match(prompt('harness/protocol.md'), /^## The local forge$/m);
  assert.match(prompt('harness/agents/release-manager.md'), /^- `workspace:slices\/reviews\/<S-nn>\.md`$/m);
  for (const rel of ['harness/commands/second-opinion.md', 'harness/commands/merge-order.md', 'harness/commands/retro.md', 'harness/commands/board.md', 'harness/commands/slice.md']) {
    assert.match(prompt(rel), /forge/, `${rel} reads the forge before any gh call`);
  }
});
