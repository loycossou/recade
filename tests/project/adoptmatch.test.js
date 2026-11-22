import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { initGithub, adoptBoard } from '../../src/project/github.js';
import { reconcile } from '../../src/harness/board.js';
import { run } from '../../src/cli.js';

/* The existing issues of the adopted code repositories are matched to slices and added to the workspace board through
   their link. The slice sheet stays private, so no issue is created in a code repository, and no second issue is
   created in the workspace for a linked slice. */

const WS = 'fernhill/fernhill-lending-workspace';
const API = 'fernhill/fernhill-api';
const SHEET = (id, title, touch) => `---
doc_id: ${id}
title: "${title}"
repos: [app]
branch: slice/${id.toLowerCase()}-x
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
  - "${touch}"
---

# ${id}: ${title}

## Scope

- LOAN-01 (the private gist)
`;
const ENTRY = (name, remote) => ({ name, path: `repos/${name}`, remote, default_branch: 'main', role: '', visibility: 'private' });
const API_ISSUE = { number: 7, title: 'Apply for a loan', url: `https://github.com/${API}/issues/7`, labels: [] };

/** An adopted workspace: api has a GitHub remote, web has none, and the workspace repository and its board are recorded. */
function workspace({ github = { owner: 'fernhill', repo: 'fernhill-lending-workspace', project_number: 4 } } = {}) {
  const root = join(mkdtempSync(join(tmpdir(), 'recade-match-')), 'fernhill-lending-workspace');
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({
    version: 1, kind: 'workspace', mode: 'adopt', lots: [], repos: [ENTRY('api', `https://github.com/${API}.git`), ENTRY('web', 'none')], ...(github === null ? {} : { github }),
  }));
  writeFileSync(join(root, 'slices', 'S-01-apply.md'), SHEET('S-01', 'Apply for a loan', 'api:src/apply/**'));
  writeFileSync(join(root, 'slices', 'S-02-payout.md'), SHEET('S-02', 'Schedule a payout', 'web:src/payout/**'));
  return root;
}
const stateOf = (root) => parse(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8'));

/** A fake gh with one list of issues for each repository, a board that has every field, and a record of the calls. */
function fakeGh({ issues = { [WS]: [], [API]: [API_ISSUE] }, boards = [{ number: 4, id: 'PVT_4', title: 'Fernhill Lending delivery', closed: false }, { number: 9, id: 'PVT_9', title: 'Old roadmap', closed: false }] } = {}) {
  const gh = { calls: [], issues: Object.fromEntries(Object.entries(issues).map(([k, v]) => [k, [...v]])), items: [], next: 100 };
  const ok = (data) => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const options = (names) => names.map((n, i) => ({ id: `O_${n}_${i}`, name: n }));
  const fields = [
    { id: 'F_status', name: 'Status', type: 'ProjectV2SingleSelectField', options: options(['Backlog', 'Todo', 'Done']) },
    { id: 'F_inc', name: 'Increment', type: 'ProjectV2SingleSelectField', options: options(['INC-1']) },
    { id: 'F_sprint', name: 'Sprint', type: 'ProjectV2IterationField' },
    { id: 'F_lane', name: 'Lane', type: 'ProjectV2SingleSelectField', options: options(['standard', 'sensitive', 'no-code']) },
    { id: 'F_points', name: 'Points', type: 'ProjectV2Field' },
    { id: 'F_prio', name: 'Priority', type: 'ProjectV2SingleSelectField', options: options(['P0', 'P1', 'P2', 'P3']) },
    { id: 'F_due', name: 'Due', type: 'ProjectV2Field' },
    { id: 'F_owner', name: 'Owner', type: 'ProjectV2Field' },
    { id: 'F_epic', name: 'Epic', type: 'ProjectV2Field' },
  ];
  gh.exec = async (cmd, args) => {
    if (cmd === 'git') {
      const [, , a, b] = args;
      if (a === 'rev-parse') return ok('abc\n');
      if (a === 'remote' && b === 'get-url') return ok('https://github.com/fernhill/fernhill-lending-workspace.git\n');
      if (a === 'ls-remote') return ok('abc\trefs/heads/main\n');
      return { code: 1, stdout: '', stderr: `unexpected git call ${args.join(' ')}` };
    }
    assert.equal(cmd, 'gh');
    gh.calls.push(args);
    const [a, b] = args;
    if (a === 'repo' && b === 'view') return ok({ name: args[2].split('/')[1], visibility: 'PRIVATE' });
    if (a === 'project' && b === 'list') return ok({ projects: boards, totalCount: boards.length });
    if (a === 'project' && b === 'view') {
      const p = boards.find((x) => String(x.number) === args[2]);
      return p ? ok(p) : { code: 1, stdout: '', stderr: 'no such board' };
    }
    if (a === 'project' && b === 'field-list') return ok({ fields, totalCount: fields.length });
    if (a === 'project' && b === 'item-list') return ok({ items: gh.items, totalCount: gh.items.length });
    if (a === 'project' && b === 'item-add') {
      const url = flag(args, '--url');
      const all = Object.values(gh.issues).flat();
      const issue = all.find((i) => i.url === url);
      if (issue === undefined) return { code: 1, stdout: '', stderr: `no issue at ${url}` };
      const item = { id: `PVTI_${gh.next++}`, title: issue.title, content: { url, number: issue.number, type: 'Issue', title: issue.title } };
      gh.items.push(item);
      return ok(item);
    }
    if (a === 'project' && b === 'item-edit') return ok({});
    if (a === 'issue' && b === 'list') return ok(gh.issues[flag(args, '--repo')] ?? []);
    if (a === 'issue' && b === 'create') {
      const repo = flag(args, '--repo');
      const list = (gh.issues[repo] ??= []);
      const issue = { number: list.length + 50, title: flag(args, '--title'), url: `https://github.com/${repo}/issues/${list.length + 50}`, labels: [] };
      list.push(issue);
      return ok(`${issue.url}\n`);
    }
    return { code: 1, stdout: '', stderr: `unexpected call: ${args.join(' ')}` };
  };
  return gh;
}
const calls = (gh, a, b) => gh.calls.filter((c) => c[0] === a && c[1] === b);

test('adoptBoard proposes the open issues of every code repository with a GitHub remote, and the boards of the owner', async () => {
  const root = workspace();
  const gh = fakeGh();
  const r = await adoptBoard(root, { exec: gh.exec });
  assert.equal(r.error, null);
  assert.deepEqual(r.matched.map((m) => [m.repo, m.issue, m.slice, m.url]), [['api', 7, 'S-01', API_ISSUE.url]]);
  const lists = calls(gh, 'issue', 'list').map((c) => c[c.indexOf('--repo') + 1]);
  assert.deepEqual(lists.sort(), [API, WS].sort(), 'the workspace and api; web has no GitHub remote');
  assert.deepEqual(r.choose.map((c) => c.number), [4, 9], 'the boards of the owner are listed even when one is recorded');
  assert.equal(r.project_number, 4, 'the recorded board stays the board');
  assert.deepEqual(r.unmatched, []);
  assert.equal(calls(gh, 'issue', 'create').length + calls(gh, 'project', 'item-add').length, 0, 'reading writes nothing');
});

test('issues of two repositories with the same number are told apart, and a tie across repositories is a question', async () => {
  const root = workspace();
  const web = { ...ENTRY('web', `https://github.com/fernhill/fernhill-web.git`) };
  const state = stateOf(root);
  state.repos = [state.repos[0], web];
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify(state));
  const gh = fakeGh({ issues: { [WS]: [], [API]: [API_ISSUE], 'fernhill/fernhill-web': [{ number: 7, title: 'Schedule a payout', url: 'https://github.com/fernhill/fernhill-web/issues/7', labels: [] }] } });
  const r = await adoptBoard(root, { exec: gh.exec });
  assert.deepEqual(r.matched.map((m) => `${m.repo}#${m.issue}=${m.slice}`).sort(), ['api#7=S-01', 'web#7=S-02']);
  const tie = fakeGh({ issues: { [WS]: [], [API]: [API_ISSUE, { ...API_ISSUE, number: 8, url: `https://github.com/${API}/issues/8` }] } });
  const t = await adoptBoard(workspace(), { exec: tie.exec });
  assert.deepEqual(t.matched, []);
  assert.deepEqual(t.ambiguous, [{ issues: ['api#7', 'api#8'], slices: ['S-01'] }]);
});

test('accepting a match records the full issue URL of the code repository; all or nothing', async () => {
  const root = workspace();
  const gh = fakeGh();
  const r = await adoptBoard(root, { exec: gh.exec, accept: [{ issue: 7, repo: 'api', slice: 'S-01' }] });
  assert.equal(r.error, null);
  assert.deepEqual(r.linked, { 'S-01': API_ISSUE.url });
  assert.deepEqual(stateOf(root).github.links, { 'S-01': API_ISSUE.url });
  assert.deepEqual(r.matched, [], 'a linked issue is not proposed again');
  // A bad pair stops the whole answer: nothing is recorded.
  const other = workspace();
  for (const accept of [
    [{ issue: 7, repo: 'api', slice: 'S-01' }, { issue: 99, repo: 'api', slice: 'S-02' }],
    [{ issue: 7, repo: 'web', slice: 'S-01' }],
    [{ issue: 7, repo: 'nope', slice: 'S-01' }],
    [{ issue: 7, repo: 'api', slice: 'S-01' }, { issue: 7, repo: 'api', slice: 'S-02' }],
  ]) {
    const bad = await adoptBoard(other, { exec: fakeGh().exec, accept });
    assert.notEqual(bad.error, null, JSON.stringify(accept));
    assert.equal(stateOf(other).github.links, undefined, 'nothing recorded after a refusal');
  }
});

test('initGithub adds the linked issue of the code repository to the board and creates no issue for that slice', async () => {
  const root = workspace();
  const gh = fakeGh();
  await adoptBoard(root, { exec: gh.exec, accept: [{ issue: 7, repo: 'api', slice: 'S-01' }] });
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null, r.error);
  const creates = calls(gh, 'issue', 'create');
  assert.deepEqual(creates.map((c) => c[c.indexOf('--title') + 1]), ['[S-02] Schedule a payout'], 'one issue, for the slice with no link');
  assert.equal(creates.every((c) => c[c.indexOf('--repo') + 1] === WS), true, 'never in a code repository');
  const adds = calls(gh, 'project', 'item-add').map((c) => c[c.indexOf('--url') + 1]);
  assert.deepEqual(adds.sort(), [API_ISSUE.url, `https://github.com/${WS}/issues/50`].sort());
  assert.equal(adds.filter((u) => u === API_ISSUE.url).length, 1, 'exactly one item for the linked issue');
  assert.deepEqual(gh.issues[API], [API_ISSUE], 'the code repository is not touched');
  // A second run changes nothing: the item is found by the URL of the linked issue.
  const before = gh.calls.length;
  const again = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(again.error, null);
  assert.equal(calls(gh, 'issue', 'create').length, 1);
  assert.equal(calls(gh, 'project', 'item-add').length, 2);
  assert.ok(gh.calls.length > before);
  assert.equal(stateOf(root).github.links['S-01'], API_ISSUE.url);
});

test('initGithub dry run plans the item-add with the linked URL, and a link that is no issue URL is ignored with a warning', async () => {
  const root = workspace({ github: { owner: 'fernhill', repo: 'fernhill-lending-workspace', project_number: 4, links: { 'S-01': API_ISSUE.url } } });
  const gh = fakeGh();
  const dry = await initGithub(root, { owner: 'fernhill', exec: gh.exec, dryRun: true });
  assert.equal(dry.error, null, dry.error);
  assert.ok(dry.planned.some((l) => l.includes('item-add') && l.includes(API_ISSUE.url)), dry.planned.join('\n'));
  assert.equal(dry.planned.some((l) => l.includes('[S-01]') && l.includes('issue create')), false);
  const bad = workspace({ github: { owner: 'fernhill', repo: 'fernhill-lending-workspace', project_number: 4, links: { 'S-01': 'https://example.com/x/issues/7' } } });
  const g2 = fakeGh();
  const r = await initGithub(bad, { owner: 'fernhill', exec: g2.exec });
  assert.equal(r.error, null);
  assert.ok(r.warnings.some((w) => /S-01/.test(w) && /not a GitHub issue/.test(w)), r.warnings.join('\n'));
  assert.equal(calls(g2, 'issue', 'create').some((c) => c.includes('[S-01] Apply for a loan')), true, 'with no usable link the slice gets its own issue');
});

test('the CLI reads --accept with the repository in front of the number, and prints the refs', async () => {
  const root = workspace();
  const gh = fakeGh();
  const out = [];
  const err = [];
  const io = { cwd: root, env: {}, exec: gh.exec, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  assert.equal(await run(['adopt', 'board'], io), 0, err.join(''));
  assert.match(out.join(''), /api#7 "Apply for a loan" -> S-01/);
  out.length = 0;
  assert.equal(await run(['adopt', 'board', '--accept', 'api#7=S-01'], io), 0, err.join(''));
  assert.match(out.join(''), /Linked: S-01=https:\/\/github\.com\/fernhill\/fernhill-api\/issues\/7/);
  for (const bad of ['api#=S-01', '#7=S-01', 'Api#7=S-01', 'api#7', '7=S-01,api#x=S-02']) {
    err.length = 0;
    assert.equal(await run(['adopt', 'board', '--accept', bad], io), 2, bad);
  }
});

test('/board finds the linked issue of a code repository: its item, its comment and its state', () => {
  const root = join(mkdtempSync(join(tmpdir(), 'recade-match-')), 'p');
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({
    version: 1, mode: 'scratch', lots: [], repos: [ENTRY('api', `https://github.com/${API}.git`)], github: { owner: 'fernhill', repo: 'fernhill-lending-workspace', project_number: 7, links: { 'S-01': API_ISSUE.url } },
  }));
  writeFileSync(join(root, 'slices', 'S-01-apply.md'), SHEET('S-01', 'Apply for a loan', 'src/apply/**').replace('## Scope', '## Definition of Done\n\n- [x] `make test` (3 tests) is green\n\n## Scope'));
  writeFileSync(join(root, 'slices', 'STATUS.md'), '# Slice status\n\n| Slice | Title | Format | Lane | Increment | State | Depends on | Size | Note |\n|---|---|---|---|---|---|---|---|---|\n| S-01 | Apply for a loan | small | standard | INC-1 | ready-to-merge | | S | |\n');
  const calls = [];
  const options = ['Backlog', 'Ready', 'In progress', 'In review', 'Done'].map((name, i) => ({ id: `opt_${i}`, name }));
  const item = { id: 'PVTI_1', title: 'Apply for a loan', status: 'In review', content: { url: API_ISSUE.url, number: 7, type: 'Issue' } };
  const ok = (d) => ({ code: 0, stdout: typeof d === 'string' ? d : JSON.stringify(d), stderr: '' });
  const exec = (cmd) => {
    const args = cmd.slice(1);
    calls.push(args);
    const [a, b] = args;
    if (a === 'project' && b === 'view') return ok({ number: 7, id: 'PVT_board' });
    if (a === 'project' && b === 'field-list') return ok({ fields: [{ id: 'F_status', name: 'Status', options }], totalCount: 1 });
    if (a === 'project' && b === 'item-list') return ok({ items: [item], totalCount: 1 });
    if (a === 'issue' && b === 'list') return ok([]);
    if (a === 'issue' && b === 'view') return ok({ number: 7, title: 'Apply for a loan', url: API_ISSUE.url, state: 'OPEN' });
    if (a === 'pr' && b === 'view') return ok({ number: 12, state: 'MERGED', mergedAt: '2026-11-13T10:00:00Z', url: 'https://github.com/fernhill/fernhill-api/pull/12', headRefOid: 'a'.repeat(40), baseRefName: 'main' });
    if (a === 'project' && b === 'item-edit') return ok({});
    if (a === 'issue' && b === 'comment') return ok('https://github.com/x\n');
    if (a === 'issue' && b === 'close') return ok('');
    return { code: 1, stdout: '', stderr: `unexpected call: ${args.join(' ')}` };
  };
  const result = reconcile(root, { exec, apply: true });
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.find((r) => r.id === 'S-01').reason?.includes('not on the board') ?? false, false);
  assert.ok(calls.some((c) => c[0] === 'project' && c[1] === 'item-edit' && c.includes('PVTI_1')), 'the item of the linked issue is moved');
  const comment = calls.find((c) => c[0] === 'issue' && c[1] === 'comment');
  assert.equal(comment[2], '7');
  assert.equal(comment[comment.indexOf('--repo') + 1], API, 'the comment goes to the repository of the linked issue');
  const close = calls.find((c) => c[0] === 'issue' && c[1] === 'close');
  assert.equal(close[close.indexOf('--repo') + 1], API, 'and so does the close');
});

test('matching before github init: the code repository issues are linked first, so init creates no issue for that slice', async () => {
  const root = workspace({ github: null });
  const gh = fakeGh();
  gh.noWorkspaceRepo = true;
  const exec = gh.exec;
  // The workspace has no GitHub repository: not on GitHub, and no origin in the folder.
  const wrapped = async (cmd, args) => {
    if (cmd === 'git' && args[2] === 'remote' && args[3] === 'get-url' && gh.noWorkspaceRepo) return { code: 2, stdout: '', stderr: "error: No such remote 'origin'" };
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view' && args[2] === WS && gh.noWorkspaceRepo) return { code: 1, stdout: '', stderr: `GraphQL: Could not resolve to a Repository with the name '${WS}'. (repository)` };
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'create') {
      gh.noWorkspaceRepo = false;
      gh.issues[WS] = [];
      return { code: 0, stdout: `https://github.com/${args[2]}\n`, stderr: '' };
    }
    if (cmd === 'git' && args[2] === 'remote' && args[3] === 'add') return { code: 0, stdout: '', stderr: '' };
    return exec(cmd, args);
  };
  const early = await adoptBoard(root, { exec: wrapped, owner: 'fernhill', accept: [{ issue: 7, repo: 'api', slice: 'S-01' }] });
  assert.equal(early.error, null, early.error);
  assert.deepEqual(stateOf(root).github, { owner: 'fernhill', links: { 'S-01': API_ISSUE.url } });
  // An issue of the workspace cannot be named before the repository exists.
  const nameless = await adoptBoard(workspace({ github: null }), { exec: wrapped, owner: 'fernhill', accept: [{ issue: 7, slice: 'S-01' }] });
  assert.match(nameless.error, /must name its code repository/);
  const r = await initGithub(root, { owner: 'fernhill', exec: wrapped });
  assert.equal(r.error, null, r.error);
  const creates = calls(gh, 'issue', 'create');
  assert.deepEqual(creates.map((c) => c[c.indexOf('--title') + 1]), ['[S-02] Schedule a payout']);
  assert.equal(calls(gh, 'project', 'item-add').some((c) => c.includes(API_ISSUE.url)), true);
  assert.equal(stateOf(root).github.links['S-01'], API_ISSUE.url);
});

const STRANGER = 'https://github.com/stranger/other/issues/3';

test('a link must point to the workspace repository or to the GitHub remote of a registered code repository: initGithub and /board ignore any other', async () => {
  const links = { 'S-01': STRANGER };
  const root = workspace({ github: { owner: 'fernhill', repo: 'fernhill-lending-workspace', project_number: 4, links } });
  const gh = fakeGh();
  gh.issues['stranger/other'] = [{ number: 3, title: 'Not ours', url: STRANGER, labels: [] }];
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null, r.error);
  assert.ok(r.warnings.some((w) => /S-01/.test(w) && /not an issue of the workspace repository or of a code repository/.test(w)), r.warnings.join('\n'));
  assert.equal(calls(gh, 'project', 'item-add').some((c) => c.includes(STRANGER)), false, 'nothing of the stranger reaches the board');
  assert.equal(calls(gh, 'issue', 'create').some((c) => c.includes('[S-01] Apply for a loan')), true);
  // The workspace repository and a registered remote are fine.
  for (const url of [`https://github.com/${WS}/issues/5`, API_ISSUE.url]) {
    const ok = workspace({ github: { owner: 'fernhill', repo: 'fernhill-lending-workspace', project_number: 4, links: { 'S-01': url } } });
    const g = fakeGh();
    g.issues[WS] = [{ number: 5, title: 'Mine', url: `https://github.com/${WS}/issues/5`, labels: [] }];
    const done = await initGithub(ok, { owner: 'fernhill', exec: g.exec });
    assert.equal(done.error, null, done.error);
    assert.equal(calls(g, 'project', 'item-add').some((c) => c.includes(url)), true, url);
  }
  // /board does not even ask about it.
  const probe = [];
  const state = stringify({ version: 1, mode: 'scratch', lots: [], github: { owner: 'fernhill', repo: 'fernhill-lending-workspace', project_number: 7, links } });
  const dir = join(mkdtempSync(join(tmpdir(), 'recade-match-')), 'p');
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'recade', 'state.yaml'), state);
  writeFileSync(join(dir, 'slices', 'S-01-apply.md'), SHEET('S-01', 'Apply for a loan', 'src/apply/**'));
  const ok = (d) => ({ code: 0, stdout: JSON.stringify(d), stderr: '' });
  reconcile(dir, {
    exec: (cmd) => {
      const args = cmd.slice(1);
      probe.push(args);
      if (args[1] === 'view' && args[0] === 'project') return ok({ number: 7, id: 'PVT' });
      if (args[1] === 'field-list') return ok({ fields: [{ id: 'F', name: 'Status', options: [{ id: 'o', name: 'Done' }] }] });
      if (args[1] === 'item-list') return ok({ items: [] });
      if (args[1] === 'list') return ok([]);
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  });
  assert.equal(probe.some((a) => a.includes(STRANGER)), false);
});

test('the CLI commits the board and the links it records: a workspace under git is clean, so github init is not refused as a foreign edit', async () => {
  const root = workspace();
  const git = (...args) => spawnSync('git', ['-C', root, '-c', 'user.name=ci', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  assert.equal(git('init', '-q', '-b', 'main').status, 0);
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-q', '-m', 'chore: start').status, 0);
  const gh = fakeGh();
  const out = [];
  const err = [];
  const io = { cwd: root, env: {}, exec: gh.exec, run: (cmd, opts) => { const r = spawnSync(cmd[0], cmd.slice(1), { cwd: opts.cwd, encoding: 'utf8' }); return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }; }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  assert.equal(await run(['adopt', 'board', '--project', '4', '--accept', 'api#7=S-01'], io), 0, err.join(''));
  assert.deepEqual(stateOf(root).github.links, { 'S-01': API_ISSUE.url });
  assert.equal(git('status', '--porcelain').stdout, '', `nothing left to commit: ${err.join('')}`);
  assert.equal(git('log', '-1', '--format=%s').stdout.trim(), 'chore(recade): adopt board recorded');
  const before = git('rev-list', '--count', 'HEAD').stdout;
  assert.equal(await run(['adopt', 'board', '--project', '4', '--accept', 'api#7=S-01'], io), 0, err.join(''));
  assert.equal(git('rev-list', '--count', 'HEAD').stdout, before, 'a second run with nothing new commits nothing');
});
