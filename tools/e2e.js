#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { run } from '../src/cli.js';
import { defaultExec } from '../src/doctor.js';
import { loadState } from '../src/state.js';
import { checkSlices, sliceRepoOrder } from '../src/project/slices.js';
import { registryNames } from '../src/project/touches.js';
import { createFakeGh } from './fake-gh.js';
import { buildAdoptRepo } from '../example/adopt/build.js';

/**
 * The end-to-end driver (plan 5, task 6). It plays the CLI path of every phase of a Recade project, with the agent
 * outputs recorded in `example/recorded/<mode>/<phase>/` dropped where the agents would write them and the owner's
 * recorded answers (`answers.yaml`) given at each gate. No model runs and nothing leaves the machine: `gh` is a fake
 * that records its calls, and a `git` command that would reach a remote is answered by the fake as well.
 *
 * Since plan 5b the project is a workspace: a private git repository `<slug>-workspace` with its code repositories under
 * `repos/<name>/`. The run happens under a parent folder whose name has a space and an accent, so every path of Recade is
 * tested as one argument. A new product (scratch, from) creates the code repositories `api` and `web`; the adopted one
 * (adopt) clones the existing repository. The last phase carries a slice from todo to done across the repositories, with
 * a fake pull request in each. Nothing is written outside `<parent>/<slug>-workspace` (and the config folder), and the
 * adopted original is left as it was.
 *
 * A run fails with the phase, the file and the line that broke it: either a command of Recade refused a recorded file
 * (a lint finding, a doctrine without its sections, an ID nothing defines), or a file Recade generated no longer
 * reads as it did when it was recorded (`example/expected/<mode>/<phase>/`). Run with `--update` to record again.
 */

export const EXAMPLE = fileURLToPath(new URL('../example/', import.meta.url));
/** The command files of the plugin, whose Step 1 the run walks before each phase (the checks a session makes first). */
export const COMMANDS = fileURLToPath(new URL('../commands/', import.meta.url));

/**
 * The sources that Step 1 of a command file requires, for the mode of the project. The command file lists them under
 * the point that starts "Check that the sources of the phase exist", one line for each mode:
 * "- mode `adopt` with `full` true: ...", "- mode `adopt`: ..." and "- any other mode: ...", each path in backticks,
 * relative to the workspace. Returns null when the file has no such point.
 * @param {string} text the command file
 * @param {{mode: string, full?: boolean}} project
 * @returns {{line: number, files: string[]}|null}
 */
export function phaseSources(text, { mode, full = false }) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.includes('Check that the sources of the phase exist'));
  if (start < 0) return null;
  const rows = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s+- (mode `adopt` with `full` true|mode `adopt`|any other mode): (.*)$/.exec(lines[i]);
    if (m === null) {
      if (rows.size > 0) break;
      continue;
    }
    rows.set(m[1], { line: i + 1, files: [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]) });
  }
  if (mode === 'adopt') return (full ? rows.get('mode `adopt` with `full` true') : undefined) ?? rows.get('mode `adopt`') ?? null;
  return rows.get('any other mode') ?? null;
}
export const MODES = ['scratch', 'from', 'adopt'];

/** Every date of a run is this day, so generated files compare byte for byte. */
const NOW = new Date(2026, 10, 18, 12, 0, 0);
const PROJECT = { scratch: 'Fernhill Lending', from: 'Fernhill Lending', adopt: 'fernhill-desk' };
const OWNER = 'fernhill';
/** The parent folder of the workspace, and of the original of the adopt mode: a space and an accent in each (Review Focus 3). */
export const PARENT_FOLDER = 'Projets Clients \u00c9t\u00e9';
export const ORIGINALS_FOLDER = 'D\u00e9p\u00f4ts existants';
/** The slice that goes from todo to done in the last phase, in every mode. */
const DELIVERED = 'S-01';

const PHASES = {
  scratch: ['intake', 'team', 'docs', 'bible', 'slices', 'harness', 'delivery'],
  from: ['intake', 'team', 'docs', 'bible', 'slices', 'harness', 'delivery'],
  adopt: ['inventory', 'team', 'docs', 'bible', 'slices', 'harness', 'delivery'],
};

/** What each phase must have received from the recorded agents. A missing file fails the run, named. */
const REQUIRED = {
  scratch: {
    intake: ['intake/brief.md', 'intake/gaps.md'],
    team: ['team/roster.md', ...['project-lead', 'architect', 'security-lead', 'ux-designer', 'qa-lead', 'ui-designer', 'devops-lead', 'chief-reviewer'].map((r) => `team/${r}.md`)],
    docs: ['docs/D1.md', 'docs/D2.md', 'docs/D3.md', 'docs/STACK.md', 'docs/PLAN.md', 'design/tokens.json', 'design/theme.json', 'design/directions/README.md'],
    bible: ['BIBLE.md'],
    slices: [],
    harness: [],
    delivery: [],
  },
  adopt: {
    inventory: ['docs/inventory.md', 'docs/STACK.md'],
    team: [],
    docs: ['docs/inventory.md', 'docs/RULES.md', 'docs/INVARIANTS.md', 'docs/CONTRACTS.md'],
    bible: ['BIBLE.md', 'docs/PLAN.md'],
    slices: [],
    harness: [],
    delivery: [],
  },
};
REQUIRED.from = REQUIRED.scratch;
REQUIRED.adopt.team = REQUIRED.scratch.team;

/** The files Recade generates in each phase, compared with `example/expected/`. */
const COMPARED = {
  intake: ['intake/provisionals.md', 'intake/questionnaire.md', 'recade/state.yaml'],
  inventory: ['.recade/created.json', 'recade/state.yaml'],
  team: ['recade/state.yaml'],
  docs: ['decisions/DEC-01.md', 'decisions/DEC-02.md', 'recade/state.yaml'],
  bible: ['INDEX.md', 'recade/state.yaml'],
  slices: ['slices/STATUS.md', 'slices/graph.md', 'recade/state.yaml'],
  harness: [],
  delivery: ['slices/STATUS.md', 'recade/state.yaml'],
};
const COMPARED_ADOPT = {
  ...COMPARED,
  docs: ['docs/source/INDEX.md', '.recade/created.json', 'recade/state.yaml'],
  harness: [],
};

/** A failure of the run: what broke, where. */
class E2EError extends Error {
  constructor(phase, file, line, message) {
    super(message);
    this.phase = phase;
    this.file = file;
    this.line = line;
  }
}

const norm = (rel) => rel.split('\\').join('/');

/** The project-relative files under `dir`, without the entries of the recording that are not project files. */
function recordedFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (rel === '' && (e.name.startsWith('_') || e.name === 'agent.json')) continue;
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk('');
  return out.sort();
}

/** The first line where two texts differ: its 1-based number and the two lines. */
function firstDifference(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { line: i + 1, expected: a[i] ?? '(end of file)', actual: b[i] ?? '(end of file)' };
  }
  return null;
}

/** The first line of CLI output that reads `<file>:<line>:<column> ...` with an error (or no severity). */
function firstFinding(text) {
  for (const l of text.split('\n')) {
    const m = /^(\S+?):(\d+):(\d+) (?:(error|warn) )?(\S+) (.*)$/.exec(l);
    if (m !== null && m[4] !== 'warn') return { file: m[1], line: Number(m[2]), message: `${m[5]} ${m[6]}` };
  }
  return null;
}

/** One hash for a whole folder: every path, and the content of every file, the git folder included. */
export function treeHash(root) {
  const hash = createHash('sha256');
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = rel === '' ? e.name : `${rel}/${e.name}`;
      const full = join(root, path);
      hash.update(`${path}\0`);
      if (e.isDirectory()) walk(path);
      else if (lstatSync(full).isSymbolicLink()) hash.update(`link:${readlinkSync(full)}`);
      else hash.update(readFileSync(full));
    }
  };
  walk('');
  return hash.digest('hex');
}

/**
 * Play one example project from its first command to the installed and verified harness.
 * @param {{mode: 'scratch'|'from'|'adopt', tmp: string, exec?: Function, example?: string, commands?: string, update?: boolean, stopAfter?: string}} options
 *   `tmp` is an existing empty folder. `exec` runs the local `git` commands (default: for real); `gh` never reaches it.
 *   `example` is the folder with `recorded/`, `expected/` and the answers (default: the plugin's own `example/`).
 *   `update` records the generated files instead of comparing them. `stopAfter` ends the run after a phase.
 * @returns {Promise<{ok: boolean, mode: string, dir: string, ms: number, steps: {phase: string, gate: string, gates: string[], files: string[], ms: number, verify?: string}[],
 *   gh: {calls: string[][], writes: string[][], refused: string[]}, failure?: {phase: string, file: string, line: number|null, message: string}}>}
 */
export async function runE2E({ mode, tmp, exec = defaultExec, example = EXAMPLE, commands = COMMANDS, update = false, stopAfter } = {}) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}. Use ${MODES.join(', ')}.`);
  if (typeof tmp !== 'string' || tmp === '') throw new Error('runE2E needs a temp folder (tmp).');
  const started = Date.now();
  const adopt = mode === 'adopt';
  const answers = parse(readFileSync(join(example, adopt ? 'adopt' : 'scratch', 'answers.yaml'), 'utf8'));
  const config = join(tmp, 'config');
  const projects = join(tmp, PARENT_FOLDER);
  const originals = join(tmp, ORIGINALS_FOLDER);
  mkdirSync(projects, { recursive: true });
  const dir = join(projects, adopt ? 'fernhill-desk-workspace' : 'fernhill-lending-workspace');
  /** The adopt mode keeps the original where the owner has it: outside the parent folder of the workspace. */
  const original = join(originals, 'fernhill-desk');
  const env = { ...process.env, RECADE_CONFIG_DIR: config };
  /** The code repositories of the run: asked from the owner's answers, or the one adopted. */
  const repoNames = adopt ? ['fernhill-desk'] : (answers.repos ?? []).map((r) => r.name);
  const gh = createFakeGh({
    base: exec,
    remotes: adopt ? { [`https://github.com/${OWNER}/fernhill-desk.git`]: original } : {},
    existing: adopt ? {
      repo: `${OWNER}/fernhill-desk`,
      projects: [{ number: 4, id: 'PVT_4', title: 'Fernhill roadmap', closed: false }],
      fields: [{ id: 'F_status', name: 'Status', type: 'ProjectV2SingleSelectField', options: ['Todo', 'In Progress', 'Done'].map((n, i) => ({ id: `O_${i}`, name: n })) }],
      issues: [
        { number: 11, title: 'Cap the late fee', url: `https://github.com/${OWNER}/fernhill-desk/issues/11`, labels: [{ name: 'feature' }] },
        { number: 12, title: 'Ledger forgets loans after a restart', url: `https://github.com/${OWNER}/fernhill-desk/issues/12`, labels: [{ name: 'S-02' }] },
        { number: 13, title: 'Fix a typo in the README footer', url: `https://github.com/${OWNER}/fernhill-desk/issues/13`, labels: [] },
      ],
    } : null,
  });
  /** The tree of the original before and after the run: every file and every reference of the git folder, hashed. */
  const originalTree = { before: null, after: null };

  const steps = [];
  let phase = null;
  const touched = new Set();
  const result = (extra) => ({
    ok: extra === undefined, mode, dir, tmp, parent: projects, repos: repoNames, ms: Date.now() - started, steps,
    original: adopt ? { dir: original, ...originalTree, after: existsSync(original) ? treeHash(original) : null } : null,
    gh: { calls: gh.calls, writes: gh.writes(), refused: gh.gitRefused, network: gh.network, prs: gh.prs, issues: gh.issues },
    ...(extra === undefined ? {} : { failure: extra }),
  });

  /** Run one command of the CLI. `expect` is the exit code that is not a failure. Returns its output. */
  async function cli(args, { cwd = dir, expect = 0, stdin } = {}) {
    const out = [];
    const err = [];
    const code = await run(args, {
      cwd, env, exec: gh.exec, run: gh.run, now: () => NOW,
      stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
      ...(stdin === undefined ? {} : { readStdin: async () => stdin }),
    });
    const r = { code, stdout: out.join(''), stderr: err.join('') };
    if (code !== expect) {
      const text = `${r.stdout}\n${r.stderr}`;
      const found = firstFinding(text);
      const first = text.split('\n').find((l) => l.trim() !== '') ?? `exit ${code}`;
      throw new E2EError(phase, found?.file ?? `recade ${args.slice(0, 2).join(' ')}`, found?.line ?? null, found?.message ?? `exit ${code}, expected ${expect}: ${first}`);
    }
    return r;
  }

  /** A local git command in `where` (the workspace by default; a code repository or a worktree otherwise). */
  const gitIn = async (where, ...args) => {
    const r = await exec('git', ['-C', where, '-c', 'user.name=Fernhill CI', '-c', 'user.email=ci', '-c', 'commit.gpgsign=false', ...args]);
    if (r.code !== 0) throw new E2EError(phase, `git ${args[0]}`, null, `git ${args.join(' ')} failed in ${relative(projects, where)}: ${String(r.stderr).split('\n')[0]}`);
    return r.stdout;
  };
  const git = (...args) => gitIn(dir, ...args);
  const commitIn = async (where, message, ...paths) => {
    await gitIn(where, 'add', ...(paths.length === 0 ? ['-A'] : ['--', ...paths]));
    // `recade state pass` in a workspace already commits state.yaml: a step with nothing left to stage is not a failure.
    const staged = await exec('git', ['-C', where, 'diff', '--cached', '--quiet']);
    if (staged.code === 0) return;
    await gitIn(where, 'commit', '-q', '-m', message);
  };
  const commit = (message, ...paths) => commitIn(dir, message, ...paths);

  /** The recorded folder of a phase: the mode's own, else the scratch one (the product is the same in every mode). */
  const recordedDir = () => {
    const own = join(example, 'recorded', mode, phase);
    return existsSync(own) ? own : join(example, 'recorded', 'scratch', phase);
  };

  /** Drop the recorded agent outputs of the phase where the agents write them, then check the required ones are there. */
  async function drop({ viaAdopt = false } = {}) {
    const through = (rel) => (typeof viaAdopt === 'function' ? viaAdopt(rel) : viaAdopt);
    const from = recordedDir();
    for (const rel of recordedFiles(from)) {
      const text = readFileSync(join(from, rel), 'utf8');
      if (through(rel)) await cli(['adopt', 'write', rel], { stdin: text });
      else {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
      }
      touched.add(rel);
    }
    for (const rel of REQUIRED[mode][phase] ?? []) {
      if (!existsSync(join(dir, rel))) throw new E2EError(phase, rel, null, `The recorded output is missing: ${norm(relative(example, join(from, rel)))} is not there.`);
    }
  }

  /** The commands the recorded agents ran, in `agent.json` of the phase. */
  async function agentCommands() {
    const file = join(recordedDir(), 'agent.json');
    if (!existsSync(file)) return;
    for (const args of JSON.parse(readFileSync(file, 'utf8')).cli) await cli(args);
  }

  /** The owner's answer for a gate is yes: only then does the run pass it, with the command a person would run. */
  async function gate(name) {
    if (answers.gates?.[name] !== 'yes' && answers.gates?.[name] !== true) {
      throw new E2EError(phase, `${adopt ? 'adopt' : 'scratch'}/answers.yaml`, null, `The recorded owner answer for ${name} is not yes: the run stops at the gate.`);
    }
    await cli(['state', 'pass', name]);
    return name;
  }

  /** Compare what Recade generated with what was recorded, or record it with `update`. */
  function compare() {
    const table = adopt ? COMPARED_ADOPT : COMPARED;
    for (const rel of table[phase] ?? []) {
      const actual = readFileSync(join(dir, rel), 'utf8');
      const expectedFile = join(example, 'expected', mode, phase, rel);
      touched.add(rel);
      if (update) {
        mkdirSync(dirname(expectedFile), { recursive: true });
        writeFileSync(expectedFile, actual);
        continue;
      }
      if (!existsSync(expectedFile)) {
        throw new E2EError(phase, rel, null, `There is no expected file ${norm(relative(example, expectedFile))}. Record it with: npm run e2e -- --update`);
      }
      const diff = firstDifference(readFileSync(expectedFile, 'utf8'), actual);
      if (diff !== null) throw new E2EError(phase, rel, diff.line, `Line ${diff.line} changed. Expected: ${diff.expected} Got: ${diff.actual}`);
    }
  }

  const lint = (...paths) => cli(['lint-style', ...paths]);
  const render = async (...files) => {
    await cli(['render', ...files]);
    for (const f of files) {
      const base = f.replace(/^docs\//, '').replace(/\.md$/, '');
      for (const ext of base.startsWith('PLAN') ? ['docx', 'pdf', 'xlsx'] : ['docx', 'pdf']) {
        const out = `docs/deliverables/${base}.${ext}`;
        if (!existsSync(join(dir, out))) throw new E2EError(phase, f, null, `The render wrote no ${out}.`);
        touched.add(out);
      }
    }
  };

  /**
   * Walk Step 1 of the command file of the phase, as a session would before it does any work: the command named by the
   * state (`command` of `recade state show --json`, the one `/recade:resume` re-enters), the gate check of
   * `recade state can-start`, then every source that the file requires for the mode of the project, and the extra
   * check of the step (`team check` before the BIBLE, `repo list` before the slices). A source the file requires and
   * the phases before did not write fails the run at that line of the command file: the owner would be stopped there.
   */
  async function walkStep1(command, phaseNumber) {
    const shown = JSON.parse((await cli(['state', 'show', '--json'])).stdout);
    if (shown.command !== command) throw new E2EError(phase, 'recade/state.yaml', null, `The state sends the owner to /recade:${shown.command}, not /recade:${command}.`);
    await cli(['state', 'can-start', String(phaseNumber)]);
    const file = `commands/${command}.md`;
    const sources = phaseSources(readFileSync(join(commands, `${command}.md`), 'utf8'), { mode: shown.mode, full: shown.full === true });
    if (sources === null) throw new E2EError(phase, file, null, `Step 1 lists no source for the mode ${shown.mode}.`);
    for (const rel of sources.files) {
      if (!existsSync(join(dir, rel))) throw new E2EError(phase, file, sources.line, `Step 1 stops here: ${rel} is missing in mode ${shown.mode}.`);
    }
    if (command === 'bible') await cli(['team', 'check']);
    if (command === 'slices') await cli(['repo', 'list', '--json']);
  }

  /** Fill the questionnaire with the owner's answers, in the order of the template. */
  function answerQuestionnaire() {
    const file = join(dir, 'intake', 'questionnaire.md');
    const lines = readFileSync(file, 'utf8').split('\n');
    const given = answers.questionnaire ?? [];
    let n = 0;
    const filled = lines.map((l) => {
      const m = /^\| (.+?) \| \| \|$/.exec(l);
      if (m === null) return l;
      const a = given[n++];
      return a === null || a === undefined ? l : `| ${m[1]} | ${String(a).replaceAll('|', '\\|')} | given |`;
    });
    if (n !== given.length) {
      throw new E2EError(phase, 'intake/questionnaire.md', null, `The questionnaire has ${n} questions and example/scratch/answers.yaml answers ${given.length}.`);
    }
    writeFileSync(file, filled.join('\n'));
  }

  const exists = (base, paths) => paths.filter((p) => existsSync(join(base, p)));
  const repoDir = (name) => join(dir, 'repos', name);
  const repoFlags = () => repoNames.flatMap((n) => ['--repo', n]);

  /** The phases. Each returns the gates it passed. */
  const play = {
    async intake() {
      await cli(['config', 'set', 'github_owner', OWNER], { cwd: tmp });
      const from = mode === 'from' ? ['--from', join(example, 'from')] : [];
      await cli(['new', PROJECT[mode], '--parent', projects, ...from, '--json'], { cwd: tmp });
      answerQuestionnaire();
      await cli(['intake', 'scan', '--json']);
      await drop();
      await agentCommands();
      const open = await cli(['provisional', 'list', '--open']);
      if (open.stdout.trim().split('\n').length !== 3) throw new E2EError(phase, 'intake/provisionals.md', null, 'The recorded analyst opened a number of provisional values other than 3.');
      await lint('intake/brief.md', 'intake/gaps.md');
      const gates = [await gate('G0')];
      compare();
      await commit('docs(intake): intake brief, gaps and provisional values');
      return gates;
    },
    async inventory() {
      // The owner has the repository in a folder of their own, with its history pushed: Recade only ever reads it.
      mkdirSync(original, { recursive: true });
      buildAdoptRepo(original);
      originalTree.before = treeHash(original);
      await cli(['config', 'set', 'github_owner', OWNER], { cwd: tmp });
      await cli(['adopt', 'preflight'], { cwd: original });
      const init = await cli(['adopt', 'init', '--parent', projects, '--repo', original, '--repo-name', 'fernhill-desk', '--name', 'fernhill-desk', '--json'], { cwd: tmp });
      if (JSON.parse(init.stdout).dir === undefined || !existsSync(join(dir, 'repos', 'fernhill-desk', '.git'))) throw new E2EError(phase, 'recade adopt init', null, 'adopt init did not clone the repository into the workspace.');
      const scan = JSON.parse((await cli(['inventory', 'scan', '--json'])).stdout);
      if (scan.repos.length !== 1 || scan.missing.length !== 0) throw new E2EError(phase, 'recade inventory scan', null, `The scan did not read the one adopted repository: ${JSON.stringify(scan.missing)}`);
      await drop({ viaAdopt: true });
      await lint('docs/inventory.md', 'docs/STACK.md');
      const gates = [await gate('G0-inventory')];
      compare();
      await commit('docs: inventory and stack in place', 'recade', 'docs');
      return gates;
    },
    async team() {
      await walkStep1('team', 1);
      await drop();
      await cli(['team', 'check']);
      await lint('team');
      await cli(['index', 'check']);
      const gates = [await gate('G1')];
      compare();
      await commit('docs(team): team roster and doctrines', 'team', 'recade');
      return gates;
    },
    async docs() {
      await cli(['state', 'can-start', '2']);
      if (adopt) return play.docsFromCode();
      await drop();
      await agentCommands();
      for (const step of ['direction', 'stack', 'd2', 'd3', 'plan', 'gate']) await cli(['state', 'set', 'docs_step', step]);
      const listed = JSON.parse((await cli(['decision', 'list', '--open', '--json'])).stdout);
      for (const d of listed) {
        const choice = answers.decisions?.[d.id];
        if (choice === undefined) throw new E2EError(phase, `decisions/${d.id}.md`, null, `There is no recorded owner answer for ${d.id}.`);
        await cli(['decision', 'close', d.id, '--choice', choice]);
      }
      const gates = [await gate('G2-stack')];
      await lint('docs', 'design/directions/README.md');
      await cli(['index', 'check']);
      await render('docs/D1.md', 'docs/D2.md', 'docs/D3.md', 'docs/PLAN.md');
      gates.push(await gate('G2'));
      await cli(['state', 'set', 'docs_step', 'done']);
      // After G2, one code repository for each deployable of section 2.5 of D2, on the owner's yes.
      for (const r of answers.repos ?? []) {
        await cli(['repo', 'add', r.name, '--new', '--role', r.role, '--visibility', r.visibility ?? 'private']);
        if (!existsSync(join(repoDir(r.name), '.git'))) throw new E2EError(phase, `repos/${r.name}`, null, `recade repo add did not create the repository ${r.name}.`);
      }
      compare();
      await commit('docs: documents approved at G2', 'docs', 'design', 'decisions', 'recade');
      return gates;
    },
    async docsFromCode() {
      const before = await cli(['adopt', 'from-code', '--json']);
      const read = JSON.parse(before.stdout);
      if (read.sources.length === 0) throw new E2EError(phase, 'docs/source/INDEX.md', null, 'from-code copied no existing document.');
      await drop({ viaAdopt: true });
      await cli(['adopt', 'from-code']);
      const gates = [await gate('G2-stack'), await gate('G2')];
      compare();
      await commit('docs: documents written from the code', 'docs', 'recade');
      return gates;
    },
    async bible() {
      await walkStep1('bible', 3);
      // In adopt the BIBLE is written in the workspace like every document of Recade; the PLAN of the remaining work goes through `adopt write`.
      await drop({ viaAdopt: adopt ? (rel) => rel === 'docs/PLAN.md' : false });
      await agentCommands();
      await lint('BIBLE.md', 'docs/PLAN.md', 'docs/reviews');
      await cli(['index', 'build']);
      await cli(['index', 'check']);
      await render('docs/PLAN.md');
      const gates = [await gate('G3')];
      compare();
      await commit('docs(bible): rules and delivery plan approved at G3', 'BIBLE.md', 'INDEX.md', 'docs', 'recade');
      return gates;
    },
    async slices() {
      await walkStep1('slices', 4);
      await cli(['state', 'set', 'slicing', answers.slicing]);
      await drop();
      await cli(['slices', 'check']);
      await lint('slices');
      await cli(['index', 'check']);
      await cli(['slices', 'graph']);
      await cli(['slices', 'status']);
      await commit('docs(slices): slice sheets', 'slices', 'recade');
      if (adopt) await board();
      const writesBefore = gh.writes().length;
      const dry = await cli(['github', 'init', '--dry-run', ...(adopt ? [] : repoFlags())]);
      if (gh.writes().length !== writesBefore) throw new E2EError(phase, 'recade github init', null, 'The dry run made a write call.');
      if (!/These calls would run|Nothing to create/.test(dry.stdout)) throw new E2EError(phase, 'recade github init', null, 'The dry run did not list the calls it would make.');
      if (answers.github?.create !== 'yes' && answers.github?.create_missing_issues !== 'yes') throw new E2EError(phase, 'example/scratch/answers.yaml', null, 'The recorded owner answer to create the board is not yes.');
      // One yes for the private workspace repository and its board, one for the auto-push of the workspace, one for each new code repository.
      const autoPush = answers.github?.auto_push === 'yes' ? ['--auto-push'] : [];
      await cli(['github', 'init', ...autoPush, ...(adopt ? [] : repoFlags())]);
      const gates = [await gate('G4')];
      compare();
      return gates;
    },
    async harness() {
      await cli(['state', 'can-start', '5']);
      // Two targets: the project commands in the workspace, then the slice commands, the guard and the gates in each code repository.
      const missing = [];
      const first = await cli(['harness', 'install', '--target', 'workspace']);
      for (const r of repoNames) missing.push((await cli(['harness', 'install', '--target', 'code', '--repo', r])).stdout);
      await answerMissingRows(missing.join('\n'));
      const session = join(recordedDir(), '_session');
      const protocol = join(dir, '.claude', 'protocol.md');
      writeFileSync(protocol, `${readFileSync(protocol, 'utf8')}${readFileSync(join(session, 'protocol-additions.md'), 'utf8')}`);
      touched.add('.claude/protocol.md');
      await lint('.claude/protocol.md');
      await cli(['harness', 'models', '--check', '--dir', join(dir, '.claude', 'agents')]);
      await cli(['harness', 'models', '--check', '--dir', join(repoDir(repoNames[0]), '.claude', 'agents')]);
      await cli(['harness', 'set', '--wip-limit', '3']);
      await cli(['claude-md', 'refresh', '--write', '--target', 'workspace']);
      for (const r of repoNames) await cli(['claude-md', 'refresh', '--write', '--target', 'code', '--repo', r]);
      for (const target of [[], ...repoNames.map((r) => ['--repo', r])]) {
        const again = await cli(['harness', 'install', '--target', target.length === 0 ? 'workspace' : 'code', ...target]);
        if (!/0 created, 0 updated/.test(again.stdout)) throw new E2EError(phase, '.claude/protocol.md', null, `A second install changed files: ${again.stdout.split('\n')[1]}`);
      }
      if (!readFileSync(protocol, 'utf8').includes('## Project invariants')) throw new E2EError(phase, '.claude/protocol.md', null, 'A second install lost the specialisation below the line.');
      const verified = [(await cli(['harness', 'verify', '--target', 'workspace'])).stdout];
      for (const r of repoNames) verified.push((await cli(['harness', 'verify', '--target', 'code', '--repo', r])).stdout);
      const cost = await cli(['cost', 'record', DELIVERED, '--minutes', '30', '--fix-loops', '0', '--transcript', join(session, 'transcript.jsonl')]);
      if (!/tokens/.test(cost.stdout)) throw new E2EError(phase, 'recade cost record', null, 'The cost record counted no tokens from the recorded session.');
      // Each code repository commits its own harness. In adopt only the files Recade wrote are staged, by name (the rest is the owner's).
      for (const r of repoNames) {
        const where = repoDir(r);
        if (adopt) {
          const created = JSON.parse(readFileSync(join(where, '.recade', 'created.json'), 'utf8')).files.map((f) => f.path);
          // `.recade/` is the machine-local record and is in .gitignore.
          for (const p of exists(where, [...created.filter((c) => !c.startsWith('.recade/')), '.claude/settings.json', '.gitignore', 'CLAUDE.md'])) await gitIn(where, 'add', '--', p);
          await gitIn(where, 'commit', '-q', '-m', 'chore: install the Recade harness');
        } else await commitIn(where, 'chore: install the Recade harness');
      }
      await commit('chore: install the Recade harness', ...exists(dir, ['.claude', '.githooks', '.github', '.gitignore', 'CLAUDE.md', 'docs', 'recade']));
      const gates = [await gate('G5')];
      await commit('docs: harness approved at G5', 'recade');
      return { gates, verify: verified.join('\n'), first: first.stdout };
    },
    /** A slice across the repositories, from todo to done: a worktree and a branch in each, a pull request in each, merged in order. */
    async delivery() {
      const row = checkSlices(dir).status.find((s) => s.id === DELIVERED);
      const names = sliceRepoOrder(row, registryNames(loadState(dir)));
      if (row.status !== 'todo' || names.length === 0) throw new E2EError(phase, `slices/${row.file}`, null, `${DELIVERED} should be todo and touch a code repository, and is ${row.status} with ${names.length} repositories.`);
      const issue = gh.issues.find((i) => i.title.startsWith(`[${DELIVERED}]`) || Object.values(loadState(dir).github?.links ?? {}).includes(i.url));
      for (const name of names) {
        const where = repoDir(name);
        const base = loadState(dir).repos.find((e) => e.name === name).default_branch;
        const tree = join(where, '.claude', 'worktrees', DELIVERED);
        await gitIn(where, 'worktree', 'add', '-q', join('.claude', 'worktrees', DELIVERED), '-b', row.branch, base);
        mkdirSync(join(tree, 'src'), { recursive: true });
        writeFileSync(join(tree, 'src', `${DELIVERED.toLowerCase()}.js`), `export const slice = '${DELIVERED}';\n`);
        await commitIn(tree, `feat(${name}): ${DELIVERED} ${row.title}`);
        // The pull request body links the issue of the workspace by its URL and holds no text of the sheet.
        const pr = gh.run(['gh', 'pr', 'create', '--base', base, '--head', row.branch, '--title', `[${DELIVERED}] ${row.title}`, '--body', `Slice issue: ${issue?.url ?? 'not on a board yet'}`], { cwd: where });
        if (pr.code !== 0) throw new E2EError(phase, `gh pr create (${name})`, null, pr.stderr);
      }
      for (const status of ['spec', 'tests', 'implementation', 'audit', 'ready-to-merge']) await cli(['slices', 'status', '--set', DELIVERED, status]);
      // The owner ticks the Definition of Done at gate-2, through the CLI, one commit in the workspace.
      const dod = (readFileSync(join(dir, 'slices', row.file.split('/').pop()), 'utf8').match(/^\| \d+ \|.*\[ \] \|$/gm) ?? []).length;
      if (dod === 0) throw new E2EError(phase, `slices/${row.file.split('/').pop()}`, null, 'The sheet has no open row in its Definition of Done.');
      await cli(['slices', 'dod', DELIVERED, ...Array.from({ length: dod }, (_, i) => ['--tick', String(i + 1)]).flat()]);
      // Open and approved: the board shows the slice in review, nothing is closed yet.
      await cli(['board', 'reconcile', '--apply']);
      if (gh.calls.some(([a, b]) => a === 'issue' && b === 'close')) throw new E2EError(phase, 'recade board reconcile', null, 'The issue was closed before the pull requests were merged.');
      // Merged in the order of the sheet.
      for (const name of names) {
        const where = repoDir(name);
        const base = loadState(dir).repos.find((e) => e.name === name).default_branch;
        await gitIn(where, 'merge', '-q', '--ff-only', row.branch);
        gh.mergePr(name, row.branch);
        if (names.indexOf(name) < names.length - 1) {
          await cli(['board', 'reconcile', '--apply']);
          if (gh.calls.some(([a, b]) => a === 'issue' && b === 'close')) throw new E2EError(phase, 'recade board reconcile', null, `The issue was closed with ${base} merged in only some repositories.`);
        }
      }
      const done = await cli(['board', 'reconcile', '--apply']);
      if (!/done/.test(done.stdout)) throw new E2EError(phase, 'recade board reconcile', null, `${DELIVERED} did not move to done: ${done.stdout.split('\n').slice(0, 4).join(' | ')}`);
      const cleanup = await cli(['board', 'cleanup', '--apply']);
      touched.add('slices/STATUS.md');
      compare();
      return { gates: [], cleanup: cleanup.stdout };
    },
  };

  /**
   * The install lists the rows of the harness technical sheet that have no value. The owner answers each one (a command or
   * Not applicable, never an invention), the answer goes into the stack in place through `adopt write`, and the install runs again.
   */
  async function answerMissingRows(installOutput) {
    const rows = [...new Set([...installOutput.matchAll(/has no value for (.+?)\. \S+ fails on those steps/g)].flatMap((m) => m[1].split(', ')))];
    if (rows.length === 0) return;
    const given = answers.stack_rows ?? {};
    const lacking = rows.filter((r) => given[r] === undefined);
    if (!adopt || lacking.length > 0) {
      throw new E2EError(phase, 'docs/STACK.md', null, `The harness technical sheet has no value for ${(adopt ? lacking : rows).join(', ')} and no recorded owner answer fills it.`);
    }
    const stack = readFileSync(join(dir, 'docs', 'STACK.md'), 'utf8').replace(/\n*$/, '\n');
    await cli(['adopt', 'write', 'docs/STACK.md'], { stdin: `${stack}${rows.map((r) => `| ${r} | ${given[r]} |\n`).join('')}` });
    touched.add('docs/STACK.md');
    for (const r of repoNames) await cli(['harness', 'install', '--target', 'code', '--repo', r]);
  }

  /** Adopt: the owner chooses the existing board, then links the issues of the repository to the slices, as recorded. Nothing is created. */
  async function board() {
    let first = JSON.parse((await cli(['adopt', 'board', '--json'])).stdout);
    if (first.project_number === null && first.choose.some((b) => b.number === answers.board.project)) {
      first = JSON.parse((await cli(['adopt', 'board', '--project', String(answers.board.project), '--json'])).stdout);
    }
    if (first.project_number !== answers.board.project || first.created) {
      throw new E2EError(phase, 'recade adopt board', null, `The existing board ${answers.board.project} was not found, or a board was created: ${JSON.stringify(first)}`);
    }
    const accept = Object.entries(answers.board.accept).map(([issue, slice]) => `${issue}=${slice}`);
    const proposed = new Set(first.matched.map((m) => `${m.repo === undefined ? '' : `${m.repo}#`}${m.issue}=${m.slice}`));
    for (const pair of accept) {
      if (!proposed.has(pair)) throw new E2EError(phase, 'recade adopt board', null, `The board did not propose ${pair} to the owner.`);
    }
    await cli(['adopt', 'board', '--project', String(answers.board.project), '--accept', accept.join(',')]);
  }

  let phaseStart = Date.now();
  try {
    for (phase of PHASES[mode]) {
      phaseStart = Date.now();
      touched.clear();
      const out = await play[phase]();
      const gates = Array.isArray(out) ? out : out.gates;
      steps.push({ phase, gate: gates.at(-1), gates, files: [...touched].sort(), ms: Date.now() - phaseStart, ...(Array.isArray(out) ? {} : { verify: out.verify }) });
      if (phase === stopAfter) break;
    }
  } catch (err) {
    if (!(err instanceof E2EError)) throw err;
    return result({ phase: err.phase, file: err.file, line: err.line, message: err.message });
  }
  return result();
}

// ---- command line: node tools/e2e.js [--mode scratch|from|adopt] [--update] [--keep]

async function main(argv) {
  const modes = argv.includes('--mode') ? [argv[argv.indexOf('--mode') + 1]] : MODES;
  const update = argv.includes('--update');
  const keep = argv.includes('--keep');
  let failed = false;
  const rows = [];
  for (const mode of modes) {
    const tmp = mkdtempSync(join(tmpdir(), `recade-e2e-${mode}-`));
    try {
      const r = await runE2E({ mode, tmp, update });
      rows.push(`${mode.padEnd(8)} ${r.ok ? 'ok  ' : 'FAIL'} ${(r.ms / 1000).toFixed(1)} s  ${r.steps.map((s) => s.phase).join(' > ')}`);
      if (!r.ok) {
        failed = true;
        const f = r.failure;
        process.stderr.write(`FAIL ${mode}, phase ${f.phase}: ${f.file}${f.line === null ? '' : `:${f.line}`} ${f.message}\n`);
      }
    } finally {
      if (!keep) rmSync(tmp, { recursive: true, force: true });
      else process.stdout.write(`kept ${tmp}\n`);
    }
  }
  process.stdout.write(`${rows.join('\n')}\n`);
  if (update) process.stdout.write('Expected files recorded in example/expected/.\n');
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
