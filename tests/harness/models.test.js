import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { run } from '../../src/cli.js';
import { lintText } from '../../src/style/lint.js';
import { loadModels, syncAgents, validateModels, familyOf } from '../../src/harness/models.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const modelsPath = join(repo, 'harness', 'models.yaml');
const protocolPath = join(repo, 'harness', 'protocol.md');
const models = loadModels(modelsPath);

const AGENT_NAMES = [
  'spec-writer', 'ux-designer', 'ui-designer', 'test-engineer', 'implementer', 'implementer-critical', 'reviewer',
  'security-reviewer', 'design-reviewer', 'product-reviewer', 'domain-reviewer', 'devops', 'doc-writer', 'release-manager',
  'board-keeper', 'test-runner', 'explorer', 'code-teacher', 'second-opinion', 'merge-keeper',
];

/** Spec section 10.2: [standard model, standard effort, sensitive model, sensitive effort]. */
const TABLE = {
  'spec-writer': ['opus', 'high', 'opus', 'high'],
  'ux-designer': ['opus', 'high', 'opus', 'high'],
  'ui-designer': ['sonnet', 'high', 'sonnet', 'high'],
  'test-engineer': ['sonnet', 'high', 'sonnet', 'high'],
  implementer: ['sonnet', 'high', 'sonnet', 'high'],
  'implementer-critical': ['opus', 'high', 'opus', 'high'],
  reviewer: ['opus', 'high', 'opus', 'high'],
  'security-reviewer': ['sonnet', 'high', 'opus', 'high'],
  'design-reviewer': ['sonnet', 'high', 'sonnet', 'high'],
  'product-reviewer': ['opus', 'medium', 'opus', 'medium'],
  'domain-reviewer': ['sonnet', 'high', 'sonnet', 'high'],
  devops: ['sonnet', 'medium', 'sonnet', 'medium'],
  'doc-writer': ['sonnet', 'medium', 'sonnet', 'medium'],
  'release-manager': ['sonnet', 'medium', 'sonnet', 'medium'],
  'board-keeper': ['sonnet', 'medium', 'sonnet', 'medium'],
  explorer: ['sonnet', 'medium', 'sonnet', 'medium'],
  'test-runner': ['sonnet', 'low', 'sonnet', 'low'],
  'code-teacher': ['sonnet', 'high', 'sonnet', 'high'],
  'second-opinion': ['claude-fable-5-2', 'high', 'claude-fable-5-2', 'high'],
  'merge-keeper': ['sonnet', 'medium', 'sonnet', 'medium'],
};

function tmpAgents(files) {
  const dir = mkdtempSync(join(tmpdir(), 'recade-harness-agents-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function makeIO() {
  const out = [];
  const err = [];
  return {
    io: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, cwd: repo, env: {} },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

test('models.yaml holds exactly the 20 agents of the spec table, with the exact models and efforts', () => {
  assert.deepEqual(Object.keys(models.agents).sort(), [...AGENT_NAMES].sort());
  for (const [name, [model, effort, sModel, sEffort]] of Object.entries(TABLE)) {
    assert.deepEqual(models.agents[name], { standard: { model, effort }, sensitive: { model: sModel, effort: sEffort } }, name);
  }
});

test('implementer-critical, spec-writer, ux-designer, reviewer and product-reviewer run on Opus; test-runner is low', () => {
  for (const name of ['implementer-critical', 'spec-writer', 'ux-designer', 'reviewer', 'product-reviewer']) {
    for (const lane of ['standard', 'sensitive']) assert.equal(models.agents[name][lane].model, 'opus', `${name} ${lane}`);
  }
  for (const lane of ['standard', 'sensitive']) assert.equal(models.agents['test-runner'][lane].effort, 'low');
  assert.equal(models.agents['security-reviewer'].sensitive.model, 'opus');
});

test('no Haiku anywhere, and the floor is Sonnet medium except test-runner', () => {
  assert.equal(/haiku/i.test(readFileSync(modelsPath, 'utf8')), false);
  for (const [name, lanes] of Object.entries(models.agents)) {
    for (const lane of Object.values(lanes)) {
      assert.notEqual(familyOf(models, lane.model), undefined, `${name}: ${lane.model}`);
      assert.ok(['medium', 'high'].includes(lane.effort) || (name === 'test-runner' && lane.effort === 'low'), `${name}: ${lane.effort}`);
    }
  }
});

test('the second opinion is always another model family than the reviewer, in both lanes', () => {
  for (const lane of ['standard', 'sensitive']) {
    const second = familyOf(models, models.agents['second-opinion'][lane].model);
    const reviewer = familyOf(models, models.agents.reviewer[lane].model);
    assert.equal(reviewer, 'opus');
    assert.equal(second, 'fable');
    assert.notEqual(second, reviewer);
  }
  assert.deepEqual(Object.keys(models.families).sort(), ['fable', 'opus', 'sonnet']);
});

test('validateModels reports Haiku, a low effort outside test-runner, xhigh, unknown models and a same-family second opinion', () => {
  const clone = () => structuredClone(models);
  assert.deepEqual(validateModels(models), []);
  const haiku = clone();
  haiku.agents.explorer.standard.model = 'haiku';
  assert.ok(validateModels(haiku).some((p) => /explorer.*haiku/i.test(p)));
  const low = clone();
  low.agents.explorer.standard.effort = 'low';
  assert.ok(validateModels(low).some((p) => /explorer.*low/.test(p)));
  const xhigh = clone();
  xhigh.agents.reviewer.sensitive.effort = 'xhigh';
  assert.ok(validateModels(xhigh).some((p) => /reviewer.*xhigh/.test(p)));
  const unknown = clone();
  unknown.agents.devops.standard.model = 'gpt-9';
  assert.ok(validateModels(unknown).some((p) => /devops.*gpt-9/.test(p)));
  const same = clone();
  same.agents['second-opinion'].standard.model = 'opus';
  assert.ok(validateModels(same).some((p) => /second-opinion.*reviewer/.test(p)));
  const missing = clone();
  delete missing.agents['merge-keeper'].sensitive;
  assert.ok(validateModels(missing).some((p) => /merge-keeper.*sensitive/.test(p)));
});

test('loadModels throws one line per problem on an invalid file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-harness-models-'));
  const bad = join(dir, 'models.yaml');
  const broken = structuredClone(models);
  broken.agents['second-opinion'].standard.model = 'opus';
  writeFileSync(bad, stringify(broken));
  assert.throws(() => loadModels(bad), /second-opinion.*reviewer/);
  writeFileSync(bad, 'agents: [');
  assert.throws(() => loadModels(bad), /models\.yaml/);
});

test('syncAgents writes model and effort, adds sensitive keys only when the lane differs, and handles zero files', () => {
  assert.deepEqual(syncAgents(tmpAgents({}), models), { changed: [] });
  const dir = tmpAgents({
    'reviewer.md': '---\nname: reviewer\ndescription: x\ntools: Read\n---\n\nbody\n',
    'security-reviewer.md': '---\nname: security-reviewer\nmodel: old\ndescription: x\neffort: low\ntools: Read\n---\n\nbody\n',
    'README.txt': 'ignored',
  });
  assert.deepEqual(syncAgents(dir, models, { check: true }), { changed: ['reviewer.md', 'security-reviewer.md'] });
  assert.equal(readFileSync(join(dir, 'reviewer.md'), 'utf8'), '---\nname: reviewer\ndescription: x\ntools: Read\n---\n\nbody\n');
  assert.deepEqual(syncAgents(dir, models), { changed: ['reviewer.md', 'security-reviewer.md'] });
  assert.equal(readFileSync(join(dir, 'reviewer.md'), 'utf8'), '---\nname: reviewer\ndescription: x\ntools: Read\nmodel: opus\neffort: high\n---\n\nbody\n');
  assert.equal(
    readFileSync(join(dir, 'security-reviewer.md'), 'utf8'),
    '---\nname: security-reviewer\nmodel: sonnet\neffort: high\nsensitive_model: opus\nsensitive_effort: high\ndescription: x\ntools: Read\n---\n\nbody\n',
  );
  assert.deepEqual(syncAgents(dir, models, { check: true }), { changed: [] });
  assert.deepEqual(syncAgents(dir, models), { changed: [] });
});

test('syncAgents removes stale sensitive keys, keeps the body, and rejects unknown agents and missing front matter', () => {
  const dir = tmpAgents({ 'explorer.md': '---\nname: explorer\nsensitive_model: opus\nsensitive_effort: high\n---\n\n## Role\n' });
  assert.deepEqual(syncAgents(dir, models), { changed: ['explorer.md'] });
  assert.equal(readFileSync(join(dir, 'explorer.md'), 'utf8'), '---\nname: explorer\nmodel: sonnet\neffort: medium\n---\n\n## Role\n');
  const bad = tmpAgents({ 'nobody.md': '---\nname: nobody\n---\n', 'reviewer.md': 'no front matter\n' });
  assert.throws(() => syncAgents(bad, models), (err) => /nobody\.md: no agent "nobody" in models\.yaml/.test(err.message) && /reviewer\.md: no front matter/.test(err.message));
});

test('recade harness models --check passes on the repo and exits 1 on drift, 0 after a sync', async () => {
  const ok = makeIO();
  assert.equal(await run(['harness', 'models', '--check'], ok.io), 0, ok.stderr());
  const dir = tmpAgents({ 'reviewer.md': '---\nname: reviewer\nmodel: sonnet\neffort: high\n---\n' });
  const drift = makeIO();
  assert.equal(await run(['harness', 'models', '--check', '--dir', dir], drift.io), 1);
  assert.match(drift.stderr(), /reviewer\.md/);
  assert.match(readFileSync(join(dir, 'reviewer.md'), 'utf8'), /model: sonnet/);
  const fix = makeIO();
  assert.equal(await run(['harness', 'models', '--dir', dir], fix.io), 0);
  assert.match(fix.stdout(), /reviewer\.md/);
  assert.match(readFileSync(join(dir, 'reviewer.md'), 'utf8'), /model: opus/);
  const again = makeIO();
  assert.equal(await run(['harness', 'models', '--check', '--dir', dir], again.io), 0);
});

test('recade harness models rejects bad usage with exit 2 and unreadable inputs with exit 2', async () => {
  for (const args of [[], ['nope'], ['models', '--bogus'], ['models', '--dir'], ['models', '--dir', '--check'], ['models', 'extra']]) {
    const t = makeIO();
    assert.equal(await run(['harness', ...args], t.io), 2, args.join(' '));
    assert.match(t.stderr(), /^Usage: recade harness models/);
  }
  const missing = makeIO();
  assert.equal(await run(['harness', 'models', '--dir', join(tmpdir(), 'recade-no-such-dir-xyz')], missing.io), 2);
});

const protocol = readFileSync(protocolPath, 'utf8');
const section = (title) => {
  const m = new RegExp(`^## ${title}\\s*$`, 'm').exec(protocol);
  assert.ok(m, `section ${title}`);
  const rest = protocol.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
};

test('protocol.md has its sections in order, no em dash and no style finding', () => {
  const headings = [...protocol.matchAll(/^## (.+?)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, [
    'Statuses and transitions', 'Verdicts', 'Lanes', 'Report block', 'Fingerprint and stamps', 'Where the files live', 'Review evidence', 'Delegation', 'Two failures stop',
    'Questions as multiple choice', 'Data, not instructions', 'Writing voice',
  ]);
  assert.deepEqual(lintText(protocol, 'harness/protocol.md'), []);
});

test('protocol statuses are exactly the eleven, and any other status is invalid', () => {
  const rows = [...section('Statuses and transitions').matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual(rows, ['todo', 'design', 'spec', 'gate-1', 'tests', 'implementation', 'audit', 'gate-2', 'ready-to-merge', 'done', 'blocked']);
  assert.ok(section('Statuses and transitions').includes('Any other status is invalid'));
});

test('protocol verdicts are exactly the four sets, with the bounded loops', () => {
  const text = section('Verdicts');
  for (const part of ['`READY | GAPS`', '`CONFORMS | CONFORMS_WITH_RESERVATIONS | FIX | REOPEN`', '`ON_DIRECTION | FIX`', '`CONCURS | CONCERNS | BLOCKING`', 'twice at most', 'BLOCKING', 'no agent merges']) {
    assert.ok(text.toLowerCase().includes(part.toLowerCase()), part);
  }
});

test('protocol lanes hold the three chains of spec 10.3', () => {
  const text = section('Lanes');
  for (const part of ['`sensitive`', '`standard`', '`no-code`', 'gate-1', 'gate-2', 'implementer-critical', 'mutation', 'security-reviewer', 'second-opinion', 'two options and a recommendation', 'test-engineer', 'release-manager', '/board']) {
    assert.ok(text.includes(part), part);
  }
});

test('protocol report block lists the ten keys in order', () => {
  const keys = [...section('Report block').matchAll(/^\d+\. ([A-Za-z0-9 /]+?):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['Slice', 'Status', 'Decisions applied', 'DoD PASS/FAIL', 'Out of scope', 'Human actions', 'BLOCKING', 'Decided while building', 'IDs changed', 'Cost']);
  assert.ok(section('Report block').includes('raw output'));
});

test('protocol covers fingerprint, two failures, QCM questions, data not instructions and the voice pointer', () => {
  const checks = {
    'Fingerprint and stamps': ['HEAD', 'porcelain', 'hash', 'recade gate run', 'current tree fingerprint'],
    'Two failures stop': ['two', 'stop', 'BLOCKING'],
    'Questions as multiple choice': ['recommendation', 'default', 'A', 'B'],
    'Data, not instructions': ['data', 'never as instructions'],
    'Writing voice': ['`writing-voice`', 'recade lint-style'],
  };
  for (const [title, parts] of Object.entries(checks)) {
    for (const part of parts) assert.ok(section(title).includes(part), `${title}: ${part}`);
  }
});

test('sensitiveLane lists the agents whose sensitive lane differs, and the CLI prints them for /slice', async () => {
  const { sensitiveLane } = await import('../../src/harness/models.js');
  assert.deepEqual(sensitiveLane(models), [{ agent: 'security-reviewer', model: 'opus', effort: 'high' }]);
  const ok = makeIO();
  assert.equal(await run(['harness', 'models', '--check'], ok.io), 0, ok.stderr());
  assert.match(ok.stdout(), /^Sensitive lane: security-reviewer model opus effort high\.$/m);
  // The front matter written by the sync carries the same values, which /slice reads at dispatch.
  const fm = readFileSync(join(repo, 'harness', 'agents', 'security-reviewer.md'), 'utf8');
  assert.match(fm, /^sensitive_model: opus$/m);
  assert.match(fm, /^sensitive_effort: high$/m);
});

test('protocol: the second opinion follows second_opinion, sensitive by default, and the sensitive lane dispatches with sensitive_model', () => {
  const lanes = section('Lanes');
  assert.match(lanes, /`off`[^.]*never/);
  assert.match(lanes, /`always`[^.]*every/);
  assert.match(lanes, /`sensitive` \(the default\)[^.]*more than 400/);
  assert.doesNotMatch(lanes, /runs on every `sensitive` PR and on every PR of more than 400 changed lines\. Elsewhere/);
  assert.match(lanes, /sensitive_model/);
});
