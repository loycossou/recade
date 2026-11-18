import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseNotes, prependChangelog, parseCommit, ReleaseNotesInputError } from '../../src/harness/releasenotes.js';
import { defaultExec } from '../../src/harness/stamps.js';
import { lintText } from '../../src/style/lint.js';
import { run } from '../../src/cli.js';

const EM = String.fromCharCode(0x2014);
/** Built from parts so that no address appears in the source. */
const MAIL = ['test', 'users.invalid'].join(String.fromCharCode(64));
const NOW = () => new Date(2026, 10, 14, 12, 0, 0);

function git(repo, ...args) {
  const r = spawnSync('git', args, {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: MAIL, GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: MAIL, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

let counter = 0;
/** Commit a new file with `message` (the body goes after a blank line). */
function commit(repo, message) {
  counter += 1;
  writeFileSync(join(repo, `file-${counter}.txt`), `${counter}\n`);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', message);
}

/** A repository with tag v0.1.0 and a mixed history after it. Nothing is merged, so every commit counts. */
function history({ remote = 'https://github.com/fernhill/lending.git' } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'recade-notes-'));
  git(repo, 'init', '-q', '-b', 'main');
  if (remote !== null) git(repo, 'remote', 'add', 'origin', remote);
  commit(repo, 'chore: start');
  git(repo, 'tag', 'v0.1.0');
  commit(repo, 'docs: explain the ledger (#14)');
  commit(repo, 'feat(schedule): export the schedule as a sheet (#12)');
  commit(repo, 'fix(login): keep the session after a redirect (#13)');
  commit(repo, 'perf(search): index the borrower names (#15)');
  commit(repo, 'refactor: split the rate module');
  commit(repo, 'feat(rates)!: rates are percentages now (#16)');
  commit(repo, 'feat(auth): add single sign-on (#17)\n\nBREAKING CHANGE: the old session cookie is no longer read');
  commit(repo, 'Tidy the readme');
  commit(repo, 'feat: add the amortisation table');
  git(repo, 'tag', 'v0.2.0');
  return repo;
}

const lines = (text) => text.split('\n');

test('parseCommit reads the type, the scope, the bang, the PR number and the BREAKING CHANGE footer', () => {
  assert.deepEqual(parseCommit('feat(schedule): export it (#12)', ''), { type: 'feat', scope: 'schedule', breaking: false, breakingNote: null, description: 'export it', pr: 12 });
  assert.deepEqual(parseCommit('fix!: drop the old flag', ''), { type: 'fix', scope: null, breaking: true, breakingNote: null, description: 'drop the old flag', pr: null });
  const note = parseCommit('feat: new cookie', 'Some text.\n\nBREAKING CHANGE: the old cookie is not read\nand a second line');
  assert.equal(note.breaking, true);
  assert.equal(note.breakingNote, 'the old cookie is not read');
  assert.equal(parseCommit('BREAKING-CHANGE in the middle of a line is not a footer', '').breaking, false);
  assert.deepEqual(parseCommit('Tidy the readme', ''), { type: 'other', scope: null, breaking: false, breakingNote: null, description: 'Tidy the readme', pr: null });
  assert.equal(parseCommit('Feat: Capital type', '').type, 'feat');
  assert.equal(parseCommit('chore(deps): bump yaml (#9)', '').type, 'chore');
});

test('release notes group the commits of the range: breaking first, then feat, fix, perf, docs, others', () => {
  const repo = history();
  const text = releaseNotes(repo, 'v0.1.0..v0.2.0', { exec: defaultExec, version: '0.2.0', now: NOW });
  const headings = lines(text).filter((l) => l.startsWith('#'));
  assert.deepEqual(headings, ['## 0.2.0 (2026-11-14)', '### Breaking changes', '### Features', '### Fixes', '### Performance', '### Documentation', '### Other changes']);
  const section = (name) => text.slice(text.indexOf(`### ${name}`)).split(/\n### /)[0];
  assert.match(section('Breaking changes'), /- \*\*rates:\*\* rates are percentages now \(\[#16\]\(https:\/\/github\.com\/fernhill\/lending\/pull\/16\)\)/);
  assert.match(section('Breaking changes'), /- \*\*auth:\*\* add single sign-on \(\[#17\]\(https:\/\/github\.com\/fernhill\/lending\/pull\/17\)\)\n  - Breaking: the old session cookie is no longer read/);
  assert.match(section('Features'), /- \*\*schedule:\*\* export the schedule as a sheet \(\[#12\]/);
  assert.match(section('Features'), /- add the amortisation table\n/);
  assert.equal(/single sign-on|percentages/.test(section('Features')), false, 'a breaking commit shows once, in Breaking changes');
  assert.match(section('Fixes'), /\*\*login:\*\* keep the session after a redirect \(\[#13\]/);
  assert.match(section('Performance'), /\*\*search:\*\* index the borrower names/);
  assert.match(section('Documentation'), /explain the ledger \(\[#14\]/);
  assert.match(section('Other changes'), /split the rate module/);
  assert.match(section('Other changes'), /Tidy the readme/);
  assert.equal(text.includes('chore: start'), false, 'the commit of the lower bound is out of the range');
  assert.equal(text.includes(EM), false);
  assert.equal(text.includes('(#12)'), false, 'the PR number is a link, not left in the subject');
  assert.deepEqual(lintText(text, 'CHANGELOG.md').filter((f) => f.severity === 'error'), []);
});

test('a section is left out when it has no commit, and the heading says Unreleased for HEAD without a version', () => {
  const repo = mkdtempSync(join(tmpdir(), 'recade-notes-small-'));
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'chore: start');
  commit(repo, 'fix: a crash');
  const text = releaseNotes(repo, 'HEAD~1..HEAD', { exec: defaultExec, now: NOW });
  assert.deepEqual(lines(text).filter((l) => l.startsWith('#')), ['## Unreleased (2026-11-14)', '### Fixes']);
  assert.match(text, /- a crash\n/);
  assert.equal(releaseNotes(repo, 'HEAD~1..HEAD', { exec: defaultExec, now: NOW, version: '1.0.0' }).split('\n')[0], '## 1.0.0 (2026-11-14)');
  assert.equal(releaseNotes(repo, 'HEAD~1..HEAD', { exec: defaultExec, now: NOW }).includes('chore: start'), false);
});

test('a PR number stays plain text without a GitHub remote, and the links follow an ssh remote', () => {
  const plain = releaseNotes(history({ remote: null }), 'v0.1.0..v0.2.0', { exec: defaultExec, version: '0.2.0', now: NOW });
  assert.match(plain, /export the schedule as a sheet \(#12\)/);
  assert.equal(plain.includes('](http'), false);
  const other = releaseNotes(history({ remote: 'https://git.example.invalid/fernhill/lending.git' }), 'v0.1.0..v0.2.0', { exec: defaultExec, version: '0.2.0', now: NOW });
  assert.match(other, /\(#12\)/);
  const ssh = releaseNotes(history({ remote: ['git', 'github.com:fernhill/lending.git'].join(String.fromCharCode(64)) }), 'v0.1.0..v0.2.0', { exec: defaultExec, version: '0.2.0', now: NOW });
  assert.match(ssh, /\[#12\]\(https:\/\/github\.com\/fernhill\/lending\/pull\/12\)/);
});

test('a pull request merged with a merge commit gives its number to the commits it brought', () => {
  const repo = mkdtempSync(join(tmpdir(), 'recade-notes-merge-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/fernhill/lending.git');
  commit(repo, 'chore: start');
  git(repo, 'tag', 'v0.1.0');
  git(repo, 'switch', '-q', '-c', 'slice/s-04-export');
  commit(repo, 'feat(export): write the file');
  commit(repo, 'fix(export): quote the commas');
  git(repo, 'switch', '-q', 'main');
  commit(repo, 'docs: a note on main');
  git(repo, 'merge', '--no-ff', '-q', '-m', 'Merge pull request #21 from fernhill/slice/s-04-export\n\nfeat(export): the export slice', 'slice/s-04-export');
  const text = releaseNotes(repo, 'v0.1.0..HEAD', { exec: defaultExec, now: NOW });
  assert.match(text, /\*\*export:\*\* write the file \(\[#21\]/);
  assert.match(text, /\*\*export:\*\* quote the commas \(\[#21\]/);
  assert.equal(/Merge pull request/.test(text), false, 'the merge commit itself is not an entry');
  assert.equal(/a note on main \(\[#/.test(text), false);
});

test('a range with no commit, a bad range or a bad ref is refused', () => {
  const repo = history();
  assert.throws(() => releaseNotes(repo, 'v0.2.0..v0.2.0', { exec: defaultExec }), (err) => err instanceof ReleaseNotesInputError && /No commit/.test(err.message));
  for (const bad of ['v0.1.0', '..v0.2.0', 'v0.1.0..', '--all..HEAD', 'a..b..c', 'v0.1.0..v0.2.0 --x', '$(id)..HEAD', 'a;b..HEAD']) {
    assert.throws(() => releaseNotes(repo, bad, { exec: defaultExec }), (err) => err instanceof ReleaseNotesInputError && /range/i.test(err.message), bad);
  }
  assert.throws(() => releaseNotes(repo, 'nope..HEAD', { exec: defaultExec }), /git log failed/);
  assert.throws(() => releaseNotes(repo, 'v0.1.0..v0.2.0', { exec: defaultExec, version: 'bad version' }), (err) => err instanceof ReleaseNotesInputError && /version/i.test(err.message));
});

test('the exec is injected: git is only read, with no shell and no option taken from the range', () => {
  const calls = [];
  const exec = (cmd, opts) => {
    calls.push(cmd);
    return defaultExec(cmd, opts);
  };
  releaseNotes(history(), 'v0.1.0..v0.2.0', { exec, version: '0.2.0', now: NOW });
  assert.ok(calls.length > 0);
  for (const cmd of calls) {
    assert.equal(cmd[0], 'git');
    assert.ok(['log', 'remote', 'rev-list'].includes(cmd[1]), cmd.join(' '));
  }
  assert.ok(calls.some((c) => c.includes('v0.1.0..v0.2.0')));
});

test('prependChangelog creates CHANGELOG.md, then puts each new section under the title, newest first', () => {
  const root = mkdtempSync(join(tmpdir(), 'recade-changelog-'));
  const one = '## 0.1.0 (2026-01-01)\n\n### Features\n\n- first\n';
  const two = '## 0.2.0 (2026-02-01)\n\n### Fixes\n\n- second\n';
  assert.equal(prependChangelog(root, one), join(root, 'CHANGELOG.md'));
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), `# Changelog\n\n${one}`);
  prependChangelog(root, two);
  assert.equal(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), `# Changelog\n\n${two}\n${one}`);
  assert.throws(() => prependChangelog(root, two), (err) => err instanceof ReleaseNotesInputError && /already has a section "## 0\.2\.0/.test(err.message));
  // A hand-written file keeps its own title and its text.
  const mine = mkdtempSync(join(tmpdir(), 'recade-changelog-mine-'));
  writeFileSync(join(mine, 'CHANGELOG.md'), '# Release history\n\nSome intro.\n\n## 0.0.1 (2025-12-01)\n\n- old\n');
  prependChangelog(mine, one);
  assert.equal(readFileSync(join(mine, 'CHANGELOG.md'), 'utf8'), `# Release history\n\nSome intro.\n\n${one}\n## 0.0.1 (2025-12-01)\n\n- old\n`);
  // A file with no title gets the section on top.
  const bare = mkdtempSync(join(tmpdir(), 'recade-changelog-bare-'));
  writeFileSync(join(bare, 'CHANGELOG.md'), '## 0.0.1 (2025-12-01)\n\n- old\n');
  prependChangelog(bare, one);
  assert.equal(readFileSync(join(bare, 'CHANGELOG.md'), 'utf8'), `${one}\n## 0.0.1 (2025-12-01)\n\n- old\n`);
});

// ---------------------------------------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------------------------------------

async function cli(argv, { cwd }) {
  const out = [];
  const err = [];
  const code = await run(argv, { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd, env: {} });
  return { code, out: out.join(''), err: err.join('') };
}

test('recade release-notes prints the section, --write prepends CHANGELOG.md, and the exit codes are 0, 1 and 2', async () => {
  const repo = history();
  const printed = await cli(['release-notes', 'v0.1.0..v0.2.0', '--version', '0.2.0'], { cwd: repo });
  assert.equal(printed.code, 0, printed.err);
  assert.match(printed.out, /^## 0\.2\.0 \(\d{4}-\d{2}-\d{2}\)\n/);
  assert.match(printed.out, /### Breaking changes/);
  assert.equal(existsSync(join(repo, 'CHANGELOG.md')), false, 'nothing is written without --write');
  const written = await cli(['release-notes', 'v0.1.0..v0.2.0', '--version', '0.2.0', '--write'], { cwd: repo });
  assert.equal(written.code, 0, written.err);
  assert.match(written.out, /Wrote CHANGELOG\.md/);
  const changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^# Changelog\n\n## 0\.2\.0 \(/);
  assert.match(changelog, /### Breaking changes[\s\S]*### Features/);
  const twice = await cli(['release-notes', 'v0.1.0..v0.2.0', '--version', '0.2.0', '--write'], { cwd: repo });
  assert.equal(twice.code, 1);
  assert.match(twice.err, /already has a section/);
  assert.equal((await cli(['release-notes', 'v0.2.0..v0.2.0'], { cwd: repo })).code, 1);
  for (const args of [['release-notes'], ['release-notes', 'v0.1.0'], ['release-notes', 'v0.1.0..v0.2.0', '--bogus'], ['release-notes', 'v0.1.0..v0.2.0', '--version'], ['release-notes', '--write']]) {
    const r = await cli(args, { cwd: repo });
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /Usage: recade release-notes/, args.join(' '));
  }
  const gone = mkdtempSync(join(tmpdir(), 'recade-notes-nogit-'));
  mkdirSync(join(gone, 'x'));
  assert.equal((await cli(['release-notes', 'a..b'], { cwd: gone })).code, 2);
});
