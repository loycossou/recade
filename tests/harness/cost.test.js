import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { recordCost, readCost, retro, doraMetrics } from '../../src/harness/cost.js';
import { openProvisional } from '../../src/project/provisionals.js';
import { addQuarantine, removeQuarantine } from '../../src/harness/quarantine.js';
import { defaultExec } from '../../src/harness/stamps.js';
import { lintText } from '../../src/style/lint.js';
import { run, COMMAND_MAP } from '../../src/cli.js';

const repoDir = fileURLToPath(new URL('../..', import.meta.url));
const read = (path) => readFileSync(join(repoDir, path), 'utf8');
const EM = String.fromCharCode(0x2014);

// ---------------------------------------------------------------------------------------------------------
// A fictional project with a synthetic git history
// ---------------------------------------------------------------------------------------------------------

/** Built from parts so that no address appears in the source. */
const MAIL = ['test', 'users.invalid'].join(String.fromCharCode(64));

function git(repo, date, ...args) {
  const r = spawnSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: MAIL, GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: MAIL },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Commit `files` (name to content) on the current branch at `date`; return the commit id. */
function commit(repo, date, message, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(repo, name, '..'), { recursive: true });
    writeFileSync(join(repo, name), content);
    git(repo, date, 'add', name);
  }
  git(repo, date, 'commit', '-q', '-m', message);
  return git(repo, date, 'rev-parse', 'HEAD');
}

function sheet(id, increment) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['app'], branch: `slice/${id.toLowerCase()}-x`, format: 'small', lane: 'standard',
    implementer: 'implementer', increment, depends_on: [], blocks: [], external_prerequisite: 'none',
    provisionals_used: [], size: 'M', touches: [`src/${id.toLowerCase()}/**`],
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n`;
}

/** A project that is also a git repository on `main`. */
function makeProject(sheets) {
  const root = mkdtempSync(join(tmpdir(), 'recade-cost-'));
  mkdirSync(join(root, 'recade'));
  mkdirSync(join(root, 'slices'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', languages: { work: 'en' } }));
  for (const [id, inc] of Object.entries(sheets)) writeFileSync(join(root, 'slices', `${id}-x.md`), sheet(id, inc));
  git(root, '2026-03-01T09:00:00Z', 'init', '-q', '-b', 'main');
  commit(root, '2026-03-01T09:00:00Z', 'chore: start', { 'README.txt': 'start\n' });
  return root;
}

/**
 * The history of increment INC-1 (S-01, S-02) and one slice of INC-2 (S-03):
 *  03-03 S-01 merged (first commit 03-02 09:00: lead time 24 h), touches src/login.js
 *  03-04 S-03 merged (other increment), touches src/other.js
 *  03-05 S-02 merged (first commit 03-03 09:00: lead time 48 h), touches src/export.js
 *  03-06 `fix: login crash` on src/login.js: 3 days after S-01, so S-01 failed and was restored 72 h later
 *  03-07 `fix: other typo` on src/other.js: S-03 is not in INC-1, nothing to count
 *  03-20 `Revert "feat(S-02)"` on src/export.js: 15 days after S-02, outside the 7 days
 */
function history() {
  const root = makeProject({ 'S-01': 'INC-1', 'S-02': 'INC-1', 'S-03': 'INC-2' });
  const s1 = commit(root, '2026-03-03T09:00:00Z', 'feat(S-01): login (#1)', { 'src/login.js': 'v1\n' });
  const s3 = commit(root, '2026-03-04T09:00:00Z', 'feat(S-03): other (#3)', { 'src/other.js': 'v1\n' });
  const s2 = commit(root, '2026-03-05T09:00:00Z', 'feat(S-02): export (#2)', { 'src/export.js': 'v1\n' });
  const fix = commit(root, '2026-03-06T09:00:00Z', 'fix: login crash (#4)', { 'src/login.js': 'v2\n' });
  commit(root, '2026-03-07T09:00:00Z', 'fix: other typo (#5)', { 'src/other.js': 'v2\n' });
  commit(root, '2026-03-20T09:00:00Z', 'Revert "feat(S-02): export (#2)"', { 'src/export.js': 'v0\n' });
  const prs = [
    pr(1, 'slice/s-01-login', s1, '2026-03-03T09:00:00Z', '2026-03-02T09:00:00Z', 'feat(S-01): login'),
    pr(3, 'slice/s-03-other', s3, '2026-03-04T09:00:00Z', '2026-03-03T09:00:00Z', 'feat(S-03): other'),
    pr(2, 'slice/s-02-export', s2, '2026-03-05T09:00:00Z', '2026-03-03T09:00:00Z', 'feat(S-02): export'),
    pr(4, 'hotfix/login', fix, '2026-03-06T09:00:00Z', '2026-03-06T08:00:00Z', 'fix: login crash'),
  ];
  return { root, prs };
}

/** One entry of `gh pr list --state merged`. */
function pr(number, branch, oid, mergedAt, firstCommit, title) {
  return {
    number, title, headRefName: branch, mergedAt, mergeCommit: { oid },
    commits: [{ oid: `c${number}`, committedDate: firstCommit, authoredDate: firstCommit }, { oid: `d${number}`, committedDate: mergedAt, authoredDate: mergedAt }],
    files: [],
  };
}

/** A fake exec: `gh pr list` prints `prs`, git runs for real. Calls are recorded. */
function fakeExec(prs, calls = []) {
  return (cmd, opts) => {
    calls.push(cmd);
    if (cmd[0] === 'gh') {
      if (cmd[1] === 'pr' && cmd[2] === 'list') return { code: 0, stdout: JSON.stringify(prs), stderr: '' };
      return { code: 1, stdout: '', stderr: `unexpected gh call: ${cmd.join(' ')}` };
    }
    return defaultExec(cmd, opts);
  };
}

const NOW = () => new Date('2026-04-01T10:00:00Z');

// ---------------------------------------------------------------------------------------------------------
// Cost records
// ---------------------------------------------------------------------------------------------------------

test('recordCost appends one JSON line to .recade/cost.jsonl and creates the folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-cost-rec-'));
  const a = recordCost(root, { slice: 'S-03', minutes: 42, fixLoops: 1 }, { now: NOW });
  recordCost(root, { slice: 'S-03a', minutes: 5, fixLoops: 0, tokens: 12000 }, { now: NOW });
  assert.deepEqual(a, { slice: 'S-03', minutes: 42, fix_loops: 1, at: '2026-04-01T10:00:00.000Z' });
  const lines = readFileSync(join(root, '.recade', 'cost.jsonl'), 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), a);
  assert.equal(JSON.parse(lines[1]).tokens, 12000);
  assert.equal(JSON.parse(lines[1]).slice, 'S-03a');
});

test('recordCost refuses a bad slice id, negative or fractional numbers, and writes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-cost-bad-'));
  for (const bad of [
    { slice: 's-03', minutes: 1, fixLoops: 0 }, { slice: 'S-3', minutes: 1, fixLoops: 0 }, { slice: 'S-03; rm', minutes: 1, fixLoops: 0 },
    { slice: 'S-03', minutes: -1, fixLoops: 0 }, { slice: 'S-03', minutes: 1.5, fixLoops: 0 }, { slice: 'S-03', minutes: 1, fixLoops: -2 },
    { slice: 'S-03', minutes: Number.NaN, fixLoops: 0 }, { slice: 'S-03', minutes: 1, fixLoops: 0, tokens: -5 }, { slice: 'S-03', minutes: 1 },
  ]) assert.throws(() => recordCost(root, bad), /slice|minutes|FIX loops|tokens/i, JSON.stringify(bad));
  assert.equal(existsSync(join(root, '.recade', 'cost.jsonl')), false);
});

test('readCost keeps the last record of a slice (the ledger is cumulative), the last tokens given, and counts bad lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-cost-read-'));
  assert.deepEqual(readCost(root), { bySlice: new Map(), skipped: 0 });
  recordCost(root, { slice: 'S-01', minutes: 10, fixLoops: 0, tokens: 500 }, { now: NOW });
  recordCost(root, { slice: 'S-01', minutes: 30, fixLoops: 2 }, { now: NOW });
  recordCost(root, { slice: 'S-02', minutes: 7, fixLoops: 0 }, { now: NOW });
  writeFileSync(join(root, '.recade', 'cost.jsonl'), `${readFileSync(join(root, '.recade', 'cost.jsonl'), 'utf8')}not json\n{"slice":"x"}\n\n`);
  const { bySlice, skipped } = readCost(root);
  assert.equal(skipped, 2);
  assert.deepEqual(bySlice.get('S-01'), { slice: 'S-01', minutes: 30, fixLoops: 2, tokens: 500, usage: null, tokenRecords: 1, records: 2, lastAt: '2026-04-01T10:00:00.000Z' });
  assert.deepEqual(bySlice.get('S-02'), { slice: 'S-02', minutes: 7, fixLoops: 0, tokens: null, usage: null, tokenRecords: 0, records: 1, lastAt: '2026-04-01T10:00:00.000Z' });
});

// ---------------------------------------------------------------------------------------------------------
// DORA metrics on a synthetic history
// ---------------------------------------------------------------------------------------------------------

test('DORA: lead time, deployment frequency, change failure rate and time to restore from git and gh, for the increment only', () => {
  const { root, prs } = history();
  const m = doraMetrics(root, 'INC-1', { exec: fakeExec(prs) });
  assert.equal(m.merges.length, 2, 'S-03 belongs to INC-2');
  assert.deepEqual(m.merges.map((x) => x.slice), ['S-01', 'S-02']);
  assert.equal(m.leadTimeHours, 36, 'median of 24 h and 48 h');
  assert.equal(m.windowDays, 7, 'the window is at least one week');
  assert.equal(m.deploysPerWeek, 2);
  assert.equal(m.failed.length, 1);
  assert.equal(m.failed[0].slice, 'S-01');
  assert.equal(m.failed[0].by, 'fix: login crash');
  assert.equal(m.changeFailureRate, 0.5);
  assert.equal(m.restoreHours, 72);
});

test('DORA: a revert of the same files inside 7 days is a failure, a revert after 7 days or a fix on other files is not', () => {
  const root = makeProject({ 'S-01': 'INC-1', 'S-02': 'INC-1', 'S-04': 'INC-1' });
  const s1 = commit(root, '2026-03-03T09:00:00Z', 'feat(S-01): a (#1)', { 'src/a.js': '1\n' });
  const s2 = commit(root, '2026-03-04T09:00:00Z', 'feat(S-02): b (#2)', { 'src/b.js': '1\n' });
  const s4 = commit(root, '2026-03-05T09:00:00Z', 'feat(S-04): c (#3)', { 'src/c.js': '1\n' });
  commit(root, '2026-03-05T12:00:00Z', 'Revert "feat(S-01): a (#1)"', { 'src/a.js': '0\n' }); // 2 days and 3 h after S-01
  commit(root, '2026-03-06T09:00:00Z', 'fix: unrelated (#9)', { 'src/other.js': '1\n' }); // other files
  commit(root, '2026-03-13T09:00:00Z', 'fix(b): late (#10)', { 'src/b.js': '2\n' }); // 9 days after S-02
  commit(root, '2026-03-06T09:00:00Z', 'feat: more c (#11)', { 'src/c.js': '2\n' }); // not a fix
  const prs = [
    pr(1, 'slice/s-01-a', s1, '2026-03-03T09:00:00Z', '2026-03-03T08:00:00Z', 'feat(S-01): a'),
    pr(2, 'slice/s-02-b', s2, '2026-03-04T09:00:00Z', '2026-03-04T08:00:00Z', 'feat(S-02): b'),
    pr(3, 'slice/s-04-c', s4, '2026-03-05T09:00:00Z', '2026-03-05T08:00:00Z', 'feat(S-04): c'),
  ];
  const m = doraMetrics(root, 'INC-1', { exec: fakeExec(prs) });
  assert.deepEqual(m.failed.map((f) => f.slice), ['S-01']);
  assert.equal(m.changeFailureRate, 1 / 3);
  assert.equal(m.restoreHours, 51);
});

test('DORA: a fix that only touches the shared status and index files is not tied to a merge', () => {
  const root = makeProject({ 'S-01': 'INC-1' });
  const s1 = commit(root, '2026-03-03T09:00:00Z', 'feat(S-01): a (#1)', { 'src/a.js': '1\n', 'slices/STATUS.md': 's1\n', 'INDEX.md': 'i1\n' });
  commit(root, '2026-03-04T09:00:00Z', 'fix: status typo (#2)', { 'slices/STATUS.md': 's2\n', 'INDEX.md': 'i2\n' });
  const prs = [pr(1, 'slice/s-01-a', s1, '2026-03-03T09:00:00Z', '2026-03-02T09:00:00Z', 'feat(S-01): a')];
  assert.equal(doraMetrics(root, 'INC-1', { exec: fakeExec(prs) }).failed.length, 0);
  commit(root, '2026-03-05T09:00:00Z', 'fix: a crash (#3)', { 'src/a.js': '2\n', 'slices/STATUS.md': 's3\n' });
  assert.equal(doraMetrics(root, 'INC-1', { exec: fakeExec(prs) }).failed.length, 1, 'a fix on real code still counts');
});

test('DORA: a merge commit takes the title of its pull request, so a fix merged with a merge commit is seen', () => {
  const root = makeProject({ 'S-01': 'INC-1' });
  const s1 = commit(root, '2026-03-03T09:00:00Z', 'feat(S-01): a (#1)', { 'src/a.js': '1\n' });
  git(root, '2026-03-04T09:00:00Z', 'checkout', '-q', '-b', 'topic');
  commit(root, '2026-03-04T08:00:00Z', 'wip', { 'src/a.js': '2\n' });
  git(root, '2026-03-04T09:00:00Z', 'checkout', '-q', 'main');
  git(root, '2026-03-04T09:00:00Z', 'merge', '--no-ff', '-q', '-m', 'Merge pull request #7 from team/topic', 'topic');
  const merge = git(root, '2026-03-04T09:00:00Z', 'rev-parse', 'HEAD');
  const prs = [
    pr(1, 'slice/s-01-a', s1, '2026-03-03T09:00:00Z', '2026-03-02T09:00:00Z', 'feat(S-01): a'),
    pr(7, 'topic', merge, '2026-03-04T09:00:00Z', '2026-03-04T08:00:00Z', 'fix: a crash'),
  ];
  const m = doraMetrics(root, 'INC-1', { exec: fakeExec(prs) });
  assert.equal(m.failed.length, 1);
  assert.equal(m.failed[0].by, 'fix: a crash');
  assert.equal(m.restoreHours, 24);
});

test('DORA: a long increment gives deployments per week over its real window, and no merge gives no number', () => {
  const root = makeProject({ 'S-01': 'INC-1', 'S-02': 'INC-1', 'S-03': 'INC-1', 'S-04': 'INC-1' });
  const oids = ['2026-03-02', '2026-03-10', '2026-03-17', '2026-03-23'].map((d, i) => commit(root, `${d}T09:00:00Z`, `feat(S-0${i + 1}): x (#${i + 1})`, { [`src/f${i}.js`]: '1\n' }));
  const prs = oids.map((oid, i) => pr(i + 1, `slice/s-0${i + 1}-x`, oid, ['2026-03-02', '2026-03-10', '2026-03-17', '2026-03-23'][i] + 'T09:00:00Z', '2026-03-01T09:00:00Z', `feat(S-0${i + 1}): x`));
  const m = doraMetrics(root, 'INC-1', { exec: fakeExec(prs) });
  assert.equal(m.windowDays, 22, '03-01 09:00 to 03-23 09:00');
  assert.equal(m.deploysPerWeek, Number((4 / (22 / 7)).toFixed(2)));
  const none = doraMetrics(root, 'INC-1', { exec: fakeExec([]) });
  assert.equal(none.merges.length, 0);
  assert.equal(none.deploysPerWeek, null);
  assert.equal(none.leadTimeHours, null);
  assert.equal(none.changeFailureRate, null);
  assert.equal(none.restoreHours, null);
});

test('DORA: gh and git failures are reported, and only gh pr list is run', () => {
  const { root, prs } = history();
  assert.throws(() => doraMetrics(root, 'INC-1', { exec: () => ({ code: 1, stdout: '', stderr: 'gh: not logged in\n' }) }), /gh pr list failed: gh: not logged in/);
  assert.throws(() => doraMetrics(root, 'INC-1', { exec: () => ({ code: 0, stdout: 'nope', stderr: '' }) }), /did not print JSON/);
  assert.throws(() => doraMetrics(root, 'INC-1', { exec: fakeExec(prs), base: 'nope' }), /branch nope/);
  assert.throws(() => doraMetrics(root, 'INC-1', { exec: fakeExec(prs), base: '--bad' }), /Invalid base branch/);
  const calls = [];
  doraMetrics(root, 'INC-1', { exec: fakeExec(prs, calls) });
  const gh = calls.filter((c) => c[0] === 'gh');
  assert.equal(gh.length, 1);
  assert.deepEqual(gh[0].slice(0, 5), ['gh', 'pr', 'list', '--state', 'merged']);
  assert.ok(calls.filter((c) => c[0] === 'git').every((c) => ['log', 'rev-parse'].includes(c[1] === '-c' ? c[3] : c[1])), 'git is only read');
});

// ---------------------------------------------------------------------------------------------------------
// retro
// ---------------------------------------------------------------------------------------------------------

test('retro writes retros/INC-1.md from the template with the delivered slices, DORA, cost and the open provisionals', () => {
  const { root, prs } = history();
  mkdirSync(join(root, 'intake'));
  openProvisional(root, { what: 'Working name', why: 'Not chosen yet', assumption: 'Use the project name', owner: 'Client', due: '2026-04-10' });
  recordCost(root, { slice: 'S-01', minutes: 90, fixLoops: 1, tokens: 120000 }, { now: NOW });
  recordCost(root, { slice: 'S-03', minutes: 999, fixLoops: 9 }, { now: NOW });
  const result = retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW });
  assert.equal(result.file, join(root, 'retros', 'INC-1.md'));
  const text = readFileSync(result.file, 'utf8');
  assert.match(text, /^---\ndoc_id: "INC-1"\n/);
  assert.match(text, /^date: "2026-04-01"$/m);
  assert.match(text, /^language: "en"$/m);
  assert.equal(text.includes('{{'), false);
  assert.equal(text.includes(EM), false);
  assert.deepEqual(lintText(text, 'retros/INC-1.md').filter((f) => f.severity === 'error'), []);
  for (const heading of ['Demo', 'Delivered', 'Decisions', 'Carry-over', 'Provisionals still open', 'Quarantined tests', 'DORA metrics', 'Cost per slice', 'Recalibrated dates', 'Spec back-ports done', 'How to open the next increment']) {
    assert.match(text, new RegExp(`^## ${heading}$`, 'm'), heading);
  }
  assert.match(text, /\| S-01 \| feat\(S-01\): login \| 2026-03-03 \|/);
  assert.match(text, /\| S-02 \| feat\(S-02\): export \| 2026-03-05 \|/);
  assert.equal(/S-03/.test(text), false, 'a slice of another increment never shows');
  assert.match(text, /\| Deployment frequency \| 2 merges, 2 per week \|/);
  assert.match(text, /\| Lead time for changes \| 36 h \(median of 2\) \|/);
  assert.match(text, /\| Change failure rate \| 50% \(1 of 2 merges\) \|/);
  assert.match(text, /\| Time to restore service \| 3 days \(median of 1\) \|/);
  assert.match(text, /\| Slice \| Elapsed time \| FIX loops \| Tokens \|/);
  assert.match(text, /Elapsed time is the wall clock/);
  assert.match(text, /\| S-01 \| 1 h 30 min \| 1 \| 120000 \|/);
  assert.match(text, /\| S-02 \| not recorded \| not recorded \| not recorded \|/);
  assert.match(text, /\| PRV-01: Working name \| Client \| 2026-04-10 \|/);
});

test('an increment cannot close with a quarantined test: retro refuses, names the tests and writes nothing, even with force', () => {
  const { root, prs } = history();
  addQuarantine(root, { test: 'login redirect keeps the session', reason: 'timing on the shared runner', slice: 'S-01' }, { now: NOW });
  addQuarantine(root, { test: 'export keeps the row order', reason: 'order depends on the clock', slice: 'S-02' }, { now: NOW });
  for (const force of [false, true]) {
    assert.throws(() => retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW, force }), (err) => {
      assert.equal(err.name, 'RetroInputError');
      assert.match(err.message, /INC-1 cannot close with 2 quarantined tests/);
      assert.match(err.message, /login redirect keeps the session \(S-01\)/);
      assert.match(err.message, /export keeps the row order \(S-02\)/);
      assert.match(err.message, /recade quarantine remove/);
      return true;
    });
  }
  assert.equal(existsSync(join(root, 'retros')), false);
  removeQuarantine(root, 'login redirect keeps the session');
  assert.throws(() => retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }), /cannot close with 1 quarantined test:/);
  removeQuarantine(root, 'export keeps the row order');
  assert.equal(existsSync(retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }).file), true);
});

test('retro lists the quarantined tests, and one of a later increment is listed without stopping the close', () => {
  const { root, prs } = history();
  const clean = readFileSync(retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }).file, 'utf8');
  assert.match(clean, /^## Quarantined tests\n\nNo test is quarantined\.$/m);
  const other = history();
  addQuarantine(other.root, { test: 'rates | rounding', reason: 'float noise', slice: 'S-03', since: '2026-03-02' }, { now: NOW });
  const text = readFileSync(retro(other.root, 'INC-1', { exec: fakeExec(other.prs), now: NOW }).file, 'utf8');
  assert.match(text, /^## Quarantined tests$/m);
  assert.match(text, /\| Test \| Slice \| Since \| Reason \|/);
  assert.match(text, /\| rates \\\| rounding \| S-03 \| 2026-03-02 \| float noise \|/);
  assert.match(text, /fixed before the increment of its slice closes/);
  assert.deepEqual(lintText(text, 'retros/INC-1.md').filter((f) => f.severity === 'error'), []);
});

test('retro shows the tokens of each slice and, per slice, the tokens by agent model', () => {
  const { root, prs } = history();
  const usage = [
    { agent: 'main', model: 'model-a', input: 10, output: 200, cacheCreation: 3000, cacheRead: 40000 },
    { agent: 'a1', type: 'implementer', model: 'model-b', input: 5, output: 60, cacheCreation: 0, cacheRead: 700 },
    { agent: 'a2', type: 'reviewer', model: 'model-b', input: 1, output: 2, cacheCreation: 3, cacheRead: 4 },
  ];
  recordCost(root, { slice: 'S-01', minutes: 90, fixLoops: 1, tokens: 43975, usage }, { now: NOW });
  const text = readFileSync(retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }).file, 'utf8');
  assert.match(text, /\| S-01 \| 1 h 30 min \| 1 \| 43975 \|/);
  assert.match(text, /\| Slice \| Model \| Input \| Output \| Cache write \| Cache read \|/);
  assert.match(text, /\| S-01 \| model-a \| 10 \| 200 \| 3000 \| 40000 \|/);
  assert.match(text, /\| S-01 \| model-b \| 6 \| 62 \| 3 \| 704 \|/);
  assert.equal(text.includes('model-a \| 10 \| 200 \| 3000 \| 40000 \|\n| S-02'), false);
  assert.equal(text.includes(EM), false);
  assert.deepEqual(lintText(text, 'retros/INC-1.md').filter((f) => f.severity === 'error'), []);
});

test('retro says tokens are not recorded for a slice without them, and shows no per model table when no slice has rows', () => {
  const { root, prs } = history();
  recordCost(root, { slice: 'S-01', minutes: 90, fixLoops: 1, tokens: 500 }, { now: NOW });
  const text = readFileSync(retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }).file, 'utf8');
  assert.match(text, /\| S-01 \| 1 h 30 min \| 1 \| 500 \|/);
  assert.match(text, /\| S-02 \| not recorded \| not recorded \| not recorded \|/);
  assert.equal(text.includes('| Model |'), false);
  assert.match(text, /Tokens are input, output, cache write and cache read added up, from the session transcripts/);
});

test('retro says a slice total is partial when some of its records have no tokens', () => {
  const { root, prs } = history();
  recordCost(root, { slice: 'S-01', minutes: 30, fixLoops: 0, tokens: 500 }, { now: NOW });
  recordCost(root, { slice: 'S-01', minutes: 90, fixLoops: 1 }, { now: NOW });
  const text = readFileSync(retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }).file, 'utf8');
  assert.match(text, /\| S-01 \| 1 h 30 min \| 1 \| 500 \(partial: 1 of 2 records\) \|/);
});

test('retro compares with the DORA table of the previous increment when its retro exists', () => {
  const { root, prs } = history();
  mkdirSync(join(root, 'retros'));
  writeFileSync(join(root, 'retros', 'INC-0.md'), '## DORA metrics\n\n| Metric | Value | Compared with last increment |\n|---|---|---|\n| Deployment frequency | 1 merge, 1 per week | none |\n| Lead time for changes | 2 days (median of 3) | none |\n');
  writeFileSync(join(root, 'slices', 'S-00-x.md'), sheet('S-00', 'INC-0'));
  const text = readFileSync(retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }).file, 'utf8');
  assert.match(text, /\| Deployment frequency \| 2 merges, 2 per week \| was 1 merge, 1 per week \|/);
  assert.match(text, /\| Lead time for changes \| 36 h \(median of 2\) \| was 2 days \(median of 3\) \|/);
  assert.match(text, /\| Change failure rate \| 50% \(1 of 2 merges\) \| no earlier retro figure \|/);
});

test('retro lists the slices of the increment that were not merged as carry-over, and says so when nothing was recorded', () => {
  const root = makeProject({ 'S-01': 'INC-1', 'S-02': 'INC-1' });
  const s1 = commit(root, '2026-03-03T09:00:00Z', 'feat(S-01): a (#1)', { 'src/a.js': '1\n' });
  const prs = [pr(1, 'slice/s-01-a', s1, '2026-03-03T09:00:00Z', '2026-03-02T09:00:00Z', 'feat(S-01): a')];
  const text = readFileSync(retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }).file, 'utf8');
  assert.match(text, /\| S-02: Slice S-02 \| Not merged when this retro was written \| To decide \|/);
  assert.match(text, /No provisional is open\./);
  assert.match(text, /\| S-01 \| not recorded \| not recorded \| not recorded \|/);
});

test('retro refuses an unknown increment, a bad id, an existing file without force, and writes nothing', () => {
  const { root, prs } = history();
  assert.throws(() => retro(root, 'INC-9', { exec: fakeExec(prs), now: NOW }), /No slice belongs to INC-9/);
  assert.throws(() => retro(root, 'inc-1', { exec: fakeExec(prs), now: NOW }), /Invalid increment/);
  assert.throws(() => retro(root, '../x', { exec: fakeExec(prs), now: NOW }), /Invalid increment/);
  assert.equal(existsSync(join(root, 'retros')), false);
  const first = retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW });
  writeFileSync(first.file, 'owner edits\n');
  assert.throws(() => retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }), /already exists/);
  assert.equal(readFileSync(first.file, 'utf8'), 'owner edits\n');
  retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW, force: true });
  assert.match(readFileSync(first.file, 'utf8'), /^---\ndoc_id: "INC-1"/);
});

// ---------------------------------------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------------------------------------

async function cli(args, { cwd, exec = defaultExec }) {
  const out = [];
  const err = [];
  const code = await run(args, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {}, run: exec });
  return { code, out: out.join(''), err: err.join('') };
}

test('recade cost record writes a record, from a worktree too with --project, and reports usage errors with exit 2', async () => {
  const { root } = history();
  const ok = await cli(['cost', 'record', 'S-01', '--minutes', '42', '--fix-loops', '1', '--tokens', '900'], { cwd: root });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Recorded S-01: 42 min, 1 FIX loop, 900 tokens\./);
  const elsewhere = mkdtempSync(join(tmpdir(), 'recade-cost-wt-'));
  const viaProject = await cli(['cost', 'record', 'S-02', '--minutes', '5', '--fix-loops', '0', '--project', root], { cwd: elsewhere });
  assert.equal(viaProject.code, 0, viaProject.err);
  const lines = readFileSync(join(root, '.recade', 'cost.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.slice), ['S-01', 'S-02']);
  assert.equal(existsSync(join(elsewhere, '.recade')), false);
  for (const args of [
    ['cost'], ['cost', 'record'], ['cost', 'record', 'S-01'], ['cost', 'record', 'S-01', '--minutes', 'x', '--fix-loops', '0'],
    ['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '-1'], ['cost', 'record', 'S-1', '--minutes', '1', '--fix-loops', '0'],
    ['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '0', '--bogus'], ['cost', 'show'],
  ]) {
    const r = await cli(args, { cwd: root });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /Usage: recade cost record/, args.join(' '));
  }
  const none = await cli(['cost', 'record', 'S-01', '--minutes', '1', '--fix-loops', '0'], { cwd: elsewhere });
  assert.equal(none.code, 1);
  assert.match(none.err, /No Recade project here/);
});

test('recade retro exits 1 and names the quarantined tests when the increment cannot close', async () => {
  const { root, prs } = history();
  addQuarantine(root, { test: 'login redirect keeps the session', reason: 'timing', slice: 'S-01' }, { now: NOW });
  const r = await cli(['retro', 'INC-1'], { cwd: root, exec: fakeExec(prs) });
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot close with 1 quarantined test/);
  assert.match(r.err, /login redirect keeps the session/);
  assert.equal(existsSync(join(root, 'retros')), false);
});

test('recade retro writes the file, prints a summary, exits 1 on an existing file and 2 on a gh failure or bad usage', async () => {
  const { root, prs } = history();
  const exec = fakeExec(prs);
  const first = await cli(['retro', 'INC-1'], { cwd: root, exec });
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /Wrote retros\/INC-1\.md/);
  assert.match(first.out, /Deployment frequency: 2 merges, 2 per week/);
  assert.equal(first.out.includes(EM), false);
  const again = await cli(['retro', 'INC-1'], { cwd: root, exec });
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists.*--force/);
  assert.equal((await cli(['retro', 'INC-1', '--force'], { cwd: root, exec })).code, 0);
  const json = await cli(['retro', 'INC-1', '--force', '--json'], { cwd: root, exec });
  assert.equal(JSON.parse(json.out).metrics.changeFailureRate, 0.5);
  const fail = await cli(['retro', 'INC-1', '--force'], { cwd: root, exec: () => ({ code: 1, stdout: '', stderr: 'boom\n' }) });
  assert.equal(fail.code, 2);
  assert.match(fail.err, /gh pr list failed: boom/);
  for (const args of [['retro'], ['retro', 'one'], ['retro', 'INC-1', 'INC-2'], ['retro', 'INC-1', '--nope']]) {
    const r = await cli(args, { cwd: root, exec });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /Usage: recade retro/);
  }
  const unknown = await cli(['retro', 'INC-9'], { cwd: root, exec });
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /No slice belongs to INC-9/);
});

test('recade help lists the cost command, so /slice can detect it', async () => {
  const out = [];
  await run(['help'], { stdout: { write: (s) => out.push(s) }, stderr: { write: () => {} }, cwd: repoDir, env: {} });
  assert.match(out.join(''), /^recade cost /m);
  assert.ok(COMMAND_MAP.some((c) => c.phase === 'harness' && c.command === 'retro'));
});

// ---------------------------------------------------------------------------------------------------------
// The harness files
// ---------------------------------------------------------------------------------------------------------

test('/slice records the cost into the main checkout at the end and before it stops on a block', () => {
  const slice = read('harness/commands/slice.md');
  assert.match(slice, /recade cost record '<S-nn>' --minutes <minutes> --fix-loops <FIX loops> --project '<home>'/);
  assert.match(slice, /Started:/);
  assert.match(slice, /Before you stop, record the cost as in Step 13 point 1\./);
});

test('/retro runs the CLI, never writes the file by hand, and keeps the human sections for the owner', () => {
  const src = read('harness/commands/retro.md');
  assert.match(src, /^description: .{40,}/m);
  assert.match(src, /recade retro '<INC-n>' --project '<home>'/);
  assert.match(src, /gh/);
  assert.equal(src.includes(EM), false);
  assert.match(src, /Demo/);
  assert.match(src, /never merge|never merges|You never merge/i);
});

// ---------------------------------------------------------------------------------------------------------
// Across code repositories (spec 6.13): gh and git run in repos/<name>/, one report per repository and a total
// ---------------------------------------------------------------------------------------------------------

/**
 * A workspace (state `kind: workspace`, registry api and web) with two real code repositories:
 *  api: S-01 merged 03-03 (first commit 03-02: lead 24 h), then `fix: login crash` 03-06 on the same file: failed, restored 72 h later
 *  web: S-02 merged 03-05 (first commit 03-03: lead 48 h), no fix
 */
function wsHistory() {
  const ws = mkdtempSync(join(tmpdir(), 'Projets Clients '));
  mkdirSync(join(ws, 'recade'));
  mkdirSync(join(ws, 'slices'));
  writeFileSync(join(ws, 'recade', 'state.yaml'), stringify({
    version: 1, kind: 'workspace', languages: { work: 'en' }, repos: ['api', 'web'].map((name) => ({ name, remote: 'none', default_branch: 'main' })),
  }));
  const wsSheet = (id, repo) => `---\n${stringify({
    doc_id: id, title: `Slice ${id}`, repos: [repo], branch: `slice/${id.toLowerCase()}-x`, format: 'small', lane: 'standard',
    implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [], external_prerequisite: 'none',
    provisionals_used: [], size: 'M', touches: [`${repo}:src/**`],
  })}---\n\n# ${id}: Slice ${id}\n`;
  writeFileSync(join(ws, 'slices', 'S-01-x.md'), wsSheet('S-01', 'api'));
  writeFileSync(join(ws, 'slices', 'S-02-x.md'), wsSheet('S-02', 'web'));
  const dirs = {};
  for (const name of ['api', 'web']) {
    dirs[name] = join(ws, 'repos', name);
    mkdirSync(dirs[name], { recursive: true });
    git(dirs[name], '2026-03-01T09:00:00Z', 'init', '-q', '-b', 'main');
    commit(dirs[name], '2026-03-01T09:00:00Z', 'chore: start', { 'README.txt': 'start\n' });
  }
  const s1 = commit(dirs.api, '2026-03-03T09:00:00Z', 'feat(S-01): login (#1)', { 'src/login.js': 'v1\n' });
  commit(dirs.api, '2026-03-06T09:00:00Z', 'fix: login crash (#4)', { 'src/login.js': 'v2\n' });
  const s2 = commit(dirs.web, '2026-03-05T09:00:00Z', 'feat(S-02): export (#2)', { 'src/export.js': 'v1\n' });
  const prs = {
    api: [pr(1, 'slice/s-01-login', s1, '2026-03-03T09:00:00Z', '2026-03-02T09:00:00Z', 'feat(S-01): login')],
    web: [pr(2, 'slice/s-02-export', s2, '2026-03-05T09:00:00Z', '2026-03-03T09:00:00Z', 'feat(S-02): export')],
  };
  return { ws, dirs, prs };
}

/** gh answers from the folder it runs in (`prs[basename(cwd)]`); git is real. Every call is recorded with its folder. */
function wsExec(prs, calls = []) {
  return (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd });
    if (cmd[0] === 'gh') return { code: 0, stdout: JSON.stringify(prs[opts.cwd.split('/').pop()] ?? []), stderr: '' };
    return defaultExec(cmd, opts);
  };
}

test('DORA (workspace): gh and git run in each repos/<name>/, the figures are reported per repository and in total', () => {
  const { ws, dirs, prs } = wsHistory();
  const calls = [];
  const m = doraMetrics(ws, 'INC-1', { exec: wsExec(prs, calls) });
  assert.deepEqual(m.repos.map((r) => r.repo), ['api', 'web']);
  assert.deepEqual(m.repos.map((r) => r.merges.map((x) => x.slice)), [['S-01'], ['S-02']]);
  assert.deepEqual(m.repos.map((r) => r.changeFailureRate), [1, 0]);
  assert.equal(m.repos[0].restoreHours, 72);
  assert.equal(m.repos[0].leadTimeHours, 24);
  assert.equal(m.repos[1].leadTimeHours, 48);
  // the total
  assert.deepEqual(m.merges.map((x) => [x.repo, x.slice]), [['api', 'S-01'], ['web', 'S-02']]);
  assert.equal(m.leadTimeHours, 36);
  assert.equal(m.changeFailureRate, 0.5);
  assert.equal(m.failed.length, 1);
  assert.equal(m.failed[0].repo, 'api');
  assert.equal(m.deploysPerWeek, 2);
  // where the commands ran
  assert.deepEqual([...new Set(calls.filter((c) => c.cmd[0] === 'gh').map((c) => c.cwd))].sort(), [dirs.api, dirs.web]);
  assert.equal(calls.every((c) => c.cwd === dirs.api || c.cwd === dirs.web), true, 'nothing runs in the workspace folder itself');
  assert.equal(calls.filter((c) => c.cmd[0] === 'git').length > 0, true);
});

test('DORA (workspace): a fix in one repository is not linked to a merge of another', () => {
  const { ws, dirs, prs } = wsHistory();
  commit(dirs.web, '2026-03-06T10:00:00Z', 'fix: login crash (#9)', { 'src/login.js': 'x\n' }); // same name as the api file, other repository
  const m = doraMetrics(ws, 'INC-1', { exec: wsExec(prs) });
  assert.equal(m.repos[1].changeFailureRate, 0);
});

test('DORA (workspace): the base of each repository is its default branch, --base overrides it for all', () => {
  const { ws, prs } = wsHistory();
  const file = join(ws, 'recade', 'state.yaml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/(name: web[\s\S]*?default_branch: )main/, '$1trunk'));
  const calls = [];
  assert.throws(() => doraMetrics(ws, 'INC-1', { exec: wsExec(prs, calls) }), /web: .*branch trunk/);
  assert.deepEqual(calls.filter((c) => c.cmd[0] === 'gh').map((c) => c.cmd[c.cmd.indexOf('--base') + 1]), ['main', 'trunk']);
  const forced = doraMetrics(ws, 'INC-1', { exec: wsExec(prs), base: 'main' });
  assert.equal(forced.base, 'main');
});

test('DORA (workspace): a repository folder with no .git of its own, or a failing gh, is an error that names the repository', () => {
  const { ws, dirs, prs } = wsHistory();
  rmSync(join(dirs.web, '.git'), { recursive: true, force: true });
  assert.throws(() => doraMetrics(ws, 'INC-1', { exec: wsExec(prs) }), /web: repos\/web is not a git repository\. Run: recade repo sync/);
  const again = wsHistory();
  const exec = (cmd, opts) => (cmd[0] === 'gh' && opts.cwd.endsWith('web') ? { code: 1, stdout: '', stderr: 'rate limited' } : wsExec(again.prs)(cmd, opts));
  assert.throws(() => doraMetrics(again.ws, 'INC-1', { exec }), /web: gh pr list failed: rate limited/);
});

test('retro (workspace): the DORA section gives the total and one row per repository', () => {
  const { ws, prs } = wsHistory();
  const result = retro(ws, 'INC-1', { exec: wsExec(prs), now: NOW });
  assert.equal(result.values['Deployment frequency'], '2 merges, 2 per week');
  assert.equal(result.values['Change failure rate'], '50% (1 of 2 merges)');
  const text = readFileSync(result.file, 'utf8');
  assert.match(text, /\| Repository \| Merges \| Lead time \| Change failure rate \| Time to restore \|/);
  assert.match(text, /\| api \| 1 \| 24 h \| 100% \(1 of 1 merge\) \| 3 days \|/);
  assert.match(text, /\| web \| 1 \| 2 days \| 0% \(0 of 1 merge\) \| no failure to restore \|/);
  assert.match(text, /Computed from the pull requests merged into the default branch of each repository/);
  assert.equal(text.includes(EM), false);
});

test('recade retro (workspace) runs across the repositories, and --json carries the per-repository figures', async () => {
  const { ws, prs } = wsHistory();
  const out = [];
  const err = [];
  const code = await run(['retro', 'INC-1', '--json'], { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd: ws, env: {}, run: wsExec(prs) });
  assert.equal(code, 0, err.join(''));
  const json = JSON.parse(out.join(''));
  assert.deepEqual(json.metrics.repos.map((r) => r.repo), ['api', 'web']);
  assert.equal(json.metrics.merges.length, 2);
});

test('retro (legacy, no registry) is unchanged: no repos in the metrics and no repository table', () => {
  const { root, prs } = history();
  const result = retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW });
  assert.equal(result.metrics.repos, undefined);
  assert.equal(readFileSync(result.file, 'utf8').includes('| Repository |'), false);
});

test('retro says how long the first slice took, from the dates of the state', () => {
  const { root, prs } = history();
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', languages: { work: 'en' }, started: '2026-02-20', first_slice_done: '2026-03-03' }));
  const text = retro(root, 'INC-1', { exec: fakeExec(prs), now: NOW }).text;
  assert.match(text, /^Started on 2026-02-20\. First slice delivered on 2026-03-03, 11 days later\.$/m);
  const old = history();
  assert.doesNotMatch(retro(old.root, 'INC-1', { exec: fakeExec(old.prs), now: NOW }).text, /First slice delivered|since the start/);
});
