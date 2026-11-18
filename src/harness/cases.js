import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frontMatter } from './verify.js';

/**
 * Agent test cases (spec section 12): `harness/cases/<agent>/<case>.md`. Each one holds an input for the agent and the
 * verdict it must give. `loadCases` and `evaluateCase` are pure. `runCases` calls `claude -p` and is reached only from
 * `recade harness cases --run`, never from CI or from the tests (they inject the runner).
 *
 * Case file:
 *   front matter: agent, case, verdict (a verdict of protocol.md, `not` and one of them, or `none`), must_contain and must_not_contain (lists)
 *   `## Input`    the prompt sent to the agent, with its fictional material inline
 *   `## Expected` what a good answer looks like, in words
 */

export const VERDICTS = Object.freeze(['READY', 'GAPS', 'CONFORMS', 'CONFORMS_WITH_RESERVATIONS', 'FIX', 'REOPEN', 'ON_DIRECTION', 'CONCURS', 'CONCERNS', 'BLOCKING']);

/** @typedef {{agent: string, name: string, verdict: string, mustContain: string[], mustNotContain: string[], input: string, expected: string, file: string}} Case */

const section = (text, title) => {
  const m = new RegExp(`^## ${title}\\s*$`, 'm').exec(text);
  if (m === null) return '';
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^## /m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
};
const strings = (v) => (Array.isArray(v) ? v.map(String) : []);

/**
 * Every case under a folder, sorted by agent then case name.
 * @param {string} dir
 * @returns {Case[]}
 * @throws {Error} naming the first case file that is malformed
 */
export function loadCases(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const agent of readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
    for (const f of readdirSync(join(dir, agent)).filter((x) => x.endsWith('.md')).sort()) {
      const file = join(dir, agent, f);
      const text = readFileSync(file, 'utf8');
      const fm = frontMatter(text);
      const where = `${agent}/${f}`;
      if (fm === null) throw new Error(`${where}: the front matter does not parse.`);
      if (fm.agent !== agent) throw new Error(`${where}: agent is ${JSON.stringify(fm.agent)}, it must be ${agent}.`);
      if (typeof fm.case !== 'string' || fm.case === '') throw new Error(`${where}: no case name.`);
      if (fm.verdict !== 'none' && !VERDICTS.includes(String(fm.verdict).replace(/^not /, ''))) throw new Error(`${where}: verdict must be one of ${VERDICTS.join(', ')}, \`not\` and one of them, or none.`);
      const input = section(text, 'Input');
      if (input === '') throw new Error(`${where}: no ## Input section.`);
      out.push({ agent, name: fm.case, verdict: fm.verdict, mustContain: strings(fm.must_contain), mustNotContain: strings(fm.must_not_contain), input, expected: section(text, 'Expected'), file });
    }
  }
  return out;
}

/** The verdict an answer gives: the last line that is one verdict and nothing else. Null when there is none. */
export function verdictOf(output) {
  const lines = String(output).split(/\r?\n/).map((l) => l.trim().replace(/^`+|`+$/g, '').trim());
  return [...lines].reverse().find((l) => VERDICTS.includes(l)) ?? null;
}

/**
 * Does an answer meet a case?
 * @param {Case} c
 * @param {string} output
 * @returns {{ok: boolean, reasons: string[]}}
 */
export function evaluateCase(c, output) {
  const reasons = [];
  const got = verdictOf(output);
  if (c.verdict === 'none') {
    if (got !== null) reasons.push(`expected no verdict, got ${got}`);
  } else if (/^not /.test(c.verdict)) {
    // `not BLOCKING`: any verdict but that one, and a verdict there must be.
    if (got === null || got === c.verdict.slice(4)) reasons.push(`expected a verdict other than ${c.verdict.slice(4)}, got ${got ?? 'no verdict'}`);
  } else if (got !== c.verdict) reasons.push(`expected ${c.verdict}, got ${got ?? 'no verdict'}`);
  // Case and white space do not count: a line break or a double space inside a phrase must not hide it.
  const flat = (t) => String(t).toLowerCase().replace(/\s+/g, ' ');
  const lower = flat(output);
  for (const s of c.mustContain) if (!lower.includes(flat(s))) reasons.push(`the answer does not contain ${JSON.stringify(s)}`);
  for (const s of c.mustNotContain) if (lower.includes(flat(s))) reasons.push(`the answer contains ${JSON.stringify(s)}`);
  return { ok: reasons.length === 0, reasons };
}

/** The two sets of cases: the plugin's own agents (`cases/` and `agents/`) and the harness agents (`harness/cases/` and `harness/agents/`). */
export const CASE_SETS = Object.freeze(['plugin', 'harness']);

/**
 * Where a set lives in the plugin. Both sets can name the same agent (ux-designer, ui-designer), so a case is always
 * handled with its set.
 * @param {string} pluginRoot
 * @param {'plugin'|'harness'} set
 */
export const setPaths = (pluginRoot, set) => (set === 'plugin'
  ? { casesDir: join(pluginRoot, 'cases'), agentsDir: join(pluginRoot, 'agents') }
  : { casesDir: join(pluginRoot, 'harness', 'cases'), agentsDir: join(pluginRoot, 'harness', 'agents') });

/**
 * The cases of the chosen sets, each tagged with its set, in the order plugin then harness.
 * @param {string} pluginRoot
 * @param {{sets?: string[], agent?: string}} [options]
 * @returns {{set: string, cases: Case[]}[]}
 * @throws {Error} naming the first case file that is malformed
 */
export function loadCaseSets(pluginRoot, { sets = CASE_SETS, agent } = {}) {
  return CASE_SETS.filter((s) => sets.includes(s)).map((set) => {
    const all = loadCases(setPaths(pluginRoot, set).casesDir);
    return { set, cases: agent === undefined ? all : all.filter((c) => c.agent === agent) };
  });
}

/**
 * The `claude -p` command line of a case: the agent file as extra system prompt, its model, no tool but Read.
 * Limits of this replay: the front matter of the agent file (`tools`, `effort`, `sensitive_*`) is not enforced by
 * `-p`, only its text and the model are used, so a case tests the prompt, not the tool list or the effort. The run is
 * not isolated from the user's own Claude settings and MCP servers either: no isolation flag is passed, because none
 * has been checked against a real claude here. The run happens in an empty temp folder with `Read` only.
 */
export function claudeCommand(c, agentText) {
  const model = frontMatter(agentText)?.model;
  const cmd = ['claude', '-p', c.input, '--append-system-prompt', agentText, '--output-format', 'text', '--max-turns', '4', '--allowedTools', 'Read'];
  if (typeof model === 'string' && model !== '') cmd.push('--model', model);
  return cmd;
}

/** Runs a command without a shell. A missing program gives code 127. Ten minutes at most. */
export function defaultRun(cmd, { cwd }) {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { code: 127, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error.message}\n` };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Run cases through the agent files of `agentsDir`. The command runs in an empty temporary folder, so an agent reads
 * nothing but its input.
 * @param {Case[]} cases
 * @param {{agentsDir: string, exec?: typeof defaultRun}} options
 * @returns {{case: Case, ok: boolean, reasons: string[]}[]}
 */
export function runCases(cases, { agentsDir, exec = defaultRun }) {
  const cwd = mkdtempSync(join(tmpdir(), 'recade-cases-'));
  try {
    return cases.map((c) => {
      const file = join(agentsDir, `${c.agent}.md`);
      if (!existsSync(file)) return { case: c, ok: false, reasons: [`no agent file ${c.agent}.md in ${agentsDir}`] };
      const r = exec(claudeCommand(c, readFileSync(file, 'utf8')), { cwd });
      if (r.code !== 0) return { case: c, ok: false, reasons: [`claude exited ${r.code}: ${r.stderr.trim().split('\n')[0] ?? ''}`] };
      return { case: c, ...evaluateCase(c, r.stdout) };
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
