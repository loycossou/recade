import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { runE2E, phaseSources, MODES, EXAMPLE, COMMANDS, PARENT_FOLDER, ORIGINALS_FOLDER } from '../tools/e2e.js';

// The folders live until the whole file is done: the cross-mode tests read the projects of the mode tests.
const folders = [];
after(() => folders.forEach((f) => rmSync(f, { recursive: true, force: true })));
const sandbox = () => {
  const tmp = mkdtempSync(join(tmpdir(), 'recade-e2e-'));
  folders.push(tmp);
  return tmp;
};

/** A copy of the example folder that a test can break. */
const exampleCopy = (tmp) => {
  const dir = join(tmp, 'example');
  cpSync(EXAMPLE, dir, { recursive: true });
  return dir;
};

const GATES = { scratch: ['G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5'], adopt: ['G0-inventory', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5'] };
GATES.from = GATES.scratch;
const PHASES = { scratch: ['intake', 'team', 'docs', 'bible', 'slices', 'harness', 'delivery'], adopt: ['inventory', 'team', 'docs', 'bible', 'slices', 'harness', 'delivery'] };
PHASES.from = PHASES.scratch;
const WORKSPACE = { scratch: 'fernhill-lending-workspace', from: 'fernhill-lending-workspace', adopt: 'fernhill-desk-workspace' };

const stateOf = (dir) => parse(readFileSync(join(dir, 'recade', 'state.yaml'), 'utf8'));
const read = (dir, rel) => readFileSync(join(dir, rel), 'utf8');
const gitOut = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).stdout;
const sheetOf = (dir, id) => read(dir, `slices/${readdirSync(join(dir, 'slices')).find((f) => f.startsWith(`${id}-`))}`);
const results = {};
for (const mode of MODES) {
  test(`the ${mode} mode runs green from the first question to a slice merged in every code repository`, async (t) => {
    const tmp = sandbox(t);
    const r = await runE2E({ mode, tmp });
    results[mode] = r;
    assert.equal(r.ok, true, r.failure === undefined ? '' : `${r.failure.phase} ${r.failure.file}:${r.failure.line} ${r.failure.message}`);
    assert.deepEqual(r.steps.map((s) => s.phase), PHASES[mode]);
    assert.deepEqual(r.steps.flatMap((s) => s.gates), GATES[mode], 'every gate is passed, in order, on the recorded owner answer');
    for (const s of r.steps) assert.ok(s.files.length > 0, `${s.phase} wrote files`);
    assert.ok(Number.isInteger(r.ms) && r.ms > 0, 'the run reports its duration');
    assert.deepEqual(r.repos, mode === 'adopt' ? ['fernhill-desk'] : ['api', 'web']);

    const state = stateOf(r.dir);
    assert.ok(GATES[mode].every((g) => typeof state.gates[g].passed === 'string'), 'the project state holds every gate as passed');
    assert.equal(state.mode, mode === 'from' ? 'from-docs' : mode);
    assert.equal(state.kind, 'workspace');
    assert.deepEqual(state.repos.map((e) => e.name), r.repos, 'the registry holds the code repositories');
    // The harness is installed at two targets and verified at each: the project commands in the workspace, the slice commands,
    // the guard and the gates in each code repository.
    assert.ok(existsSync(join(r.dir, '.claude', 'commands', 'status.md')) && existsSync(join(r.dir, '.github', 'workflows', 'workspace.yml')));
    assert.equal(existsSync(join(r.dir, '.claude', 'commands', 'slice.md')), false, 'no slice command in the workspace');
    assert.equal(existsSync(join(r.dir, '.github', 'workflows', 'ci.yml')), false, 'no CI of a code repository in the workspace');
    for (const name of r.repos) {
      const repo = join(r.dir, 'repos', name);
      assert.ok(existsSync(join(repo, '.claude', 'agents', 'reviewer.md')) && existsSync(join(repo, '.claude', 'commands', 'slice.md')), `${name} has the slice harness`);
      assert.ok(existsSync(join(repo, '.github', 'workflows', mode === 'adopt' ? 'recade.yml' : 'ci.yml')), `${name} has its CI`);
      assert.ok(existsSync(join(repo, '.recade', 'workspace')), `${name} is linked to its workspace`);
      // A new repository has no document at all; an adopted one keeps the documents its owner wrote, and none of Recade's.
      assert.equal(existsSync(join(repo, 'docs')), mode === 'adopt', `no document of Recade is copied into ${name}`);
      assert.equal(existsSync(join(repo, 'docs', 'source')) || existsSync(join(repo, 'docs', 'recade')) || existsSync(join(repo, 'docs', 'inventory.md')), false);
      assert.equal(existsSync(join(repo, 'BIBLE.md')), false);
    }
    assert.equal(r.steps.find((s) => s.phase === 'harness').verify.match(/Harness verified/g).length, 1 + r.repos.length, 'verify passes on each target');
    // The documents are rendered where the commands say.
    const out = join(r.dir, 'docs', 'deliverables');
    assert.ok(existsSync(join(out, 'PLAN.xlsx')) && existsSync(join(out, 'PLAN.docx')) && existsSync(join(out, 'PLAN.pdf')));
    if (mode !== 'adopt') for (const d of ['D1', 'D2', 'D3']) assert.ok(existsSync(join(out, `${d}.docx`)) && existsSync(join(out, `${d}.pdf`)), `${d} is rendered`);
    // Slices exist, with the generated STATUS and graph.
    assert.ok(readdirSync(join(r.dir, 'slices')).filter((f) => /^S-\d\d/.test(f)).length >= 3);
    assert.ok(existsSync(join(r.dir, 'slices', 'STATUS.md')) && existsSync(join(r.dir, 'slices', 'graph.md')));
    // The board work went to the fake gh: it was asked, it wrote, and nothing left the machine.
    assert.ok(r.gh.calls.length > 0 && r.gh.writes.length > 0);
    const created = r.gh.writes.filter(([a, b]) => a === 'repo' && b === 'create').map((args) => args[2]);
    assert.deepEqual(created, mode === 'adopt'
      ? ['fernhill/fernhill-desk-workspace']
      : ['fernhill/fernhill-lending-workspace', 'fernhill/fernhill-lending-api', 'fernhill/fernhill-lending-web'], 'the private workspace repository first, then one repository for each yes; an adopted repository is never created');
  });
}

test('every mode ends with a clean workspace of exactly the planned tree, and its .gitignore keeps the code repositories out', (t) => {
  const TRACKED = ['.claude', '.githooks', '.github', '.gitignore', 'BIBLE.md', 'CLAUDE.md', 'INDEX.md', 'decisions', 'design', 'docs', 'intake', 'recade', 'retros', 'slices', 'team'];
  for (const mode of MODES) {
    const r = results[mode];
    if (r === undefined) { t.skip(`${mode} did not run`); continue; }
    const tracked = gitOut(r.dir, 'ls-files').split('\n').filter(Boolean);
    const top = [...new Set(tracked.map((f) => f.split('/')[0]))].sort();
    assert.deepEqual(top.filter((x) => !TRACKED.includes(x)), [], `${mode}: only the planned folders and files are tracked`);
    for (const x of ['recade', 'slices', 'docs', '.claude', '.githooks', 'BIBLE.md', 'CLAUDE.md']) assert.ok(top.includes(x), `${mode}: ${x} is tracked`);
    const lines = read(r.dir, '.gitignore').split('\n').map((l) => l.trim());
    for (const ignored of ['repos/', 'artifacts/', 'tmp/', '.recade/']) assert.ok(lines.includes(ignored), `${mode}: .gitignore holds ${ignored}`);
    for (const name of r.repos) {
      assert.ok(existsSync(join(r.dir, 'repos', name, '.git')), `${mode}: ${name} is a repository of its own`);
      assert.equal(spawnSync('git', ['-C', r.dir, 'check-ignore', '-q', `repos/${name}/package.json`]).status, 0, `${mode}: repos/${name} is ignored by the workspace`);
    }
    assert.equal(tracked.some((f) => f.startsWith('repos/') || f.startsWith('.recade/')), false);
    assert.equal(gitOut(r.dir, 'status', '--porcelain'), '', `${mode}: every file of Recade is committed`);
    assert.equal(gitOut(r.dir, 'branch', '--show-current').trim(), 'main');
    for (const name of r.repos) assert.equal(gitOut(join(r.dir, 'repos', name), 'status', '--porcelain').split('\n').filter((l) => l !== '' && !l.includes('.claude/worktrees')).join('\n'), '', `${mode}: ${name} has nothing left uncommitted`);
  }
});

test('nothing is written outside <parent>/<slug>-workspace: the parent holds that folder alone, and the adopted original is the one it was', (t) => {
  for (const mode of MODES) {
    const r = results[mode];
    if (r === undefined) { t.skip(`${mode} did not run`); continue; }
    assert.equal(r.parent.endsWith(PARENT_FOLDER), true);
    assert.match(PARENT_FOLDER, / .*É/, 'the parent folder has a space and an accent');
    assert.deepEqual(readdirSync(r.parent), [WORKSPACE[mode]], `${mode}: the parent holds the workspace only`);
    assert.equal(r.dir, join(r.parent, WORKSPACE[mode]));
    const around = readdirSync(r.tmp).sort();
    assert.deepEqual(around, [...new Set(['config', PARENT_FOLDER, ...(mode === 'adopt' ? [ORIGINALS_FOLDER] : [])])].sort(), `${mode}: the temp folder holds the config, the parent and, for adopt, the original`);
    if (mode === 'adopt') {
      assert.ok(r.original.before !== null && r.original.before === r.original.after, 'the tree of the original, its git folder included, is byte for byte what it was');
      assert.equal(gitOut(r.original.dir, 'status', '--porcelain'), '');
      assert.equal(readdirSync(r.original.dir).includes('.recade'), false);
    }
  }
});

test('a slice that touches api and web goes from todo to done with one fake pull request in each repository, and the issue of the workspace closes once', (t) => {
  for (const mode of ['scratch', 'from']) {
    const r = results[mode];
    if (r === undefined) { t.skip(`${mode} did not run`); continue; }
    assert.match(sheetOf(r.dir, 'S-01'), /\ntouches:\n  - "api:[^"]+"(\n  - "[^"]+")*\n  - "web:/, 'the sheet names both repositories');
    assert.match(read(r.dir, 'slices/STATUS.md'), /\| S-01 \|[^\n]*\| done \|/);
    assert.deepEqual(r.gh.prs.map((p) => [p.repo, p.full, p.number, p.state, p.base]), [
      ['api', 'fernhill/fernhill-lending-api', 1, 'MERGED', 'main'],
      ['web', 'fernhill/fernhill-lending-web', 1, 'MERGED', 'main'],
    ], 'one pull request for each repository, in the merge order of the sheet');
    assert.equal(r.gh.calls.filter(([a, b]) => a === 'pr' && b === 'create').length, 2);
    const sheet = sheetOf(r.dir, 'S-01');
    for (const p of r.gh.prs) {
      const head = gitOut(join(r.dir, 'repos', p.repo), 'rev-parse', 'main').trim();
      assert.equal(head, p.sha, `${p.repo}: main is the commit that was merged`);
      assert.match(sheet, new RegExp(`\\n  ${p.repo}: ${p.sha}\\n`), `merged: records ${p.repo}`);
      assert.match(p.body, /^Slice issue: https:\/\/github\.com\/fernhill\/fernhill-lending-workspace\/issues\/\d+$/, 'the body links the issue of the workspace and holds no text of the sheet');
    }
    const issues = r.gh.issues.filter((i) => i.title.startsWith('[S-01]'));
    assert.deepEqual(issues.map((i) => [i.repo, i.state]), [['fernhill/fernhill-lending-workspace', 'CLOSED']]);
    assert.equal(r.gh.issues.some((i) => i.repo !== 'fernhill/fernhill-lending-workspace'), false, 'no issue is created in a code repository');
    assert.equal(r.gh.writes.filter(([a, b]) => a === 'issue' && b === 'close').length, 1, 'the issue closes once, when the last pull request is merged');
    const subjects = gitOut(r.dir, 'log', '--format=%s').split('\n');
    assert.ok(subjects.includes('chore(slices): S-01 ready-to-merge') && subjects.some((l) => /^docs\(slices\): tick DoD rows? /.test(l)) && subjects[0] === 'chore(board): reconcile slices');
    for (const name of r.repos) {
      assert.equal(existsSync(join(r.dir, 'repos', name, '.claude', 'worktrees', 'S-01')), false, `${name}: the merged worktree was cleaned up`);
      assert.equal(gitOut(join(r.dir, 'repos', name), 'branch', '--list', 'slice/*').trim(), '', `${name}: and so was its branch`);
    }
  }
  const adopt = results.adopt;
  if (adopt !== undefined) {
    assert.match(read(adopt.dir, 'slices/STATUS.md'), /\| S-01 \|[^\n]*\| done \|/);
    assert.deepEqual(adopt.gh.prs.map((p) => [p.repo, p.state]), [['fernhill-desk', 'MERGED']], 'an adopted slice has one pull request, in the adopted repository');
  }
});

test('auto-push calls only the workspace repository: no code repository is pushed by Recade, and every push is on the default branch', (t) => {
  for (const mode of MODES) {
    const r = results[mode];
    if (r === undefined) { t.skip(`${mode} did not run`); continue; }
    assert.equal(stateOf(r.dir).workspace?.auto_push, true, `${mode}: the owner said yes, and it is recorded`);
    const pushes = r.gh.network.filter((n) => n.sub === 'push');
    assert.ok(pushes.length >= 2, `${mode}: the workspace was pushed after its steps (${pushes.length})`);
    for (const p of pushes) {
      assert.equal(p.cwd, r.dir, `${mode}: the push runs in the workspace`);
      assert.deepEqual(p.args.slice(-2), ['origin', 'main']);
    }
    assert.deepEqual([...new Set(r.gh.network.map((n) => n.sub))].filter((s) => !['push', 'ls-remote', 'clone'].includes(s)), [], `${mode}: no fetch and no pull`);
    assert.equal(r.gh.network.filter((n) => n.sub === 'clone').length, mode === 'adopt' ? 1 : 0, `${mode}: only adopt clones, and only the repository the owner gave`);
  }
});

test('scratch and from give the same documents after the intake: one product in every mode', async (t) => {
  if (results.scratch === undefined || results.from === undefined) { t.skip('a mode did not run'); return; }
  for (const rel of ['docs/D1.md', 'docs/PLAN.md', 'BIBLE.md', 'slices/S-02-loans-returns.md', 'team/roster.md']) {
    assert.equal(read(results.scratch.dir, rel), read(results.from.dir, rel), `${rel} is the same in scratch and from`);
  }
  assert.notEqual(read(results.scratch.dir, 'intake/brief.md'), read(results.from.dir, 'intake/brief.md'), 'the intake is what differs');
  assert.ok(existsSync(join(results.from.dir, 'intake', 'attachments', 'loan-register.xlsx')), 'the client spreadsheet was copied');
  assert.ok(!existsSync(join(results.scratch.dir, 'intake', 'attachments', 'loan-register.xlsx')));
  // The three modes describe one product: the same fictional library in every document set.
  if (results.adopt !== undefined) assert.match(read(results.adopt.dir, 'docs/inventory.md'), /Fernhill/);
  assert.match(read(results.scratch.dir, 'docs/D1.md'), /Fernhill/);
});

test('adopt keeps the repository as it was: no file of the owner is edited or deleted, the CI file stays byte for byte, the board is matched not duplicated', async (t) => {
  if (results.adopt === undefined) { t.skip('adopt did not run'); return; }
  const workspace = results.adopt.dir;
  const dir = join(workspace, 'repos', 'fernhill-desk');
  const git = (...args) => gitOut(dir, ...args);
  const owners = git('rev-list', '--reverse', 'HEAD').trim().split('\n')[2]; // the last commit of the example's own history
  const changed = git('diff', '--name-status', `${owners}..HEAD`).split('\n').filter(Boolean);
  const edited = changed.filter((l) => !l.startsWith('A\t'));
  assert.deepEqual(edited, ['M\t.gitignore'], 'only .gitignore changes in the code repository: Recade appends its own line to it, as the adopt command says');
  const patch = git('diff', `${owners}..HEAD`, '--', '.gitignore');
  assert.deepEqual(patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')), [], 'the .gitignore of the owner only gains a line');
  assert.equal(git('show', `${owners}:.github/workflows/ci.yml`), read(dir, '.github/workflows/ci.yml'), 'ci.yml is byte for byte what the owner wrote');
  const added = changed.filter((l) => l.startsWith('A\t')).map((l) => l.slice(2));
  assert.deepEqual(added.filter((f) => !/^(\.claude\/|\.githooks\/|\.github\/workflows\/recade[^/]*\.yml$|\.github\/dependabot\.yml$|CLAUDE\.md$|src\/s-01\.js$)/.test(f)), [], 'Recade wrote in the code repository only its harness, and the slice the run delivered');
  assert.equal(existsSync(join(dir, 'docs', 'recade')), false);
  assert.equal(existsSync(join(workspace, 'docs', 'recade')), false, 'docs/recade/ no longer exists');
  const gh = results.adopt.gh;
  assert.equal(gh.calls.some(([a, b]) => a === 'project' && b === 'create'), false, 'no second board is created');
  assert.equal(gh.writes.some(([a, b, c]) => a === 'repo' && b === 'create' && c === 'fernhill/fernhill-desk'), false, 'the existing repository is not created again');
  assert.ok(gh.writes.some(([a, b, c]) => a === 'repo' && b === 'create' && c === 'fernhill/fernhill-desk-workspace'), 'the workspace repository is the only new one');
  const state = stateOf(workspace);
  assert.equal(state.github.project_number, 4);
  assert.deepEqual(state.github.links, {
    'S-01': 'https://github.com/fernhill/fernhill-desk/issues/11',
    'S-02': 'https://github.com/fernhill/fernhill-desk/issues/12',
  }, 'the owner linked two existing issues of the adopted repository to slices');
  const slices = gh.issues.filter((i) => i.repo === 'fernhill/fernhill-desk-workspace').map((i) => i.title.slice(0, 6));
  assert.equal(slices.includes('[S-01]') || slices.includes('[S-02]'), false, 'a linked slice gets no second issue in the workspace');
  assert.ok(gh.issues.filter((i) => i.repo === 'fernhill/fernhill-desk').length === 3 && gh.issues.every((i) => i.repo !== 'fernhill/fernhill-desk' || [11, 12, 13].includes(i.number)), 'nothing is created in the adopted repository');
  assert.ok(gh.network.every((n) => ['push', 'ls-remote', 'clone'].includes(n.sub)), 'the only remote git calls were answered by the fake');
});

test('adopt writes the PLAN of the remaining work through the own-files policy, and slices check reads it', async (t) => {
  if (results.adopt === undefined) { t.skip('adopt did not run'); return; }
  const dir = results.adopt.dir;
  const created = JSON.parse(read(dir, '.recade/created.json')).files.map((f) => f.path);
  assert.ok(created.includes('docs/PLAN.md'), 'docs/PLAN.md is recorded in .recade/created.json of the workspace');
  assert.ok(created.includes('docs/RULES.md') && created.includes('docs/source/INDEX.md'), 'the documents written from the code sit under docs/');
  const record = JSON.parse(read(join(dir, 'repos', 'fernhill-desk'), '.recade/created.json')).files.map((f) => f.path);
  assert.deepEqual(record.filter((p) => !/^(\.claude\/|\.githooks\/|\.github\/workflows\/recade[^/]*\.yml$|\.github\/dependabot\.yml$|CLAUDE\.md$|\.gitignore$)/.test(p)), [], 'the code repository record holds harness paths only');
  const check = spawnSync(process.execPath, [join(EXAMPLE, '..', 'bin', 'recade.js'), 'slices', 'check', '--project', dir], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
});

test('Step 1 of team, bible and slices lists the sources of every mode, and an adopted project needs no intake and no D1 to D3', () => {
  const read = (c) => readFileSync(join(COMMANDS, `${c}.md`), 'utf8');
  for (const c of ['team', 'bible', 'slices']) {
    for (const p of [{ mode: 'new' }, { mode: 'from-docs' }, { mode: 'adopt' }, { mode: 'adopt', full: true }]) {
      const got = phaseSources(read(c), p);
      assert.ok(got !== null && got.files.length > 0, `${c}.md lists the sources of ${JSON.stringify(p)}`);
    }
    const adopt = phaseSources(read(c), { mode: 'adopt' }).files;
    assert.equal(adopt.some((f) => f.startsWith('intake/') || /^docs\/D[123]\.md$/.test(f)), false, `${c}.md: the default adopt mode writes no intake and no D1 to D3`);
  }
  assert.deepEqual(phaseSources(read('team'), { mode: 'adopt' }).files, ['docs/inventory.md', 'docs/STACK.md']);
  assert.deepEqual(phaseSources(read('team'), { mode: 'new' }).files, ['intake/brief.md']);
  assert.deepEqual(phaseSources(read('bible'), { mode: 'adopt' }).files, ['docs/RULES.md', 'docs/INVARIANTS.md', 'docs/CONTRACTS.md', 'docs/STACK.md'], 'the PLAN of the remaining work is written by the bible phase');
  assert.deepEqual(phaseSources(read('bible'), { mode: 'adopt', full: true }).files, ['docs/D1.md', 'docs/D2.md', 'docs/D3.md', 'docs/STACK.md']);
  assert.ok(phaseSources(read('slices'), { mode: 'adopt' }).files.includes('docs/PLAN.md') && phaseSources(read('slices'), { mode: 'adopt' }).files.includes('BIBLE.md'));
  assert.equal(phaseSources('# no such point\n', { mode: 'adopt' }), null);
});

test('a command file that sends the adopted project to a source it never writes stops the adopt run at that line', async (t) => {
  const tmp = sandbox(t);
  const commands = join(tmp, 'commands');
  cpSync(COMMANDS, commands, { recursive: true });
  const file = join(commands, 'team.md');
  const lines = readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('   - mode `adopt`:'));
  lines[at] = '   - mode `adopt`: `intake/brief.md`;';
  writeFileSync(file, lines.join('\n'));
  const r = await runE2E({ mode: 'adopt', tmp, commands, stopAfter: 'team' });
  assert.equal(r.ok, false);
  assert.equal(r.failure.phase, 'team');
  assert.equal(r.failure.file, 'commands/team.md');
  assert.equal(r.failure.line, at + 1);
  assert.match(r.failure.message, /intake\/brief\.md is missing in mode adopt/);
});

test('a run needs a known mode and an empty temp folder', async (t) => {
  await assert.rejects(runE2E({ mode: 'nope', tmp: sandbox(t) }), /Unknown mode/);
  await assert.rejects(runE2E({ mode: 'scratch' }), /needs a temp folder/);
});

test('a broken recorded file makes the run fail with the phase and the file named', async (t) => {
  const tmp = sandbox(t);
  const example = exampleCopy(tmp);
  const file = join(example, 'recorded', 'scratch', 'team', 'team', 'architect.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('## Review checklist', '## Checks'));
  const r = await runE2E({ mode: 'scratch', tmp, example });
  assert.equal(r.ok, false);
  assert.equal(r.failure.phase, 'team');
  assert.equal(r.failure.file, 'team/architect.md');
  assert.ok(Number.isInteger(r.failure.line) && r.failure.line > 0);
  assert.match(r.failure.message, /Review checklist/);
  assert.deepEqual(r.steps.map((s) => s.phase), ['intake'], 'the steps before the failure are reported');
});

test('a citation of an ID that nothing defines fails in the docs phase, at the line of the citation', async (t) => {
  const tmp = sandbox(t);
  const example = exampleCopy(tmp);
  const file = join(example, 'recorded', 'scratch', 'docs', 'docs', 'D1.md');
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace('## 12. Exclusions\n', '## 12. Exclusions\n\nSee FR-ZZZ-99 (a requirement nobody wrote).\n'));
  const line = text.split('\n').indexOf('## 12. Exclusions') + 3;
  const r = await runE2E({ mode: 'scratch', tmp, example });
  assert.equal(r.ok, false);
  assert.equal(r.failure.phase, 'docs');
  assert.equal(r.failure.file, 'docs/D1.md');
  assert.equal(r.failure.line, line);
  assert.match(r.failure.message, /FR-ZZZ-99/);
});

test('a recorded file that is missing fails with the phase and the path, not a stack trace', async (t) => {
  const tmp = sandbox(t);
  const example = exampleCopy(tmp);
  rmSync(join(example, 'recorded', 'scratch', 'intake', 'intake', 'brief.md'));
  const r = await runE2E({ mode: 'scratch', tmp, example });
  assert.equal(r.ok, false);
  assert.equal(r.failure.phase, 'intake');
  assert.equal(r.failure.file, 'intake/brief.md');
  assert.match(r.failure.message, /missing/i);
});

test('a change in a generated file fails with the phase, the file and the first line that differs', async (t) => {
  const tmp = sandbox(t);
  const example = exampleCopy(tmp);
  const expected = join(example, 'expected', 'scratch', 'intake', 'intake', 'provisionals.md');
  const lines = readFileSync(expected, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.startsWith('| PRV-02'));
  lines[at] = lines[at].replace('Logo', 'Wordmark');
  writeFileSync(expected, lines.join('\n'));
  const r = await runE2E({ mode: 'scratch', tmp, example });
  assert.equal(r.ok, false);
  assert.equal(r.failure.phase, 'intake');
  assert.equal(r.failure.file, 'intake/provisionals.md');
  assert.equal(r.failure.line, at + 1);
  assert.match(r.failure.message, /Wordmark/);
  assert.match(r.failure.message, /Logo/);
});

test('the update option writes the generated files the next run compares with', async (t) => {
  const tmp = sandbox(t);
  const example = exampleCopy(tmp);
  rmSync(join(example, 'expected'), { recursive: true, force: true });
  const missing = await runE2E({ mode: 'scratch', tmp: mkdtempSync(join(tmp, 'a-')), example });
  assert.equal(missing.ok, false);
  assert.match(missing.failure.message, /no expected file/i);
  const updated = await runE2E({ mode: 'scratch', tmp: mkdtempSync(join(tmp, 'b-')), example, update: true });
  assert.equal(updated.ok, true, updated.failure?.message);
  assert.ok(existsSync(join(example, 'expected', 'scratch', 'intake', 'intake', 'provisionals.md')));
});

test('nothing reaches a network: gh is the fake and no git command leaves the machine', async (t) => {
  const tmp = sandbox(t);
  const seen = [];
  const { defaultExec } = await import('../src/doctor.js');
  const exec = (cmd, args, timeout) => {
    seen.push([cmd, ...args]);
    return defaultExec(cmd, args, timeout);
  };
  const r = await runE2E({ mode: 'scratch', tmp, exec, stopAfter: 'slices' });
  assert.equal(r.ok, true, r.failure?.message);
  assert.equal(seen.some(([cmd]) => cmd === 'gh'), false, 'the real gh is never run');
  assert.equal(seen.some(([cmd, ...a]) => cmd === 'git' && ['push', 'ls-remote', 'fetch', 'pull', 'clone'].includes(a[0] === '-C' ? a[2] : a[0])), false, 'no remote git command is run for real');
  assert.ok(r.gh.writes.some((args) => args[0] === 'repo' && args[1] === 'create' && args.includes('--push')), 'the repository was created, and pushed, on the fake');
});

test('the example is fictional, free of the em dash and of raw e-mail strings', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const em = String.fromCharCode(0x2014);
  for (const file of walk(EXAMPLE).filter((f) => /\.(md|json|yaml|jsonl|js|html)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    assert.equal(text.includes(em), false, `${file} holds an em dash`);
    assert.equal(/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), false, `${file} holds an e-mail string`);
  }
  assert.ok(existsSync(join(EXAMPLE, 'README.md')));
});
