import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import { fillCi, fillDependabot } from '../../src/harness/ci.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const CI = read('../../harness/ci/ci.yml');
const DEPENDABOT = read('../../harness/dependabot.yml');
const STACK = read('../fixtures/harness-ci/STACK.md');
const TOKEN = /__RECADE_[A-Z0-9_]+__/;

/** The sheet of the fixture with one row replaced (or removed with `null`). */
function withRow(item, value) {
  return STACK.split('\n')
    .flatMap((line) => (line.startsWith(`| ${item} |`) ? (value === null ? [] : [`| ${item} | ${value} |`]) : [line]))
    .join('\n');
}

const stepsOf = (doc) => Object.values(doc.jobs).flatMap((job) => job.steps);
const runs = (doc) => stepsOf(doc).map((s) => s.run).filter(Boolean).join('\n');

test('the templates are valid YAML before they are filled', () => {
  assert.equal(parseDocument(CI).errors.length, 0);
  assert.equal(parseDocument(DEPENDABOT).errors.length, 0);
});

test('every placeholder of ci.yml is filled from a fictional STACK sheet, and the result is valid YAML', () => {
  const { text, missing } = fillCi(CI, STACK);
  assert.doesNotMatch(text, TOKEN);
  assert.deepEqual(missing, []);
  const doc = parseDocument(text);
  assert.equal(doc.errors.length, 0);
  const all = runs(doc.toJS());
  for (const cmd of [
    'npm ci', 'npm run lint', 'npm run typecheck', 'npm run build', 'npm test', 'npm run test:contract',
    'npx playwright install --with-deps chromium', 'npx playwright test', 'npx playwright test --grep @confirmation',
    'npx playwright test --grep @a11y', 'npm run perf:budget', 'semgrep scan --config auto --error',
    'npm audit --audit-level=high | tee audit.txt', 'npx @cyclonedx/cyclonedx-npm --output-file sbom/sbom.json',
    'gitleaks detect --no-banner',
  ]) {
    assert.ok(all.includes(cmd), `missing the command ${cmd}`);
  }
});

test('only the heading of the tech sheet is read, a same-named row elsewhere is ignored', () => {
  const { text } = fillCi(CI, STACK);
  assert.doesNotMatch(text, /not this one/);
});

test('the runtime becomes a setup step with the version of the sheet', () => {
  const doc = parse(fillCi(CI, STACK).text);
  const setups = stepsOf(doc).filter((s) => String(s.uses).startsWith('actions/setup-node@'));
  assert.ok(setups.length >= 3, 'the quality, e2e and security jobs each set the toolchain up');
  assert.ok(setups.every((s) => String(s.with['node-version']) === '22'));
  const py = parse(fillCi(CI, withRow('Runtime', '`python 3.12`')).text);
  assert.ok(stepsOf(py).some((s) => String(s.uses).startsWith('actions/setup-python@') && String(s.with['python-version']) === '3.12'));
});

test('the job set covers every gate the brief names, in the right jobs', () => {
  const doc = parse(fillCi(CI, STACK).text);
  const names = (job) => doc.jobs[job].steps.map((s) => s.name ?? '').join('|');
  assert.match(names('quality'), /Lint.*Typecheck.*Unit tests.*Contract tests/);
  assert.match(names('e2e'), /End to end.*Confirmation tests.*Accessibility.*Performance budget/);
  assert.match(names('security'), /SAST.*Dependency audit.*SBOM.*Secret scan/);
  const recade = doc.jobs.recade.steps.map((s) => s.run ?? '').join('\n');
  assert.match(recade, /lint-style/);
  assert.match(recade, /quarantine check/);
  // The documents are in the workspace, so the ID index is checked there (workspace.yml), not in the code repository.
  assert.doesNotMatch(recade, /index check/);
});

test('a row that is empty, still an example, or absent gives a failing step and is reported', () => {
  for (const sheet of [withRow('SAST', ''), withRow('SAST', 'Example: `semgrep scan`'), withRow('SAST', null)]) {
    const { text, missing } = fillCi(CI, sheet);
    assert.deepEqual(missing, ['SAST']);
    assert.doesNotMatch(text, TOKEN);
    assert.match(runs(parse(text)), /SAST.*not filled.*exit 1/);
  }
  const noSheet = fillCi(CI, '# no sheet here\n');
  assert.ok(noSheet.missing.includes('Runtime') && noSheet.missing.includes('Test'));
  assert.doesNotMatch(noSheet.text, TOKEN);
  assert.equal(parseDocument(noSheet.text).errors.length, 0);
});

test('a row declared not applicable keeps the step as a visible no-op', () => {
  const { text, missing } = fillCi(CI, withRow('Contract tests', 'not applicable, no public API'));
  assert.deepEqual(missing, []);
  assert.match(runs(parse(text)), /echo "Contract tests: not applicable/);
});

test('the SBOM upload runs by default and is skipped when the sheet says not applicable', () => {
  const upload = (sheet) => stepsOf(parse(fillCi(CI, sheet).text)).find((s) => s.name === 'Keep the SBOM');
  assert.equal(upload(STACK).if, true);
  assert.equal(upload(STACK)['if-no-files-found'] ?? upload(STACK).with['if-no-files-found'], 'error');
  for (const value of ['none', 'not applicable, no deliverable', 'n/a']) {
    const { text, missing } = fillCi(CI, withRow('SBOM', value));
    assert.deepEqual(missing, []);
    assert.equal(stepsOf(parse(text)).find((s) => s.name === 'Keep the SBOM').if, false);
  }
});

test('a command cannot smuggle an expression or a second line into the workflow', () => {
  assert.throws(() => fillCi(CI, withRow('Lint', '`echo ${{ secrets.TOKEN }}`')), /expression/i);
  assert.throws(() => fillCi(CI, withRow('Runtime', '`node 22; curl x`')), /runtime/i);
  assert.throws(() => fillCi(CI, withRow('Runtime', '`ruby 3.3`')), /runtime/i);
});

test('permissions are least privilege: read only, no secret, no pull_request_target', () => {
  const doc = parse(fillCi(CI, STACK).text);
  assert.deepEqual(doc.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(doc.jobs)) {
    assert.ok(job['timeout-minutes'] > 0, `${name} has a timeout`);
    if (job.permissions) assert.ok(Object.values(job.permissions).every((v) => v === 'read' || v === 'none'), `${name} writes nothing`);
  }
  assert.ok(!('pull_request_target' in doc.on));
  assert.doesNotMatch(CI, /secrets\./);
  assert.doesNotMatch(CI, /:\s*write\b/);
});

test('every action is pinned to a major tag or a full commit SHA, and checkout keeps no credentials', () => {
  const doc = parse(fillCi(CI, STACK).text);
  const steps = stepsOf(doc);
  for (const s of steps.filter((x) => x.uses)) {
    assert.match(s.uses, /^[\w.-]+\/[\w.-]+@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/, s.uses);
  }
  for (const s of steps.filter((x) => String(x.uses).startsWith('actions/checkout@'))) {
    assert.equal(s.with['persist-credentials'], false);
  }
});

test('untrusted event data never reaches a shell line', () => {
  const doc = parse(fillCi(CI, STACK).text);
  for (const s of stepsOf(doc).filter((x) => x.run)) {
    assert.doesNotMatch(s.run, /\$\{\{\s*github\.(event|head_ref)/, s.name);
  }
});

test('no secret appears in plain text in either template or the filled workflow', () => {
  const filled = fillCi(CI, STACK).text;
  for (const text of [CI, filled, DEPENDABOT, fillDependabot(DEPENDABOT, STACK).text]) {
    assert.doesNotMatch(text, /AKIA[0-9A-Z]{16}/);
    assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    assert.doesNotMatch(text, /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/_-]{8,}/i);
  }
});

test('dependabot: the ecosystem comes from the runtime, an explicit row wins, github-actions is kept current', () => {
  const { text } = fillDependabot(DEPENDABOT, STACK);
  assert.doesNotMatch(text, TOKEN);
  const doc = parse(text);
  assert.equal(doc.version, 2);
  assert.deepEqual(doc.updates.map((u) => u['package-ecosystem']), ['npm', 'github-actions']);
  assert.ok(doc.updates.every((u) => u.schedule.interval === 'weekly' && u['open-pull-requests-limit'] > 0));
  assert.equal(parse(fillDependabot(DEPENDABOT, withRow('Runtime', '`python 3.12`')).text).updates[0]['package-ecosystem'], 'pip');
  const explicit = STACK.replace('| Install |', '| Dependency ecosystem | `cargo` |\n| Install |');
  assert.equal(parse(fillDependabot(DEPENDABOT, explicit).text).updates[0]['package-ecosystem'], 'cargo');
  assert.throws(() => fillDependabot(DEPENDABOT, explicit.replace('`cargo`', '`evil: true`')), /ecosystem/i);
  assert.throws(() => fillDependabot(DEPENDABOT, '# no sheet\n'), /ecosystem/i);
});

test('quarantined tests run in their own non-blocking job that still reports, and the blocking jobs never read the quarantine', () => {
  const doc = parse(fillCi(CI, STACK).text);
  const job = doc.jobs.quarantine;
  assert.ok(job, 'a quarantine job');
  assert.equal(job['continue-on-error'], true, 'its failure never blocks the workflow');
  assert.ok(job['timeout-minutes'] > 0);
  assert.equal(job.needs, undefined, 'nothing waits for it and it waits for nothing');
  for (const name of ['quality', 'e2e', 'security', 'recade']) {
    assert.notEqual(doc.jobs[name]['continue-on-error'], true, `${name} blocks`);
    assert.equal(doc.jobs[name].needs === undefined || !doc.jobs[name].needs.includes('quarantine'), true);
  }
  const runsOf = (steps) => steps.map((s) => s.run ?? '').join('\n');
  const text = runsOf(job.steps);
  assert.match(text, /quarantine list --names/, 'it reads the tracked list');
  assert.match(text, /GITHUB_STEP_SUMMARY/, 'it reports on the run page');
  assert.match(text, /quarantine list --names \| paste -sd'\|' -|echo "Quarantine tests: /, 'it runs the command of the sheet row');
  const setup = job.steps.findIndex((s) => s.name === 'Install the browsers');
  assert.ok(setup > 0, 'it installs the browsers like the e2e job');
  assert.match(String(job.steps[setup].if), /steps\.listing\.outputs\.count != '0'/, 'only when something is quarantined');
  assert.match(job.steps[setup].run, /npx playwright install --with-deps chromium/);
  assert.ok(setup < job.steps.findIndex((s) => s.id === 'quarantined'), 'before the run');
  const ran = job.steps.find((s) => s.id === 'quarantined');
  assert.ok(ran, 'a step with the id quarantined');
  assert.match(String(ran.if), /steps\.listing\.outputs\.count != '0'/, 'it runs only when something is quarantined');
  assert.equal(job.steps.some((s) => String(s.if).includes('always()')), true, 'the report step runs after a failure too');
  assert.equal(job.steps.some((s) => String(s.uses).startsWith('actions/upload-artifact@')), true, 'the output is kept');
  // The blocking recade job fails an entry that outlives its increment.
  assert.match(runsOf(doc.jobs.recade.steps), /quarantine check/);
  for (const s of stepsOf(doc).filter((x) => x.run)) assert.doesNotMatch(s.run, /\$\{\{/, `${s.name}: no expression inside a run line`);
});

test('the Quarantine tests row is optional: absent, it is a visible no-op and not a missing row', () => {
  const fixture = withRow('Quarantine tests', '`npx playwright test --grep @quarantine`');
  const { text, missing } = fillCi(CI, fixture);
  assert.deepEqual(missing, []);
  assert.match(runs(parse(text)), /npx playwright test --grep @quarantine/);
  const none = fillCi(CI, withRow('Quarantine tests', null));
  assert.deepEqual(none.missing, []);
  assert.doesNotMatch(none.text, TOKEN);
  assert.match(runs(parse(none.text)), /Quarantine tests: no command in the harness technical sheet/);
  assert.throws(() => fillCi(CI, withRow('Quarantine tests', '`echo ${{ secrets.TOKEN }}`')), /expression/i);
  assert.equal(fillCi(CI, withRow('Quarantine tests', 'not applicable')).missing.length, 0);
});

test('the shipped STACK template lists every row the CI template reads', () => {
  const stack = read('../../templates/STACK.md');
  for (const item of ['Runtime', 'Install', 'Lint', 'Typecheck', 'Build', 'Test', 'Contract tests', 'E2E setup', 'E2E tests', 'Confirmation tests', 'Accessibility tests', 'Performance budget', 'SAST', 'Dependency audit', 'SBOM', 'Secret scan', 'Quarantine tests']) {
    assert.ok(stack.includes(`| ${item} |`), `STACK.md has no ${item} row`);
  }
});

test('the template keeps the browser install step in the quarantine job, and fillCi refuses one that lost it', () => {
  assert.doesNotThrow(() => fillCi(CI, STACK));
  const noSetup = CI.replace(/      - name: Install the browsers\n        if: steps\.listing[^\n]*\n        run: \|\n          __RECADE_E2E_SETUP__\n/, '');
  assert.notEqual(noSetup, CI);
  assert.throws(() => fillCi(noSetup, STACK), /quarantine job .* must install the browsers/);
});

// ---------------------------------------------------------------------------------------------------------
// the second opinion of a code repository reads the private sheet from the workspace (spec 6.14)
// ---------------------------------------------------------------------------------------------------------

const SECOND = read('../../harness/ci/second-opinion.yml');
const second = parse(SECOND);
const secondJob = second.jobs['second-opinion'];
const secondSteps = secondJob.steps;
const clone = secondSteps.find((s) => s.id === 'workspace');
const notice = secondSteps.find((s) => /notice/i.test(s.name ?? ''));
const reviewer = secondSteps.find((s) => String(s.uses).startsWith('anthropics/claude-code-action@'));
const FLAG = 'RECADE_WORKSPACE_READY';

test('second opinion: the workspace is read only when the secret RECADE_WORKSPACE_TOKEN is set, and the guard is a job flag, since a step cannot read secrets', () => {
  // GitHub refuses the secrets context in a step `if`: the secret is tested once, in the job environment, as a yes or no.
  assert.match(secondJob.env[FLAG], /secrets\.RECADE_WORKSPACE_TOKEN != ''/);
  assert.ok(clone, 'a step with the id workspace');
  assert.equal(clone.if, `env.${FLAG} == 'true'`);
  assert.equal(clone.env.WORKSPACE_TOKEN, '${{ secrets.RECADE_WORKSPACE_TOKEN }}');
  for (const s of secondSteps) assert.doesNotMatch(String(s.if ?? ''), /secrets\./, `${s.name}: the if of a step never reads the secrets context`);
  assert.ok(secondSteps.indexOf(clone) < secondSteps.indexOf(reviewer), 'the sheet is fetched before the reviewer runs');
  assert.match(reviewer.if, new RegExp(`env\\.${FLAG} == 'true'`));
  assert.match(reviewer.if, /steps\.workspace\.outputs\.found == 'true'/);
});

test('second opinion: without the secret the job ends with a notice and succeeds, and nothing else runs', () => {
  assert.ok(notice, 'a notice step');
  assert.equal(notice.if, `env.${FLAG} != 'true'`);
  assert.match(notice.run, /::notice::.*second opinion runs locally with \/second-opinion/);
  assert.doesNotMatch(notice.run, /exit [1-9]/);
  for (const s of secondSteps.filter((x) => x !== notice)) assert.match(String(s.if ?? ''), new RegExp(`env\\.${FLAG} == 'true'`), `${s.name} waits for the workspace access`);
  assert.equal(secondJob['continue-on-error'], undefined);
});

test('second opinion: the workspace is cloned read only into the runner temp folder, with the token in a header and not in the URL', () => {
  assert.match(clone.run, /RUNNER_TEMP/);
  assert.match(clone.run, /clone --quiet --depth 1/);
  assert.match(clone.run, /extraheader/);
  assert.match(clone.run, /::add-mask::/);
  assert.doesNotMatch(clone.run, /https:\/\/[^\s"]*\$\{?WORKSPACE_TOKEN/, 'no token in a URL');
  assert.doesNotMatch(clone.run, /\bgit\b[^\n]*\bpush\b/);
  assert.equal(clone.run.includes('${{'), false, 'no expression inside the shell');
  assert.match(clone.run, /rm -rf "\$dest"/, 'the clone is removed once the sheet is copied');
  // The repository and the branch are checked before they reach a command.
  assert.match(clone.run, /WORKSPACE_REPOSITORY/);
  assert.match(clone.run, /\*\[!A-Za-z0-9\._\/-\]\*/);
  assert.match(clone.run, /gh pr view/, 'the branch comes from gh, not from the event');
});

test('second opinion: the sheet is never printed to the log', () => {
  for (const s of secondSteps.filter((x) => x.run)) {
    assert.doesNotMatch(s.run, /\b(cat|head|tail|less|more|bat|tee)\b/, `${s.name}: no command that prints a file`);
    assert.doesNotMatch(s.run, /set -[a-z]*x/, `${s.name}: no trace of the commands`);
    for (const line of s.run.split('\n').filter((l) => /\b(echo|printf)\b/.test(l))) {
      assert.doesNotMatch(line, /\$\{?(sheet|f|dest)\b/, `${s.name}: ${line.trim()}`);
    }
  }
  assert.match(clone.run, /cp -- "\$sheet" \.recade-private\/slice-sheet\.md/, 'the sheet is copied into the checkout, where the reviewer may read, and nowhere else');
  assert.match(reviewer.with.prompt, /\.recade-private\/slice-sheet\.md/);
  assert.match(reviewer.with.prompt, /private/i);
  assert.match(reviewer.with.prompt, /never quote/i);
  assert.doesNotMatch(reviewer.with.prompt, /slice sheet in slices\//);
});

test('second opinion: the token reaches only the clone step, and the reviewer step never sees it', () => {
  for (const s of secondSteps.filter((x) => x !== clone)) assert.doesNotMatch(JSON.stringify(s), /secrets\.RECADE_WORKSPACE_TOKEN|WORKSPACE_TOKEN":/, s.name);
  assert.doesNotMatch(JSON.stringify(second.on), /RECADE_WORKSPACE_TOKEN/);
  assert.equal(Object.keys(second.on).join(), 'pull_request');
  assert.deepEqual(Object.values(second.permissions), ['read', 'write']);
});

test('the pull request body links the issue of the workspace by its full URL, never by a closing keyword with a bare number', () => {
  for (const file of ['release-manager', 'merge-keeper']) {
    const text = read(`../../harness/agents/${file}.md`);
    assert.match(text, /https:\/\/github\.com\/<owner>\/<workspace>\/issues\/<n>/, `${file} names the full URL form`);
    assert.doesNotMatch(text, /\b(closes|fixes|resolves) #/i, `${file} gives no closing keyword with a number`);
  }
  const release = read('../../harness/agents/release-manager.md');
  assert.match(release, /Slice issue: https:\/\/github\.com\/<owner>\/<workspace>\/issues\/<n>/);
  assert.match(release, /slice sheet is private. Never paste or copy text of the sheet/);
});

// ---------------------------------------------------------------------------------------------------------
// fix round 1: the sheet matcher is strict, the clone is cleaned in every case
// ---------------------------------------------------------------------------------------------------------

const AWK = /awk -v want="\$branch" '([^']*)' "\$f"/.exec(clone.run)?.[1];
const sheetText = (front) => `---\n${front}\n---\n\n# body\nbranch: slice/in-the-body\n`;
const awkFinds = (dir, branch, text) => {
  const file = join(dir, 'sheet.md');
  writeFileSync(file, text);
  return spawnSync('awk', ['-v', `want=${branch}`, AWK, file]).status === 0;
};

test('second opinion: the matcher finds a sheet only by a branch line of its front matter', () => {
  assert.ok(AWK, 'the awk program is in the clone step');
  const dir = mkdtempSync(join(tmpdir(), 'recade-awk-'));
  assert.equal(awkFinds(dir, 'slice/s-01', sheetText('doc_id: S-01\nbranch: slice/s-01')), true);
  assert.equal(awkFinds(dir, 'slice/s-01', sheetText('doc_id: S-01\nbranch: "slice/s-01"')), true, 'quotes');
  assert.equal(awkFinds(dir, 'slice/s-01', '---\r\ndoc_id: S-01\r\nbranch: slice/s-01\r\n---\r\n'), true, 'CRLF');
  assert.equal(awkFinds(dir, 'slice/s-02', sheetText('doc_id: S-01\nbranch: slice/s-01')), false, 'another branch');
  assert.equal(awkFinds(dir, 'slice/none', ''), false, 'an empty file');
  assert.equal(awkFinds(dir, 'slice/none', '---\ndoc_id: S-00\ntitle: x\n'), false, 'front matter never closed, no branch');
  assert.equal(awkFinds(dir, 'slice/none', sheetText('doc_id: S-00')), false, 'no branch line in the front matter');
  assert.equal(awkFinds(dir, 'slice/in-the-body', sheetText('doc_id: S-00')), false, 'a branch line after the front matter is not one');
  assert.equal(awkFinds(dir, 'slice/s-01', 'no front matter\nbranch: slice/s-01\n'), false, 'no front matter at all');
});

/** Run the clone step in bash against a local fake workspace and a fake gh. */
function runCloneStep({ sheets, branch }) {
  const base = mkdtempSync(join(tmpdir(), 'recade-step-'));
  const remote = join(base, 'workspace.git');
  const seed = join(base, 'seed');
  mkdirSync(join(seed, 'slices'), { recursive: true });
  for (const [name, text] of Object.entries(sheets)) writeFileSync(join(seed, 'slices', name), text);
  const run = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  run(seed, 'init', '-q', '-b', 'main');
  run(seed, '-c', 'user.name=T', '-c', `user.email=${['t', 'example.test'].join('@')}`, 'add', '-A');
  run(seed, '-c', 'user.name=T', '-c', `user.email=${['t', 'example.test'].join('@')}`, 'commit', '-q', '-m', 'x');
  spawnSync('git', ['clone', '-q', '--bare', seed, remote]);
  const checkout = join(base, 'checkout');
  mkdirSync(checkout);
  run(checkout, 'init', '-q');
  const bin = join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho '${branch}'\n`, { mode: 0o755 });
  const temp = join(base, 'temp');
  mkdirSync(temp);
  const output = join(base, 'output');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['-c', clone.run], {
    cwd: checkout,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: base, RUNNER_TEMP: temp, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'acme/fernhill-api',
      PR_NUMBER: '7', WORKSPACE_REPOSITORY: 'acme/fernhill-workspace', WORKSPACE_TOKEN: 'fake-token-value',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/acme/fernhill-workspace.git',
    },
  });
  return { r, checkout, temp, output: readFileSync(output, 'utf8') };
}

test('second opinion, the step run on a fixture: an empty or unterminated sheet never wins, and the real sheet is copied', () => {
  const sheets = {
    'S-00-empty.md': '',
    'S-01-open.md': '---\ndoc_id: S-01\ntitle: x\n',
    'S-02-real.md': sheetText('doc_id: S-02\nbranch: slice/s-02'),
  };
  const real = runCloneStep({ sheets, branch: 'slice/s-02' });
  assert.equal(real.r.status, 0, real.r.stderr);
  assert.match(real.output, /found=true/);
  assert.match(readFileSync(join(real.checkout, '.recade-private', 'slice-sheet.md'), 'utf8'), /doc_id: S-02/);
  assert.equal(existsSync(join(real.temp, 'recade-workspace')), false, 'the clone is removed');
  assert.doesNotMatch(real.r.stdout + real.r.stderr, /doc_id|fake-token-value/, 'nothing of the sheet or the token is printed');
  for (const branch of ['slice/none', 'slice/s-01']) {
    const none = runCloneStep({ sheets, branch });
    assert.equal(none.r.status, 0, none.r.stderr);
    assert.match(none.output, /found=false/, branch);
    assert.match(none.r.stdout, /::notice::No slice sheet/);
    assert.equal(existsSync(join(none.checkout, '.recade-private')), false, `${branch}: nothing copied`);
  }
});

test('second opinion: a last step removes the clone and the private copy in every case, and the header says how to make the token read only', () => {
  const last = secondSteps[secondSteps.length - 1];
  assert.match(last.if, /always\(\)/);
  assert.match(last.if, new RegExp(`env\\.${FLAG} == 'true'`));
  assert.match(last.run, /rm -rf "\$\{RUNNER_TEMP\}\/recade-workspace"/);
  assert.match(last.run, /rm -rf \.recade-private/);
  assert.equal(last.run.includes('${{'), false);
  assert.ok(secondSteps.indexOf(last) > secondSteps.indexOf(reviewer));
  const header = SECOND.split('\n').filter((l) => l.startsWith('#')).join('\n');
  assert.match(header, /fine-grained/i);
  assert.match(header, /Contents.*read.only/i);
  assert.match(header, /workspace repository only/i);
});
