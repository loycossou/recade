import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { adoptBoard, matchIssues } from '../../src/project/github.js';
import { run } from '../../src/cli.js';

const SHEET = (id, title) => `---
doc_id: ${id}
title: "${title}"
repos: [app]
branch: slice/${id.toLowerCase()}
format: small
lane: standard
implementer: implementer
increment: INC-1
depends_on: []
blocks: []
external_prerequisite: none
provisionals_used: []
size: S
touches:
  - "src/${id.toLowerCase()}/**"
---

# ${id}: ${title}

## Scope

- LOAN-01 (the gist)
`;

/** An adopted repository folder named fernhill-lending with three slices. */
function adopted({ github = null } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'recade-board-'));
  const root = join(base, 'fernhill-lending');
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(root, d), { recursive: true });
  const state = { version: 1, mode: 'adopt', lots: [] };
  if (github !== null) state.github = github;
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify(state));
  writeFileSync(join(root, 'slices', 'S-01-apply.md'), SHEET('S-01', 'Apply for a loan'));
  writeFileSync(join(root, 'slices', 'S-02-payout.md'), SHEET('S-02', 'Schedule a payout'));
  writeFileSync(join(root, 'slices', 'S-03-ledger.md'), SHEET('S-03', 'Export the ledger'));
  return root;
}

const stateOf = (root) => parse(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8'));

const THREE = [
  { number: 11, title: 'Apply for a loan', url: 'https://github.com/fernhill/fernhill-lending/issues/11', labels: [{ name: 'feature' }] },
  { number: 12, title: 'Schedule payout', url: 'https://github.com/fernhill/fernhill-lending/issues/12', labels: [] },
  { number: 13, title: 'CSV for the accountants', url: 'https://github.com/fernhill/fernhill-lending/issues/13', labels: [{ name: 'S-03' }] },
];

/** A fake gh and git holding an existing repository, projects and open issues. Every call is recorded. */
function fakeGh({ projects = [{ number: 4, id: 'PVT_4', title: 'Fernhill roadmap', closed: false }], issues = THREE, origin = 'https://github.com/fernhill/fernhill-lending.git', visibility = 'PRIVATE', failOn = () => false } = {}) {
  const gh = { calls: [], projects: [...projects], issues };
  const ok = (data) => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
  const flag = (args, name) => args[args.indexOf(name) + 1];
  gh.exec = async (cmd, args) => {
    if (cmd === 'git') {
      assert.deepEqual(args.slice(2), ['remote', 'get-url', 'origin']);
      return origin === null ? { code: 2, stdout: '', stderr: "error: No such remote 'origin'" } : ok(`${origin}\n`);
    }
    assert.equal(cmd, 'gh');
    gh.calls.push(args);
    if (failOn(args)) return { code: 1, stdout: '', stderr: 'boom: simulated failure\nsecond line' };
    const [a, b] = args;
    if (a === 'repo' && b === 'view') return ok({ name: 'fernhill-lending', visibility });
    if (a === 'project' && b === 'list') {
      const shown = args.includes('--closed') ? gh.projects : gh.projects.filter((p) => p.closed !== true);
      return ok({ projects: shown, totalCount: shown.length });
    }
    if (a === 'project' && b === 'view') {
      const p = gh.projects.find((x) => String(x.number) === args[2]);
      return p ? ok(p) : { code: 1, stdout: '', stderr: `GraphQL: Could not resolve to a ProjectV2 with the number ${args[2]}.` };
    }
    if (a === 'project' && b === 'create') {
      const p = { number: 9, id: 'PVT_9', title: flag(args, '--title'), closed: false };
      gh.projects.push(p);
      return ok(p);
    }
    if (a === 'issue' && b === 'list') return ok(gh.issues);
    return { code: 1, stdout: '', stderr: `unexpected call: ${args.join(' ')}` };
  };
  return gh;
}

const writes = (gh) => gh.calls.filter(([a, b]) => (a === 'project' && ['create', 'field-create', 'item-add', 'item-edit'].includes(b))
  || (a === 'issue' && ['create', 'edit', 'comment', 'close'].includes(b)) || (a === 'repo' && b === 'create') || a === 'api');

// ---- matching ----

test('issues are matched to slices by title or by label, and an unrelated issue stays unmatched', () => {
  const slices = [{ id: 'S-01', title: 'Apply for a loan' }, { id: 'S-02', title: 'Schedule a payout' }, { id: 'S-03', title: 'Export the ledger' }];
  const { matched, unmatched } = matchIssues([...THREE, { number: 14, title: 'Fix a typo in the footer', labels: [] }], slices);
  assert.deepEqual(matched.map((m) => [m.issue, m.slice, m.by]), [[11, 'S-01', 'title'], [12, 'S-02', 'title'], [13, 'S-03', 'label']]);
  assert.deepEqual(unmatched, [14]);
});

test('a [ID] prefix, a slice: label and a slice/ label all match; the same slice is never given to two issues, a tie is left to the owner', () => {
  const slices = [{ id: 'S-01', title: 'Apply for a loan' }, { id: 'S-02', title: 'Schedule a payout' }];
  const issues = [
    { number: 1, title: '[S-01] something else entirely', labels: [] },
    { number: 2, title: 'unrelated', labels: [{ name: 'slice:S-02' }] },
    { number: 3, title: 'Apply for a loan', labels: [] },
    { number: 4, title: 'x', labels: [{ name: 'slice/s-02' }] },
  ];
  const { matched, unmatched } = matchIssues(issues, slices);
  const bySlice = Object.fromEntries(matched.map((m) => [m.slice, m.issue]));
  assert.equal(bySlice['S-01'], 1, 'the explicit ID beats the title');
  assert.equal(bySlice['S-02'], undefined, 'two issues with the same label are a question, not the lowest number');
  assert.deepEqual(unmatched.sort(), [2, 3, 4]);
});

test('two slices with the same score for an issue leave it unmatched instead of guessing', () => {
  const slices = [{ id: 'S-01', title: 'Export ledger report' }, { id: 'S-02', title: 'Export ledger summary' }];
  const { matched, unmatched } = matchIssues([{ number: 5, title: 'Export ledger', labels: [] }], slices);
  assert.deepEqual(matched, []);
  assert.deepEqual(unmatched, [5]);
});

// ---- reading the existing board ----

test('an existing project and three open issues give three matches and no write call at all; the one board is proposed, recorded only after the answer', async () => {
  const root = adopted();
  const gh = fakeGh();
  const first = await adoptBoard(root, { exec: gh.exec });
  assert.equal(first.error, null);
  assert.equal(first.project_number, null, 'a single open board is a proposal, not a record');
  assert.deepEqual(first.choose, [{ number: 4, title: 'Fernhill roadmap', closed: false }]);
  assert.equal(stateOf(root).github?.project_number, undefined);
  const r = await adoptBoard(root, { exec: gh.exec, project: 4 });
  assert.equal(r.error, null);
  assert.equal(r.repo, 'fernhill/fernhill-lending');
  assert.equal(r.project_number, 4);
  assert.deepEqual(r.matched.map((m) => [m.issue, m.slice]), [[11, 'S-01'], [12, 'S-02'], [13, 'S-03']]);
  assert.deepEqual(r.unmatched, []);
  assert.equal(r.needsCreate, false);
  assert.equal(r.created, false);
  assert.deepEqual(writes(gh), [], 'nothing is created');
  assert.equal(gh.calls.some(([a, b]) => a === 'project' && b === 'create'), false, 'no create call');
  assert.deepEqual(stateOf(root).github, { owner: 'fernhill', repo: 'fernhill-lending', project_number: 4 });
  const list = gh.calls.find(([a, b]) => a === 'issue' && b === 'list');
  assert.ok(list.includes('--state') && list[list.indexOf('--state') + 1] === 'open');
});

test('a second run is the same read and changes nothing', async () => {
  const root = adopted();
  const gh = fakeGh();
  await adoptBoard(root, { exec: gh.exec, project: 4 });
  const first = readFileSync(join(root, 'recade', 'state.yaml'), 'utf8');
  const again = await adoptBoard(root, { exec: gh.exec });
  assert.equal(again.matched.length, 3);
  assert.equal(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8'), first);
});

test('no project: nothing is created and the result says one is needed; the yes makes exactly one create call', async () => {
  const root = adopted();
  const gh = fakeGh({ projects: [] });
  const asked = await adoptBoard(root, { exec: gh.exec });
  assert.equal(asked.error, null);
  assert.equal(asked.project_number, null);
  assert.equal(asked.needsCreate, true);
  assert.equal(asked.created, false);
  assert.deepEqual(writes(gh), [], 'no create call before the yes');
  assert.equal(stateOf(root).github?.project_number, undefined);

  const yes = await adoptBoard(root, { exec: gh.exec, create: true });
  assert.equal(yes.error, null);
  assert.equal(yes.created, true);
  assert.equal(yes.project_number, 9);
  const creates = gh.calls.filter(([a, b]) => a === 'project' && b === 'create');
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0], ['project', 'create', '--owner', 'fernhill', '--title', 'Fernhill Lending delivery', '--format', 'json']);
  assert.equal(writes(gh).length, 1, 'the project is the only write');
  assert.equal(stateOf(root).github.project_number, 9);

  const next = await adoptBoard(root, { exec: gh.exec, create: true });
  assert.equal(next.created, false, 'the project is found now, not created again');
  assert.equal(gh.calls.filter(([a, b]) => a === 'project' && b === 'create').length, 1);
});

test('create is refused when a project exists: no second board', async () => {
  const root = adopted();
  const gh = fakeGh();
  const r = await adoptBoard(root, { exec: gh.exec, create: true });
  assert.match(r.error, /already has a board/);
  assert.deepEqual(writes(gh), []);
});

test('closed boards are listed and offered with the open ones, and a chosen closed board gets a warning', async () => {
  const root = adopted();
  const gh = fakeGh({ projects: [
    { number: 1, id: 'P1', title: 'Old', closed: true },
    { number: 2, id: 'P2', title: 'Fernhill roadmap', closed: false },
    { number: 3, id: 'P3', title: 'Fernhill ops', closed: false },
  ] });
  const r = await adoptBoard(root, { exec: gh.exec });
  assert.equal(r.project_number, null);
  assert.deepEqual(r.choose, [{ number: 1, title: 'Old', closed: true }, { number: 2, title: 'Fernhill roadmap', closed: false }, { number: 3, title: 'Fernhill ops', closed: false }]);
  assert.equal(r.needsCreate, false);
  assert.equal(stateOf(root).github?.project_number, undefined);
  const list = gh.calls.find(([a, b]) => a === 'project' && b === 'list');
  assert.ok(list.includes('--closed'), 'closed boards are read');
  const chosen = await adoptBoard(root, { exec: gh.exec, project: 3 });
  assert.equal(chosen.project_number, 3);
  assert.equal(stateOf(root).github.project_number, 3);
  const old = await adoptBoard(adopted(), { exec: gh.exec, project: 1 });
  assert.ok(old.warnings.some((w) => /closed/.test(w) && /--undo/.test(w)));
  const missing = await adoptBoard(root, { exec: gh.exec, project: 99 });
  assert.match(missing.error, /project view failed/);
  assert.equal(stateOf(root).github.project_number, 3, 'a wrong answer changes nothing');
});

test('a closed board with the title Recade would use is offered, and create is refused: never a silent second board', async () => {
  const root = adopted();
  const gh = fakeGh({ projects: [{ number: 6, id: 'P6', title: 'Fernhill Lending delivery', closed: true }] });
  const r = await adoptBoard(root, { exec: gh.exec });
  assert.equal(r.needsCreate, false, 'a board exists, closed or not');
  assert.deepEqual(r.choose, [{ number: 6, title: 'Fernhill Lending delivery', closed: true }]);
  assert.equal(r.suggested, 6, 'the closed board with the right title is the suggestion');
  const create = await adoptBoard(root, { exec: gh.exec, create: true });
  assert.match(create.error, /already has a board/);
  assert.match(create.error, /closed/);
  assert.equal(gh.calls.some(([a, b]) => a === 'project' && b === 'create'), false, 'no create call');
  assert.deepEqual(writes(gh), []);
  const reuse = await adoptBoard(root, { exec: gh.exec, project: 6 });
  assert.equal(reuse.project_number, 6);
  assert.ok(reuse.warnings.some((w) => /closed/.test(w)));
});

test('a list that reaches the limit is refused, never truncated silently', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, title: `Issue ${i}`, labels: [] }));
  const issues = await adoptBoard(adopted(), { exec: fakeGh({ issues: many }).exec });
  assert.match(issues.error, /1000 open issues/);
  assert.match(issues.error, /limit/);
  const boards = Array.from({ length: 1000 }, (_, i) => ({ number: i + 1, id: `P${i}`, title: `B${i}`, closed: false }));
  const projects = await adoptBoard(adopted(), { exec: fakeGh({ projects: boards }).exec });
  assert.match(projects.error, /1000 boards/);
  const ok = await adoptBoard(adopted(), { exec: fakeGh({ issues: many.slice(0, 999) }).exec });
  assert.equal(ok.error, null, 'one under the limit is fine');
});

test('two issues with the same title for one slice are a question for the owner, not the lowest number', () => {
  const slices = [{ id: 'S-01', title: 'Apply for a loan' }, { id: 'S-02', title: 'Schedule a payout' }];
  const r = matchIssues([
    { number: 5, title: 'Apply for a loan', labels: [] },
    { number: 6, title: 'Apply for a loan', labels: [] },
    { number: 7, title: 'Schedule a payout', labels: [] },
  ], slices);
  assert.deepEqual(r.matched.map((m) => [m.issue, m.slice]), [[7, 'S-02']]);
  assert.deepEqual(r.unmatched, [5, 6]);
  assert.deepEqual(r.ambiguous, [{ issues: [5, 6], slices: ['S-01'] }]);
  const tie = matchIssues([{ number: 5, title: 'Export ledger', labels: [] }], [{ id: 'S-01', title: 'Export ledger report' }, { id: 'S-02', title: 'Export ledger summary' }]);
  assert.deepEqual(tie.ambiguous, [{ issues: [5], slices: ['S-01', 'S-02'] }]);
});

test('the recorded owner and repository are validated like the ones given on the command line', async () => {
  for (const github of [{ owner: '-x', repo: 'fernhill-lending' }, { owner: 'fernhill', repo: '--json' }, { owner: 'fern hill', repo: 'a' }]) {
    const gh = fakeGh();
    const r = await adoptBoard(adopted({ github }), { exec: gh.exec });
    assert.match(r.error, /Invalid repository/);
    assert.equal(gh.calls.length, 0, 'nothing reaches gh');
  }
});

test('the recorded board is used first, whatever other projects exist', async () => {
  const root = adopted({ github: { owner: 'fernhill', repo: 'fernhill-lending', project_number: 3 } });
  const gh = fakeGh({ projects: [{ number: 2, id: 'P2', title: 'A', closed: false }, { number: 3, id: 'P3', title: 'B', closed: false }] });
  const r = await adoptBoard(root, { exec: gh.exec });
  assert.equal(r.project_number, 3);
  assert.equal(gh.calls.some(([a, b]) => a === 'project' && b === 'list'), false, 'no list needed');
});

test('a public repository is a warning, not a refusal, and a repository with no GitHub remote is an error', async () => {
  const root = adopted();
  const pub = await adoptBoard(root, { exec: fakeGh({ visibility: 'PUBLIC' }).exec });
  assert.equal(pub.error, null);
  assert.ok(pub.warnings.some((w) => /public/.test(w)));
  for (const origin of [null, 'https://gitlab.example.test/fernhill/app.git']) {
    const r = await adoptBoard(adopted(), { exec: fakeGh({ origin }).exec });
    assert.match(r.error, /GitHub remote/);
  }
  const ssh = await adoptBoard(adopted(), { exec: fakeGh({ origin: `${['git', 'github.com'].join('@')}:fernhill/fernhill-lending.git` }).exec });
  assert.equal(ssh.repo, 'fernhill/fernhill-lending');
  const named = await adoptBoard(adopted(), { exec: fakeGh({ origin: null }).exec, repoName: 'fernhill/fernhill-lending' });
  assert.equal(named.error, null);
  const bad = await adoptBoard(adopted(), { exec: fakeGh().exec, repoName: 'fernhill/../x' });
  assert.match(bad.error, /Invalid repository/);
});

test('a failing gh call ends the run with one line and records nothing', async () => {
  const root = adopted();
  const gh = fakeGh({ failOn: ([a, b]) => a === 'issue' && b === 'list' });
  const r = await adoptBoard(root, { exec: gh.exec });
  assert.equal(r.error, 'gh issue list failed: boom: simulated failure');
  assert.equal(stateOf(root).github, undefined);
});

// ---- the owner's answer ----

test('the accepted matches are recorded as links, and only valid ones', async () => {
  const root = adopted();
  const gh = fakeGh();
  const ok = await adoptBoard(root, { exec: gh.exec, accept: [{ issue: 11, slice: 'S-01' }, { issue: 13, slice: 'S-03' }] });
  assert.equal(ok.error, null);
  assert.deepEqual(stateOf(root).github.links, { 'S-01': 11, 'S-03': 13 });
  assert.deepEqual(ok.linked, { 'S-01': 11, 'S-03': 13 });
  const more = await adoptBoard(root, { exec: gh.exec, accept: [{ issue: 12, slice: 'S-02' }] });
  assert.deepEqual(stateOf(root).github.links, { 'S-01': 11, 'S-02': 12, 'S-03': 13 }, 'links add up');
  assert.deepEqual(more.matched, [], 'a linked issue is not proposed again');
  for (const [accept, pattern] of [
    [[{ issue: 99, slice: 'S-01' }], /Issue 99 is not an open issue/],
    [[{ issue: 11, slice: 'S-77' }], /S-77 is not a slice/],
    [[{ issue: 11, slice: 'S-01' }, { issue: 12, slice: 'S-01' }], /S-01 is linked to two issues/],
    [[{ issue: 11, slice: 'S-01' }, { issue: 11, slice: 'S-02' }], /Issue 11 is linked to two slices/],
  ]) {
    const fresh = adopted();
    const r = await adoptBoard(fresh, { exec: fakeGh().exec, accept });
    assert.match(r.error, pattern);
    assert.equal(stateOf(fresh).github?.links, undefined, 'nothing recorded on a refusal');
  }
});

test('an issue already linked to a slice is not proposed again, and a link to another issue is refused', async () => {
  const root = adopted({ github: { owner: 'fernhill', repo: 'fernhill-lending', project_number: 4, links: { 'S-01': 11 } } });
  const r = await adoptBoard(root, { exec: fakeGh().exec });
  assert.deepEqual(r.matched.map((m) => m.slice), ['S-02', 'S-03']);
  assert.deepEqual(r.linked, { 'S-01': 11 });
  const clash = await adoptBoard(root, { exec: fakeGh().exec, accept: [{ issue: 12, slice: 'S-01' }] });
  assert.match(clash.error, /S-01 is already linked to issue 11/);
});

// ---- the commands ----

function cliIo(root, extra = {}) {
  const out = []; const err = [];
  return { out, err, io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd: root, env: { HOME: root }, ...extra } };
}

test('recade adopt board prints the proposal, --json prints the result, and nothing is written without the answers', async () => {
  const root = adopted();
  const gh = fakeGh();
  const text = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['adopt', 'board'], text.io), 0, text.err.join(''));
  const out = text.out.join('');
  assert.match(out, /Repository: fernhill\/fernhill-lending/);
  assert.match(out, /Boards to choose from: 4 Fernhill roadmap/);
  assert.match(out, /#11 .*Apply for a loan.* S-01 \(title\)/);
  assert.match(out, /#13 .* S-03 \(label\)/);
  const json = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['adopt', 'board', '--json'], json.io), 0);
  assert.equal(JSON.parse(json.out.join('')).matched.length, 3);
  const chosen = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['adopt', 'board', '--project', '4'], chosen.io), 0);
  assert.match(chosen.out.join(''), /Board: 4/);
  assert.deepEqual(writes(gh), []);
});

test('recade adopt board takes --project, --create, --accept and --repo, and rejects what it does not know', async () => {
  const root = adopted();
  const gh = fakeGh({ projects: [] });
  const create = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['adopt', 'board', '--create', '--json'], create.io), 0, create.err.join(''));
  assert.equal(JSON.parse(create.out.join('')).created, true);
  const accept = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['adopt', 'board', '--accept', '11=S-01,12=S-02'], accept.io), 0, accept.err.join(''));
  assert.deepEqual(stateOf(root).github.links, { 'S-01': 11, 'S-02': 12 });
  for (const argv of [['adopt', 'board', '--accept', 'nonsense'], ['adopt', 'board', '--project', 'x'], ['adopt', 'board', '--nope'], ['adopt', 'board', 'extra']]) {
    const t = cliIo(root, { exec: gh.exec });
    assert.equal(await run(argv, t.io), 2, argv.join(' '));
    assert.match(t.err.join(''), /Usage: recade adopt/);
  }
  const t = cliIo(adopted(), { exec: fakeGh({ origin: null }).exec });
  assert.equal(await run(['adopt', 'board'], t.io), 1, 'a refusal of the board is exit 1');
  assert.match(t.err.join(''), /GitHub remote/);
});

/** Register a code repository `app` in the workspace `root` and put `files` in `repos/app/`. */
function withApp(root, files = {}) {
  const state = parse(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({
    ...state, kind: 'workspace', repos: [{ name: 'app', path: 'repos/app', remote: 'none', default_branch: 'main', role: '', visibility: 'private' }],
  }));
  mkdirSync(join(root, 'repos', 'app'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, 'repos', 'app', rel, '..'), { recursive: true });
    writeFileSync(join(root, 'repos', 'app', rel), text);
  }
}

test('recade adopt from-code lists the targets and the gaps, and --json prints them; --full gives D1 to D3', async () => {
  const root = adopted();
  withApp(root, { 'README.md': '# Fernhill\n' });
  const t = cliIo(root);
  assert.equal(await run(['adopt', 'from-code'], t.io), 0, t.err.join(''));
  const out = t.out.join('');
  assert.match(out, /docs\/RULES\.md/);
  assert.match(out, /SRC-01 repos\/app\/README\.md/);
  assert.match(out, /Reading: all/);
  const j = cliIo(root);
  assert.equal(await run(['adopt', 'from-code', '--full', '--json'], j.io), 0);
  assert.deepEqual(JSON.parse(j.out.join('')).targets.map((x) => x.doc), ['docs/D1.md', 'docs/D2.md', 'docs/D3.md']);
  const bad = cliIo(root);
  assert.equal(await run(['adopt', 'from-code', 'extra'], bad.io), 2);
});

test('recade adopt from-code works from a code repository of the workspace, and says so when there is no adopted workspace', async () => {
  const root = adopted();
  withApp(root, { 'README.md': '# Fernhill\n' });
  const plain = mkdtempSync(join(tmpdir(), 'recade-board-plain-'));
  const none = cliIo(plain);
  assert.equal(await run(['adopt', 'from-code'], none.io), 1);
  assert.match(none.err.join(''), /No adopted workspace here: run recade adopt init --parent/);
});

test('recade adopt from-code exits 1 when the files written have gaps', async () => {
  const root = adopted();
  withApp(root);
  writeFileSync(join(root, 'docs', 'RULES.md'), '# Rules\n');
  const t = cliIo(root);
  assert.equal(await run(['adopt', 'from-code'], t.io), 1);
  assert.match(t.out.join(''), /Gaps:/);
  assert.match(t.out.join(''), /the section "Golden files" is missing/);
});

test('recade adopt write refuses docs/source/: the copies are only made by from-code', async () => {
  const root = adopted();
  const t = cliIo(root, { readStdin: async () => 'edited copy\n' });
  assert.equal(await run(['adopt', 'write', 'docs/source/app/README.md'], t.io), 1);
  assert.match(t.err.join(''), /docs\/source\/.*only made by/);
  assert.equal(await run(['adopt', 'write', 'docs/source/INDEX.md'], cliIo(root, { readStdin: async () => 'x' }).io), 1);
  const ok = cliIo(root, { readStdin: async () => '# Rules\n' });
  assert.equal(await run(['adopt', 'write', 'docs/RULES.md'], ok.io), 0, ok.err.join(''));
});
