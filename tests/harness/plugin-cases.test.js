import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { claudeCommand, evaluateCase, loadCases } from '../../src/harness/cases.js';
import { install } from '../../src/harness/install.js';
import { cli, makeProject, plugin } from './fixture-project.js';

/** Test cases of the plugin's own agents (agents/*.md, spec sections 12 and 14), kept in cases/<agent>/*.md. */
const pluginAgentsDir = join(plugin, 'agents');
const pluginCasesDir = join(plugin, 'cases');
// The list comes from the agent files, so a plugin agent added later fails here until it has its cases.
const agents = readdirSync(pluginAgentsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
const cases = loadCases(pluginCasesDir);
const harnessCases = loadCases(join(plugin, 'harness', 'cases'));

test('every agent of agents/*.md has at least two cases, and no case names an agent that does not exist', () => {
  assert.ok(agents.length >= 15, 'the agent list is read from the folder');
  for (const agent of agents) {
    const own = cases.filter((c) => c.agent === agent);
    assert.ok(own.length >= 2, `${agent} has ${own.length} case(s), it needs at least two in cases/${agent}/`);
    assert.equal(new Set(own.map((c) => c.name)).size, own.length, `${agent}: case names are unique`);
  }
  for (const c of cases) assert.ok(agents.includes(c.agent), `${c.file}: agents/${c.agent}.md does not exist`);
});

test('every case parses with an input, an expectation, and words that make it checkable', () => {
  assert.ok(cases.length >= agents.length * 2);
  for (const c of cases) {
    const where = `${c.agent}/${c.name}`;
    assert.ok(c.input.length > 100, `${where}: input`);
    assert.ok(c.expected.length > 0, `${where}: expected`);
    assert.equal(c.verdict, 'none', `${where}: the plugin agents give no verdict, they report`);
    assert.ok(c.mustContain.length > 0, `${where}: a case with no verdict must name what the answer contains`);
    assert.match(c.input, /fictional/i, `${where}: the input says it is fictional`);
    assert.match(c.input, /Do not run/, `${where}: the input says nothing is run`);
  }
});

test('every agent has a case that must succeed and one that must be refused or report gaps', () => {
  for (const agent of agents) {
    const text = cases.filter((c) => c.agent === agent).map((c) => c.expected);
    assert.ok(text.some((t) => /^Succeeds\b/.test(t)), `${agent}: one Expected starts with "Succeeds"`);
    assert.ok(text.some((t) => /^(Refuses|Reports gaps)\b/.test(t)), `${agent}: one Expected starts with "Refuses" or "Reports gaps"`);
  }
});

const flat = (t) => String(t).toLowerCase().replace(/\s+/g, ' ');
// Words an agent's own report template always gives, whatever it did: the fixed headings and the Report section.
const FIXED_WORDS = ['verdict', 'findings', 'what is good', 'where it stopped', 'readability', 'install commands', 'task', 'commands', 'measures', 'glossary terms', 'hotspots', 'none'];
const reportOf = (agent) => {
  const text = readFileSync(join(pluginAgentsDir, `${agent}.md`), 'utf8');
  return flat(text.slice(text.indexOf('## Report')));
};

test('every Refuses or Reports gaps case forbids what a compliant agent would not write', () => {
  const stops = cases.filter((c) => /^(Refuses|Reports gaps)\b/.test(c.expected));
  assert.ok(stops.length >= agents.length, 'at least one for each agent');
  for (const c of stops) assert.ok(c.mustNotContain.length > 0, `${c.agent}/${c.name}: must_not_contain is empty`);
});

test('every case needs a word that its own input does not hand over and that a fixed report heading does not give', () => {
  for (const c of cases) {
    const input = flat(c.input);
    const report = reportOf(c.agent);
    const real = c.mustContain.filter((w) => !input.includes(flat(w)) && !FIXED_WORDS.includes(flat(w)) && !report.includes(flat(w)));
    assert.ok(real.length > 0, `${c.agent}/${c.name}: every must_contain word is echoed from the input or given by the report template (${c.mustContain.join(', ')})`);
    for (const w of c.mustNotContain) assert.ok(w.length >= 4, `${c.agent}/${c.name}: forbidden word ${JSON.stringify(w)} is too short to mean anything`);
  }
});

test('the matcher ignores case and line breaks inside a phrase', () => {
  const c = { verdict: 'none', mustContain: ['verdict: approve'], mustNotContain: ['verdict: changes needed'] };
  assert.equal(evaluateCase(c, 'Verdict:\n  approve').ok, true);
  assert.match(evaluateCase(c, 'Verdict:\nChanges\nneeded').reasons.join(), /does not contain "verdict: approve".*contains "verdict: changes needed"/);
});

test('D3 ids in the cases follow the template format SEC-<DOMAIN>-<nn>', () => {
  for (const c of cases) assert.doesNotMatch(readFileSync(c.file, 'utf8'), /\bSR-\d/, `${c.file}: SR-nn is not a D3 id`);
});

test('the plugin cases use fictional content only', () => {
  for (const c of cases) {
    const text = readFileSync(c.file, 'utf8');
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, `${c.file}: no e-mail`);
    assert.equal(text.includes(String.fromCharCode(0x2014)), false, `${c.file}: no em dash`);
    assert.doesNotMatch(text, /\bHaiku\b/i, c.file);
    assert.doesNotMatch(text, /\+\d[\d ]{8,}/, `${c.file}: no phone number`);
  }
});

test('the spec examples: a two-line idea lists provisionals, no spike means no stack choice, an oversized slice is split, a doctrine without sources is not written', () => {
  const has = (agent, name) => cases.find((c) => c.agent === agent && c.name === name);
  assert.ok(has('intake-analyst', 'two-line-idea').mustContain.includes('PRV-02'), 'more than one provisional is opened');
  assert.ok(has('intake-analyst', 'two-line-idea').mustNotContain.includes('blocking gaps none'), 'the blocking gaps are not empty');
  assert.ok(has('stack-analyst', 'no-spike-results').mustContain.includes('not run'));
  assert.ok(has('stack-analyst', 'no-spike-results').mustNotContain.includes('40 ms'), 'the owner number is not copied');
  assert.ok(has('slicer', 'slice-over-the-caps').mustContain.includes('split'));
  assert.ok(has('doctrine-writer', 'one-source-only').mustContain.includes('not written'));
  assert.ok(has('doctrine-writer', 'sourced-doctrine').mustContain.includes('review checklist'));
});

test('a plugin case fails an answer that gives a verdict word line, and passes one with its words', () => {
  const c = cases.find((x) => x.agent === 'intake-analyst' && x.name === 'two-line-idea');
  assert.equal(evaluateCase(c, c.mustContain.join('\n')).ok, true);
  assert.match(evaluateCase(c, `${c.mustContain.join('\n')}\nREADY`).reasons.join(), /expected no verdict, got READY/);
  assert.match(evaluateCase(c, 'nothing useful').reasons.join(), /does not contain/);
});

test('claudeCommand reads the model of a plugin agent file', () => {
  const text = readFileSync(join(pluginAgentsDir, 'intake-analyst.md'), 'utf8');
  const cmd = claudeCommand(cases[0], text);
  assert.equal(cmd[cmd.indexOf('--append-system-prompt') + 1], text);
  assert.ok(cmd.includes('--model'));
});

// An answer that holds every word a case needs, so the injected runner passes every case.
const answering = (set) => (cmd) => {
  const c = set.find((x) => x.input === cmd[2]);
  return { code: 0, stdout: `${c.mustContain.join('\n')}\n`, stderr: '' };
};

test('recade cases lists both sets and runs nothing without --run', async () => {
  const r = await cli(plugin, ['cases'], { run: () => { throw new Error('nothing must run'); } });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^\[plugin\] intake-analyst\/two-line-idea {2}expects no verdict$/m);
  assert.match(r.stdout, /^\[harness\] reviewer\/weakened-test {2}expects FIX$/m);
  assert.match(r.stdout, new RegExp(`${cases.length + harnessCases.length} cases\\. Run them with: recade cases --run`));
  const only = await cli(plugin, ['cases', '--plugin']);
  assert.doesNotMatch(only.stdout, /\[harness\]/);
  assert.match(only.stdout, new RegExp(`${cases.length} cases\\.`));
  const harness = await cli(plugin, ['cases', '--harness']);
  assert.doesNotMatch(harness.stdout, /\[plugin\]/);
  assert.match(harness.stdout, new RegExp(`${harnessCases.length} cases\\.`));
  const both = await cli(plugin, ['cases', '--plugin', '--harness']);
  assert.match(both.stdout, new RegExp(`${cases.length + harnessCases.length} cases\\.`));
});

test('recade cases --agent keeps the agents of both sets that share a name, and exits 2 on an unknown agent or option', async () => {
  const r = await cli(plugin, ['cases', '--agent', 'ux-designer']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^\[plugin\] ux-designer\//m);
  assert.match(r.stdout, /^\[harness\] ux-designer\//m);
  assert.equal((await cli(plugin, ['cases', '--agent', 'nobody'])).code, 2);
  assert.match((await cli(plugin, ['cases', '--agent', 'nobody'])).stderr, /No test case for the agent nobody/);
  assert.equal((await cli(plugin, ['cases', '--plugin', '--agent', 'reviewer'])).code, 2, 'reviewer is a harness agent only');
  const bad = await cli(plugin, ['cases', '--nope']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /Usage: recade cases/);
  assert.equal((await cli(plugin, ['cases', 'extra'])).code, 2);
});

test('recade cases --run is refused in CI before any call, and uses the injected runner otherwise', async () => {
  const seen = [];
  const run = (cmd) => {
    seen.push(cmd);
    return answering(cases)(cmd);
  };
  const ci = await cli(plugin, ['cases', '--run'], { run, env: { CI: 'true' } });
  assert.equal(ci.code, 2);
  assert.match(ci.stderr, /not run in CI/);
  assert.equal(seen.length, 0, 'no call in CI');
  const ci1 = await cli(plugin, ['cases', '--plugin', '--run'], { run, env: { CI: '1' } });
  assert.equal(ci1.code, 2);
  assert.equal(seen.length, 0);
  const r = await cli(plugin, ['cases', '--plugin', '--run', '--agent', 'slicer'], { run });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^pass \[plugin\] slicer\/slice-over-the-caps$/m);
  assert.match(r.stdout, /^2 of 2 cases passed/m);
  assert.equal(seen.length, 2);
  assert.ok(seen[0][seen[0].indexOf('--append-system-prompt') + 1].includes('name: slicer'));
  assert.ok(seen[0][seen[0].indexOf('--append-system-prompt') + 1].includes('Respect the caps'), 'the plugin agent file is the one tested');
});

test('recade cases --run reads plugin agents from the plugin and harness agents from the project, and fails a case the answer misses', async () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  const seen = [];
  const run = (cmd) => {
    seen.push(cmd);
    const input = cmd[2];
    if (cases.some((c) => c.input === input)) return answering(cases)(cmd);
    return { code: 0, stdout: 'Fine.\nCONCURS\n', stderr: '' };
  };
  const r = await cli(root, ['cases', '--run', '--agent', 'ux-designer'], { run });
  assert.equal(r.code, 1, 'the harness ux-designer cases expect other verdicts than CONCURS');
  assert.match(r.stdout, /^pass \[plugin\] ux-designer\/.+$/m);
  assert.match(r.stdout, /^FAIL \[harness\] ux-designer\/.+$/m);
  const prompts = seen.map((c) => c[c.indexOf('--append-system-prompt') + 1]);
  assert.equal(prompts.filter((p) => p.includes('recade-harness v')).length, 2, 'the installed harness agent files are used for the harness set');
  assert.equal(prompts.filter((p) => !p.includes('recade-harness v')).length, cases.filter((c) => c.agent === 'ux-designer').length, 'the plugin agent files for the plugin set');
  assert.match(r.stdout, /plugin agents read from .*agents/);
  assert.match(r.stdout, /harness agents read from .*\.claude/);
  const failing = await cli(root, ['cases', '--plugin', '--run', '--agent', 'recruiter'], { run: () => ({ code: 0, stdout: 'nothing\n', stderr: '' }) });
  assert.equal(failing.code, 1);
  assert.match(failing.stdout, /^FAIL \[plugin\] recruiter\/.+: the answer does not contain/m);
  const crashed = await cli(root, ['cases', '--plugin', '--run', '--agent', 'recruiter'], { run: () => ({ code: 127, stdout: '', stderr: 'spawn claude ENOENT\n' }) });
  assert.match(crashed.stdout, /claude exited 127/);
});

test('recade harness cases still lists and runs only the harness set', async () => {
  const r = await cli(plugin, ['harness', 'cases']);
  assert.doesNotMatch(r.stdout, /\[plugin\]/);
  assert.match(r.stdout, /41 cases\. Run them with: recade harness cases --run/);
});

test('recade help lists the cases command', async () => {
  const r = await cli(plugin, ['help']);
  assert.match(r.stdout, /^recade cases +List and replay the agent test cases/m);
});
