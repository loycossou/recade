import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_ALIASES, PRICES, PRICES_DATE, PRICES_SOURCE, dollarsOf, modelId, priceOf } from '../src/pricing.js';
import {
  DEFAULT_ROLES, PHASE_IDS, SHORT_ROLES, TOKENS_PER_WORD, estimatePhases, estimateSlice, formatRange, projectFacts, rosterRoles, roundDollars, runTokens,
} from '../src/estimate.js';
import { MECHANICAL_STAGES, stageTier } from '../src/models.js';
import { loadModels } from '../src/harness/models.js';
import { run } from '../src/cli.js';
import { DEFAULT_BUDGETS } from '../src/budgets.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const tiers = JSON.parse(readFileSync(join(repo, 'agents', 'models.json'), 'utf8'));
const harnessModels = loadModels(join(repo, 'harness', 'models.yaml'));
const read = (f) => readFileSync(join(repo, 'commands', f), 'utf8');

const ROSTER = ['project-lead', 'architect', 'security-lead', 'ux-designer', 'qa-lead', 'ui-designer', 'devops-lead', 'chief-reviewer', 'domain-expert'];

/** A fictional project: G0 passed, a roster of 9 roles with a domain expert, documents in English and French. */
function fixture({ gates = 'gates:\n  G0: { passed: "2026-11-01" }\n', roster = true, budgets = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'recade-estimate-'));
  mkdirSync(join(root, 'recade'));
  writeFileSync(join(root, 'recade', 'state.yaml'),
    `version: 1\nmode: scratch\n${gates}languages:\n  chat: en\n  work: en\n  deliverables: [en, fr]\n  code: en\n  product_ui: [en]\n${budgets}`);
  if (roster) {
    mkdirSync(join(root, 'team'));
    const rows = ROSTER.map((r) => `| ${r} | Someone | A reason. | claude-opus-5-5 | high | core |`).join('\n');
    writeFileSync(join(root, 'team', 'roster.md'), `## Team\n\n| Role | Inspired by | Why this role for this project | Model | Effort | Origin |\n|---|---|---|---|---|---|\n${rows}\n`);
  }
  return root;
}

function makeIO(cwd, env = {}) {
  const out = [];
  const err = [];
  const config = mkdtempSync(join(tmpdir(), 'recade-estimate-config-'));
  return {
    io: { cwd, env: { HOME: cwd, RECADE_CONFIG_DIR: config, ...env }, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    stdout: () => out.join(''), stderr: () => err.join(''), config,
  };
}

const ctx = { writer: 'opus', tiers };

// ---------------------------------------------------------------------------------------------------------
// The price table
// ---------------------------------------------------------------------------------------------------------

test('the price table holds the prices of 2026-11-03, per million tokens, for the four models', () => {
  assert.equal(PRICES_DATE, '2026-11-03');
  assert.equal(PRICES_SOURCE, 'prices of 2026-11-03, Anthropic API, per million tokens');
  assert.deepEqual(JSON.parse(JSON.stringify(PRICES)), {
    'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
    'claude-fable-5-2': { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
  });
});

test('every alias and model id of the repository has a price', () => {
  assert.deepEqual({ ...MODEL_ALIASES }, { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' });
  const yaml = new Set(Object.values(harnessModels.agents).flatMap((l) => [l.standard.model, l.sensitive.model]));
  for (const m of [...yaml, tiers.writer.model, tiers.mechanical.model, 'opus', 'fable']) assert.ok(priceOf(m), m);
  assert.equal(modelId('sonnet'), 'claude-sonnet-5-5');
  assert.equal(modelId('claude-opus-5-5'), 'claude-opus-5-5');
  assert.throws(() => modelId('gpt'), /No price for the model "gpt"/);
});

test('dollarsOf prices each kind of token at its own rate', () => {
  assert.equal(dollarsOf('opus', { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }), 4 + 20 + 5 + 0.2);
  assert.equal(dollarsOf('claude-fable-5-2', { output: 500000 }), 20);
  assert.equal(dollarsOf('haiku', {}), 0);
});

// ---------------------------------------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------------------------------------

test('runTokens: what a run writes is output, what it reads goes to the cache once and is read back on later turns', () => {
  const r = { profile: 'reply', writes: 1000, reads: 0 };
  const low = runTokens(r, 'high', 'low');
  // reply: 3 turns of 600 tool tokens; 1000 words and the 400-word report at 1.4 tokens a word.
  const written = 1400 * TOKENS_PER_WORD;
  assert.equal(low.output, written + 3 * 150 + 3 * 600);
  assert.equal(low.input, 3 * 300);
  assert.equal(low.cacheWrite, 18000 + 2000 + written + 3 * 600 + 3 * 150);
  assert.equal(low.cacheRead, 3 * 20000 + ((written + 3 * 600 + 3 * 150) * 3) / 2);
  const high = runTokens(r, 'high', 'high');
  assert.ok(high.output > low.output && high.cacheRead > low.cacheRead);
});

test('roundDollars rounds the low figure down and the high one up, to a step that grows with the figure', () => {
  assert.equal(roundDollars(0.634, 'down'), 0.6);
  assert.equal(roundDollars(0.634, 'up'), 0.7);
  assert.equal(roundDollars(12.2, 'down'), 12);
  assert.equal(roundDollars(12.2, 'up'), 13);
  assert.equal(roundDollars(43, 'down'), 40);
  assert.equal(roundDollars(43, 'up'), 45);
  assert.equal(roundDollars(512, 'up'), 520);
  assert.equal(formatRange({ rounded: { low: 12, high: 30 }, runs: { low: 14, high: 14 } }), 'about $12 to $30, 14 agent runs');
  assert.equal(formatRange({ rounded: { low: 0.6, high: 4 }, runs: { low: 1, high: 2 } }), 'about $0.60 to $4, 1 to 2 agent runs');
});

test('projectFacts reads the roster, the domain expert, the translations and the budgets of the project', () => {
  const root = fixture({ budgets: 'budgets:\n  D1: 12000\n' });
  assert.deepEqual(rosterRoles(root).map((r) => r.role), ROSTER);
  const facts = projectFacts(root, { languages: { deliverables: ['en', 'fr'] }, budgets: { D1: 12000 } });
  assert.deepEqual({ ...facts.roles }, { low: 9, high: 9 });
  assert.deepEqual({ ...facts.domainExpert }, { low: 1, high: 1 });
  assert.equal(facts.translations, 1);
  assert.equal(facts.budgets.D1, 12000);
  const bare = projectFacts(fixture({ roster: false }), null);
  assert.deepEqual(bare.roles, DEFAULT_ROLES);
  assert.deepEqual({ ...bare.domainExpert }, { low: 0, high: 1 });
  assert.equal(bare.translations, 0);
});

test('the estimate of the fixture project: deterministic figures for each phase not passed yet', () => {
  const root = fixture();
  const state = { mode: 'scratch', gates: { G0: { passed: '2026-11-01' } }, languages: { deliverables: ['en', 'fr'] } };
  const result = estimatePhases(projectFacts(root, state), state, ctx);
  assert.equal(result.estimate, true);
  assert.equal(result.prices, PRICES_SOURCE);
  assert.deepEqual(result.phases.map((p) => p.phase), ['team', 'docs', 'bible', 'slices', 'harness']);
  const figures = Object.fromEntries(result.phases.map((p) => [p.phase, [p.runs.low, p.runs.high, p.rounded.low, p.rounded.high]]));
  assert.deepEqual(figures, EXPECTED_FIXTURE);
  assert.deepEqual(result.total.runs, {
    low: result.phases.reduce((n, p) => n + p.runs.low, 0), high: result.phases.reduce((n, p) => n + p.runs.high, 0),
  });
  for (const p of result.phases) assert.ok(p.dollars.low < p.dollars.high, p.phase);
});

test('a translation adds mechanical runs, a bigger budget costs more, Fable costs more than Opus', () => {
  const root = fixture();
  const one = { languages: { deliverables: ['en'] } };
  const two = { languages: { deliverables: ['en', 'fr'] } };
  const docs = (state, c = ctx) => estimatePhases(projectFacts(root, state), state, { ...c, phases: ['docs'] }).phases[0];
  const a = docs(one);
  const b = docs(two);
  assert.equal(b.runs.low - a.runs.low, 4);
  const translations = b.items.filter((i) => i.stage === 'translate');
  assert.deepEqual(translations.map((i) => [i.agent, i.runs.low]), [['project-lead', 2], ['architect', 1], ['security-lead', 1]]);
  for (const i of translations) assert.equal(i.model, 'claude-sonnet-5-5');
  const big = docs({ ...one, budgets: { D1: 20000 } });
  assert.ok(big.dollars.low > a.dollars.low);
  assert.ok(docs(one, { ...ctx, writer: 'fable' }).dollars.low > a.dollars.low);
});

test('the docs phase counts the runs the command dispatches: one review per document, the spikes, a domain contribution', () => {
  const root = fixture();
  const state = { languages: { deliverables: ['en'] } };
  const docs = estimatePhases(projectFacts(root, state), state, { ...ctx, phases: ['docs'] }).phases[0];
  const count = (agent, stage) => docs.items.filter((i) => i.agent === agent && i.stage === stage).reduce((n, i) => n + i.runs.low, 0);
  assert.equal(count('project-lead', 'draft-d1'), 1);
  assert.equal(count('domain-expert', 'contribute'), 1);
  assert.equal(count('domain-expert', 'review'), 1);
  assert.equal(count('security-lead', 'review'), 1);
  assert.equal(count('architect', 'review'), 3);
  assert.equal(count('spike-runner', 'spike'), 6);
  assert.equal(count('stack-analyst', 'decide'), 5);
  const team = estimatePhases(projectFacts(root, state), state, { ...ctx, phases: ['team'] }).phases[0];
  assert.equal(team.items.find((i) => i.agent === 'doctrine-writer').runs.low, 9);
});

test('the short track: spikes from none to the full number, one stack opinion, a revise only for a blocker, two boards', () => {
  const root = fixture();
  const full = { languages: { deliverables: ['en'] } };
  const short = { ...full, track: 'short' };
  const phase = (state, id) => estimatePhases(projectFacts(root, state), state, { ...ctx, phases: [id] }).phases[0];
  const runs = (p, agent, stage) => p.items.filter((i) => i.agent === agent && i.stage === stage)
    .reduce((n, i) => ({ low: n.low + i.runs.low, high: n.high + i.runs.high }), { low: 0, high: 0 });
  const [fd, sd] = [phase(full, 'docs'), phase(short, 'docs')];
  assert.equal(projectFacts(root, full).track, 'full');
  assert.equal(projectFacts(root, short).track, 'short');
  // Spikes: 6 to 15 in the full track; in the short track the leader gap is unknown before the research.
  assert.deepEqual(runs(fd, 'spike-runner', 'spike'), { low: 6, high: 15 });
  assert.deepEqual(runs(sd, 'spike-runner', 'spike'), { low: 0, high: 15 });
  // One opinion on the stack, the architect's: three architect reviews (STACK, D3, PLAN) on both tracks, no devops one.
  assert.deepEqual(runs(fd, 'devops-lead', 'review'), { low: 1, high: 1 });
  assert.deepEqual(runs(sd, 'devops-lead', 'review'), { low: 0, high: 0 });
  assert.deepEqual(runs(sd, 'architect', 'review'), runs(fd, 'architect', 'review'));
  // The art direction: two boards, and its revise round only on a blocker.
  assert.deepEqual(runs(fd, 'ui-designer', 'revise'), { low: 1, high: 2 });
  assert.deepEqual(runs(sd, 'ui-designer', 'revise'), { low: 0, high: 1 });
  const boards = (p) => p.items.find((i) => i.agent === 'ui-designer' && i.stage === 'directions').dollars;
  assert.ok(boards(sd).high < boards(fd).high);
  // With the full budgets kept, only the number of boards differs: two is the low figure of both tracks.
  const same = phase({ ...short, budgets: { ...DEFAULT_BUDGETS } }, 'docs');
  assert.equal(boards(same).low, boards(fd).low);
  assert.ok(boards(same).high < boards(fd).high);
  // The revise round after a review: one per document in the full track, 0 to 1 in the short track.
  // D1, D2, D3 and the PLAN each have their author revise once, plus the second rounds and the cuts that both tracks keep.
  const fr = runs(fd, 'project-lead', 'revise');
  const sr = runs(sd, 'project-lead', 'revise');
  assert.equal(fr.low - sr.low, 2, 'D1 and the PLAN');
  assert.equal(fr.high, sr.high);
  assert.equal(runs(fd, 'architect', 'revise').low - runs(sd, 'architect', 'revise').low, 1, 'D2');
  assert.equal(runs(fd, 'security-lead', 'revise').low - runs(sd, 'security-lead', 'revise').low, 1, 'D3');
  const [fb, sb] = [phase(full, 'bible'), phase(short, 'bible')];
  assert.equal(runs(fb, 'bible-writer', 'revise').low - runs(sb, 'bible-writer', 'revise').low, 1);
  // Half the budgets, fewer runs: the short track costs less in every phase it changes.
  for (const [f, s] of [[fd, sd], [fb, sb]]) {
    assert.ok(s.runs.low < f.runs.low && s.runs.high <= f.runs.high, `${f.phase} runs`);
    assert.ok(s.dollars.low < f.dollars.low && s.dollars.high < f.dollars.high, `${f.phase} dollars`);
  }
});

test('the short track with no roster yet counts the 8 core roles, plus one for regulated data', () => {
  const root = fixture({ roster: false });
  const team = (state) => estimatePhases(projectFacts(root, state), state, { ...ctx, phases: ['team'] }).phases[0];
  assert.deepEqual({ ...SHORT_ROLES }, { low: 8, high: 9 });
  assert.deepEqual(projectFacts(root, { track: 'short' }).roles, SHORT_ROLES);
  assert.deepEqual(projectFacts(root, {}).roles, DEFAULT_ROLES);
  const doctrines = (p) => p.items.find((i) => i.agent === 'doctrine-writer').runs;
  assert.deepEqual(doctrines(team({ track: 'short' })), { low: 8, high: 11 });
  assert.deepEqual(doctrines(team({})), { low: 9, high: 13 });
  // A roster, once written, is what counts, on both tracks.
  assert.deepEqual({ ...projectFacts(fixture(), { track: 'short' }).roles }, { low: 9, high: 9 });
});

test('every phase passed: nothing to estimate; the intake of an adopted project is not estimated', () => {
  const gates = Object.fromEntries(['G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5'].map((g) => [g, { passed: '2026-11-01' }]));
  assert.deepEqual(estimatePhases(projectFacts(null, null), { gates }, ctx).phases, []);
  const adopt = estimatePhases(projectFacts(null, null), { mode: 'adopt', gates: {} }, ctx);
  assert.deepEqual(adopt.phases.map((p) => p.phase), PHASE_IDS.filter((p) => p !== 'intake'));
  assert.throws(() => estimatePhases(projectFacts(null, null), null, { ...ctx, phases: ['nope'] }), /Unknown phase: nope/);
});

test('the estimate of one slice follows the chain of the lane and the models of harness/models.yaml', () => {
  const standard = estimateSlice('standard', { harnessModels });
  const sensitive = estimateSlice('sensitive', { harnessModels });
  assert.deepEqual([standard.runs.low, standard.runs.high, standard.rounded.low, standard.rounded.high], EXPECTED_SLICE.standard);
  assert.deepEqual([sensitive.runs.low, sensitive.runs.high, sensitive.rounded.low, sensitive.rounded.high], EXPECTED_SLICE.sensitive);
  const agents = (e) => e.items.filter((i) => i.runs.low > 0).map((i) => i.agent);
  assert.deepEqual(agents(standard), ['spec-writer', 'test-engineer', 'implementer', 'reviewer', 'doc-writer', 'release-manager']);
  assert.deepEqual(agents(sensitive), ['spec-writer', 'domain-reviewer', 'test-engineer', 'implementer-critical', 'reviewer', 'security-reviewer', 'doc-writer', 'release-manager', 'second-opinion']);
  assert.equal(sensitive.items.find((i) => i.agent === 'security-reviewer').model, 'claude-opus-5-5');
  assert.equal(standard.items.find((i) => i.agent === 'implementer').model, 'claude-sonnet-5-5');
  const off = estimateSlice('sensitive', { harnessModels, secondOpinion: 'off' });
  assert.equal(off.items.some((i) => i.agent === 'second-opinion'), false);
  assert.throws(() => estimateSlice('no-code', { harnessModels }), /Unknown lane/);
});

// Figures of the constants of src/estimate.js: when a constant is tuned, these change on purpose.
const EXPECTED_FIXTURE = {
  team: [11, 13, 17, 60],
  docs: [54, 90, 25, 105],
  bible: [6, 10, 3, 9],
  slices: [1, 3, 1.3, 6],
  harness: [5, 7, 2, 7],
};
const EXPECTED_SLICE = { standard: [6, 13, 3, 35], sensitive: [9, 17, 7, 50] };

// ---------------------------------------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------------------------------------

test('recade cost estimate prints each phase not passed, the total, and says it is an estimate at API prices', async () => {
  const root = fixture();
  const t = makeIO(root);
  assert.equal(await run(['cost', 'estimate', '--project', root], t.io), 0, t.stderr());
  const lines = t.stdout().trim().split('\n');
  assert.deepEqual(lines.map((l) => l.split(':')[0]), ['Team', 'Documents', 'Bible', 'Slices', 'Harness', 'Total', 'An estimate, not a measure']);
  assert.match(lines[0], /^Team: about \$\d+ to \$\d+, \d+ to \d+ agent runs$/);
  assert.match(lines[5], /\(API prices; on a Claude subscription it counts against your usage limits instead\.\)$/);
  assert.equal(lines[6], 'An estimate, not a measure: prices of 2026-11-03, Anthropic API, per million tokens, writing model opus.');
});

test('recade cost estimate --phase prints the one line a phase command shows the owner', async () => {
  const root = fixture();
  const t = makeIO(root);
  assert.equal(await run(['cost', 'estimate', '--phase', 'docs', '--project', root], t.io), 0, t.stderr());
  assert.match(t.stdout().split('\n')[0],
    /^Estimated cost of this phase: about \$\d+ to \$\d+, \d+ to \d+ agent runs \(API prices; on a Claude subscription it counts against your usage limits instead\.\)$/);
});

test('recade cost estimate --json gives the figures, the runs of each kind and the price source', async () => {
  const root = fixture();
  const t = makeIO(root);
  assert.equal(await run(['cost', 'estimate', '--phase', 'bible', '--json', '--project', root], t.io), 0, t.stderr());
  const out = JSON.parse(t.stdout());
  assert.equal(out.estimate, true);
  assert.equal(out.writer, 'opus');
  assert.equal(out.prices, PRICES_SOURCE);
  assert.equal(out.phases.length, 1);
  const [bible] = out.phases;
  assert.equal(bible.phase, 'bible');
  assert.deepEqual([bible.runs.low, bible.runs.high, bible.rounded.low, bible.rounded.high], EXPECTED_FIXTURE.bible);
  assert.ok(bible.items.some((i) => i.agent === 'chief-reviewer' && i.stage === 'review' && i.model === 'claude-opus-5-5'));
  assert.ok(bible.items.some((i) => i.agent === 'bible-writer' && i.stage === 'translate' && i.model === 'claude-sonnet-5-5' && i.effort === 'medium'));
  assert.deepEqual(Object.keys(out.total), ['runs', 'dollars', 'rounded']);
});

test('recade cost estimate follows the writing model of the user config', async () => {
  const root = fixture();
  const t = makeIO(root);
  writeFileSync(join(t.config, 'config.yaml'), 'models:\n  writer: fable\n');
  assert.equal(await run(['cost', 'estimate', '--phase', 'team', '--json', '--project', root], t.io), 0, t.stderr());
  const out = JSON.parse(t.stdout());
  assert.equal(out.writer, 'fable');
  assert.ok(out.phases[0].items.every((i) => i.model === 'claude-fable-5-2'));
});

test('recade cost estimate --slice needs no project, and every phase passed says so', async () => {
  const t = makeIO(tmpdir());
  assert.equal(await run(['cost', 'estimate', '--slice', 'sensitive'], t.io), 0, t.stderr());
  assert.match(t.stdout(), /^Estimated cost of one sensitive slice: about \$\d+ to \$\d+, 9 to 17 agent runs/);
  assert.match(t.stdout(), /recade cost record measures a slice\./);
  const gates = `gates:\n${['G0', 'G1', 'G2-stack', 'G2', 'G3', 'G4', 'G5'].map((g) => `  ${g}: { passed: "2026-11-01" }`).join('\n')}\n`;
  const root = fixture({ gates });
  const u = makeIO(root);
  assert.equal(await run(['cost', 'estimate', '--project', root], u.io), 0, u.stderr());
  assert.match(u.stdout(), /^Every phase is passed: nothing to estimate\./);
});

test('recade cost estimate: bad usage exits 2, no project exits 1', async () => {
  const root = fixture();
  for (const args of [['--phase'], ['--phase', 'nope'], ['--slice', 'no-code'], ['--phase', 'docs', '--slice', 'standard'], ['extra'], ['--bogus']]) {
    const t = makeIO(root);
    assert.equal(await run(['cost', 'estimate', ...args, '--project', root], t.io), 2, args.join(' '));
    assert.match(t.stderr(), /^Usage: recade cost estimate/);
  }
  const empty = mkdtempSync(join(tmpdir(), 'recade-estimate-none-'));
  const t = makeIO(empty);
  assert.equal(await run(['cost', 'estimate'], t.io), 1);
  assert.match(t.stderr(), /No Recade project here/);
  const r = makeIO(root);
  assert.equal(await run(['cost', 'record'], r.io), 2);
  assert.match(r.stderr(), /Usage: recade cost record/);
});

test('recade help lists recade cost estimate', async () => {
  const t = makeIO(tmpdir());
  assert.equal(await run(['help'], t.io), 0);
  assert.match(t.stdout(), /^recade cost\s+.*recade cost estimate \[--phase <phase> \| --slice standard\|sensitive\] \[--json\]/m);
});

// ---------------------------------------------------------------------------------------------------------
// Each phase shows its estimate; mechanical stages run on the mechanical model
// ---------------------------------------------------------------------------------------------------------

test('each phase command shows the estimate once, in one line, and never blocks on it', () => {
  for (const [f, phase] of [['new.md', 'intake'], ['team.md', 'team'], ['docs.md', 'docs'], ['bible.md', 'bible'], ['slices.md', 'slices'], ['harness.md', 'harness']]) {
    const text = read(f);
    assert.equal(text.split(`run \`recade cost estimate --phase ${phase} --project '<dir>'\` once`).length, 2, f);
    for (const part of ['Estimated cost of this phase:', 'on a Claude subscription it counts against your usage limits instead', 'if the command fails or prints nothing, say nothing about the cost and go on']) {
      assert.ok(text.includes(part), `${f}: ${part}`);
    }
    const at = text.indexOf('**Cost estimate.**');
    const firstDispatch = text.indexOf(f === 'new.md' ? '\n## Step 4.' : '\n## Step 2.');
    assert.ok(at > 0 && at < firstDispatch, f);
  }
});

test('the mechanical stages are translate, glossary, apply-decisions and the format fixes; drafting and reviewing stay on the writer', () => {
  assert.deepEqual(MECHANICAL_STAGES.map((m) => m.stage), ['translate', 'glossary', 'apply-decisions', 'fix']);
  assert.equal(stageTier('project-lead', 'translate'), 'mechanical');
  assert.equal(stageTier('project-lead', 'glossary'), 'mechanical');
  assert.equal(stageTier('bible-writer', 'apply-decisions'), 'mechanical');
  assert.equal(stageTier('architect', 'fix'), 'mechanical');
  assert.equal(stageTier('stack-analyst', 'apply-decisions'), 'writer');
  for (const stage of ['draft', 'draft-d1', 'draft-plan', 'contribute', 'review', 'revise', 'plan', 'cut', 'doctrine']) {
    for (const agent of ['project-lead', 'architect', 'security-lead', 'bible-writer', 'chief-reviewer', 'slicer']) assert.equal(stageTier(agent, stage), 'writer', `${agent} ${stage}`);
  }
});

const MECHANICAL_RULE = 'Read the mechanical model once too: run `recade models mechanical` and keep the word it prints (`sonnet`)';

test('docs, bible and amend dispatch the mechanical stages on the mechanical model, and only those', () => {
  for (const f of ['docs.md', 'bible.md', 'amend.md']) {
    const text = read(f);
    assert.equal(text.split(MECHANICAL_RULE).length, 2, f);
    for (const part of ['with the stage `translate`, `glossary` or `apply-decisions`', 'a line of `recade lint-style`, `recade index check` or `recade render` (a format fix)',
      'Drafts, contributions, reviews, a `revise` after a review note, a size error or the owner\'s words, and every stage of the other agents keep the writing model.']) assert.ok(text.includes(part), `${f}: ${part}`);
    assert.ok(text.indexOf('Read the writing model once') < text.indexOf(MECHANICAL_RULE), f);
  }
  for (const f of ['new.md', 'team.md', 'slices.md', 'harness.md', 'adopt.md']) assert.equal(read(f).includes(MECHANICAL_RULE), false, f);
});

test('recade models mechanical prints the alias and the effort of the mechanical tier of agents/models.json', async () => {
  const a = makeIO(tmpdir());
  assert.equal(await run(['models', 'mechanical'], a.io), 0);
  assert.equal(a.stdout(), `${tiers.mechanical.model}\n`);
  const b = makeIO(tmpdir());
  assert.equal(await run(['models', 'mechanical', '--effort'], b.io), 0);
  assert.equal(b.stdout(), `${tiers.mechanical.effort}\n`);
  assert.deepEqual(tiers.mechanical, { model: 'sonnet', effort: 'medium' });
});
