import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { checkSlices, renderStatus } from '../../src/project/slices.js';
import { install } from '../../src/harness/install.js';
import { protect, protectionArgs, requiredChecks } from '../../src/harness/protect.js';
import { cli, git, makeProject, makeWorkspace, plugin } from './fixture-project.js';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

test('protection names the CI jobs as required checks, includes administrators and allows no force push', () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  const checks = requiredChecks(root);
  assert.ok(checks.length >= 3 && checks.includes('conflicts'));
  const args = protectionArgs('acme/fernhill', 'main', ['CI', 'conflicts']);
  const text = args.join(' ');
  assert.deepEqual(args.slice(0, 4), ['api', '-X', 'PUT', 'repos/acme/fernhill/branches/main/protection']);
  assert.match(text, /required_status_checks\[strict\]=true/);
  assert.match(text, /required_status_checks\[contexts\]\[\]=CI/);
  assert.match(text, /enforce_admins=true/);
  assert.match(text, /required_pull_request_reviews\[required_approving_review_count\]=0/);
  assert.match(text, /restrictions=null/);
  assert.match(text, /allow_force_pushes=false/);
  assert.match(text, /allow_deletions=false/);
});

test('without --apply nothing is called but a read, and with --apply the gh api call is made once (owner consent)', () => {
  const root = makeProject({ state: 'version: 1\nmode: scratch\ngithub:\n  owner: acme\n  repo: fernhill\n' });
  install(root, { pluginRoot: plugin });
  const calls = [];
  const exec = (cmd) => {
    calls.push(cmd.join(' '));
    return ok();
  };
  const dry = protect(root, { exec });
  assert.equal(dry.applied, false);
  assert.equal(dry.error, null);
  assert.equal(dry.repo, 'acme/fernhill');
  assert.deepEqual(calls, []);
  assert.match(dry.command, /^gh api -X PUT repos\/acme\/fernhill\/branches\/main\/protection /);
  const done = protect(root, { exec, apply: true });
  assert.equal(done.applied, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^gh api -X PUT repos\/acme\/fernhill\/branches\/main\/protection /);
  assert.equal(calls.some((c) => /pr merge/.test(c)), false);
});

test('the repository comes from gh when the state has none, and errors are plain', () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  const viaGh = protect(root, { exec: (cmd) => (cmd.includes('repo') ? ok('acme/fernhill\n') : ok()) });
  assert.equal(viaGh.repo, 'acme/fernhill');
  assert.match(protect(root, { exec: () => ({ code: 1, stdout: '', stderr: 'no repo' }) }).error, /The GitHub repository is not known/);
  const failed = protect(root, { exec: (cmd) => (cmd.includes('api') ? { code: 1, stdout: '', stderr: 'HTTP 403: Upgrade to GitHub Pro\n' } : ok('acme/fernhill')), apply: true });
  assert.match(failed.error, /gh could not set the protection: HTTP 403/);
  assert.equal(failed.applied, false);
  assert.match(protect(makeProject(), { exec: () => ok('acme/fernhill') }).error, /No CI job found/);
  assert.match(protect(root, { exec: () => ok('acme/fernhill'), branch: 'a b' }).error, /Not a branch name/);
});

test('recade harness protect through the CLI: dry run by default, --apply on request', async () => {
  const root = makeProject({ state: 'version: 1\nmode: scratch\ngithub:\n  owner: acme\n  repo: fernhill\n' });
  install(root, { pluginRoot: plugin });
  const calls = [];
  const run = (cmd) => {
    calls.push(cmd);
    return ok();
  };
  const dry = await cli(root, ['harness', 'protect'], { run });
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /Nothing changed\. To apply it, with the owner's agreement: recade harness protect --apply/);
  const before = calls.length;
  const applied = await cli(root, ['harness', 'protect', '--apply'], { run });
  assert.equal(applied.code, 0);
  assert.match(applied.stdout, /Protection applied\./);
  assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1)[0], 'gh');
  assert.equal(parse(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')).name, 'CI');
});

test('recade harness set records the required gates and the WIP limit, and parallel plan reads the limit', async () => {
  const root = makeProject();
  assert.equal((await cli(root, ['harness', 'set'])).code, 2);
  assert.equal((await cli(root, ['harness', 'set', '--required-gates', 'bad name'])).code, 2);
  assert.equal((await cli(root, ['harness', 'set', '--wip-limit', '12'])).code, 2);
  const r = await cli(root, ['harness', 'set', '--required-gates', 'tests,lint', '--wip-limit', '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /harness\.required_gates: tests, lint/);
  assert.match(r.stdout, /harness\.wip_limit: 2/);
  const state = parse(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8'));
  assert.deepEqual(state.harness, { required_gates: ['tests', 'lint'], wip_limit: 2 });
  assert.equal(state.mode, 'scratch', 'the other keys stay');
  // A second set of one key keeps the other.
  await cli(root, ['harness', 'set', '--wip-limit', '3']);
  assert.deepEqual(parse(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8')).harness, { required_gates: ['tests', 'lint'], wip_limit: 3 });
  const none = await cli(root, ['harness', 'set', '--required-gates', 'none']);
  assert.equal(none.code, 0);
  assert.deepEqual(parse(readFileSync(join(root, 'recade', 'state.yaml'), 'utf8')).harness, { required_gates: [], wip_limit: 3 });
});

test('recade gate run takes --project before the dash dash, and a --project after it belongs to the command', async () => {
  const root = makeProject();
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: start');
  const elsewhere = tmpdir();
  const r = await cli(elsewhere, ['gate', 'run', 'echo-gate', '--project', root, '--', 'echo', '--project', 'x']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^echo-gate: green/);
  const stamps = JSON.parse(readFileSync(join(root, '.recade', 'stamps.json'), 'utf8'));
  assert.deepEqual(stamps['echo-gate'].cmd, ['echo', '--project', 'x']);
});

test('parallel plan takes its default limit from harness.wip_limit, and --max still wins', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-wip-'));
  mkdirSync(join(root, 'recade'));
  mkdirSync(join(root, 'slices'));
  writeFileSync(join(root, 'recade', 'state.yaml'), stringify({ version: 1, mode: 'scratch', harness: { wip_limit: 2 } }));
  for (const n of [1, 2, 3, 4]) {
    const id = `S-0${n}`;
    const meta = {
      doc_id: id, title: `Slice ${id}`, repos: ['app'], branch: `slice/${id.toLowerCase()}`, format: 'small', lane: 'standard',
      implementer: 'implementer', increment: 'INC-1', depends_on: [], blocks: [], external_prerequisite: 'none',
      provisionals_used: [], size: 'M', touches: [`src/a${n}/**`],
    };
    writeFileSync(join(root, 'slices', `${id}-x.md`), `---\n${stringify(meta)}---\n\n# ${id}: Slice ${id}\n`);
  }
  writeFileSync(join(root, 'slices', 'STATUS.md'), renderStatus(checkSlices(root).status.map((r) => ({ ...r, status: 'todo' }))));
  const picked = async (...extra) => JSON.parse((await cli(root, ['parallel', 'plan', '--json', ...extra])).stdout).picked.length;
  assert.equal(await picked(), 2);
  assert.equal(await picked('--max', '4'), 4);
});

test('requiredChecks of a workspace reads the jobs of workspace.yml, and nothing errors when the workflow is absent', async () => {
  const ws = await makeWorkspace();
  assert.deepEqual(requiredChecks(ws.dir), [], 'no workflow yet: no check, no error');
  install(ws.dir, { pluginRoot: plugin, target: 'workspace', ref: 'v1.0.0' });
  const jobs = Object.values(parse(readFileSync(join(ws.dir, '.github/workflows/workspace.yml'), 'utf8')).jobs).map((j) => j.name);
  assert.ok(jobs.length > 0);
  assert.deepEqual(requiredChecks(ws.dir), jobs);
  // The workspace rule uses no check today: protect still sends none, whatever the workflow holds.
  const state = parse(readFileSync(join(ws.dir, 'recade/state.yaml'), 'utf8'));
  writeFileSync(join(ws.dir, 'recade/state.yaml'), stringify({ ...state, github: { owner: 'acme', repo: 'fernhill-workspace' } }));
  const result = protect(ws.dir, { exec: () => ok() });
  assert.equal(result.error, null);
  assert.deepEqual(result.checks, []);
  assert.doesNotMatch(result.command, /contexts/);
});

test('requiredChecks of a workspace survives an unreadable workspace.yml', async () => {
  const ws = await makeWorkspace();
  mkdirSync(join(ws.dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(ws.dir, '.github/workflows/workspace.yml'), 'jobs: [unclosed\n');
  assert.deepEqual(requiredChecks(ws.dir), []);
});
