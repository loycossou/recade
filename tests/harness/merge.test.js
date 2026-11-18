import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { checkSlices, renderStatus } from '../../src/project/slices.js';
import { mergeOrder } from '../../src/harness/merge.js';
import { lintText } from '../../src/style/lint.js';
import { run } from '../../src/cli.js';

const repoDir = fileURLToPath(new URL('../..', import.meta.url));
const read = (path) => readFileSync(join(repoDir, path), 'utf8');

// ---------------------------------------------------------------------------------------------------------
// A fictional project and a fake gh
// ---------------------------------------------------------------------------------------------------------

function sheet(id, front = {}) {
  const meta = {
    doc_id: id, title: `Slice ${id}`, repos: ['app'], branch: `slice/${id.toLowerCase()}`, format: 'small', lane: 'standard',
    implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [], external_prerequisite: 'none',
    provisionals_used: [], size: 'M', touches: [`src/${id.toLowerCase()}/**`], ...front,
  };
  return `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n`;
}

/** `slices` maps a file name to header keys; `statuses` maps an id to its status. */
function project({ slices, statuses = {}, hotspots = [] }) {
  const root = mkdtempSync(join(tmpdir(), 'recade-merge-'));
  mkdirSync(join(root, 'recade'));
  mkdirSync(join(root, 'slices'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', hotspots }));
  for (const [name, front] of Object.entries(slices)) writeFileSync(join(root, 'slices', name), sheet(name.slice(0, 4), front));
  const rows = checkSlices(root).status;
  for (const r of rows) r.status = statuses[r.id] ?? 'todo';
  writeFileSync(join(root, 'slices', 'STATUS.md'), renderStatus(rows));
  return root;
}

/** One PR of the fake `gh pr list`. */
const pr = (number, branch, files, extra = {}) => ({
  number, title: `PR ${number}`, headRefName: branch, isDraft: false, isCrossRepository: false,
  additions: files.length * 10, deletions: 0, files: files.map((path) => ({ path, additions: 10, deletions: 0 })), ...extra,
});

/** A fake exec: `gh pr list` prints the PRs, everything else fails loudly. The calls are recorded. */
function fakeGh(prs, calls = [], merged = []) {
  return (cmd) => {
    calls.push(cmd);
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
      const wanted = cmd[cmd.indexOf('--state') + 1];
      return { code: 0, stdout: JSON.stringify(wanted === 'merged' ? merged : prs), stderr: '' };
    }
    return { code: 127, stdout: '', stderr: `unexpected command: ${cmd.join(' ')}` };
  };
}

const numbers = (order) => order.map((o) => o.pr);

const SET = [
  pr(11, 'slice/S-01-base', ['src/a.js']),
  pr(12, 'slice/S-02-api', ['src/b.js']),
  pr(13, 'slice/S-03-menu', ['src/routes.js', 'src/c.js']),
  pr(14, 'slice/S-04-tabs', ['src/routes.js']),
  pr(15, 'slice/S-05-report', ['src/x1.js', 'src/x2.js', 'src/x3.js', 'src/x4.js', 'src/x5.js']),
  pr(16, 'slice/S-06-late', ['src/late.js']),
  pr(17, 'slice/S-07-wip', ['src/wip.js'], { isDraft: true }),
];

function setProject() {
  return project({
    slices: {
      'S-01-base.md': { touches: ['src/a.js'] },
      'S-02-api.md': { depends_on: ['S-01'], touches: ['src/b.js'] },
      'S-03-menu.md': { touches: ['src/routes.js', 'src/c.js'] },
      'S-04-tabs.md': { touches: ['src/routes.js'] },
      'S-05-report.md': { touches: ['src/x*.js'] },
      'S-06-late.md': { depends_on: ['S-09'], touches: ['src/late.js'] },
      'S-07-wip.md': { touches: ['src/wip.js'] },
      'S-09-never.md': { touches: ['src/never.js'] },
    },
    statuses: { 'S-01': 'ready-to-merge', 'S-02': 'ready-to-merge', 'S-03': 'ready-to-merge', 'S-04': 'ready-to-merge', 'S-05': 'ready-to-merge', 'S-06': 'ready-to-merge', 'S-09': 'implementation' },
  });
}

// ---------------------------------------------------------------------------------------------------------
// mergeOrder
// ---------------------------------------------------------------------------------------------------------

test('the order puts the smallest and most independent first, after what a PR depends on, and what cannot go last', () => {
  const calls = [];
  const order = mergeOrder(setProject(), { exec: fakeGh(SET, calls) });
  // 11 first (small, shares nothing); 12 once 11 is placed; 15 is big but shares nothing; 14 before 13 (fewer files);
  // 16 waits for S-09 which is still in implementation and has no PR; 17 is a draft.
  assert.deepEqual(numbers(order), [11, 12, 15, 14, 13, 16, 17]);
  assert.ok(order.every((o) => typeof o.reason === 'string' && o.reason.length > 0 && !o.reason.includes('\n')));
  assert.match(order[1].reason, /after #11/);
  assert.match(order[3].reason, /routes\.js/);
  assert.match(order[3].reason, /#13/);
  assert.match(order[4].reason, /no file left in common/);
  assert.match(order[5].reason, /waits for S-09/);
  assert.match(order[6].reason, /draft/);
  assert.deepEqual(order.map((o) => o.waiting), [false, false, false, false, false, true, true]);
  const list = calls.find((c) => c[2] === 'list');
  assert.deepEqual(list.slice(0, 5), ['gh', 'pr', 'list', '--state', 'open']);
  assert.ok(list.includes('--base') && list[list.indexOf('--base') + 1] === 'main');
  assert.ok(calls.every((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'list'), 'only reads: a gh pr list');
  assert.equal(calls.some((c) => c.includes('merged')), false, 'no merged query when no dependency needs it');
});

test('a dependency on a PR that is still open puts that PR first, even when it is the bigger one', () => {
  const root = project({
    slices: { 'S-01-base.md': { touches: ['src/a*.js'] }, 'S-02-api.md': { depends_on: ['S-01'], touches: ['src/b.js'] } },
    statuses: { 'S-01': 'ready-to-merge', 'S-02': 'ready-to-merge' },
  });
  const order = mergeOrder(root, { exec: fakeGh([pr(5, 'slice/S-02-api', ['src/b.js']), pr(6, 'slice/S-01-base', ['src/a1.js', 'src/a2.js', 'src/a3.js'])]) });
  assert.deepEqual(numbers(order), [6, 5]);
});

test('a dependency counts as met when its slice is done, or ready-to-merge with a merged PR; a closed unmerged PR does not count', () => {
  const slices = { 'S-01-base.md': {}, 'S-02-api.md': { depends_on: ['S-01'], touches: ['src/b.js'] } };
  const mine = [pr(5, 'slice/S-02-api', ['src/b.js'])];
  const mergedPr = { headRefName: 'slice/S-01-base', mergedAt: '2026-11-13T10:00:00Z' };
  const closedPr = { headRefName: 'slice/S-01-base', mergedAt: null };
  // done: met, and gh is not asked about merged PRs.
  let calls = [];
  let root = project({ slices, statuses: { 'S-01': 'done', 'S-02': 'ready-to-merge' } });
  let order = mergeOrder(root, { exec: fakeGh(mine, calls, []) });
  assert.equal(order[0].waiting, false);
  assert.equal(calls.some((c) => c.includes('merged')), false);
  // ready-to-merge: met only with a merged PR for the branch, found with --state merged on the base.
  root = project({ slices, statuses: { 'S-01': 'ready-to-merge', 'S-02': 'ready-to-merge' } });
  calls = [];
  order = mergeOrder(root, { exec: fakeGh(mine, calls, [mergedPr]) });
  assert.equal(order[0].waiting, false);
  const q = calls.find((c) => c.includes('merged'));
  assert.deepEqual(q.slice(0, 8), ['gh', 'pr', 'list', '--state', 'merged', '--base', 'main', '--limit']);
  assert.ok(q.includes('headRefName,mergedAt'));
  for (const merged of [[], [closedPr], [{ headRefName: 'slice/S-07-other', mergedAt: '2026-11-13T10:00:00Z' }]]) {
    order = mergeOrder(root, { exec: fakeGh(mine, [], merged) });
    assert.equal(order[0].waiting, true);
    assert.match(order[0].reason, /waits for S-01 \(ready-to-merge\).*no open or merged pull request/);
  }
  for (const dep of ['todo', 'audit', 'gate-2', 'blocked']) {
    root = project({ slices, statuses: { 'S-01': dep, 'S-02': 'ready-to-merge' } });
    order = mergeOrder(root, { exec: fakeGh(mine) });
    assert.match(order[0].reason, new RegExp(`waits for S-01 \\(${dep}`), dep);
  }
});

test('a failure of the merged PR query is an error, not a silent pass', () => {
  const root = project({ slices: { 'S-01-base.md': {}, 'S-02-api.md': { depends_on: ['S-01'] } }, statuses: { 'S-01': 'ready-to-merge' } });
  const exec = (cmd) => (cmd.includes('merged') ? { code: 1, stdout: '', stderr: 'rate limited' } : { code: 0, stdout: JSON.stringify([pr(5, 'slice/S-02-api', ['a'])]), stderr: '' });
  assert.throws(() => mergeOrder(root, { exec }), /gh pr list failed: rate limited/);
});

test('a PR that depends on a waiting PR waits too, and a dependency cycle ends the list without a loop', () => {
  const root = project({
    slices: {
      'S-01-a.md': { depends_on: ['S-09'] }, 'S-02-b.md': { depends_on: ['S-01'], touches: ['src/b.js'] },
      'S-03-c.md': { depends_on: ['S-04'], touches: ['src/c.js'] }, 'S-04-d.md': { depends_on: ['S-03'], touches: ['src/d.js'] },
      'S-05-e.md': { touches: ['src/e.js'] }, 'S-09-z.md': {},
    },
    statuses: { 'S-09': 'spec' },
  });
  const order = mergeOrder(root, {
    exec: fakeGh([
      pr(1, 'slice/S-01-a', ['src/a.js']), pr(2, 'slice/S-02-b', ['src/b.js']), pr(3, 'slice/S-03-c', ['src/c.js']),
      pr(4, 'slice/S-04-d', ['src/d.js']), pr(5, 'slice/S-05-e', ['src/e.js']),
    ]),
  });
  assert.deepEqual(numbers(order), [5, 1, 2, 3, 4]);
  assert.match(order[1].reason, /waits for S-09/);
  assert.match(order[2].reason, /waits for #1/);
  assert.match(order[3].reason, /cycle/);
  assert.match(order[4].reason, /cycle/);
});

test('a PR whose branch is not a slice branch is ordered by size and shared files only', () => {
  const root = project({ slices: { 'S-01-a.md': {} } });
  const order = mergeOrder(root, { exec: fakeGh([pr(8, 'chore/deps', ['package.json', 'package-lock.json']), pr(9, 'fix/typo', ['README.md'])]) });
  assert.deepEqual(numbers(order), [9, 8]);
});

test('a lower case slice branch is read as the slice, and a hotspot file is named in the reason', () => {
  const root = project({
    slices: { 'S-01-base.md': {}, 'S-02-api.md': { depends_on: ['S-01'], touches: ['src/b.js'] } },
    statuses: { 'S-01': 'ready-to-merge', 'S-02': 'ready-to-merge' },
    hotspots: ['src/routes/**'],
  });
  const order = mergeOrder(root, { exec: fakeGh([pr(5, 'slice/s-02-api', ['src/routes/index.js']), pr(6, 'slice/s-01-base', ['src/a.js'])]) });
  assert.deepEqual(numbers(order), [6, 5]);
  assert.match(order[1].reason, /hotspot "src\/routes\/\*\*"/);
});

test('a PR with no files listed does not crash, and no open PR gives an empty order', () => {
  const root = project({ slices: { 'S-01-a.md': {} } });
  assert.deepEqual(mergeOrder(root, { exec: fakeGh([]) }), []);
  const order = mergeOrder(root, { exec: fakeGh([{ number: 3, title: 'x', headRefName: 'slice/S-01-a', isDraft: false }]) });
  assert.deepEqual(numbers(order), [3]);
});

test('a gh failure or an unreadable answer is an error, never an empty order', () => {
  const root = project({ slices: { 'S-01-a.md': {} } });
  assert.throws(() => mergeOrder(root, { exec: () => ({ code: 1, stdout: '', stderr: 'gh: not logged in\nmore' }) }), /gh pr list failed: gh: not logged in/);
  assert.throws(() => mergeOrder(root, { exec: () => ({ code: 0, stdout: 'not json', stderr: '' }) }), /did not print JSON/);
  assert.throws(() => mergeOrder(root, { exec: () => { throw new Error('spawn gh ENOENT'); } }), /spawn gh ENOENT/);
  assert.throws(() => mergeOrder(root, { exec: fakeGh([]), base: '--evil' }), /Invalid base/);
});

// ---------------------------------------------------------------------------------------------------------
// recade merge-order
// ---------------------------------------------------------------------------------------------------------

async function cli(args, { cwd, exec }) {
  const out = [];
  const err = [];
  const code = await run(args, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {}, run: exec });
  return { code, out: out.join(''), err: err.join('') };
}

test('recade merge-order prints the order, the waiting PRs, and --json', async () => {
  const root = setProject();
  const text = await cli(['merge-order'], { cwd: root, exec: fakeGh(SET) });
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^Merge order \(5 open pull requests, 2 waiting\):/);
  assert.match(text.out, /^ {2}1\. #11 /m);
  assert.match(text.out, /^ {2}5\. #13 /m);
  assert.match(text.out, /^Waiting:\n {2}#16 .*waits for S-09/m);
  assert.match(text.out, /^ {2}#17 .*draft/m);
  const json = await cli(['merge-order', '--json', '--project', root], { cwd: tmpdir(), exec: fakeGh(SET) });
  assert.equal(json.code, 0, json.err);
  assert.deepEqual(JSON.parse(json.out).map((o) => o.pr), [11, 12, 15, 14, 13, 16, 17]);
});

test('recade merge-order says so when no PR is open, and fails with the right code otherwise', async () => {
  const root = project({ slices: { 'S-01-a.md': {} } });
  const none = await cli(['merge-order'], { cwd: root, exec: fakeGh([]) });
  assert.equal(none.code, 0);
  assert.match(none.out, /No open pull request to order/);
  const bad = await cli(['merge-order'], { cwd: root, exec: () => ({ code: 1, stdout: '', stderr: 'gh: not logged in' }) });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /gh pr list failed/);
  const usage = await cli(['merge-order', '--now'], { cwd: root, exec: fakeGh([]) });
  assert.equal(usage.code, 2);
  assert.match(usage.err, /Usage: recade merge-order/);
  const lonely = mkdtempSync(join(tmpdir(), 'recade-merge-none-'));
  const noProject = await cli(['merge-order'], { cwd: lonely, exec: fakeGh([]) });
  assert.equal(noProject.code, 1);
  assert.match(noProject.err, /No Recade project here/);
});

// ---------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------

const DASH = String.fromCharCode(0x2014);
const frontmatter = (src) => Object.fromEntries(/^---\n([\s\S]*?)\n---\n/.exec(src)[1].split('\n').map((l) => [l.slice(0, l.indexOf(':')).trim(), l.slice(l.indexOf(':') + 1).trim()]));
/** The text of the `## Step <n>. <title>` section, up to the next `## `. */
function step(src, title) {
  const m = new RegExp(`^## Step \\d+\\. ${title}.*$`, 'm').exec(src);
  assert.ok(m, `step ${title}`);
  const rest = src.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

const SECOND = read('harness/commands/second-opinion.md');
const MERGE = read('harness/commands/merge-order.md');

test('both commands have a description, a narrow tool list and no way to merge, push or write the status', () => {
  for (const [name, src] of [['second-opinion', SECOND], ['merge-order', MERGE]]) {
    const fm = frontmatter(src);
    assert.ok(fm.description.length > 40, name);
    assert.ok(fm['allowed-tools'].includes('Agent') && fm['allowed-tools'].includes('AskUserQuestion'), name);
    assert.equal(/Bash\((gh|\*)[:)]/.test(fm['allowed-tools']), false, `${name}: gh or any shell`);
    assert.equal(/gh pr merge|git push|git rebase|git merge|--admin|--auto/.test(fm['allowed-tools']), false, name);
    assert.equal(/Edit|Glob|Grep/.test(fm['allowed-tools']), false, name);
    assert.match(src, /^## Step 0\. Plugin root and dependencies$/m, name);
    assert.match(step(src, 'Plugin root and dependencies'), /is not known here[\s\S]*and stop\./, name);
    assert.equal(src.includes(DASH) || src.includes('\\u2014'), false, `${name}: no long dash`);
    assert.deepEqual(lintText(src, name).filter((f) => f.severity === 'error'), [], name);
    assert.equal(/\$\{CLAUDE_PLUGIN_ROOT\}/.test(src), false, name);
    assert.equal(/\$RECADE_PLUGIN_ROOT(?![/"`])/.test(src.replace(/`\$RECADE_PLUGIN_ROOT`/g, '')), false, name);
  }
  assert.match(frontmatter(SECOND)['allowed-tools'], /Bash\(gh pr view:\*\)/);
  assert.match(frontmatter(SECOND)['allowed-tools'], /Bash\(gh pr comment:\*\)/);
  assert.equal(/Bash\(gh pr comment/.test(frontmatter(MERGE)['allowed-tools']), false);
});

test('the CLI calls of both commands are commands that exist, and every status argument is single-quoted', () => {
  const known = ['version', 'state', 'slices', 'gate', 'harness', 'merge-order', 'conflicts', 'workspace', 'repo'];
  for (const [name, src] of [['second-opinion', SECOND], ['merge-order', MERGE]]) {
    for (const m of src.matchAll(/`recade ([a-z-]+)[^`]*`/g)) if (m[1] !== '<sub>') assert.ok(known.includes(m[1]), `${name}: ${m[1]}`);
    for (const m of src.matchAll(/recade\.js" ([a-z-]+)/g)) assert.ok(known.includes(m[1]), `${name}: ${m[1]}`);
    for (const line of src.split('\n')) assert.equal(/recade slices status --set (?!'<S-nn>')/.test(line), false, `${name}: ${line.slice(0, 80)}`);
  }
});

test('/second-opinion hands the agent the PR, the sheet and the cited requirements, and never a journal or a report', () => {
  const dispatch = step(SECOND, 'The dispatch');
  const fence = /```text\n([\s\S]*?)\n```/.exec(dispatch);
  assert.ok(fence, 'the prompt is a fenced block');
  const prompt = fence[1];
  assert.match(prompt, /pull request #<PR>/);
  assert.match(prompt, /slices\/<S-nn>-\*\.md/);
  assert.match(prompt, /requirements the sheet cites/);
  assert.equal(/journal|suivi|ledger|\.recade\/|report of|reports of|verdict of|reservation/i.test(prompt), false, 'nothing of the chain goes in the prompt');
  assert.match(dispatch, /Never put in the prompt, and never read yourself/);
  assert.match(dispatch, /journal/);
  assert.match(dispatch, /Never pass a `model`/);
  assert.match(dispatch, /models\.yaml/);
  // The command never reads the ledger, the journal or the reports itself.
  assert.equal(/docs\/suivi|-journal\.md/.test(SECOND.replace(/Never put in the prompt, and never read yourself[^\n]*/, '')), false);
});

test('/second-opinion stops when the rule is off, checks the PR, and posts the verdict with gh pr comment', () => {
  const project = step(SECOND, 'The project');
  assert.match(project, /`off`[\s\S]*stop/);
  const pull = step(SECOND, 'The pull request');
  assert.match(pull, /\^\[0-9\]\{1,6\}\$/);
  assert.match(pull, /gh pr view '<PR>' --json/);
  assert.match(pull, /OPEN/);
  assert.match(pull, /\^slice\//);
  const post = step(SECOND, 'The verdict');
  assert.match(post, /gh pr comment '<PR>' --body-file '/);
  assert.match(post, /CONCURS \| CONCERNS \| BLOCKING/);
  assert.match(post, /Do not invent a verdict/);
});

test('/second-opinion sets the slice back to audit on BLOCKING, through the command and the transition table', () => {
  const post = step(SECOND, 'The verdict');
  assert.match(post, /`BLOCKING`/);
  assert.match(post, /--set '<S-nn>' implementation --project '<home>'/);
  assert.match(post, /--set '<S-nn>' audit --project '<home>'/);
  assert.match(post, /already `audit`[\s\S]*no move/);
  assert.match(post, /Never set a status after `CONCURS` or `CONCERNS`/);
  assert.match(post, /never approve/i);
});

test('/merge-order shows the order from the CLI, then after each owner merge rebases the next PR through merge-keeper', () => {
  const order = step(MERGE, 'The order');
  assert.match(order, /recade merge-order --json --project '<home>'/);
  assert.match(order, /recade conflicts check`\. From the workspace it checks every code repository against its own default branch \(never pass `--base`/);
  assert.doesNotMatch(MERGE, /--base main|origin\/main/);
  const loop = step(MERGE, 'After each merge');
  assert.match(loop, /AskUserQuestion/);
  assert.match(loop, /`Merged, go on`/);
  assert.match(loop, /`Stop here` \(recommended, the default, the safest\)|`Stop here`/);
  assert.match(loop, /git -C '<home>\/repos\/<repo>' fetch origin/);
  assert.match(loop, /worktree add --detach/);
  assert.match(loop, /merge-keeper/);
  assert.match(loop, /never merges/i);
  const rebase = step(MERGE, 'The rebase');
  assert.match(rebase, /mechanical/);
  assert.match(rebase, /recade gate run/);
  assert.match(rebase, /multiple choice/);
  assert.match(rebase, /--force-with-lease/);
  assert.match(rebase, /Only an answer `Push`/);
  assert.match(rebase, /substantive/);
  assert.match(rebase, /DEC/);
  assert.match(MERGE, /Never merge, never enable auto-merge/);
  assert.equal(/--set '/.test(MERGE), false, 'merge-order moves no status');
});

// ---------------------------------------------------------------------------------------------------------
// second-opinion.yml
// ---------------------------------------------------------------------------------------------------------

const WF_TEXT = read('harness/ci/second-opinion.yml');
const WF = parse(WF_TEXT);
const JOB = WF.jobs['second-opinion'];

test('second-opinion.yml: off unless RECADE_SECOND_OPINION is on, same repository only, on open', () => {
  assert.match(JOB.if, /vars\.RECADE_SECOND_OPINION == 'on'/);
  assert.match(JOB.if, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(JOB.if, /github\.event\.pull_request\.draft == false/);
  assert.deepEqual(Object.keys(WF.on), ['pull_request']);
  assert.deepEqual(WF.on.pull_request.types, ['opened', 'reopened', 'ready_for_review']);
  assert.match(WF_TEXT.split('\n').slice(0, 12).join('\n'), /disabled by default/i);
});

test('second-opinion.yml: least privilege, no pull_request_target, no PR code checked out, no token kept', () => {
  assert.equal(/pull_request_target|workflow_run|issue_comment/.test(WF_TEXT.replace(/^\s*#.*$/gm, '')), false);
  assert.deepEqual(WF.permissions, { contents: 'read', 'pull-requests': 'write' });
  assert.equal(JOB.permissions, undefined, 'the job does not widen the permissions');
  const checkouts = JOB.steps.filter((s) => String(s.uses).startsWith('actions/checkout'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with.ref, '${{ github.event.pull_request.base.sha }}');
  assert.equal(checkouts[0].with['persist-credentials'], false);
  assert.equal(/head\.(ref|sha)|merge_commit|refs\/pull/.test(WF_TEXT.replace(/^\s*#.*$/gm, '')), false, 'the head of the PR is never checked out or named');
  assert.equal(JOB.steps.every((s) => s.uses === undefined || /@v\d+$/.test(s.uses)), true, 'actions pinned to a major tag');
  assert.ok(JOB['timeout-minutes'] <= 30);
  assert.ok(WF.concurrency['cancel-in-progress']);
});

test('second-opinion.yml: no expression of event data inside run:, and only known expressions anywhere', () => {
  for (const s of JOB.steps) if (s.run !== undefined) assert.equal(s.run.includes('${{'), false, `run of "${s.name}"`);
  const allowed = [
    "vars.RECADE_SECOND_OPINION == 'on'", 'github.event.pull_request.head.repo.full_name == github.repository',
    'github.event.pull_request.draft == false', 'github.event.pull_request.number', 'github.event.pull_request.base.sha',
    'github.repository', 'github.token', 'secrets.ANTHROPIC_API_KEY', 'steps.model.outputs.model',
    // The private sheet is read from the workspace (spec 6.14): a read-only token, and the workspace repository the owner names.
    "secrets.RECADE_WORKSPACE_TOKEN != '' && vars.RECADE_WORKSPACE_REPOSITORY != ''", 'secrets.RECADE_WORKSPACE_TOKEN', 'vars.RECADE_WORKSPACE_REPOSITORY',
  ];
  for (const m of WF_TEXT.matchAll(/\$\{\{\s*(.*?)\s*\}\}/g)) assert.ok(allowed.includes(m[1]), `expression: ${m[1]}`);
  assert.equal(/github\.event\.(pull_request\.(title|body|head\.(ref|label|user))|comment|review|issue)|github\.head_ref/.test(WF_TEXT), false);
});

test('second-opinion.yml: the model is the one of the installed agent, read from the base checkout and checked', () => {
  const read = JOB.steps.find((s) => s.id === 'model');
  assert.ok(read);
  assert.match(read.run, /\.claude\/agents\/second-opinion\.md/);
  assert.match(read.run, /\*\[!A-Za-z0-9\._-\]\*/);
  assert.match(read.run, /GITHUB_OUTPUT/);
  const action = JOB.steps.find((s) => String(s.uses).startsWith('anthropics/claude-code-action@'));
  assert.ok(action);
  assert.match(action.with.claude_args, /--model \$\{\{ steps\.model\.outputs\.model \}\}/);
  assert.equal(/claude-(fable|opus|sonnet|haiku)|--model (opus|sonnet|fable)/i.test(WF_TEXT.replace(/^\s*#.*$/gm, '')), false, 'no model name written here');
  assert.equal(action.with.anthropic_api_key, '${{ secrets.ANTHROPIC_API_KEY }}');
  assert.equal(action.with.github_token, '${{ github.token }}');
});

test('second-opinion.yml: the agent reads only what the rule allows, and the journals are removed before it starts', () => {
  const clean = JOB.steps.find((s) => /journal|remove/i.test(s.name ?? ''));
  assert.ok(clean);
  assert.match(clean.run, /docs\/suivi/);
  assert.match(clean.run, /-journal\.md/);
  assert.ok(JOB.steps.indexOf(clean) < JOB.steps.findIndex((s) => String(s.uses).startsWith('anthropics/')));
  const action = JOB.steps.find((s) => String(s.uses).startsWith('anthropics/claude-code-action@'));
  assert.match(action.with.prompt, /\.claude\/agents\/second-opinion\.md/);
  assert.match(action.with.prompt, /\.claude\/protocol\.md/);
  assert.match(action.with.prompt, /pull request \$\{\{ github\.event\.pull_request\.number \}\}/);
  assert.match(action.with.prompt, /never the reports/i);
  const tools = /--allowedTools "([^"]*)"/.exec(action.with.claude_args)[1].split(',');
  assert.deepEqual(tools, ['Read', 'Glob', 'Grep', 'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr comment:*)']);
  assert.equal(action.env.GH_TOKEN, '${{ github.token }}');
  // Nothing outside the checkout that holds a secret or the environment of the runner can be read.
  const denied = /--disallowedTools "([^"]*)"/.exec(action.with.claude_args)[1].split(',');
  for (const dir of ['proc', 'etc', 'root', 'sys', 'home/runner/work/_temp']) assert.ok(denied.includes(`Read(//${dir}/**)`), dir);
  assert.match(WF_TEXT, /\/proc\/self\/environ/);
});

test('second-opinion.yml has no long dash and passes the style lint', () => {
  assert.equal(WF_TEXT.includes(DASH), false);
  assert.deepEqual(lintText(WF_TEXT, 'second-opinion.yml').filter((f) => f.severity === 'error'), []);
});

// ---------------------------------------------------------------------------------------------------------
// Across code repositories (spec 6.13)
// ---------------------------------------------------------------------------------------------------------

/** A workspace with the registry `repos` (`{name, default_branch}`) and slices as in `project`, touches with prefixes. */
function wsProject({ slices, statuses = {}, hotspots = [], repos = [{ name: 'api' }, { name: 'web' }] }) {
  const root = project({ slices, statuses, hotspots });
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, kind: 'workspace', hotspots, repos: repos.map((r) => ({ remote: 'none', default_branch: 'main', ...r })) }));
  return root;
}

/** A fake gh that answers each code repository folder with its own pull requests. Every call is recorded with its folder. */
function fakeWsGh(perRepo, calls = [], merged = {}) {
  return (cmd, opts) => {
    calls.push({ cmd, cwd: opts.cwd });
    const name = opts.cwd.split('/').pop();
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
      const wanted = cmd[cmd.indexOf('--state') + 1];
      return { code: 0, stdout: JSON.stringify(wanted === 'merged' ? (merged[name] ?? []) : (perRepo[name] ?? [])), stderr: '' };
    }
    return { code: 127, stdout: '', stderr: `unexpected command: ${cmd.join(' ')}` };
  };
}

const tags = (order) => order.map((o) => `${o.repo} #${o.pr}`);
const TWO_REPOS = { 'S-01-x.md': { touches: ['api:src/a/**', 'web:src/w/**'] } };

test('mergeOrder (workspace): gh runs in each repository folder, on its own default branch', () => {
  const root = wsProject({ slices: TWO_REPOS, statuses: { 'S-01': 'ready-to-merge' }, repos: [{ name: 'api' }, { name: 'web', default_branch: 'trunk' }] });
  const calls = [];
  mergeOrder(root, { exec: fakeWsGh({ api: [pr(3, 'slice/s-01', ['src/a/x.js'])], web: [pr(4, 'slice/s-01', ['src/w/y.js'])] }, calls) });
  assert.deepEqual(calls.map((c) => c.cwd), [join(root, 'repos', 'api'), join(root, 'repos', 'web')]);
  assert.equal(calls[0].cmd[calls[0].cmd.indexOf('--base') + 1], 'main');
  assert.equal(calls[1].cmd[calls[1].cmd.indexOf('--base') + 1], 'trunk');
  const forced = [];
  mergeOrder(root, { exec: fakeWsGh({}, forced), base: 'release' });
  assert.deepEqual(forced.map((c) => c.cmd[c.cmd.indexOf('--base') + 1]), ['release', 'release']);
});

test('mergeOrder (workspace): the pull requests of a slice follow the order of its touches, not their size', () => {
  const root = wsProject({ slices: TWO_REPOS, statuses: { 'S-01': 'ready-to-merge' } });
  // The web pull request is the smaller one, so alone it would go first.
  const perRepo = { api: [pr(3, 'slice/s-01', ['src/a/1.js', 'src/a/2.js', 'src/a/3.js'])], web: [pr(4, 'slice/s-01', ['src/w/y.js'])] };
  const order = mergeOrder(root, { exec: fakeWsGh(perRepo) });
  assert.deepEqual(tags(order), ['api #3', 'web #4']);
  assert.deepEqual(order.map((o) => o.slice), ['S-01', 'S-01']);
  assert.match(order[1].reason, /after api #3/);
});

test('mergeOrder (workspace): merge_order of the sheet wins over the order of the touches', () => {
  const root = wsProject({ slices: { 'S-01-x.md': { touches: ['api:src/a/**', 'web:src/w/**'], merge_order: ['web', 'api'] } }, statuses: { 'S-01': 'ready-to-merge' } });
  const perRepo = { api: [pr(3, 'slice/s-01', ['src/a/x.js'])], web: [pr(4, 'slice/s-01', ['src/w/1.js', 'src/w/2.js', 'src/w/3.js'])] };
  assert.deepEqual(tags(mergeOrder(root, { exec: fakeWsGh(perRepo) })), ['web #4', 'api #3']);
});

test('mergeOrder (workspace): a pull request waits when the one of its slice that merges first waits', () => {
  const root = wsProject({ slices: TWO_REPOS, statuses: { 'S-01': 'ready-to-merge' } });
  const perRepo = { api: [pr(3, 'slice/s-01', ['src/a/x.js'], { isDraft: true })], web: [pr(4, 'slice/s-01', ['src/w/y.js'])] };
  const order = mergeOrder(root, { exec: fakeWsGh(perRepo) });
  assert.deepEqual(tags(order), ['api #3', 'web #4']);
  assert.deepEqual(order.map((o) => o.waiting), [true, true]);
  assert.match(order[0].reason, /draft/);
  assert.match(order[1].reason, /waits for api #3.*waits/);
});

test('mergeOrder (workspace): a hotspot with a prefix counts only in its repository', () => {
  const root = wsProject({
    slices: { 'S-01-x.md': { touches: ['api:src/routes.js'] }, 'S-02-y.md': { touches: ['web:src/routes.js'] } },
    statuses: { 'S-01': 'ready-to-merge', 'S-02': 'ready-to-merge' }, hotspots: ['api:src/routes.js'],
  });
  const perRepo = { api: [pr(3, 'slice/s-01', ['src/routes.js'])], web: [pr(4, 'slice/s-02', ['src/routes.js'])] };
  const order = mergeOrder(root, { exec: fakeWsGh(perRepo) });
  assert.match(order.find((o) => o.repo === 'api').reason, /hotspot/);
  assert.equal(/hotspot/.test(order.find((o) => o.repo === 'web').reason), false);
});

test('mergeOrder (workspace): a dependency that touches another repository does not hold a pull request back', () => {
  const root = wsProject({
    slices: { 'S-01-base.md': { touches: ['web:src/w/**'] }, 'S-02-api.md': { depends_on: ['S-01'], touches: ['api:src/a/**'] } },
    statuses: { 'S-01': 'ready-to-merge', 'S-02': 'ready-to-merge' },
  });
  const perRepo = { api: [pr(3, 'slice/s-02', ['src/a/x.js'])], web: [] };
  const order = mergeOrder(root, { exec: fakeWsGh(perRepo) });
  assert.equal(order[0].waiting, false, order[0].reason);
});

test('mergeOrder (workspace): a gh failure in one repository is an error', () => {
  const root = wsProject({ slices: TWO_REPOS, statuses: { 'S-01': 'ready-to-merge' } });
  const exec = (cmd, opts) => (opts.cwd.endsWith('web') ? { code: 1, stdout: '', stderr: 'rate limited' } : fakeWsGh({ api: [] })(cmd, opts));
  assert.throws(() => mergeOrder(root, { exec }), /gh pr list failed: rate limited/);
});

test('recade merge-order (workspace): lines name the repository, --json carries repo and slice', async () => {
  const root = wsProject({ slices: TWO_REPOS, statuses: { 'S-01': 'ready-to-merge' } });
  const perRepo = { api: [pr(3, 'slice/s-01', ['src/a/x.js'])], web: [pr(4, 'slice/s-01', ['src/w/y.js'])] };
  const text = await cli(['merge-order'], { cwd: root, exec: fakeWsGh(perRepo) });
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^ {2}1\. api #3 /m);
  assert.match(text.out, /^ {2}2\. web #4 /m);
  const json = await cli(['merge-order', '--json'], { cwd: root, exec: fakeWsGh(perRepo) });
  assert.deepEqual(JSON.parse(json.out).map((o) => [o.repo, o.pr, o.slice]), [['api', 3, 'S-01'], ['web', 4, 'S-01']]);
});
