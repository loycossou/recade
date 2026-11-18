import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERDICTS, claudeCommand, evaluateCase, loadCases, runCases, verdictOf } from '../../src/harness/cases.js';
import { install } from '../../src/harness/install.js';
import { cli, makeProject, plugin } from './fixture-project.js';

const casesDir = join(plugin, 'harness', 'cases');
const agentsDir = join(plugin, 'harness', 'agents');
const agents = readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
const cases = loadCases(casesDir);

test('every agent has at least two cases, and each case names a verdict its agent can give', () => {
  for (const agent of agents) {
    const own = cases.filter((c) => c.agent === agent);
    assert.ok(own.length >= 2, `${agent} has at least two cases`);
    assert.equal(new Set(own.map((c) => c.name)).size, own.length, `${agent}: case names are unique`);
    const text = readFileSync(join(agentsDir, `${agent}.md`), 'utf8');
    for (const c of own) {
      const word = c.verdict.replace(/^not /, '');
      assert.ok(c.verdict === 'none' || VERDICTS.includes(word), `${agent}/${c.name}: verdict`);
      if (c.verdict !== 'none') assert.ok(text.includes(word), `${agent}/${c.name}: the agent file names ${word}`);
      assert.ok(c.input.length > 50 && c.expected.length > 0, `${agent}/${c.name}: input and expected`);
    }
  }
  assert.equal(cases.length, agents.length * 2 + 1, 'two cases for each agent, and style-only for the second opinion');
});

test('the spec examples: a lacking sheet gives GAPS, a weakened test gives FIX, a second opinion on a clean PR gives CONCURS', () => {
  const verdict = (agent, name) => cases.find((c) => c.agent === agent && c.name === name).verdict;
  assert.equal(verdict('spec-writer', 'lacking-sheet'), 'GAPS');
  assert.equal(verdict('reviewer', 'weakened-test'), 'FIX');
  assert.equal(verdict('second-opinion', 'clean-pr'), 'CONCURS');
  assert.equal(verdict('second-opinion', 'secret-in-diff'), 'BLOCKING');
});

test('second-opinion/clean-pr expects CONCURS with no finding, and second-opinion/style-only expects no BLOCKING', () => {
  const own = cases.filter((c) => c.agent === 'second-opinion');
  assert.deepEqual(own.map((c) => c.name).sort(), ['clean-pr', 'secret-in-diff', 'style-only']);
  const clean = own.find((c) => c.name === 'clean-pr');
  assert.equal(clean.verdict, 'CONCURS');
  assert.match(clean.expected, /^CONCURS with no finding\. Zero findings is a valid result/);
  const style = own.find((c) => c.name === 'style-only');
  assert.equal(style.verdict, 'not BLOCKING', 'no BLOCKING, whatever else the second opinion says about a style point');
  assert.match(style.expected, /^Not BLOCKING\./);
  assert.match(style.input, /`calc2`/);
  assert.match(style.input, /No secret, no dependency added, no test removed, no threshold changed\./);
  // BLOCKING fails it. CONCURS and CONCERNS both pass. No verdict at all fails.
  assert.deepEqual(evaluateCase(style, 'Style only.\nBLOCKING\n').reasons, ['expected a verdict other than BLOCKING, got BLOCKING']);
  assert.equal(evaluateCase(style, 'Nothing to weigh.\nCONCURS\n').ok, true);
  assert.equal(evaluateCase(style, 'One low point on a name.\nCONCERNS\n').ok, true);
  assert.deepEqual(evaluateCase(style, 'Nothing.').reasons, ['expected a verdict other than BLOCKING, got no verdict']);
});

test('the cases use only the global verdicts and fictional content', () => {
  for (const c of cases) {
    const text = readFileSync(c.file, 'utf8');
    assert.doesNotMatch(text, /@[a-z0-9-]+\.(?:com|org|net)/i, c.file);
    assert.equal(text.includes('\u2014'), false, c.file);
    assert.doesNotMatch(text, /\bHaiku\b/i, c.file);
  }
});

test('verdictOf takes the last line that is a verdict and nothing else', () => {
  assert.equal(verdictOf('1. Slice: S-04\n7. BLOCKING: none\n\nGAPS\n'), 'GAPS');
  assert.equal(verdictOf('The verdict may be FIX or CONFORMS.\n`FIX`\n'), 'FIX');
  assert.equal(verdictOf('Not a verdict: FIX the code'), null);
  assert.equal(verdictOf('CONFORMS\nthen more text\nFIX'), 'FIX');
});

test('evaluateCase checks the verdict, the words that must be there and the words that must not', () => {
  const c = { verdict: 'GAPS', mustContain: ['DoD'], mustNotContain: ['READY'] };
  assert.deepEqual(evaluateCase(c, 'The DoD rows have no proof.\nGAPS'), { ok: true, reasons: [] });
  assert.deepEqual(evaluateCase(c, 'The DoD rows have no proof.\nREADY').reasons, ['expected GAPS, got READY', 'the answer contains "READY"']);
  assert.deepEqual(evaluateCase(c, 'GAPS').reasons, ['the answer does not contain "DoD"']);
  assert.deepEqual(evaluateCase(c, 'dod\n').reasons, ['expected GAPS, got no verdict']);
  const none = { verdict: 'none', mustContain: ['BLOCKING'], mustNotContain: [] };
  assert.equal(evaluateCase(none, '7. BLOCKING: the row is not testable').ok, true);
  assert.deepEqual(evaluateCase(none, 'BLOCKING\nFIX').reasons, ['expected no verdict, got FIX']);
});

test('loadCases rejects a malformed case and says which', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-cases-'));
  mkdirSync(join(dir, 'reviewer'));
  writeFileSync(join(dir, 'reviewer', 'a.md'), '---\nagent: reviewer\ncase: a\nverdict: MAYBE\n---\n\n## Input\n\nx\n');
  assert.throws(() => loadCases(dir), /reviewer\/a\.md: verdict must be one of/);
  writeFileSync(join(dir, 'reviewer', 'a.md'), '---\nagent: spec-writer\ncase: a\nverdict: FIX\n---\n\n## Input\n\nx\n');
  assert.throws(() => loadCases(dir), /agent is "spec-writer", it must be reviewer/);
  writeFileSync(join(dir, 'reviewer', 'a.md'), '---\nagent: reviewer\ncase: a\nverdict: FIX\n---\n\nno input\n');
  assert.throws(() => loadCases(dir), /no ## Input section/);
  assert.deepEqual(loadCases(join(dir, 'missing')), []);
});

test('claudeCommand builds a claude -p line with the agent file as system prompt and its model', () => {
  const c = { input: 'Do the thing.' };
  const cmd = claudeCommand(c, '---\nname: reviewer\nmodel: opus\n---\n\nRole text.\n');
  assert.deepEqual(cmd.slice(0, 3), ['claude', '-p', 'Do the thing.']);
  assert.equal(cmd[cmd.indexOf('--append-system-prompt') + 1], '---\nname: reviewer\nmodel: opus\n---\n\nRole text.\n');
  assert.equal(cmd[cmd.indexOf('--model') + 1], 'opus');
  assert.equal(cmd[cmd.indexOf('--allowedTools') + 1], 'Read');
  assert.equal(cmd.some((a) => /merge|push|Bash|Write|Edit/.test(a) && a.startsWith('--allowedTools')), false);
});

test('runCases uses the injected runner and never a real claude', () => {
  const calls = [];
  const exec = (cmd, { cwd }) => {
    calls.push({ cmd, cwd });
    const text = cmd[2];
    if (text.includes('sk_live')) return { code: 0, stdout: 'a secret is in the diff\nBLOCKING\n', stderr: '' };
    return { code: 0, stdout: 'Fine.\nCONCURS\n', stderr: '' };
  };
  const two = cases.filter((c) => c.agent === 'second-opinion' && c.name !== 'style-only');
  const results = runCases(two, { agentsDir, exec });
  assert.deepEqual(results.map((r) => [r.case.name, r.ok]), [['clean-pr', true], ['secret-in-diff', true]]);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].cwd, plugin, 'cases run in an empty temp folder, not in the repository');
  const failing = runCases(two, { agentsDir, exec: () => ({ code: 0, stdout: 'CONCURS', stderr: '' }) });
  assert.equal(failing[1].ok, false);
  assert.match(failing[1].reasons.join(), /expected BLOCKING, got CONCURS/);
  const crashed = runCases(two, { agentsDir, exec: () => ({ code: 127, stdout: '', stderr: 'spawn claude ENOENT\n' }) });
  assert.match(crashed[0].reasons[0], /claude exited 127/);
  const missing = runCases(two, { agentsDir: join(tmpdir(), 'no-agents-here'), exec });
  assert.match(missing[0].reasons[0], /no agent file second-opinion\.md/);
});

test('recade harness cases lists the cases and runs nothing without --run', async () => {
  const r = await cli(plugin, ['harness', 'cases'], { run: () => { throw new Error('nothing must run'); } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^spec-writer\/lacking-sheet {2}expects GAPS$/m);
  assert.match(r.stdout, /^reviewer\/weakened-test {2}expects FIX$/m);
  assert.match(r.stdout, /41 cases\. Run them with: recade harness cases --run/);
  const one = await cli(plugin, ['harness', 'cases', '--agent', 'reviewer']);
  assert.match(one.stdout, /2 cases/);
  assert.equal((await cli(plugin, ['harness', 'cases', '--agent', 'nobody'])).code, 2);
});

test('recade harness cases --run uses the injected runner, reads the project agents, and refuses in CI', async () => {
  const root = makeProject();
  install(root, { pluginRoot: plugin });
  const seen = [];
  const run = (cmd) => {
    seen.push(cmd);
    return { code: 0, stdout: 'The DoD rows are weak.\nGAPS\n', stderr: '' };
  };
  const r = await cli(root, ['harness', 'cases', '--run', '--agent', 'spec-writer'], { run });
  assert.equal(r.code, 1, 'the second case expects READY and the runner said GAPS');
  assert.match(r.stdout, /^pass spec-writer\/lacking-sheet$/m);
  assert.match(r.stdout, /^FAIL spec-writer\/complete-sheet: expected READY, got GAPS$/m);
  assert.match(r.stdout, new RegExp(`agents read from ${join(root, '.claude', 'agents').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  assert.equal(seen.length, 2);
  assert.ok(seen[0][seen[0].indexOf('--append-system-prompt') + 1].includes('recade-harness v'), 'the installed, specialisable agent file is what is tested');
  const ci = await cli(root, ['harness', 'cases', '--run'], { run, env: { CI: 'true' } });
  assert.equal(ci.code, 2);
  assert.match(ci.stderr, /not run in CI/);
  assert.equal(seen.length, 2, 'no call in CI');
});

test('a verdict written "not X" is read, listed as such, and refused for any other word', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recade-cases-not-'));
  mkdirSync(join(dir, 'second-opinion'));
  writeFileSync(join(dir, 'second-opinion', 'a.md'), '---\nagent: second-opinion\ncase: a\nverdict: not BLOCKING\n---\n\n## Input\n\nx\n');
  const [c] = loadCases(dir);
  assert.equal(c.verdict, 'not BLOCKING');
  writeFileSync(join(dir, 'second-opinion', 'a.md'), '---\nagent: second-opinion\ncase: a\nverdict: not MAYBE\n---\n\n## Input\n\nx\n');
  assert.throws(() => loadCases(dir), /verdict must be one of/);
  const r = await cli(plugin, ['harness', 'cases', '--agent', 'second-opinion']);
  assert.match(r.stdout, /^second-opinion\/style-only {2}expects not BLOCKING$/m);
});
