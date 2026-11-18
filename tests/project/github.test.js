import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { writeOwnFile } from '../../src/project/adopt.js';
import { initGithub, adoptBoard } from '../../src/project/github.js';
import { run } from '../../src/cli.js';

const PLAN = `---
doc_id: PLAN
project: "Fernhill Lending"
---

# Fernhill Lending, delivery plan

## Backlog

| ID | Lot | Item | Size | Points | Depends on | Sprint | Phase | Status | Comment |
|---|---|---|---|---|---|---|---|---|---|
| LOAN-01 | Core | Apply for a loan | M | 2 | | 1 | Build | todo | |
| PAY-01 | Payments | Schedule a payout | S | | | 2 | Build | todo | |
`;

const SHEET = (id, lane, size) => `---
doc_id: ${id}
title: "Slice ${id}"
repos: [app]
branch: slice/${id.toLowerCase()}
format: small
lane: ${lane}
implementer: implementer
increment: INC-1
depends_on: []
blocks: []
external_prerequisite: none
provisionals_used: []
size: ${size}
touches:
  - "src/${id.toLowerCase()}/**"
---

# ${id}: Slice ${id}

## Scope

- LOAN-01 (the gist)
`;

function project({ plan = PLAN } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'recade-gh-'));
  const root = join(base, 'fernhill-lending');
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', lots: ['LOAN', 'PAY'] }));
  if (plan !== null) writeFileSync(join(root, 'docs', 'PLAN.md'), plan);
  writeFileSync(join(root, 'slices', 'S-01-apply.md'), SHEET('S-01', 'sensitive', 'L'));
  writeFileSync(join(root, 'slices', 'S-02-payout.md'), SHEET('S-02', 'standard', 'S'));
  return root;
}

const stateOf = (root) => parse(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8'));

/**
 * A fake `gh` that keeps a small GitHub in memory. `failOn(args)` returns true to make a call fail.
 * Every call is recorded in `calls`.
 */
function fakeGh({ failOn = () => false, visibility = 'PRIVATE' } = {}) {
  const gh = {
    repos: new Map(), projects: [], fields: [], issues: [], items: [], calls: [], gitCalls: [], nextId: 1,
    hasCommit: true, origin: null, remoteRefs: false, gitFail: () => false,
    codeDirs: new Map(), // code repository folders: each has its own commit, origin and remote branches
  };
  const ok = (data) => ({ code: 0, stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' });
  const flag = (args, name) => args[args.indexOf(name) + 1];
  const gitExec = (args) => {
    const [, dir, a, b] = args; // args start with -C <root>
    gh.gitCalls.push(args.slice(2));
    if (gh.gitFail(args.slice(2))) return { code: 128, stdout: '', stderr: 'fatal: could not read Username' };
    const code = gh.codeDirs.get(dir);
    if (code !== undefined) {
      if (a === 'rev-parse') return code.hasCommit ? ok('abc123\n') : { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
      if (a === 'remote' && b === 'get-url') return code.origin ? ok(`${code.origin}\n`) : { code: 2, stdout: '', stderr: "error: No such remote 'origin'" };
      if (a === 'remote' && b === 'add') { code.origin = args[5]; return ok(''); }
      if (a === 'ls-remote') return ok(code.remoteRefs ? 'abc123\trefs/heads/main\n' : '');
      if (a === 'push') { code.remoteRefs = true; return ok(''); }
      return { code: 1, stdout: '', stderr: `unexpected git call in a code repository: ${args.join(' ')}` };
    }
    if (a === 'rev-parse') return gh.hasCommit ? ok('abc123\n') : { code: 128, stdout: '', stderr: 'fatal: Needed a single revision' };
    if (a === 'remote' && b === 'get-url') return gh.origin ? ok(`${gh.origin}\n`) : { code: 2, stdout: '', stderr: "error: No such remote 'origin'" };
    if (a === 'remote' && b === 'add') { gh.origin = args[5]; return ok(''); }
    if (a === 'ls-remote') return ok(gh.remoteRefs ? 'abc123\trefs/heads/main\n' : '');
    if (a === 'push') { gh.remoteRefs = true; return ok(''); }
    return { code: 1, stdout: '', stderr: `unexpected git call: ${args.join(' ')}` };
  };
  gh.exec = async (cmd, args) => {
    if (cmd === 'git') return gitExec(args);
    gh.calls.push([cmd, ...args]);
    assert.equal(cmd, 'gh');
    if (failOn(args)) return { code: 1, stdout: '', stderr: 'boom: simulated failure\nsecond line' };
    const [a, b] = args;
    if (a === 'repo' && b === 'view') {
      const name = args[2];
      return gh.repos.has(name)
        ? ok({ name: name.split('/')[1], visibility: typeof gh.repos.get(name) === 'string' ? gh.repos.get(name) : visibility })
        : { code: 1, stdout: '', stderr: `GraphQL: Could not resolve to a Repository with the name '${name}'. (repository)` };
    }
    if (a === 'repo' && b === 'create') {
      gh.repos.set(args[2], args.includes('--public') ? 'PUBLIC' : (args.includes('--internal') ? 'INTERNAL' : 'PRIVATE'));
      const code = gh.codeDirs.get(flag(args, '--source'));
      const target = code ?? gh;
      target.origin = `https://github.com/${args[2]}.git`;
      target.remoteRefs = true;
      return ok(`https://github.com/${args[2]}\n`);
    }
    if (a === 'project' && b === 'list') return ok({ projects: gh.projects, totalCount: gh.projects.length });
    if (a === 'project' && b === 'view') {
      const p = gh.projects.find((x) => String(x.number) === args[2]);
      return p ? ok(p) : { code: 1, stdout: '', stderr: `GraphQL: Could not resolve to a ProjectV2 with the number ${args[2]}.` };
    }
    if (a === 'project' && b === 'create') {
      const p = { number: gh.projects.length + 1, id: `PVT_${gh.nextId++}`, title: flag(args, '--title') };
      gh.projects.push(p);
      if (gh.projects.length === 1) gh.fields.push({ id: 'F_status', name: 'Status', type: 'ProjectV2SingleSelectField', options: ['Todo', 'In Progress', 'Done'].map((n, i) => ({ id: `O_${i}`, name: n })) });
      return ok(p);
    }
    if (a === 'project' && b === 'field-list') return ok({ fields: gh.fields, totalCount: gh.fields.length });
    if (a === 'project' && b === 'field-create') {
      const name = flag(args, '--name');
      const type = flag(args, '--data-type');
      const f = { id: `F_${gh.nextId++}`, name, type: type === 'SINGLE_SELECT' ? 'ProjectV2SingleSelectField' : 'ProjectV2Field' };
      if (type === 'SINGLE_SELECT') f.options = flag(args, '--single-select-options').split(',').map((n) => ({ id: `O_${gh.nextId++}`, name: n }));
      gh.fields.push(f);
      return ok(f);
    }
    if (a === 'api' && b === 'graphql') {
      const query = args.find((x) => x.startsWith('query='));
      if (query.includes('createProjectV2Field')) {
        gh.fields.push({ id: `F_${gh.nextId++}`, name: 'Sprint', type: 'ProjectV2IterationField' });
      } else {
        const status = gh.fields.find((f) => f.name === 'Status');
        status.options = ['Backlog', ...status.options.map((o) => o.name)].map((n) => ({ id: `O_${gh.nextId++}`, name: n }));
      }
      return ok({ data: {} });
    }
    if (a === 'issue' && b === 'list') {
      return ok(gh.issues);
    }
    if (a === 'issue' && b === 'create') {
      const i = { number: gh.issues.length + 1, title: flag(args, '--title'), url: `https://github.com/${flag(args, '--repo')}/issues/${gh.issues.length + 1}` };
      gh.issues.push(i);
      return ok(`${i.url}\n`);
    }
    if (a === 'project' && b === 'item-list') return ok({ items: gh.items, totalCount: gh.items.length });
    if (a === 'project' && b === 'item-add') {
      const url = flag(args, '--url');
      const issue = gh.issues.find((i) => i.url === url);
      const item = { id: `PVTI_${gh.nextId++}`, title: issue.title, content: { url, number: issue.number, type: 'Issue', title: issue.title } };
      gh.items.push(item);
      return ok(item);
    }
    if (a === 'project' && b === 'item-edit') {
      const item = gh.items.find((i) => i.id === flag(args, '--id'));
      const field = gh.fields.find((f) => f.id === flag(args, '--field-id'));
      const optionId = args.includes('--single-select-option-id') ? flag(args, '--single-select-option-id') : null;
      const value = optionId === null
        ? (args.includes('--number') ? Number(flag(args, '--number')) : flag(args, '--text') ?? flag(args, '--date'))
        : field.options.find((o) => o.id === optionId).name;
      item[field.name.toLowerCase()] = value;
      return ok({});
    }
    return { code: 1, stdout: '', stderr: `unexpected call: ${args.join(' ')}` };
  };
  return gh;
}

const writes = (gh) => gh.calls.filter(([, a, b]) => (
  (a === 'repo' && b === 'create') || (a === 'project' && ['create', 'field-create', 'item-add', 'item-edit'].includes(b))
  || (a === 'issue' && b === 'create') || (a === 'api' && b === 'graphql')));
const itemOf = (gh, id) => gh.items.find((i) => i.title.startsWith(`[${id}]`));

test('first run creates the repository, the project, the fields, the issues and the items, then records the state', async () => {
  const root = project();
  const gh = fakeGh();
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.equal(r.repo, 'fernhill/fernhill-lending');
  assert.equal(r.project, 1);
  assert.deepEqual([...gh.repos.keys()], ['fernhill/fernhill-lending']);
  const create = gh.calls.find(([, a, b]) => a === 'repo' && b === 'create');
  assert.deepEqual(create, ['gh', 'repo', 'create', 'fernhill/fernhill-lending', '--private', '--source', root, '--push']);
  assert.equal(gh.projects[0].title, 'Fernhill Lending delivery');
  assert.deepEqual(gh.fields.map((f) => f.name).sort(), ['Due', 'Increment', 'Lane', 'Owner', 'Points', 'Priority', 'Sprint', 'Status']);
  assert.deepEqual(gh.issues.map((i) => i.title), [
    '[LOAN-01] Apply for a loan', '[PAY-01] Schedule a payout', '[S-01] Slice S-01', '[S-02] Slice S-02',
  ]);
  assert.equal(gh.items.length, 4);
  assert.deepEqual(r.created.filter((c) => c.startsWith('repo') || c.startsWith('project')), ['repo fernhill/fernhill-lending', 'project 1']);
  assert.ok(r.created.includes('field Lane') && r.created.includes('issue [S-01]') && r.created.includes('item [S-01]'));
  assert.deepEqual(stateOf(root).github, { owner: 'fernhill', repo: 'fernhill-lending', project_number: 1 });
});

test('field values come from the sheets and the backlog, Sprint and Increment stay empty when unknown', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.deepEqual(
    { status: itemOf(gh, 'S-01').status, lane: itemOf(gh, 'S-01').lane, points: itemOf(gh, 'S-01').points, increment: itemOf(gh, 'S-01').increment },
    { status: 'Backlog', lane: 'sensitive', points: 3, increment: 'INC-1' },
  );
  assert.equal(itemOf(gh, 'S-02').points, 1);
  assert.equal(itemOf(gh, 'S-02').lane, 'standard');
  assert.equal(itemOf(gh, 'LOAN-01').points, 2);
  assert.equal(itemOf(gh, 'LOAN-01').status, 'Backlog');
  assert.equal(itemOf(gh, 'LOAN-01').increment, undefined);
  assert.equal(itemOf(gh, 'LOAN-01').lane, undefined);
  assert.equal(itemOf(gh, 'PAY-01').points, undefined);
  for (const item of gh.items) assert.equal(item.sprint, undefined);
});

test('field and option ids are read back from the board, never hard-coded', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const listCalls = gh.calls.filter(([, a, b]) => a === 'project' && b === 'field-list');
  assert.ok(listCalls.length >= 1);
  assert.ok(listCalls[0].includes('--format') && listCalls[0].includes('json'));
  const edits = gh.calls.filter(([, a, b]) => a === 'project' && b === 'item-edit');
  const known = new Set(gh.fields.flatMap((f) => [f.id, ...(f.options ?? []).map((o) => o.id)]));
  for (const e of edits) {
    assert.ok(known.has(e[e.indexOf('--field-id') + 1]));
    assert.ok(e.includes('--project-id') && e[e.indexOf('--project-id') + 1] === gh.projects[0].id);
  }
});

test('a second run creates nothing and does not write on GitHub', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  gh.calls.length = 0;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.deepEqual(r.created, []);
  assert.deepEqual(writes(gh), []);
  assert.equal(gh.issues.length, 4);
  assert.equal(gh.items.length, 4);
  assert.deepEqual(stateOf(root).github, { owner: 'fernhill', repo: 'fernhill-lending', project_number: 1 });
});

test('an issue is found by its [ID] prefix, and a longer ID with the same start is not a match', async () => {
  const root = project();
  const gh = fakeGh();
  gh.repos.set('fernhill/fernhill-lending', true);
  gh.origin = 'https://github.com/fernhill/fernhill-lending.git';
  gh.remoteRefs = true;
  gh.issues.push({ number: 1, title: '[LOAN-010] Something else', url: 'https://github.com/fernhill/fernhill-lending/issues/1' });
  gh.issues.push({ number: 2, title: '[PAY-01] Schedule a payout', url: 'https://github.com/fernhill/fernhill-lending/issues/2' });
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const titles = gh.issues.map((i) => i.title);
  assert.equal(titles.filter((t) => t.startsWith('[PAY-01]')).length, 1);
  assert.ok(titles.includes('[LOAN-01] Apply for a loan'));
  const lists = gh.calls.filter(([, a, b]) => a === 'issue' && b === 'list');
  assert.equal(lists.length, 1);
  assert.ok(lists[0].includes('--json') && lists[0].includes('--repo') && lists[0].includes('--state') && lists[0].includes('1000'));
  assert.equal(lists[0].includes('--search'), false);
});

test('a failed project creation stops with the repository recorded, and the rerun creates only the rest', async () => {
  const root = project();
  const gh = fakeGh({ failOn: (args) => args[0] === 'project' && args[1] === 'create' });
  const first = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(first.error, /project create/);
  assert.match(first.error, /boom: simulated failure/);
  assert.equal(first.error.includes('second line'), false);
  assert.deepEqual(first.created, ['repo fernhill/fernhill-lending']);
  assert.equal(first.project, null);
  assert.equal(gh.issues.length, 0);
  assert.deepEqual(stateOf(root).github, { owner: 'fernhill', repo: 'fernhill-lending' });
  const again = fakeGh();
  again.repos = gh.repos;
  again.origin = gh.origin;
  again.remoteRefs = gh.remoteRefs;
  const second = await initGithub(root, { owner: 'fernhill', exec: again.exec });
  assert.equal(second.error, null);
  assert.equal(again.calls.some(([, a, b]) => a === 'repo' && b === 'create'), false);
  assert.equal(second.created.some((c) => c.startsWith('repo') || c.startsWith('push')), false);
  assert.deepEqual(again.gitCalls.filter(([a]) => a === 'push'), []);
  assert.ok(second.created.includes('project 1') && second.created.includes('issue [S-01]'));
  assert.equal(stateOf(root).github.project_number, 1);
});

test('a failure in the middle of the issues stops there, and the rerun finishes the others', async () => {
  const root = project();
  let issueCalls = 0;
  const gh = fakeGh({ failOn: (args) => args[0] === 'issue' && args[1] === 'create' && ++issueCalls === 3 });
  const first = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.ok(first.error);
  assert.equal(gh.issues.length, 2);
  assert.equal(gh.items.length, 2);
  assert.ok(first.created.includes('issue [PAY-01]') && !first.created.includes('issue [S-01]'));
  issueCalls = -100;
  const second = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(second.error, null);
  assert.deepEqual(second.created.filter((c) => c.startsWith('issue')), ['issue [S-01]', 'issue [S-02]']);
  assert.equal(gh.issues.length, 4);
  assert.equal(gh.items.length, 4);
});

test('values missing on an existing item are filled, values already there are never overwritten', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const item = itemOf(gh, 'S-01');
  delete item.lane;
  item.status = 'In progress';
  gh.calls.length = 0;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.equal(item.lane, 'sensitive');
  assert.equal(item.status, 'In progress');
  assert.equal(gh.calls.filter(([, a, b]) => a === 'project' && b === 'item-edit').length, 1);
});

test('a dry run calls nothing that writes, writes no state and lists the planned calls', async () => {
  const root = project();
  const gh = fakeGh();
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, dryRun: true });
  assert.equal(r.error, null);
  assert.deepEqual(writes(gh), []);
  assert.deepEqual(r.created, []);
  assert.equal(stateOf(root).github, undefined);
  const text = r.planned.join('\n');
  assert.ok(text.includes('gh repo create fernhill/fernhill-lending --private --source'));
  assert.ok(text.includes('--push'));
  assert.ok(text.includes("gh project create --owner fernhill --title 'Fernhill Lending delivery'"));
  for (const f of ['Status', 'Increment', 'Sprint', 'Lane', 'Points', 'Priority', 'Due', 'Owner']) assert.ok(text.includes(f), f);
  for (const t of ['[LOAN-01] Apply for a loan', '[PAY-01] Schedule a payout', '[S-01] Slice S-01', '[S-02] Slice S-02']) assert.ok(text.includes(t), t);
});

test('a dry run on a finished board plans nothing', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, dryRun: true });
  assert.deepEqual(r.planned, []);
});

test('a public repository that already exists is refused', async () => {
  const root = project();
  const gh = fakeGh({ visibility: 'PUBLIC' });
  gh.repos.set('fernhill/fernhill-lending', true);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(r.error, /private/i);
  assert.deepEqual(gh.gitCalls.filter(([a]) => a === 'push'), []);
  assert.deepEqual(writes(gh), []);
});

test('an error that is not "not found" on repo view stops before any write', async () => {
  const root = project();
  const gh = fakeGh();
  const exec = async (cmd, args) => (args[0] === 'repo' && args[1] === 'view'
    ? { code: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login' }
    : gh.exec(cmd, args));
  const r = await initGithub(root, { owner: 'fernhill', exec });
  assert.match(r.error, /gh auth login/);
  assert.deepEqual(writes(gh), []);
});

test('an exec that throws is a failure, not a crash, and an unsafe owner is refused', async () => {
  const root = project();
  const r = await initGithub(root, { owner: 'fernhill', exec: async () => { throw new Error('spawn gh ENOENT'); } });
  assert.match(r.error, /ENOENT/);
  const bad = await initGithub(root, { owner: '--evil', exec: async () => assert.fail('no call') });
  assert.match(bad.error, /owner/i);
});

test('a project without a commit fails early with a clear message and creates nothing', async () => {
  const root = project();
  const gh = fakeGh();
  gh.hasCommit = false;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(r.error, /no commit yet/);
  assert.deepEqual(writes(gh), []);
  assert.equal(gh.repos.size, 0);
});

test('a dry run without a first commit plans the commit instead of failing', async () => {
  const root = project();
  const gh = fakeGh();
  gh.hasCommit = false;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, dryRun: true });
  assert.equal(r.error, null);
  assert.deepEqual(writes(gh), []);
  assert.equal(gh.repos.size, 0);
  const commits = r.planned.filter((l) => / commit -m /.test(l));
  assert.equal(commits.length, 1);
  assert.match(r.planned[0], /git -C \S+ add -A/);
  assert.ok(r.planned.some((l) => l.includes('gh repo create fernhill/fernhill-lending')));
  assert.ok(r.planned.some((l) => l.includes('[S-01] Slice S-01')));
});

test('a failed repo create, ls-remote or push tells to run gh auth setup-git', async () => {
  const create = await initGithub(project(), { owner: 'fernhill', exec: fakeGh({ failOn: (a) => a[0] === 'repo' && a[1] === 'create' }).exec });
  assert.match(create.error, /repo create failed/);
  assert.match(create.error, /gh auth setup-git/);
  assert.ok(!create.error.includes('\n'));
  for (const verb of ['ls-remote', 'push']) {
    const gh = fakeGh();
    gh.repos.set('fernhill/fernhill-lending', true);
    gh.origin = 'https://github.com/fernhill/fernhill-lending.git';
    gh.remoteRefs = false;
    gh.gitFail = (a) => a[0] === verb;
    const r = await initGithub(project(), { owner: 'fernhill', exec: gh.exec });
    assert.match(r.error, new RegExp(`git ${verb} failed`));
    assert.match(r.error, /gh auth setup-git/);
  }
});

test('an existing repository whose remote has no branch gets a push, and one that has branches does not', async () => {
  const root = project();
  const gh = fakeGh();
  gh.repos.set('fernhill/fernhill-lending', true);
  gh.origin = 'https://github.com/fernhill/fernhill-lending.git';
  const dry = await initGithub(root, { owner: 'fernhill', exec: gh.exec, dryRun: true });
  assert.ok(dry.planned[0].startsWith('git -C '));
  assert.ok(dry.planned[0].endsWith('push -u origin HEAD'));
  assert.deepEqual(gh.gitCalls.filter(([a]) => a === 'push'), []);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.deepEqual(gh.gitCalls.filter(([a]) => a === 'push'), [['push', '-u', 'origin', 'HEAD']]);
  assert.ok(r.created.includes('push fernhill/fernhill-lending'));
  const again = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(again.error, null);
  assert.equal(gh.gitCalls.filter(([a]) => a === 'push').length, 1);
});

test('an existing repository with no origin remote gets one before the push', async () => {
  const root = project();
  const gh = fakeGh();
  gh.repos.set('fernhill/fernhill-lending', true);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.deepEqual(gh.gitCalls.filter(([a]) => a === 'remote' && gh.gitCalls.length).map((c) => c[1]), ['get-url', 'add']);
  assert.equal(gh.origin, 'https://github.com/fernhill/fernhill-lending.git');
  assert.equal(gh.gitCalls.filter(([a]) => a === 'push').length, 1);
});

test('the Backlog option is added to Status only on a board without items', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const status = gh.fields.find((f) => f.name === 'Status');
  assert.deepEqual(status.options.map((o) => o.name), ['Backlog', 'Todo', 'In Progress', 'Done']);
});

test('a board with items and no Backlog option stops with a message and never rewrites the options', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const status = gh.fields.find((f) => f.name === 'Status');
  status.options = status.options.filter((o) => o.name !== 'Backlog');
  gh.calls.length = 0;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(r.error, /"Backlog" option to Status by hand/);
  assert.deepEqual(writes(gh), []);
});

test('an item is matched by issue number and repository when its URL differs', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const item = itemOf(gh, 'S-01');
  item.content = { number: 3, repository: 'fernhill/fernhill-lending', type: 'Issue' };
  gh.calls.length = 0;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.deepEqual(writes(gh), []);
  assert.equal(gh.items.length, 4);
});

test('an unknown Lane value is skipped with a warning, the run goes on', async () => {
  const root = project();
  writeFileSync(join(root, 'slices', 'S-01-apply.md'), SHEET('S-01', 'sensitive', 'L').replace('lane: sensitive', 'lane: weird'));
  const gh = fakeGh();
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.equal(itemOf(gh, 'S-01').lane, undefined);
  assert.equal(itemOf(gh, 'S-01').points, 3);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /\[S-01\].*Lane.*"weird"/);
});

test('a closed board is found by the project list', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const list = gh.calls.find(([, a, b]) => a === 'project' && b === 'list');
  assert.ok(list.includes('--closed'));
});

test('a closed board found by the lookup prints a warning', async () => {
  const root = project();
  const gh = fakeGh();
  gh.repos.set('fernhill/fernhill-lending', true);
  gh.origin = 'https://github.com/fernhill/fernhill-lending.git';
  gh.remoteRefs = true;
  gh.projects.push({ number: 7, id: 'PVT_x', title: 'Fernhill Lending delivery', closed: true });
  gh.fields.push({ id: 'F_status', name: 'Status', type: 'ProjectV2SingleSelectField', options: [{ id: 'O_b', name: 'Backlog' }] });
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, dryRun: true });
  assert.equal(r.error, null);
  assert.equal(r.project, 7);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /board 7 is closed/);
});

test('the board list reads up to 1000 projects', async () => {
  const gh = fakeGh();
  await initGithub(project(), { owner: 'fernhill', exec: gh.exec });
  const list = gh.calls.find(([, a, b]) => a === 'project' && b === 'list');
  assert.equal(list[list.indexOf('--limit') + 1], '1000');
});

test('a renamed PLAN project does not create a second board, and the recorded repository is used', async () => {
  const root = project();
  const gh = fakeGh();
  assert.equal((await initGithub(root, { owner: 'fernhill', exec: gh.exec })).error, null);
  writeFileSync(join(root, 'docs', 'PLAN.md'), PLAN.replace('Fernhill Lending', 'Fernhill Credit'));
  gh.calls.length = 0;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.equal(gh.projects.length, 1);
  assert.equal(r.project, 1);
  assert.deepEqual(r.created, []);
  assert.ok(gh.calls.some((c) => c.slice(0, 3).join(' ') === 'gh project view'));
  assert.deepEqual(gh.calls.find((c) => c[1] === 'project' && c[2] === 'view'), ['gh', 'project', 'view', '1', '--owner', 'fernhill', '--format', 'json']);
  assert.ok(!gh.calls.some(([, a, b]) => a === 'project' && b === 'list'));
  assert.ok(!gh.calls.some(([, a, b]) => a === 'project' && b === 'create'));
});

test('a recorded repository name is used even when the folder is renamed', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  const moved = join(mkdtempSync(join(tmpdir(), 'recade-gh-')), 'other-name');
  cpSync(root, moved, { recursive: true });
  gh.calls.length = 0;
  const r = await initGithub(moved, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.equal(r.repo, 'fernhill/fernhill-lending');
  assert.deepEqual(gh.calls.find(([, a, b]) => a === 'repo' && b === 'view').slice(0, 3), ['gh', 'repo', 'view']);
  assert.equal(gh.calls.find(([, a, b]) => a === 'repo' && b === 'view')[3], 'fernhill/fernhill-lending');
  assert.deepEqual(writes(gh), []);
});

test('a recorded board that cannot be read stops the run and creates no other board', async () => {
  const root = project();
  const gh = fakeGh();
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  gh.projects.length = 0;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(r.error, /project view failed/);
  assert.equal(gh.projects.length, 0);
});

test('the Backlog option name loses its newlines in the mutation', async () => {
  const root = project();
  const gh = fakeGh();
  gh.repos.set('fernhill/fernhill-lending', true);
  gh.origin = 'https://github.com/fernhill/fernhill-lending.git';
  gh.remoteRefs = true;
  gh.projects.push({ number: 1, id: 'PVT_x', title: 'Fernhill Lending delivery' });
  gh.fields.push({ id: 'F_status', name: 'Status', type: 'ProjectV2SingleSelectField', options: [{ id: 'O_0', name: 'To\ndo' }, { id: 'O_1', name: 'Done' }] });
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  const query = gh.calls.map((c) => c.find((x) => String(x).includes('updateProjectV2Field'))).find(Boolean);
  assert.ok(query);
  assert.ok(!/[\r\n]/.test(query));
  assert.ok(query.includes('name: "To do"'));
});

test('a dry run on a new board does not plan the default Status field', async () => {
  const root = project();
  const gh = fakeGh();
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, dryRun: true });
  assert.equal(r.planned.some((l) => l.includes('field-create') && l.includes('--name Status')), false);
  assert.ok(r.planned.some((l) => l.includes('field-create') && l.includes('--name Lane')));
});

test('without a PLAN only the slices become issues', async () => {
  const root = project({ plan: null });
  const gh = fakeGh();
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.deepEqual(gh.issues.map((i) => i.title), ['[S-01] Slice S-01', '[S-02] Slice S-02']);
});

function cliIo(root, extra = {}, env = {}) {
  const out = []; const err = [];
  return {
    out, err,
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd: root, env: { HOME: root, ...env }, ...extra },
  };
}

test('recade github init --dry-run prints the plan, exits 0 and writes nothing', async () => {
  const root = project();
  const gh = fakeGh();
  const { io, out } = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--dry-run', '--owner', 'fernhill', '--project', root], io), 0);
  assert.ok(out.join('').includes('gh repo create fernhill/fernhill-lending --private'));
  assert.deepEqual(writes(gh), []);
});

test('recade github init runs the calls and exits 1 with what was created when one fails', async () => {
  const root = project();
  const gh = fakeGh({ failOn: (args) => args[0] === 'project' && args[1] === 'create' });
  const { io, out, err } = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--owner', 'fernhill', '--project', root], io), 1);
  assert.ok(out.join('').includes('repo fernhill/fernhill-lending'));
  assert.ok(err.join('').includes('project create'));
});

test('recade github init reads the owner from the config, and asks for it when there is none', async () => {
  const root = project();
  const gh = fakeGh();
  const none = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--project', root], none.io), 2);
  assert.match(none.err.join(''), /github_owner/);
  const dir = join(root, 'cfg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), stringify({ version: 1, github_owner: 'fernhill' }));
  const withCfg = cliIo(root, { exec: gh.exec }, { RECADE_CONFIG_DIR: dir });
  assert.equal(await run(['github', 'init', '--project', root], withCfg.io), 0, withCfg.err.join(''));
  assert.equal(stateOf(root).github.owner, 'fernhill');
});

test('recade github init saves --owner in the state and reads it first the next time', async () => {
  const root = project();
  const gh = fakeGh();
  const first = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--owner', 'fernhill', '--project', root], first.io), 0, first.err.join(''));
  assert.equal(stateOf(root).github.owner, 'fernhill');
  const dir = join(root, 'cfg');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), stringify({ version: 1, github_owner: 'someone-else' }));
  gh.calls.length = 0;
  const next = cliIo(root, { exec: gh.exec }, { RECADE_CONFIG_DIR: dir });
  assert.equal(await run(['github', 'init', '--project', root], next.io), 0, next.err.join(''));
  assert.ok(gh.calls.every((c) => !c.includes('someone-else')));
  assert.equal(stateOf(root).github.owner, 'fernhill');
});

test('recade github with a wrong sub-command or flag exits 2', async () => {
  const root = project();
  for (const argv of [['github'], ['github', 'push'], ['github', 'init', '--force'], ['github', 'init', '--owner']]) {
    const { io, err } = cliIo(root, { exec: async () => assert.fail('no call') });
    assert.equal(await run([...argv, '--project', root], io), 2, argv.join(' '));
    assert.match(err.join(''), /Usage: recade github init/);
  }
});

test('an existing issue the owner linked to a slice is added to the board, never duplicated or renamed', async () => {
  const root = project({ plan: null });
  writeOwnFile(root, 'docs/PLAN.md', PLAN); // in an adopted repository the PLAN is the one Recade wrote
  const state = stateOf(root);
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ ...state, mode: 'adopt', github: { owner: 'fernhill', repo: 'fernhill-lending', links: { 'S-01': 7 } } }));
  const gh = fakeGh();
  gh.repos.set('fernhill/fernhill-lending', true);
  gh.issues.push({ number: 7, title: 'Apply for a loan', url: 'https://github.com/fernhill/fernhill-lending/issues/7' });
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.deepEqual(gh.issues.map((i) => i.title), ['Apply for a loan', '[LOAN-01] Apply for a loan', '[PAY-01] Schedule a payout', '[S-02] Slice S-02']);
  assert.equal(gh.calls.some((c) => c[1] === 'issue' && c[2] === 'edit'), false, 'the title is not edited');
  const added = gh.calls.filter((c) => c[1] === 'project' && c[2] === 'item-add').map((c) => c[c.indexOf('--url') + 1]);
  assert.ok(added.includes('https://github.com/fernhill/fernhill-lending/issues/7'), 'the existing issue becomes the item of S-01');
  assert.ok(r.created.includes('item [S-01]') && !r.created.includes('issue [S-01]'));
  assert.equal(gh.items.find((i) => i.content.url.endsWith('/7')).status, 'Backlog', 'the board fields are set on it');
  assert.deepEqual(stateOf(root).github.links, { 'S-01': 7 }, 'the links are kept');
  const again = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.deepEqual(again.created, [], 'a second run creates nothing');
});

test('without the link the same existing issue would be duplicated, and a link to a missing issue warns and creates', async () => {
  const unlinked = project();
  const gh = fakeGh();
  gh.repos.set('fernhill/fernhill-lending', true);
  gh.issues.push({ number: 7, title: 'Apply for a loan', url: 'https://github.com/fernhill/fernhill-lending/issues/7' });
  assert.ok((await initGithub(unlinked, { owner: 'fernhill', exec: gh.exec })).created.includes('issue [S-01]'));
  const root = project();
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ ...stateOf(root), github: { owner: 'fernhill', repo: 'fernhill-lending', links: { 'S-01': 99 } } }));
  const other = fakeGh();
  other.repos.set('fernhill/fernhill-lending', true);
  const r = await initGithub(root, { owner: 'fernhill', exec: other.exec });
  assert.equal(r.error, null);
  assert.ok(r.warnings.some((w) => w.includes('[S-01]') && w.includes('#99')));
  assert.ok(r.created.includes('issue [S-01]'));
});

test('a list that reaches the limit stops the run: nothing is created on a truncated view', async () => {
  const root = project();
  const gh = fakeGh();
  gh.repos.set('fernhill/fernhill-lending', true);
  for (let i = 0; i < 1000; i++) gh.issues.push({ number: i + 100, title: `Other ${i}`, url: `https://github.com/fernhill/fernhill-lending/issues/${i + 100}` });
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(r.error, /1000 issues/);
  assert.match(r.error, /limit/);
  assert.equal(writes(gh).length > 0 && gh.calls.some((c) => c[1] === 'issue' && c[2] === 'create'), false, 'no issue is created');
});

// ---- the workspace repository and the code repositories beside it ----

const WS_SHEET = (id, lane, size, repo) => `---
doc_id: ${id}
title: "Slice ${id}"
repos: [${repo}]
branch: slice/${id.toLowerCase()}
format: small
lane: ${lane}
implementer: implementer
increment: INC-1
depends_on: []
blocks: []
external_prerequisite: none
provisionals_used: []
size: ${size}
touches:
  - "${repo}:src/${id.toLowerCase()}/**"
---

# ${id}: Slice ${id}

## Scope

- LOAN-01 (the private gist of the sheet)
`;

const ENTRY = (name, visibility, remote = 'none') => ({ name, path: `repos/${name}`, remote, default_branch: 'main', role: '', visibility });

/** A workspace folder (kind: workspace) with two registered code repositories that have no GitHub repository yet. */
function workspaceProject({ repos = [ENTRY('api', 'private'), ENTRY('web', 'public')] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'recade-ghw-'));
  const root = join(base, 'fernhill-lending-workspace');
  for (const d of ['recade', 'docs', 'slices']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, kind: 'workspace', mode: 'scratch', lots: ['LOAN', 'PAY'], repos }));
  writeFileSync(join(root, 'docs', 'PLAN.md'), PLAN);
  writeFileSync(join(root, 'slices', 'S-01-apply.md'), WS_SHEET('S-01', 'sensitive', 'L', 'api'));
  writeFileSync(join(root, 'slices', 'S-02-payout.md'), WS_SHEET('S-02', 'standard', 'S', 'web'));
  return root;
}

/** A fake gh whose code repository folders are known to the fake git. */
function workspaceGh(root, options) {
  const gh = fakeGh(options);
  for (const name of ['api', 'web']) gh.codeDirs.set(join(root, 'repos', name), { hasCommit: true, origin: null, remoteRefs: false });
  return gh;
}

const creates = (gh) => gh.calls.filter(([, a, b]) => a === 'repo' && b === 'create');

test('workspace: the workspace repository is created with --private only, and the board and issues land on it', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.equal(r.error, null);
  assert.equal(r.repo, 'fernhill/fernhill-lending-workspace');
  assert.deepEqual(creates(gh), [['gh', 'repo', 'create', 'fernhill/fernhill-lending-workspace', '--private', '--source', root, '--push']]);
  for (const flag of ['--public', '--internal']) assert.equal(creates(gh)[0].includes(flag), false);
  assert.equal(gh.projects[0].title, 'Fernhill Lending delivery', 'the board is named after the project, not after the workspace folder');
  const issueCalls = gh.calls.filter(([, a, b]) => a === 'issue' && b === 'create');
  assert.equal(issueCalls.length, 4);
  for (const c of issueCalls) assert.equal(c[c.indexOf('--repo') + 1], 'fernhill/fernhill-lending-workspace');
  assert.deepEqual(stateOf(root).github, { owner: 'fernhill', repo: 'fernhill-lending-workspace', project_number: 1 });
  assert.equal(stateOf(root).repos.every((e) => e.remote === 'none'), true, 'no code repository is created unless the owner said yes to it');
});

test('workspace: an issue body names the sheet file and never copies a word of the private sheet', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  for (const c of gh.calls.filter(([, a, b]) => a === 'issue' && b === 'create')) {
    const body = c[c.indexOf('--body') + 1];
    assert.doesNotMatch(body, /private gist|Scope|LOAN-01 \(/);
  }
});

test('workspace: a workspace repository that exists and is not private is refused', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root, { visibility: 'PUBLIC' });
  gh.repos.set('fernhill/fernhill-lending-workspace', true);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(r.error, /not private/);
  assert.deepEqual(writes(gh), []);
});

test('workspace: each code repository the owner named is created with the visibility of its entry, after the workspace repository', async () => {
  const root = workspaceProject({ repos: [ENTRY('api', 'private'), ENTRY('web', 'public')] });
  const gh = workspaceGh(root);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api', 'web'] });
  assert.equal(r.error, null);
  assert.deepEqual(creates(gh), [
    ['gh', 'repo', 'create', 'fernhill/fernhill-lending-workspace', '--private', '--source', root, '--push'],
    ['gh', 'repo', 'create', 'fernhill/fernhill-lending-api', '--private', '--source', join(root, 'repos', 'api'), '--push'],
    ['gh', 'repo', 'create', 'fernhill/fernhill-lending-web', '--public', '--source', join(root, 'repos', 'web'), '--push'],
  ]);
  assert.deepEqual(r.codeRepos, [{ name: 'api', repo: 'fernhill/fernhill-lending-api' }, { name: 'web', repo: 'fernhill/fernhill-lending-web' }]);
  assert.deepEqual(stateOf(root).repos.map((e) => [e.name, e.remote]), [
    ['api', 'https://github.com/fernhill/fernhill-lending-api.git'], ['web', 'https://github.com/fernhill/fernhill-lending-web.git'],
  ]);
  assert.equal(gh.issues.every((i) => i.url.includes('fernhill-lending-workspace')), true, 'the issues stay on the workspace repository');
});

test('workspace: an internal entry is created with --internal, and only the repositories named are created', async () => {
  const root = workspaceProject({ repos: [ENTRY('api', 'internal'), ENTRY('web', 'public')] });
  const gh = workspaceGh(root);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.equal(r.error, null);
  assert.deepEqual(creates(gh).map((c) => c.slice(3, 5)), [['fernhill/fernhill-lending-workspace', '--private'], ['fernhill/fernhill-lending-api', '--internal']]);
  assert.equal(stateOf(root).repos.find((e) => e.name === 'web').remote, 'none');
});

test('workspace: a rerun creates no repository and does not push again', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  gh.calls.length = 0;
  gh.gitCalls.length = 0;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.equal(r.error, null);
  assert.deepEqual(r.created, []);
  assert.deepEqual(writes(gh), []);
  assert.equal(gh.gitCalls.some(([a]) => a === 'push'), false);
});

test('workspace: a code repository whose first push failed after the repository was made is pushed on the rerun', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  gh.repos.set('fernhill/fernhill-lending-api', 'PRIVATE');
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.equal(r.error, null);
  assert.equal(creates(gh).some((c) => c[3] === 'fernhill/fernhill-lending-api'), false, 'the repository exists, so it is not created again');
  assert.ok(gh.gitCalls.some((c) => c[0] === 'remote' && c[1] === 'add'));
  assert.ok(gh.gitCalls.some((c) => c[0] === 'push'));
  assert.equal(stateOf(root).repos[0].remote, 'https://github.com/fernhill/fernhill-lending-api.git');
});

test('workspace: a code repository that already has a GitHub remote is only checked, never created or pushed', async () => {
  const root = workspaceProject({ repos: [ENTRY('api', 'private', 'https://github.com/fernhill/ledger-api.git'), ENTRY('web', 'public')] });
  const gh = workspaceGh(root);
  gh.repos.set('fernhill/ledger-api', 'PRIVATE');
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.equal(r.error, null);
  assert.equal(creates(gh).some((c) => c[3] === 'fernhill/ledger-api'), false);
  assert.equal(gh.codeDirs.get(join(root, 'repos', 'api')).remoteRefs, false, 'nothing is pushed to a repository that already has its remote');
  assert.deepEqual(r.codeRepos, [{ name: 'api', repo: 'fernhill/ledger-api' }]);
  assert.equal(stateOf(root).repos[0].remote, 'https://github.com/fernhill/ledger-api.git');
});

test('workspace: an entry that says private but whose GitHub repository is public stops the run', async () => {
  const root = workspaceProject({ repos: [ENTRY('api', 'private', 'https://github.com/fernhill/ledger-api.git'), ENTRY('web', 'public')] });
  const gh = workspaceGh(root);
  gh.repos.set('fernhill/ledger-api', 'PUBLIC');
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.match(r.error, /ledger-api.*public.*private/i);
});

test('workspace: a remote that is not on GitHub is skipped with a warning, not created', async () => {
  const root = workspaceProject({ repos: [ENTRY('api', 'private', 'https://git.example.test/team/api.git'), ENTRY('web', 'public')] });
  const gh = workspaceGh(root);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.equal(r.error, null);
  assert.ok(r.warnings.some((w) => /api.*not a GitHub remote/i.test(w)));
  assert.equal(creates(gh).some((c) => c[3].includes('api')), false);
});

test('workspace: an unknown repository name, or a repository with no commit, stops before anything is written', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  const unknown = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['nope'] });
  assert.match(unknown.error, /nope.*registry/i);
  assert.deepEqual(writes(gh), []);
  gh.codeDirs.get(join(root, 'repos', 'api')).hasCommit = false;
  const empty = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.match(empty.error, /api.*no commit/i);
  assert.equal(creates(gh).some((c) => c[3].includes('api')), false);
});

test('workspace: repos on a project that is not a workspace is refused', async () => {
  const root = project();
  const gh = fakeGh();
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.match(r.error, /workspace/i);
  assert.deepEqual(writes(gh), []);
});

test('workspace: a dry run plans the code repositories and writes nothing', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api', 'web'], dryRun: true });
  assert.equal(r.error, null);
  assert.ok(r.planned.some((l) => l.includes('repo create fernhill/fernhill-lending-api --private')));
  assert.ok(r.planned.some((l) => l.includes('repo create fernhill/fernhill-lending-web --public')));
  assert.deepEqual(writes(gh), []);
  assert.equal(stateOf(root).repos.every((e) => e.remote === 'none'), true);
});

test('recade github init --repo <name> creates that code repository only, one name at a time', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  const first = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--owner', 'fernhill', '--project', root], first.io), 0, first.err.join(''));
  assert.equal(creates(gh).length, 1);
  const api = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--repo', 'api', '--project', root], api.io), 0, api.err.join(''));
  assert.match(api.out.join(''), /Created: repo fernhill\/fernhill-lending-api/);
  assert.equal(creates(gh).length, 2);
  assert.equal(stateOf(root).repos.find((e) => e.name === 'web').remote, 'none');
  const bad = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--repo', '--project', root], bad.io), 2);
  const unknown = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--repo', 'nope', '--project', root], unknown.io), 1);
  assert.match(unknown.err.join(''), /nope/);
});

test('recade github init --auto-push records the owner yes with its date, only once the workspace repository exists', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  const { io } = cliIo(root, { exec: gh.exec, now: () => new Date(2026, 10, 18, 12) });
  assert.equal(await run(['github', 'init', '--owner', 'fernhill', '--auto-push', '--project', root], io), 0);
  assert.deepEqual(stateOf(root).workspace, { auto_push: true, auto_push_since: '2026-11-18' });
  const without = workspaceProject();
  const down = workspaceGh(without, { failOn: (args) => args[0] === 'repo' && args[1] === 'create' });
  const t = cliIo(without, { exec: down.exec });
  assert.equal(await run(['github', 'init', '--owner', 'fernhill', '--auto-push', '--project', without], t.io), 1);
  assert.equal(stateOf(without).workspace, undefined, 'no repository, no yes recorded');
});

test('recade github init without --auto-push leaves auto-push alone, and a dry run with it writes nothing', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  const dry = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--dry-run', '--owner', 'fernhill', '--auto-push', '--project', root], dry.io), 0);
  assert.equal(stateOf(root).workspace, undefined);
  assert.match(dry.out.join(''), /auto-push/i);
  const plain = cliIo(root, { exec: gh.exec });
  assert.equal(await run(['github', 'init', '--owner', 'fernhill', '--project', root], plain.io), 0);
  assert.equal(stateOf(root).workspace, undefined);
});

test('adoptBoard on a workspace without a GitHub repository needs an owner, then waits for github init, and refuses a public one', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  const none = await adoptBoard(root, { exec: gh.exec });
  assert.match(none.error, /No GitHub owner/);
  const early = await adoptBoard(root, { exec: gh.exec, owner: 'fernhill' });
  assert.equal(early.error, null);
  assert.equal(early.repo, null);
  assert.ok(early.warnings.some((w) => /recade github init creates it/.test(w)));
  assert.equal(stateOf(root).github.repo, undefined, 'no repository is recorded before github init');
  const owned = workspaceProject();
  writeFileSync(join(owned, 'recade', 'state.yaml'), stringify({ ...stateOf(owned), github: { owner: 'fernhill', repo: 'fernhill-lending-workspace' } }));
  const open = workspaceGh(owned, { visibility: 'PUBLIC' });
  open.repos.set('fernhill/fernhill-lending-workspace', true);
  const r = await adoptBoard(owned, { exec: open.exec });
  assert.match(r.error, /workspace.*not private/i);
});

// ---- fix round 1: validated names, no push over an existing repository ----

test('workspace: a registry name or remote that is not a plain repository name is refused before any gh or git call', async () => {
  const bad = [
    ENTRY('../x', 'private'), ENTRY('--help', 'private'), ENTRY('Api', 'private'), ENTRY('a/b', 'private'), ENTRY('workspace', 'private'), ENTRY('', 'private'),
    ENTRY('api', 'private', 'https://github.com/--x/y.git'), ENTRY('api', 'private', 'https://github.com/acme/..git'),
  ];
  for (const entry of bad) {
    const root = workspaceProject({ repos: [entry, ENTRY('web', 'public')] });
    const gh = workspaceGh(root);
    const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: [entry.name] });
    assert.ok(r.error !== null, JSON.stringify(entry));
    assert.deepEqual([gh.calls.length, gh.gitCalls.length], [0, 0], `nothing is called for ${JSON.stringify(entry)}`);
  }
});

test('workspace: a recorded workspace repository name that is not a plain name is refused before any call', async () => {
  const root = workspaceProject();
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ ...stateOf(root), github: { owner: 'fernhill', repo: '--x' } }));
  const gh = workspaceGh(root);
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(r.error, /--x/);
  assert.deepEqual([gh.calls.length, gh.gitCalls.length], [0, 0]);
});

test('workspace: an existing code repository with branches and no origin here is never pushed to, and the remote is not added', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  gh.repos.set('fernhill/fernhill-lending-api', 'PRIVATE');
  gh.codeDirs.get(join(root, 'repos', 'api')).remoteRefs = true;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec, repos: ['api'] });
  assert.match(r.error, /fernhill-lending-api.*already.*branches/i);
  assert.match(r.error, /git remote add origin/);
  assert.equal(gh.gitCalls.some((c) => c[0] === 'push' || (c[0] === 'remote' && c[1] === 'add')), false);
  assert.ok(gh.gitCalls.some((c) => c[0] === 'ls-remote' && c.includes('https://github.com/fernhill/fernhill-lending-api.git')), 'the remote is looked at by its URL');
  assert.equal(stateOf(root).repos[0].remote, 'none');
});

test('workspace: an existing workspace repository with branches and no origin is not pushed to either', async () => {
  const root = workspaceProject();
  const gh = workspaceGh(root);
  gh.repos.set('fernhill/fernhill-lending-workspace', 'PRIVATE');
  gh.remoteRefs = true;
  const r = await initGithub(root, { owner: 'fernhill', exec: gh.exec });
  assert.match(r.error, /already.*branches/i);
  assert.equal(gh.gitCalls.some((c) => c[0] === 'push' || (c[0] === 'remote' && c[1] === 'add')), false);
});
