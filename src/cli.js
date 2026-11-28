import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { basename, dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintFiles } from './style/lint.js';
import { scanAttachments, formatFinding } from './style/attachments.js';
import { checkRoot, renderIndexMd } from './index/check.js';
import { stringify } from 'yaml';
import { configPath, loadConfig, saveConfig, setConfigValue } from './config.js';
import { WRITER_CHOICES, WRITER_MODELS, isSecondOpinionChoice, isWriterChoice } from './models.js';
import { DECK_CHOICES, EXTRAS, isExtra } from './deliverables.js';
import { firstSliceDue, loadState, noteFirstSliceDone, saveState } from './state.js';
import {
  PHASES, GATES, ADOPT_GATES, SETTINGS, decisionsOf, phasesOf, gatesOf, normalizeState, canStart, passGate, resetFrom, nextAction, projectRoot, workspaceOf, currentPhase, setSetting, trackOf, forgeOf, firstSliceLine,
  phaseCommand,
} from './project/state.js';
import { runChecks, defaultExec } from './doctor.js';
import { detectEntryMode } from './entry.js';
import { scanForNames } from './guard.js';
import { expandHome } from './paths.js';
import { listFiles } from './files.js';
import { sessionStartOutput } from './hook.js';
import { createProject } from './project/scaffold.js';
import { SYNC_ADVICE, linkRepo } from './workspace/layout.js';
import { CLEAN_BRANCH, CLEAN_TITLE, applyClean, cleanPlan } from './workspace/clean.js';
import { endSession } from './session.js';
import { LOCAL_SETTINGS, applyCompact } from './harness/compact.js';
import { resolveLeftovers } from './rebase.js';
import { REPO_NAME } from './project/touches.js';
import { addRepo, listRepos, checkRepos, syncRepos, stripCredentials, VISIBILITIES } from './workspace/repos.js';
import { commitWorkspace, checkWorkspace, pushPending, CommitError, defaultExec as commitExec } from './workspace/commit.js';
import { initAdopt, preflight, writeOwnFile, AdoptError } from './project/adopt.js';
import { scan as scanInventory, renderInventory, scanWorkspace, renderWorkspaceInventory } from './project/inventory.js';
import { checkTeam } from './project/doctrine.js';
import { checkSlices, renderGraph, renderStatus, setStatus, tickDod } from './project/slices.js';
import { cleanSpikes, recordBefore, spikeEnv, spikeRoom } from './project/spikes.js';
import { initGithub, adoptBoard } from './project/github.js';
import { fromCode } from './project/fromcode.js';
import { impactOf } from './project/amend.js';
import { buildIdPattern } from './index/ids.js';
import { openProvisional, closeProvisional, listProvisionals } from './project/provisionals.js';
import { newDecision, closeDecision, listDecisions, reopenTeamDecision } from './project/decisions.js';
import { addTeamDecision, challengeTeamDecision, listTeamDecisions } from './project/teamdecisions.js';
import { DEFAULT_BUDGETS, budgetsOf, checkSizes } from './budgets.js';
import { estimatePhases, estimateSlice, formatRange, formatSteps, projectFacts, ESTIMATE_IDS, SLICE_LANES } from './estimate.js';
import { loadModels, modelWarnings, secondOpinionOf, sensitiveLane, syncAgents, withSecondOpinion } from './harness/models.js';
import { runGate, checkGate, isGateName, defaultExec as runCommand } from './harness/stamps.js';
import { formatOpen, openSlice, tieSession } from './workspace/worktrees.js';
import { handleHook, logGuard } from './harness/guard.js';
import { refresh as refreshClaudeMd, findStack } from './harness/claudemd.js';
import { explainParallel, DEFAULT_MAX } from './harness/parallel.js';
import { inspectConflicts, inspectWorkspaceConflicts, listSliceBranches } from './harness/conflicts.js';
import { reconcile, applyStatusMoves, cleanup, formatReconcile, formatCleanup } from './harness/board.js';
import { mergeOrder } from './harness/merge.js';
import { findTranscripts, readCost, readTranscriptUsage, recordCost, retro, RetroInputError } from './harness/cost.js';
import { addQuarantine, removeQuarantine, listQuarantine, checkQuarantine, QuarantineInputError } from './harness/quarantine.js';
import { releaseNotes, prependChangelog, ReleaseNotesInputError } from './harness/releasenotes.js';
import { install, formatInstall, isAdopt, InstallError, pluginVersion, setupLocal, INSTALL_RECORD } from './harness/install.js';
import { specialise, SpecialiseError } from './harness/specialise.js';
import { TARGET_NAMES, REPO_SETTINGS, readRepoSettings, repoSettingsFile, repoSettingsRel, writeRepoSettings } from './harness/targets.js';
import { verify, formatVerify } from './harness/verify.js';
import { loadCaseSets, setPaths, runCases, defaultRun } from './harness/cases.js';
import { protect } from './harness/protect.js';
import { planLocalMerge, runLocalMerge } from './harness/localmerge.js';

/** @typedef {{stdout:{write(s:string):void}, stderr:{write(s:string):void}, cwd:string, env:Record<string,string|undefined>, run?: (cmd: string[], opts: {cwd: string}) => {code: number, stdout: string, stderr: string}}} IO `run` is an optional test seam for the board commands. */

const GUARD_EXTS = ['.md', '.js', '.json', '.yml', '.yaml', '.txt'];
/** Files that quote third-party text (the Mermaid bundle, the lock file): a private name there is a word of someone else. */
const THIRD_PARTY = (rel) => rel === 'package-lock.json' || rel.startsWith('render/vendor/');
const LOT_NAME = /^[A-Z][A-Z0-9]*$/;
const pkgUrl = new URL('../package.json', import.meta.url);

/**
 * Every command Recade documents. `/recade:*` commands come first, then the ones the harness
 * installs in each project. Commands not built yet carry `available: false`.
 * @type {{command: string, phase: 'plugin'|'harness', summary: string, available?: boolean}[]}
 */
export const COMMAND_MAP = [
  { command: 'start', phase: 'plugin', summary: 'First run: check the machine, set preferences, show the commands.' },
  { command: 'setup', phase: 'plugin', summary: 'Check the machine and say how to fix what is missing.' },
  { command: 'help', phase: 'plugin', summary: 'Show this list.' },
  { command: 'languages', phase: 'plugin', summary: 'Change the languages for chat, documents, code and product.' },
  { command: 'new', phase: 'plugin', summary: 'Start a project: intake, team, documents, bible, slices, harness.' },
  { command: 'adopt', phase: 'plugin', summary: 'Bring an existing code repository under Recade.' },
  { command: 'team', phase: 'plugin', summary: 'Build or revise the expert-inspired team of a project.' },
  { command: 'docs', phase: 'plugin', summary: 'Write or render the project documents (D1, D2, D3, STACK, PLAN).' },
  { command: 'bible', phase: 'plugin', summary: 'Write or update BIBLE.md and the ID index.' },
  { command: 'slices', phase: 'plugin', summary: 'Cut the plan into slices and write the slice sheets.' },
  { command: 'harness', phase: 'plugin', summary: 'Install the agent harness in the project.' },
  { command: 'status', phase: 'plugin', summary: 'Show the phase, the gates and the next action of a project.' },
  { command: 'resume', phase: 'plugin', summary: 'Pick up a project where it stopped.' },
  { command: 'amend', phase: 'plugin', summary: 'Change an upstream document and regenerate what depends on it.' },
  { command: 'status', phase: 'harness', summary: 'Slices, satisfied dependencies, gates waiting for a human, launchable slices.' },
  { command: 'slice', phase: 'harness', summary: 'Deliver one slice end to end, following its lane.' },
  { command: 'slice-check', phase: 'harness', summary: 'Check that a slice sheet is ready, then refresh CLAUDE.md.' },
  { command: 'slice-write', phase: 'harness', summary: 'Create a slice sheet from the template and the sources.' },
  { command: 'parallel', phase: 'harness', summary: 'Propose 3 to 5 slices to start now and open one worktree each.' },
  { command: 'review', phase: 'harness', summary: 'Review a branch against its slice sheet.' },
  { command: 'design', phase: 'harness', summary: 'Design work: direction, system, variants, spec or review.' },
  { command: 'board', phase: 'harness', summary: 'Reconcile the board, then clean the repository, worktrees and branches.' },
  { command: 'inventory', phase: 'harness', summary: 'S-00: inventory of what already exists.' },
  { command: 'decision', phase: 'harness', summary: 'Open a DEC file through a multiple-choice questionnaire.' },
  { command: 'retro', phase: 'harness', summary: 'Increment review with DORA metrics and cost per slice.' },
  { command: 'amend', phase: 'harness', summary: 'Change an upstream document and regenerate what depends on it.' },
  { command: 'explain', phase: 'harness', summary: 'Explain a project tool step by step.' },
  { command: 'second-opinion', phase: 'harness', summary: 'Second-opinion review of an open pull request, by an agent with fresh eyes.' },
  { command: 'merge-order', phase: 'harness', summary: 'Order the open pull requests, rebase the next one after each merge, resolve mechanical conflicts.' },
];

function renderHelp() {
  const line = (label, e) =>
    `${label.padEnd(20)}${e.summary}${e.available === false ? ' (coming in a later version)' : ''}\n`;
  let out = 'Recade commands\n\n';
  for (const e of COMMAND_MAP.filter((c) => c.phase === 'plugin')) out += line(`/recade:${e.command}`, e);
  out += '\nCommands the harness installs in each project\n\n';
  for (const e of COMMAND_MAP.filter((c) => c.phase === 'harness')) out += line(`/${e.command}`, e);
  out += '\nFrom the terminal\n\n';
  // A label longer than the column still keeps two spaces before its text.
  const term = (label) => label.padEnd(Math.max(20, label.length + 2));
  out += `${term('recade models')}Print the model the writing agents use, the owner's choice of Fable or Opus: recade models writer [--id]. The model of the mechanical stages (translate, glossary, apply-decisions, format fixes): recade models mechanical [--effort]\n`;
  out += `${term('recade cases')}List and replay the agent test cases, the plugin's and the harness's: recade cases [--plugin] [--harness] [--run] [--agent <name>]\n`;
  out += `${term('recade workspace')}Find the project workspace, set its auto-push, push what a step left, commit its leftover documents: recade workspace root | auto-push on|off | push | commit --paths <path>[,<path>...] -m <message>\n`;
  out += `${term('recade repo')}Register the code repositories of the workspace, check and relink them: recade repo add <name> (--new | --clone <url>) | list | check | sync\n`;
  out += `${term('recade harness')}Install, verify and test the agent harness: recade harness install | verify | cases [--run] | protect [--apply] | set | specialise <agent|command> <name> --file <path> | models | migrate [--dry-run]\n`;
  out += `${term('recade cost')}Record the cost of a slice: recade cost record <S-nn> --minutes <n> --fix-loops <n> [--tokens <n> | --transcript <path|auto> [--since <ms>] [--session-dir <dir>]]. Estimate a phase or a slice before it runs: recade cost estimate [--phase <phase> | --slice standard|sensitive] [--json]\n`;
  out += `${term('recade retro')}Write retros/INC-n.md with DORA metrics and cost per slice: recade retro <INC-n> [--force] [--json]\n`;
  out += `${term('recade intake')}Scan intake/attachments for invisible Unicode and bidi controls before an agent reads them: recade intake scan [--json]\n`;
  out += `${term('recade quarantine')}Keep flaky tests in tests/quarantine.json until they are fixed: recade quarantine add | remove | list | check\n`;
  out += `${term('recade release-notes')}Release notes from conventional commits: recade release-notes <from>..<to> [--version <v>] [--write]\n`;
  out += `${term('recade spikes')}Before a spike, check that this machine has the free memory and disk it needs, record what it holds and print the environment of the runner: recade spikes check --spike <layer>-<option> [--json]. After the spikes, remove what their manifests list and nothing else: recade spikes clean [--spike <layer>-<option>] [--json]\n`;
  out += `${term('recade docs')}Measure the project documents against their word budgets: recade docs size [D1|D2|D3|PLAN|STACK|BIBLE ...] [--json] | budgets [--json]. The team's own choices: recade decision team add | list | challenge\n`;
  out += `${term('recade render')}Render Markdown documents to DOCX and XLSX and an HTML dossier, named <ID>_<Title> in the document language (PDF too with deliverables.pdf true): recade render <file.md...> [--format docx,xlsx,html,pdf] [--out <dir>] [--no-check], or the extras you chose (deliverables.extras: stack, decisions, design, reviews; the PowerPoint deck with deliverables.deck yes): recade render extras --project <dir> [--no-check]\n`;
  return out;
}

const escapeCell = (text) => text.replaceAll('|', '\\|');

/** The command map as two Markdown tables. The README holds this output. */
function renderHelpMarkdown() {
  const table = (title, phase, label) => {
    let out = `### ${title}\n\n| Command | What it does | Status |\n|---|---|---|\n`;
    for (const e of COMMAND_MAP.filter((c) => c.phase === phase)) {
      const status = e.available === false ? 'coming later' : 'available';
      out += `| \`${label(e.command)}\` | ${escapeCell(e.summary)} | ${status} |\n`;
    }
    return out;
  };
  return `${table('Plugin commands', 'plugin', (c) => `/recade:${c}`)}\n${table('Commands the harness installs in each project', 'harness', (c) => `/${c}`)}`;
}

/**
 * Subcommand table. Later tasks add entries here.
 * @type {Record<string, (args: string[], io: IO) => Promise<number>>}
 */
export const commands = {
  async version(_args, io) {
    const { version, dependencies = {} } = JSON.parse(readFileSync(pkgUrl, 'utf8'));
    // The probe of /recade:setup and of Step 0: every dependency must resolve, without loading it. A plugin updated
    // without `npm ci` lacks the new ones, and this is where the setup notices it.
    const missing = Object.keys(dependencies).filter((name) => {
      try {
        import.meta.resolve(name);
        return false;
      } catch {
        return true;
      }
    });
    if (missing.length > 0) {
      io.stderr.write(`ERR_MODULE_NOT_FOUND: the plugin dependencies are not all installed (missing: ${missing.join(', ')}). Run npm ci --omit=dev in the plugin folder.\n`);
      return 1;
    }
    io.stdout.write(`${version}\n`);
    return 0;
  },
  async 'lint-style'(args, io) {
    const paths = args.length > 0 ? args : ['.'];
    let findings;
    try {
      findings = lintFiles(io.cwd, paths);
    } catch (err) {
      io.stderr.write(`Cannot lint: ${err.message}\n`);
      return 2;
    }
    for (const f of findings) {
      io.stdout.write(`${f.file}:${f.line}:${f.column} ${f.rule} ${f.message}\n`);
    }
    return findings.some((f) => f.severity === 'error') ? 1 : 0;
  },
  async docs(args, io) {
    const [sub, ...rest] = args;
    const usage = () => {
      io.stderr.write(`${DOCS_USAGE}\n`);
      return 2;
    };
    if (!['size', 'budgets'].includes(sub)) return usage();
    const parsed = parseOptions(rest, { flags: ['--json'], values: [] });
    if (parsed.error || (sub === 'budgets' && parsed.positional.length > 0)) return usage();
    if (parsed.positional.some((d) => !Object.hasOwn(DEFAULT_BUDGETS, d))) return usage();
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    const json = parsed.flags.has('--json');
    try {
      if (sub === 'budgets') {
        const budgets = budgetsOf(loadState(root));
        const set = loadState(root)?.budgets ?? {};
        const base = trackOf(loadState(root)) === 'short' ? 'short track' : 'default';
        if (json) io.stdout.write(`${JSON.stringify(budgets)}\n`);
        else for (const [doc, words] of Object.entries(budgets)) io.stdout.write(`${doc} ${words} words (${Object.hasOwn(set, doc) ? 'project' : base})\n`);
        return 0;
      }
      const found = checkSizes(root, parsed.positional.length > 0 ? parsed.positional : undefined);
      if (json) {
        io.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
      } else if (found.length === 0) {
        io.stdout.write('No document to measure yet.\n');
      } else {
        for (const f of found) {
          const head = `${f.level} ${f.file}: ${f.words} words, budget ${f.budget} (${f.percent}%).`;
          const tail = f.level === 'warn' ? ' Over budget: cut, do not summarise the cut.'
            : f.level === 'error' ? ' Over 150% of the budget: revise it, cut, do not summarise the cut.' : '';
          io.stdout.write(`${head}${tail}\n`);
        }
      }
      return found.some((f) => f.level === 'error') ? 1 : 0;
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
  },
  async intake(args, io) {
    const parsed = args[0] === 'scan' ? parseOptions(args.slice(1), { flags: ['--json'], values: [] }) : { error: 'usage' };
    if (parsed.error || parsed.positional.length > 0) {
      io.stderr.write(`${INTAKE_USAGE}\n`);
      return 2;
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    const result = scanAttachments(root);
    if (parsed.flags.has('--json')) {
      io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.findings.length === 0) {
      io.stdout.write('No invisible Unicode in intake/attachments, and every file could be scanned.\n');
    } else {
      for (const f of result.findings) io.stdout.write(`${f.severity === 'error' ? 'BLOCKING' : 'warning'}: ${formatFinding(f)}\n`);
      if (result.blocking) io.stdout.write('Do not let an agent read any attachment until this scan exits 0 or the owner accepts the listed findings. Remove the characters (or ask the client for a clean copy), then scan again.\n');
    }
    return result.blocking ? 1 : 0;
  },
  async state(args, io) {
    const [sub, ...rest] = args;
    const usage = (msg = STATE_USAGE) => {
      io.stderr.write(`${msg}\n`);
      return 2;
    };
    if (!['show', 'can-start', 'pass', 'set', 'reset-from'].includes(sub)) return usage();
    if (sub === 'show' && rest.some((a) => a !== '--json')) return usage();
    if (sub === 'can-start' && rest.length !== 1) return usage();
    if ((sub === 'pass' || sub === 'reset-from') && rest.length !== 1) return usage();
    if (sub === 'reset-from' && !GATES.includes(rest[0]) && !ADOPT_GATES.includes(rest[0])) return usage(`Unknown gate: ${rest[0]}. Use ${GATES.join(', ')}.\n${STATE_USAGE}`);
    if (sub === 'set' && rest.length !== 2) return usage();
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    let state;
    try {
      state = normalizeState(loadState(root));
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
    if (sub === 'show') {
      if (rest.includes('--json')) {
        const phase = currentPhase(state);
        const command = phaseCommand(state, phase);
        const entry = COMMAND_MAP.find((c) => c.phase === 'plugin' && c.command === command);
        const out = {
          ...state,
          decisions: decisionsOf(state),
          phase: phase.id,
          phase_name: phase.name,
          command,
          command_available: entry?.available !== false,
          next_action: nextAction(state),
          track: trackOf(state),
          forge: forgeOf(state),
          // The owner chose the forge already (`recade state set forge`): /recade:slices asks only when this is false.
          forge_asked: state.forge === 'github' || state.forge === 'local',
          first_slice: firstSliceLine(state, localDate((io.now ?? (() => new Date()))())),
        };
        io.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      } else {
        io.stdout.write(renderState(state, root, localDate((io.now ?? (() => new Date()))())));
      }
      return 0;
    }
    if (sub === 'can-start') {
      const n = Number(rest[0]);
      const phases = phasesOf(state);
      if (!/^\d+$/.test(rest[0]) || n >= phases.length) {
        return usage(`Invalid phase: ${rest[0]}. Use a number from 0 to ${phases.length - 1}.`);
      }
      const { ok, missing } = canStart(state, n);
      if (ok) {
        io.stdout.write(`Phase ${n} (${phases[n].name}) can start.\n`);
        return 0;
      }
      io.stdout.write(`Cannot start phase ${n} (${phases[n].name}). Missing gate: ${missing}.\n`);
      return 1;
    }
    // Load, compute and save under the commit lock, so two sessions never overwrite each other's change. Every change
    // of the state is committed as it is made, so a state file that is dirty later was edited by someone else.
    const message = sub === 'pass' ? `chore(recade): ${rest[0]} passed` : sub === 'reset-from' ? `chore(recade): reset from ${rest[0]}` : `chore(recade): ${rest[0]} set`;
    const step = await endStep(io, root, ['recade/state.yaml'], (r) => (r.next === undefined ? null : message), () => {
      let fresh;
      try {
        fresh = normalizeState(loadState(root));
      } catch (err) {
        return { fail: { code: 2, text: oneLine(err) } };
      }
      let computed;
      try {
        if (sub === 'pass') {
          if (!gatesOf(fresh).includes(rest[0])) return { fail: { usage: `Unknown gate: ${rest[0]}. Use ${gatesOf(fresh).join(', ')}.` } };
          computed = passGate(fresh, rest[0], localDate((io.now ?? (() => new Date()))()));
        } else if (sub === 'reset-from') {
          computed = resetFrom(fresh, rest[0]);
        } else {
          if (!SETTINGS.includes(rest[0])) return { fail: { usage: `Cannot set ${rest[0]}. Use ${SETTINGS.join(', ')}.` } };
          computed = setSetting(fresh, rest[0], rest[1]);
        }
      } catch (err) {
        return { fail: sub === 'pass' ? { code: 1, text: oneLine(err) } : { usage: oneLine(err) } };
      }
      try {
        saveState(root, computed);
      } catch (err) {
        return { fail: { code: 2, text: `Cannot write ${root}/recade/state.yaml: ${oneLine(err)}` } };
      }
      return { next: computed };
    });
    if (step.exit !== undefined) return step.exit;
    if (step.value.fail !== undefined) {
      const { usage: text, code, text: line } = step.value.fail;
      if (text !== undefined) return usage(text);
      io.stderr.write(`${line}\n`);
      return code;
    }
    const next = step.value.next;
    if (sub === 'reset-from') io.stdout.write(`${rest[0]} and every later gate reset. ${next.next_action}\n`);
    else {
      io.stdout.write(sub === 'pass'
        ? `${rest[0]} passed on ${next.gates[rest[0]].passed}. ${next.next_action}\n`
        : `${rest[0]} set.\n`);
      // The compact size lives in the local settings of Claude Code for this project: it is applied there at once.
      if (sub === 'set' && rest[0] === 'compact') {
        const done = applyCompact(root, typeof next.compact === 'number' ? next.compact : null);
        if (done.error) io.stderr.write(`recade: warning: ${done.error}.\n`);
        else io.stdout.write(typeof next.compact === 'number' ? `Sessions of this project compact at ${next.compact} tokens (${LOCAL_SETTINGS}). It takes effect in a new session.\n` : `Sessions of this project compact at the size set by Claude Code (${LOCAL_SETTINGS}).\n`);
      }
    }
    return 0;
  },
  async new(args, io) {
    const parsed = parseOptions(args, { flags: ['--json'], values: ['--from', '--parent'] });
    if (parsed.error || parsed.positional.length !== 1) {
      io.stderr.write(`${NEW_USAGE}\n`);
      return 2;
    }
    const loaded = readConfig(io);
    if (!loaded) return 1;
    const { config } = loaded;
    const from = parsed.values['--from'];
    try {
      // The parent folder is the owner's word for this workspace; without it the workspace goes under projects_root.
      const parent = parsed.values['--parent'];
      const root = resolve(io.cwd, expandHome(parent === undefined ? config.projects_root : parent, io.env));
      const result = await createProject(parsed.positional[0], {
        root,
        mode: from === undefined ? 'scratch' : 'from-docs',
        from: from === undefined ? undefined : resolve(io.cwd, expandHome(from, io.env)),
        config,
        exec: io.exec ?? defaultExec,
        today: localDate((io.now ?? (() => new Date()))()),
      });
      if (parsed.flags.has('--json')) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        io.stdout.write(`Created ${result.dir}\n`);
        io.stdout.write(`Copied ${result.copied.length} file(s) into intake/attachments.\n`);
        if (result.unsupported.length > 0) {
          io.stdout.write(`Not supported, listed in intake/gaps.md: ${result.unsupported.join(', ')}\n`);
        }
        if (result.links.length > 0) {
          io.stdout.write(`Symbolic links skipped, listed in intake/gaps.md: ${result.links.join(', ')}\n`);
        }
        if (result.large.length > 0) {
          io.stdout.write(`Large files kept out of Git, listed in intake/gaps.md: ${result.large.join(', ')}\n`);
        }
      }
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 1;
    }
    return 0;
  },
  async workspace(args, io) {
    const [sub, ...rest] = args;
    if (sub === 'commit') {
      // The main session commits leftovers of the workspace (a sheet written by an agent, a design) under the commit lock, with no push.
      const wanted = parseWorkspaceCommit(rest);
      if (wanted === null) {
        io.stderr.write(`${WORKSPACE_USAGE}\n(the paths are documents of the workspace: slices, design, decisions, retros, team, intake, docs, BIBLE.md, INDEX.md; the message is one line of 200 characters at most)\n`);
        return 2;
      }
      const root = projectRoot(io.cwd);
      if (root === null || gitWorkspace(root) === null) {
        io.stderr.write('recade: this project is not a workspace under git, so there is nothing to commit here.\n');
        return 1;
      }
      const step = await endStep(io, root, wanted.paths, wanted.message, () => ({}), { own: false });
      if (step.exit !== undefined) return step.exit;
      io.stdout.write(step.committed === false ? 'Nothing to commit.\n' : `Committed ${wanted.paths.length} path${wanted.paths.length === 1 ? '' : 's'}: ${wanted.message}\n`);
      return 0;
    }
    if (sub === 'push' && rest.length === 0) {
      // The commits a step left unpushed, when the owner turned auto-push on. Never an error: a failed push is a warning.
      const found = workspaceOf(io.cwd);
      if (found === null || gitWorkspace(found.dir) === null) {
        io.stdout.write('Not in a workspace under git: nothing to push.\n');
        return 0;
      }
      const r = await pushPending(found.dir, { exec: io.run ?? commitExec });
      if (r.state === 'failed') io.stderr.write(`recade: warning: ${r.warning}\n`);
      else io.stdout.write({
        off: 'Workspace auto-push is off: nothing was pushed (recade workspace auto-push on turns it on).\n',
        'no-remote': 'The workspace has no origin remote: nothing to push.\n',
        none: 'Nothing to push.\n',
        pushed: `Pushed the workspace${r.count === undefined ? '' : ` (${r.count} commit${r.count === 1 ? '' : 's'})`}.\n`,
      }[r.state]);
      return 0;
    }
    const ok = (sub === 'root' && rest.length === 0) || (sub === 'auto-push' && rest.length === 1 && ['on', 'off'].includes(rest[0]));
    if (!ok) {
      io.stderr.write(`${WORKSPACE_USAGE}\n`);
      return 2;
    }
    const found = workspaceOf(io.cwd);
    if (found === null) {
      io.stderr.write(`recade: no workspace found from ${io.cwd}. In a code repository, run ${SYNC_ADVICE} from its workspace to link it again.\n`);
      return 1;
    }
    if (sub === 'root') {
      io.stdout.write(`${found.dir}\n`);
      return 0;
    }
    try {
      const step = await endStep(io, found.dir, ['recade/state.yaml'], `chore(recade): auto-push ${rest[0]}`, () => {
        saveState(found.dir, withAutoPush(loadState(found.dir) ?? {}, rest[0] === 'on', io));
      });
      if (step.exit !== undefined) return step.exit;
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
    io.stdout.write(rest[0] === 'on' ? 'Workspace auto-push is on.\n' : 'Workspace auto-push is off.\n');
    return 0;
  },
  async repo(args, io) {
    const [sub, ...rest] = args;
    const forms = {
      add: { flags: ['--new'], values: ['--clone', '--role', '--visibility'] },
      list: { flags: ['--json'], values: [] },
      check: { flags: ['--json'], values: [] },
      sync: { flags: [], values: [] },
      clean: { flags: ['--apply'], values: [] },
    };
    const usage = () => {
      io.stderr.write(`${REPO_USAGE}\n`);
      return 2;
    };
    if (!Object.hasOwn(forms, sub)) return usage();
    const parsed = parseOptions(rest, forms[sub]);
    if (parsed.error || parsed.positional.length !== (sub === 'add' || sub === 'clean' ? 1 : 0)) return usage();
    if (sub === 'add') {
      const clone = parsed.values['--clone'];
      const visibility = parsed.values['--visibility'];
      if (parsed.flags.has('--new') === (clone !== undefined) || (visibility !== undefined && !VISIBILITIES.includes(visibility))) return usage();
    }
    const found = workspaceOf(io.cwd);
    if (found === null) {
      io.stderr.write(`recade: no workspace found from ${io.cwd}. Run this in a workspace, or in a code repository linked to one (${SYNC_ADVICE}).\n`);
      return 1;
    }
    if (sub === 'clean') {
      const name = parsed.positional[0];
      const entry = listRepos(found.dir).find((e) => e.name === name);
      const dir = join(found.dir, 'repos', String(name));
      if (entry === undefined || !existsSync(join(dir, '.git'))) {
        io.stderr.write(`${name} is not a code repository of this workspace with a folder in repos/. Run: recade repo list\n`);
        return 1;
      }
      const plan = cleanPlan(dir);
      if (!parsed.flags.has('--apply')) {
        if (plan.remove.length === 0 && plan.rewrite.length === 0) {
          io.stdout.write(`${name}: nothing to clean, the repository holds no file of Recade.\n`);
          return 0;
        }
        io.stdout.write(`Dry run: nothing was changed. On a branch ${CLEAN_BRANCH} of ${name}, from origin, the clean would:\n`);
        for (const f of plan.remove) io.stdout.write(`remove   ${f}\n`);
        for (const r of plan.rewrite) io.stdout.write(`rewrite  ${r.file}\n`);
        for (const m of plan.mentions) io.stdout.write(`still names Recade, to edit in the pull request: ${m}\n`);
        io.stdout.write(`Then commit "${CLEAN_TITLE}", push the branch and open one pull request, for the owner to merge. Run again with --apply.\n`);
        return 0;
      }
      const base = typeof entry.default_branch === 'string' && entry.default_branch !== '' ? entry.default_branch : 'main';
      const done = applyClean(dir, join(found.dir, 'worktrees', String(name), 'cleanup'), { base });
      (done.ok ? io.stdout : io.stderr).write(`${name}: ${done.message}\n`);
      return done.ok ? 0 : 1;
    }
    const exec = io.exec ?? defaultExec;
    const json = parsed.flags.has('--json');
    try {
      if (sub === 'add') {
        const clone = parsed.values['--clone'];
        // The clone can take long: the refusals come first, the work runs outside the lock, then the commit.
        const step = await endStep(io, found.dir, ['recade/state.yaml', 'slices'], `chore(recade): repository ${parsed.positional[0]} added`, () => addRepo(found.dir, parsed.positional[0], {
          ...(clone === undefined ? { new: true } : { clone }), role: parsed.values['--role'], visibility: parsed.values['--visibility'],
        }, { exec: (cmd, cmdArgs) => exec(cmd, cmdArgs, 120000), cwd: io.invokedFrom ?? io.cwd }), {
          around: true, stage: (entry) => ['recade/state.yaml', ...entry.prefixed.map((c) => c.sheet)],
        });
        if (step.exit !== undefined) {
          // The clone was made but its record was put back: remove the folder too, so the same command can run again.
          if (step.after !== undefined) {
            rmSync(join(found.dir, step.after.path), { recursive: true, force: true });
            io.stderr.write(`recade: ${step.after.path} was removed as well, so the registry and the disk agree. Fix the cause, then run this command again.\n`);
          }
          return step.exit;
        }
        const entry = step.value;
        const { prefixed, prefixedHotspots, ...saved } = entry;
        if (json) {
          io.stdout.write(`${JSON.stringify({ ...saved, prefixed, prefixedHotspots }, null, 2)}\n`);
          return 0;
        }
        io.stdout.write(`Added ${saved.name} at ${saved.path} (${saved.remote === 'none' ? 'no remote' : stripCredentials(saved.remote)}).\n`);
        for (const c of prefixed) {
          const changes = c.before.map((b, i) => (b === c.after[i] ? null : `${b} -> ${c.after[i]}`)).filter((x) => x !== null);
          io.stdout.write(`Prefixed touches in ${c.sheet}: ${changes.join(', ')}\n`);
        }
        if (prefixedHotspots.length > 0) io.stdout.write(`Prefixed hotspots: ${prefixedHotspots.map((h) => `${h.before} -> ${h.after}`).join(', ')}\n`);
        return 0;
      }
      if (sub === 'list') {
        const repos = listRepos(found.dir);
        if (json) io.stdout.write(`${JSON.stringify(repos.map((r) => (typeof r.remote === 'string' ? { ...r, remote: stripCredentials(r.remote) } : r)), null, 2)}\n`);
        else if (repos.length === 0) io.stdout.write('No code repository yet. Add one: recade repo add <name> --new | --clone <url>\n');
        else for (const r of repos) io.stdout.write(`${[r.name, r.path, typeof r.remote === 'string' ? stripCredentials(r.remote) : r.remote, r.default_branch, r.visibility, r.role].map((x) => x ?? '').join('  ')}\n`);
        return 0;
      }
      if (sub === 'check') {
        const { findings } = checkRepos(found.dir);
        if (json) io.stdout.write(`${JSON.stringify({ findings }, null, 2)}\n`);
        else if (findings.length === 0) io.stdout.write('Every repository is present, linked and has its harness.\n');
        else {
          for (const f of findings) io.stdout.write(`${f.repo}: ${f.problem}\n`);
          if (findings.some((f) => ['link missing', 'link points elsewhere', 'missing', 'git hooks off'].includes(f.problem))) io.stdout.write(`Run: ${SYNC_ADVICE}\n`);
        }
        return findings.length === 0 ? 0 : 1;
      }
      const result = await syncRepos(found.dir, { exec: (cmd, cmdArgs) => exec(cmd, cmdArgs, 120000), pluginRoot: fileURLToPath(new URL('../', import.meta.url)) });
      io.stdout.write(`Cloned ${result.cloned.length}, linked ${result.linked.length}, repaired worktrees in ${result.repaired.length}.\n`);
      if (result.hooked.length > 0) io.stdout.write(`Turned the git hooks on (core.hooksPath .githooks) in ${result.hooked.join(', ')}.\n`);
      for (const s of result.skipped) io.stdout.write(`Skipped ${s.repo}: ${s.reason}\n`);
      return result.skipped.length === 0 ? 0 : 1;
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 1;
    }
  },
  async provisional(args, io) {
    const [sub, ...rest] = args;
    const usage = () => {
      io.stderr.write(`${PROVISIONAL_USAGE}\n`);
      return 2;
    };
    if (!['open', 'close', 'list'].includes(sub)) return usage();
    const parsed = parseOptions(rest, sub === 'open'
      ? { flags: [], values: ['--what', '--why', '--assumption', '--owner', '--due'] }
      : sub === 'close'
        ? { flags: [], values: ['--value', '--replaced-in'] }
        : { flags: ['--open', '--json'], values: [] });
    if (parsed.error) return usage();
    const need = sub === 'close' ? 1 : 0;
    if (parsed.positional.length !== need) return usage();
    if (sub === 'open' && ['--what', '--why', '--assumption', '--owner'].some((k) => parsed.values[k] === undefined)) {
      return usage();
    }
    if (sub === 'close' && parsed.values['--value'] === undefined) return usage();
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    try {
      if (sub === 'open') {
        const v = parsed.values;
        const step = await endStep(io, root, ['intake/provisionals.md'], (id) => `docs(intake): ${id} opened`, () => openProvisional(root, {
          what: v['--what'], why: v['--why'], assumption: v['--assumption'], owner: v['--owner'], due: v['--due'],
        }));
        if (step.exit !== undefined) return step.exit;
        io.stdout.write(`${step.value}\n`);
      } else if (sub === 'close') {
        const date = localDate((io.now ?? (() => new Date()))());
        const id = parsed.positional[0];
        const step = await endStep(io, root, ['intake/provisionals.md'], `docs(intake): ${id} closed`, () => closeProvisional(root, id, {
          value: parsed.values['--value'], replacedIn: parsed.values['--replaced-in'] ?? '', date,
        }));
        if (step.exit !== undefined) return step.exit;
        io.stdout.write(`${id} closed on ${date}.\n`);
      } else {
        const list = listProvisionals(root, { open: parsed.flags.has('--open') });
        if (parsed.flags.has('--json')) {
          io.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
        } else {
          for (const p of list) {
            const detail = p.status === 'open' ? [p.assumption, p.owner, p.due] : [p.value, p.closedOn];
            io.stdout.write(`${[p.id, p.status, p.what, ...detail].join('\t')}\n`);
          }
        }
      }
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 1;
    }
    return 0;
  },
  async decision(args, io) {
    const [sub, ...rest] = args;
    const usage = () => {
      io.stderr.write(`${DECISION_USAGE}\n`);
      return 2;
    };
    if (sub === 'team') return decisionTeam(rest, io, usage);
    if (!['new', 'close', 'list'].includes(sub)) return usage();
    const parsed = parseOptions(rest, sub === 'new'
      ? { flags: [], values: ['--doc', '--question', '--why', '--known', '--unknown', '--options', '--recommendation', '--change-mind', '--due'] }
      : sub === 'close'
        ? { flags: [], values: ['--choice', '--by', '--why'] }
        : { flags: ['--open', '--json'], values: [] });
    if (parsed.error) return usage();
    if (parsed.positional.length !== (sub === 'close' ? 1 : 0)) return usage();
    if (sub === 'new' && ['--doc', '--question', '--why', '--known', '--unknown', '--options', '--recommendation', '--change-mind'].some((k) => parsed.values[k] === undefined)) {
      return usage();
    }
    if (sub === 'close' && parsed.values['--choice'] === undefined) return usage();
    // `--by team` is the trust mode: the team took the recommendation, so it gives its reason, and the line goes to TEAM.md.
    if (sub === 'close' && !['owner', 'team', undefined].includes(parsed.values['--by'])) return usage();
    if (sub === 'close' && (parsed.values['--by'] === 'team') !== (parsed.values['--why'] !== undefined)) return usage();
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    const date = localDate((io.now ?? (() => new Date()))());
    try {
      if (sub === 'new') {
        const v = parsed.values;
        let options;
        try {
          options = JSON.parse(v['--options']);
        } catch {
          io.stderr.write('--options must be a JSON array of {label, cost, closes, risks, calendar, repo}.\n');
          return 2;
        }
        // Only the new file is committed and checked: the owner's edits of other decisions are none of this step's business.
        const step = await endStep(io, root, ['decisions'], (id) => `docs(decisions): ${id} opened`, () => newDecision(root, {
          document: v['--doc'], question: v['--question'], why: v['--why'], known: v['--known'], unknown: v['--unknown'],
          options, recommendation: v['--recommendation'], changeMind: v['--change-mind'], due: v['--due'],
        }, { date }), { own: false, stage: (id) => [`decisions/${id}.md`] });
        if (step.exit !== undefined) return step.exit;
        io.stdout.write(`${step.value}\n`);
      } else if (sub === 'close') {
        const id = parsed.positional[0];
        const team = parsed.values['--by'] === 'team';
        const paths = [/^DEC-\d{2,}$/.test(id) ? `decisions/${id}.md` : 'decisions', ...(team ? ['decisions/TEAM.md'] : [])];
        const step = await endStep(io, root, paths, team ? `docs(decisions): ${id} closed by the team` : `docs(decisions): ${id} closed`,
          () => closeDecision(root, id, { choice: parsed.values['--choice'], ...(team ? { by: 'team', why: parsed.values['--why'] } : {}), date }));
        if (step.exit !== undefined) return step.exit;
        io.stdout.write(team ? `${id} closed on ${date} by the team (${step.value}).\n` : `${id} closed on ${date}.\n`);
      } else {
        const list = listDecisions(root, { open: parsed.flags.has('--open') });
        if (parsed.flags.has('--json')) {
          io.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
        } else {
          for (const d of list) io.stdout.write(`${[d.id, d.status, d.document, d.question, d.due, d.choice, ...(d.by === 'team' ? [`team (${d.td})`] : []), ...(d.supersedes === '' ? [] : [`supersedes ${d.supersedes}`])].join('\t')}\n`);
        }
      }
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 1;
    }
    return 0;
  },
  async team(args, io) {
    if (args.length !== 1 || args[0] !== 'check') {
      io.stderr.write(`${TEAM_USAGE}\n`);
      return 2;
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    let findings;
    try {
      findings = checkTeam(root);
    } catch (err) {
      io.stderr.write(`Cannot read ${root}/team: ${oneLine(err)}\n`);
      return 2;
    }
    printFindings(findings, io);
    const errors = findings.filter((f) => f.severity === 'error').length;
    if (errors > 0) return 1;
    const count = readdirSync(join(root, 'team')).filter((f) => f.endsWith('.md') && f !== 'roster.md').length;
    io.stdout.write(`Team check passed: ${count} doctrine${count === 1 ? '' : 's'}.\n`);
    return 0;
  },
  async slices(args, io) {
    if (args[0] === 'dod') return slicesDod(args.slice(1), io);
    if (args[0] === 'merge') return slicesMerge(args.slice(1), io);
    if (args[0] === 'open') return slicesOpen(args.slice(1), io);
    const set = args[0] === 'status' && args[1] === '--set';
    if (!set && (args.length !== 1 || !['check', 'graph', 'status'].includes(args[0]))) {
      io.stderr.write(`${SLICES_USAGE}\n`);
      return 2;
    }
    let move = null;
    if (set) {
      move = parseStatusSet(args.slice(2));
      if (move === null) {
        io.stderr.write(`${SLICES_USAGE}\n`);
        return 2;
      }
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    if (move !== null) {
      // Read, change, write and commit under the commit lock of the workspace: two sessions that move a status at once both
      // land. Every move is committed (so the next one finds the file clean); none is pushed here.
      // The first slice that becomes done records its day in the state, once: the state is then committed with STATUS.md.
      // An uncommitted change of the state that is not ours never blocks the move: the day is then left for a later move.
      const noteFirst = move.status === 'done' && firstSliceDue(root) && await firstSliceFree(io, root);
      const paths = noteFirst ? ['slices/STATUS.md', 'recade/state.yaml'] : ['slices/STATUS.md'];
      const step = await endStep(io, root, paths, (r) => (r.moved === undefined ? null : `chore(slices): ${move.id} ${r.moved.to}`), () => {
        let moved;
        try {
          moved = setStatus(root, move.id, move.status, { note: move.note });
        } catch (err) {
          return { fail: 2, message: `Cannot read ${root}/slices: ${oneLine(err)}` };
        }
        if (!moved.ok) return { fail: 1, message: moved.message };
        try {
          writeFileSync(join(root, 'slices', 'STATUS.md'), moved.text);
        } catch (err) {
          return { fail: 2, message: `Cannot write slices/STATUS.md: ${oneLine(err)}` };
        }
        if (noteFirst && moved.to === 'done') {
          try {
            noteFirstSliceDone(root, localDate((io.now ?? (() => new Date()))()));
          } catch (err) {
            io.stderr.write(`recade: warning: the day of the first slice was not recorded: ${oneLine(err)}\n`);
          }
        }
        return { moved };
      });
      if (step.exit !== undefined) return step.exit;
      if (step.value.fail !== undefined) {
        io.stderr.write(`${step.value.message}\n`);
        return step.value.fail;
      }
      io.stdout.write(`${move.id}: ${step.value.moved.from} -> ${step.value.moved.to}\n`);
      return 0;
    }
    let result;
    try {
      result = checkSlices(root);
    } catch (err) {
      io.stderr.write(`Cannot read ${root}/slices: ${oneLine(err)}\n`);
      return 2;
    }
    const [sub] = args;
    if (sub === 'check') {
      printFindings(result.findings, io);
      if (result.findings.some((f) => f.severity === 'error')) return 1;
      const n = result.status.length;
      io.stdout.write(`Slices check passed: ${n} slice${n === 1 ? '' : 's'}.\n`);
      return 0;
    }
    const file = sub === 'graph' ? 'graph.md' : 'STATUS.md';
    // The table keeps the states of the file, so it is read again under the lock, and committed like a move.
    const step = await endStep(io, root, [`slices/${file}`], `chore(slices): ${file} written`, () => {
      let fresh;
      try {
        fresh = checkSlices(root);
      } catch (err) {
        return { fail: 2, message: `Cannot read ${root}/slices: ${oneLine(err)}` };
      }
      try {
        mkdirSync(join(root, 'slices'), { recursive: true });
        writeFileSync(join(root, 'slices', file), sub === 'graph' ? renderGraph(fresh.graph) : renderStatus(fresh.status, fresh.backlog));
      } catch (err) {
        return { fail: 2, message: `Cannot write slices/${file}: ${oneLine(err)}` };
      }
      return { count: fresh.status.length };
    });
    if (step.exit !== undefined) return step.exit;
    if (step.value.fail !== undefined) {
      io.stderr.write(`${step.value.message}\n`);
      return step.value.fail;
    }
    io.stdout.write(`Wrote slices/${file} with ${step.value.count} slice${step.value.count === 1 ? '' : 's'}.\n`);
    return 0;
  },
  async spikes(args, io) {
    const [sub, ...rest] = args;
    const parsed = parseOptions(rest, { flags: ['--json'], values: ['--spike'] });
    if (!['check', 'clean'].includes(sub) || parsed.error || parsed.positional.length > 0) {
      io.stderr.write(`${SPIKES_USAGE}\n`);
      return 2;
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    const json = parsed.flags.has('--json');
    if (sub === 'check') {
      const room = spikeRoom(root, io.spikeSeams ?? {});
      const spike = parsed.values['--spike'];
      let before = null;
      let env = null;
      if (room.ok && spike !== undefined) {
        try {
          before = recordBefore(root, spike, { exec: io.run ?? runCommand, ...(io.spikeSeams ?? {}) });
        } catch (err) {
          io.stderr.write(`Cannot record the machine before the spike: ${oneLine(err)}\n`);
          return 2;
        }
        env = spikeEnv(join(root, 'spikes', spike));
      }
      if (json) io.stdout.write(`${JSON.stringify({ ...room, ...(before ? { before: before.record, env } : {}) })}\n`);
      else {
        io.stdout.write(`Free memory: ${room.memoryMb} MB (a spike needs ${room.min.memoryMb} MB).\n`);
        io.stdout.write(room.diskMb === null ? 'Free disk: unknown.\n' : `Free disk: ${room.diskMb} MB (a spike needs ${room.min.diskMb} MB).\n`);
        for (const p of room.problems) io.stdout.write(`${p}\n`);
        io.stdout.write(room.ok ? 'Room for a spike: yes.\n' : 'Room for a spike: no. Skip the spike and decide the layer from the research.\n');
        if (before) {
          io.stdout.write(`Recorded the machine before the spike in spikes/${spike}.before.json.\n`);
          io.stdout.write('Environment for the runner (it sets these before any install, so the caches stay in its folder):\n');
          for (const [k, v] of Object.entries(env)) io.stdout.write(`export ${k}=${shellQuote(v)}\n`);
        }
      }
      return room.ok ? 0 : 1;
    }
    let result;
    try {
      result = cleanSpikes(root, { exec: io.run ?? runCommand, only: parsed.values['--spike'], ...(io.spikeSeams ?? {}) });
    } catch (err) {
      io.stderr.write(`Cannot clean the spikes: ${oneLine(err)}\n`);
      return 2;
    }
    if (json) {
      io.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      for (const n of result.notes) io.stdout.write(`${n}\n`);
      for (const r of result.removed) io.stdout.write(`Removed ${r.kind} ${r.what} (spikes/${r.spike}).\n`);
      for (const r of result.gone) io.stdout.write(`Already gone: ${r.kind} ${r.what} (spikes/${r.spike}).\n`);
      for (const r of result.kept) io.stdout.write(`Kept ${r.kind} ${r.what} (spikes/${r.spike}): ${r.why}.\n`);
      const n = result.removed.length;
      io.stdout.write(`Spikes cleaned: ${n} item${n === 1 ? '' : 's'} removed, ${result.kept.length} kept, from ${result.folders.length} manifest${result.folders.length === 1 ? '' : 's'}.\n`);
    }
    return 0;
  },
  async amend(args, io) {
    const [sub, ...ids] = args;
    if (sub !== 'impact' || ids.length === 0) {
      io.stderr.write(`${AMEND_USAGE}\n`);
      return 2;
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    let lots;
    try {
      lots = lotsFromState(root);
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 1;
    }
    const idRe = buildIdPattern(lots, { global: false, anchored: true });
    const bad = ids.find((id) => !idRe.test(id));
    if (bad !== undefined) {
      io.stderr.write(`Not an ID: ${bad}.\n${AMEND_USAGE}\n`);
      return 2;
    }
    let hits;
    try {
      hits = impactOf(ids, root, { lots });
    } catch (err) {
      io.stderr.write(`Cannot read ${root}: ${oneLine(err)}\n`);
      return 2;
    }
    if (hits.length === 0) io.stdout.write(`No file cites ${ids.join(', ')}.\n`);
    for (const h of hits) io.stdout.write(`${h.file}:${h.line} ${h.id}\n`);
    return 0;
  },
  async cases(args, io) {
    const parsed = parseOptions(args, { flags: ['--plugin', '--harness', '--run'], values: ['--agent'] });
    if (parsed.error || parsed.positional.length > 0 || Object.values(parsed.values).some((v) => v.startsWith('--'))) {
      io.stderr.write(`${CASES_USAGE}\n`);
      return 2;
    }
    const only = ['plugin', 'harness'].filter((set) => parsed.flags.has(`--${set}`));
    const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
    return casesCommand(parsed, io, { pluginRoot, sets: only.length === 0 ? ['plugin', 'harness'] : only, tagged: true, command: 'recade cases' });
  },
  async rebase(args, io) {
    const parsed = parseOptions(args.slice(1), { flags: [], values: ['--dir'] });
    if (args[0] !== 'leftovers' || parsed.error || parsed.positional.length > 0) {
      io.stderr.write('Usage: recade rebase leftovers [--dir <worktree>] (settles a rebase conflict that holds only files of an older Recade)\n');
      return 2;
    }
    const r = resolveLeftovers(resolve(io.cwd, parsed.values['--dir'] ?? '.'));
    (r.state === 'others' ? io.stderr : io.stdout).write(`${r.message}\n`);
    return r.state === 'others' ? 1 : 0;
  },
  async session(args, io) {
    if (args.length !== 1 || args[0] !== 'end') {
      io.stderr.write('Usage: recade session end (run by /exit: stops this Claude Code session a moment after it returns)\n');
      return 2;
    }
    const pid = (io.endSession ?? endSession)();
    if (pid === null) {
      io.stderr.write('No Claude Code session was found above this command, so nothing was stopped. Close the session from the app.\n');
      return 1;
    }
    io.stdout.write('The session stops in a moment.\n');
    return 0;
  },
  async harness(args, io) {
    const [sub, ...rest] = args;
    const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
    const usage = () => {
      io.stderr.write(`${HARNESS_USAGE}\n`);
      return 2;
    };
    if (sub === 'models') return harnessModels(rest, io, usage);
    if (sub === 'migrate') return harnessMigrate(rest, io, { pluginRoot, usage });
    if (sub === 'sync') return harnessSync(rest, io, { pluginRoot, usage });
    if (!['install', 'verify', 'cases', 'protect', 'set', 'specialise'].includes(sub)) return usage();
    const parsed = parseOptions(rest, {
      flags: sub === 'install' ? ['--force'] : sub === 'cases' ? ['--run'] : sub === 'protect' ? ['--apply'] : [],
      values: sub === 'install' ? ['--ref', '--target', '--repo'] : sub === 'verify' || sub === 'specialise' ? [...(sub === 'specialise' ? ['--file'] : []), '--target', '--repo'] : sub === 'cases' ? ['--agent'] : sub === 'protect' ? ['--branch'] : sub === 'set' ? ['--required-gates', '--wip-limit', '--threshold-files'] : [],
    });
    if (parsed.error || parsed.positional.length !== (sub === 'specialise' ? 2 : 0) || Object.values(parsed.values).some((v) => v.startsWith('--'))) return usage();
    if (sub === 'specialise' && (parsed.values['--file'] === undefined || !['agent', 'command'].includes(parsed.positional[0]))) return usage();
    if (sub === 'cases') return casesCommand(parsed, io, { pluginRoot, sets: ['harness'], tagged: false, command: 'recade harness cases' });
    // install and verify work on a target: the workspace, or one code repository (found from where the command runs).
    const place = sub === 'install' || sub === 'verify' || sub === 'specialise' ? harnessPlace(io, { target: parsed.values['--target'], repo: parsed.values['--repo'] }) : null;
    if (place?.usage) return usage();
    if (place?.error) {
      io.stderr.write(`${place.error}\n`);
      return 1;
    }
    const root = place?.root ?? projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    if (sub === 'specialise') {
      // The text is read from a file the main session wrote (for example in the temp folder); the target is found like install.
      try {
        const text = readFileSync(resolve(io.invokedFrom ?? io.cwd, expandHome(parsed.values['--file'], io.env)), 'utf8');
        const done = specialise(root, parsed.positional[0], parsed.positional[1], text, { adopt: place.target === 'code' && isAdopt(place.workspace) });
        io.stdout.write(`${done.status} ${join(root, done.file)}\n`);
      } catch (err) {
        io.stderr.write(`${oneLine(err)}\n`);
        return err instanceof SpecialiseError || err?.code === 'ENOENT' || err?.name === 'AdoptError' ? 1 : 2;
      }
      return 0;
    }
    if (sub === 'install') {
      let result;
      try {
        result = install(root, { pluginRoot, target: place.target, workspace: place.workspace, force: parsed.flags.has('--force'), ref: parsed.values['--ref'], exec: io.run ?? runCommand, secondOpinion: projectSecondOpinion(join(root, '.claude', 'agents'), io) });
      } catch (err) {
        io.stderr.write(`${oneLine(err)}\n`);
        return err instanceof InstallError ? 1 : 2;
      }
      io.stdout.write(formatInstall(result));
      return 0;
    }
    if (sub === 'set') {
      const gates = parsed.values['--required-gates'];
      const wip = parsed.values['--wip-limit'];
      const thresholds = parsed.values['--threshold-files'];
      if (gates === undefined && wip === undefined && thresholds === undefined) return usage();
      const names = gates === undefined ? undefined : gates === 'none' ? [] : gates.split(',').map((n) => n.trim()).filter(Boolean);
      if (names !== undefined && ((gates !== 'none' && names.length === 0) || !names.every(isGateName))) {
        io.stderr.write('Gate names use letters, digits, dot, dash and underscore, separated by commas, or "none".\n');
        return 2;
      }
      const files = thresholds === undefined ? undefined : thresholds === 'none' ? [] : thresholds.split(',').map((n) => n.trim()).filter(Boolean);
      if (files !== undefined && ((thresholds !== 'none' && files.length === 0) || !files.every((f) => THRESHOLD_PATH.test(f) && !f.split('/').includes('..')))) {
        io.stderr.write('Threshold files are paths relative to the repository, with no .. and no leading slash, separated by commas, or "none".\n');
        return 2;
      }
      if (wip !== undefined && !/^[1-9]$/.test(wip)) {
        io.stderr.write('The WIP limit is a number from 1 to 9.\n');
        return 2;
      }
      // Inside a code repository the gates and the threshold files are its own settings; the WIP limit is the project's.
      // The link is checked before anything is written: a wrong one stops the command (exit 1, recade repo sync).
      const found = workspaceOf(io.cwd);
      try {
        const step = await endStep(io, root, ['recade/state.yaml', 'recade/repos'], 'chore(recade): harness settings set', () => {
          const repoDir = found?.via === 'link' ? mainRepoOf(io.cwd) : null;
          const state = loadState(root);
          let shown;
          if (repoDir !== null && (names !== undefined || files !== undefined)) {
            writeRepoSettings(repoDir, { ...(names === undefined ? {} : { required_gates: names }), ...(files === undefined ? {} : { threshold_files: files }) }, { own: isAdopt(found.dir) });
            shown = readRepoSettings(repoDir);
            if (wip !== undefined) state.harness = { ...(state.harness ?? {}), wip_limit: Number(wip) };
          } else {
            state.harness = { ...(state.harness ?? {}), ...(names === undefined ? {} : { required_gates: names }), ...(files === undefined ? {} : { threshold_files: files }), ...(wip === undefined ? {} : { wip_limit: Number(wip) }) };
            shown = state.harness;
          }
          if (wip !== undefined) saveState(root, state);
          else if (repoDir === null) saveState(root, state);
          io.stdout.write(`harness.required_gates: ${(shown.required_gates ?? []).join(', ') || 'none'}${repoDir === null ? '' : ` (${repoSettingsFile(repoDir) ?? REPO_SETTINGS})`}\nharness.threshold_files: ${(shown.threshold_files ?? []).join(', ') || 'none'}\nharness.wip_limit: ${state.harness?.wip_limit ?? `not set (default ${DEFAULT_MAX})`}\n`);
        });
        if (step.exit !== undefined) return step.exit;
      } catch (err) {
        io.stderr.write(`${oneLine(err)}\n`);
        return 2;
      }
      return 0;
    }
    if (sub === 'protect') {
      const refused = localForgeRefusal(root, '`recade harness protect`');
      if (refused !== null) {
        io.stderr.write(`${refused}\n`);
        return 1;
      }
      // Run from a code repository, it protects that repository with the strict rules, not the workspace.
      const where = workspaceOf(io.cwd);
      const codeDir = where?.via === 'link' ? mainRepoOf(io.cwd) : null;
      const result = protect(codeDir ?? root, { exec: io.run ?? runCommand, apply: parsed.flags.has('--apply'), branch: parsed.values['--branch'], code: codeDir === null ? null : { adopt: isAdopt(where.dir) } });
      if (result.error !== null) {
        io.stderr.write(`${result.error}\n`);
        return 1;
      }
      io.stdout.write(result.workspace
        ? `Branch ${result.branch} of ${result.repo} (the workspace): no pull request and no check required, no force push, no deletion, linear history.\n`
        : `Branch ${result.branch} of ${result.repo}: pull request required, checks required (${result.checks.join(', ')}), no force push, administrators included.\n`);
      io.stdout.write(result.applied ? 'Protection applied.\n' : `Nothing changed. To apply it, with the owner's agreement: recade harness protect --apply\n${result.command}\n`);
      return 0;
    }
    let result;
    try {
      result = await verify(root, { pluginRoot, target: place.target });
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
    io.stdout.write(formatVerify(result));
    return result.findings.some((f) => f.severity === 'error') ? 1 : 0;
  },
  async gate(args, io) {
    const [sub, ...rest] = args;
    const usage = () => {
      io.stderr.write(`${GATE_USAGE}\n`);
      return 2;
    };
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8' });
    if (top.status !== 0) {
      io.stderr.write('Not inside a git repository: a gate stamps the state of a git tree.\n');
      return 2;
    }
    const repo = top.stdout.trim();
    if (sub === 'run') {
      const sep = rest.indexOf('--');
      const name = rest[0];
      if (sep !== 1 || sep === rest.length - 1 || !isGateName(name)) return usage();
      const { code, stamp } = runGate(name, rest.slice(sep + 1), { repo });
      if (stamp.stale) {
        io.stdout.write(`${name}: stale (exit ${code}), the command changed the tree it ran on. Ignore build output in .gitignore or stop the command from editing tracked files, then run the gate again.\n`);
        return 1;
      }
      io.stdout.write(`${name}: ${code === 0 ? 'green' : 'red'} (exit ${code}) at ${stamp.fingerprint.head.slice(0, 7)}+${stamp.fingerprint.dirty}\n`);
      return code === 0 ? 0 : 1;
    }
    if (sub === 'check') {
      if (rest.length > 1 || (rest.length === 1 && !isGateName(rest[0]))) return usage();
      let names = rest;
      if (names.length === 0) {
        // The settings of the repository come first (a code repository of a workspace); else the state of the project.
        const own = repoSettingsOf(repo);
        if (own.error) {
          io.stderr.write(`${own.message}\n`);
          return 2;
        }
        let source = 'recade/state.yaml';
        if (own.required_gates !== undefined) {
          names = own.required_gates;
          source = repoSettingsFile(repo) ?? REPO_SETTINGS;
        } else {
          const root = projectRoot(io.cwd);
          let state = null;
          try {
            state = root === null ? null : loadState(root);
          } catch (err) {
            io.stderr.write(`${oneLine(err)}\n`);
            return 2;
          }
          const listed = state?.harness?.required_gates;
          names = Array.isArray(listed) ? listed : [];
        }
        const bad = names.filter((n) => !isGateName(n));
        if (bad.length > 0) {
          io.stderr.write(`Invalid gate name in harness.required_gates: ${bad.map((n) => JSON.stringify(n)).join(', ')}. Use letters, digits, dot, dash and underscore.\n`);
          return 2;
        }
        if (names.length === 0) {
          // Inside a code repository the gates are the repository's own: say where they are set, not the state of the workspace.
          if (source === 'recade/state.yaml' && workspaceOf(io.cwd)?.via === 'link') {
            io.stdout.write(`No required gates in ${repoSettingsFile(repo) ?? REPO_SETTINGS} (harness.required_gates). Set them with: recade harness set --required-gates <a,b>\n`);
          } else io.stdout.write(`No required gates in ${source} (harness.required_gates).\n`);
          return 0;
        }
      }
      let ok = true;
      for (const name of names) {
        const status = checkGate(name, { repo });
        io.stdout.write(`${name}: ${status}\n`);
        if (status !== 'green') ok = false;
      }
      if (!ok) io.stderr.write('A gate is not green for the current tree. Run: recade gate run <name> -- <command...>\n');
      return ok ? 0 : 1;
    }
    return usage();
  },
  async parallel(args, io) {
    const options = parseParallelArgs(args.slice(1));
    if (args[0] !== 'plan' || options === null) {
      io.stderr.write(`${PARALLEL_USAGE}\n`);
      return 2;
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    let plan;
    try {
      const limit = loadState(root)?.harness?.wip_limit;
      plan = explainParallel(root, { max: options.maxGiven || !Number.isInteger(limit) || limit < 1 ? options.max : limit });
    } catch (err) {
      io.stderr.write(`Cannot read ${root}/slices: ${oneLine(err)}\n`);
      return 2;
    }
    if (options.json) {
      io.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      return 0;
    }
    if (plan.picked.length === 0) io.stdout.write('No slice can start now: none is todo with its dependencies done and a scope free of the others.\n');
    else {
      io.stdout.write(`Start now (${plan.picked.length}):\n`);
      for (const p of plan.picked) io.stdout.write(`  ${p.slice}: ${p.reason}\n`);
      if (plan.picked.length < 3) io.stdout.write('Fewer than 3 slices can run together right now.\n');
    }
    if (plan.deferred.length > 0) {
      io.stdout.write('Wait:\n');
      for (const d of plan.deferred) io.stdout.write(`  ${d.slice}: ${d.reason}\n`);
    }
    return 0;
  },
  async conflicts(args, io) {
    const options = parseConflictsArgs(args.slice(1));
    if (args[0] !== 'check' || options === null) {
      io.stderr.write(`${CONFLICTS_USAGE}\n`);
      return 2;
    }
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8' });
    if (top.error || top.status !== 0) {
      io.stderr.write('Not a git repository. Run this from the repository folder.\n');
      return 1;
    }
    const repo = top.stdout.trim();
    // Run from the workspace itself, the check covers every code repository. From a code repository (or a CI checkout)
    // it covers that repository only.
    let ws = null;
    try {
      const found = workspaceOf(io.cwd);
      if (found?.via === 'self' && listRepos(found.dir).length > 0) ws = found.dir;
    } catch { /* a link that is not good: the repository is checked on its own */ }
    let result;
    try {
      if (ws !== null) result = inspectWorkspaceConflicts(ws, { base: options.explicitBase ? options.base : undefined, branches: options.branches });
      else {
        const branches = options.branches ?? listSliceBranches(repo);
        result = inspectConflicts(repo, { base: options.base, branches });
      }
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
    for (const name of result.skipped) io.stderr.write(`Skipped ${name}: no such branch here, locally or on origin.\n`);
    if (result.conflicts.length === 0) {
      const n = result.checked.length;
      io.stdout.write(`No conflicts: ${n} branch${n === 1 ? '' : 'es'} checked against each other and against ${ws !== null && !options.explicitBase ? 'the default branch of their repository' : options.base}.\n`);
      return 0;
    }
    for (const c of result.conflicts) io.stdout.write(`${c.a} and ${c.b} conflict on: ${c.files.join(', ')}\n`);
    io.stderr.write(`${result.conflicts.length} conflict${result.conflicts.length === 1 ? '' : 's'}. Rebase the branch on ${ws !== null && !options.explicitBase ? 'the default branch of its repository' : options.base}, or run the slices one after the other.\n`);
    return 1;
  },
  async 'merge-order'(args, io) {
    let json = false;
    let base;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--json') json = true;
      else if (args[i] === '--base' && BRANCH_NAME.test(args[i + 1] ?? '')) base = args[++i];
      else {
        io.stderr.write(`${MERGE_ORDER_USAGE}\n`);
        return 2;
      }
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    let order;
    try {
      order = mergeOrder(root, { exec: io.run ?? runCommand, base });
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
    if (json) {
      io.stdout.write(`${JSON.stringify(order, null, 2)}\n`);
      return 0;
    }
    if (order.length === 0) {
      io.stdout.write(`No open ${forgeOf(loadState(root)) === 'local' ? 'review request' : 'pull request'} to order against ${base ?? 'the default branch'}.\n`);
      return 0;
    }
    const ready = order.filter((o) => !o.waiting);
    const waiting = order.filter((o) => o.waiting);
    io.stdout.write(`Merge order (${ready.length} open pull request${ready.length === 1 ? '' : 's'}, ${waiting.length} waiting):\n`);
    // On the local forge an entry is a slice branch with its review request, not a numbered pull request.
    const name = (o) => `${o.repo === undefined ? '' : `${o.repo} `}${o.branch === undefined ? `#${o.pr}` : o.branch}`;
    ready.forEach((o, i) => io.stdout.write(`  ${i + 1}. ${name(o)} ${o.reason}\n`));
    if (waiting.length > 0) {
      io.stdout.write('Waiting:\n');
      for (const o of waiting) io.stdout.write(`  ${name(o)} ${o.reason}\n`);
    }
    return 0;
  },
  async cost(args, io) {
    if (args[0] === 'estimate') return costEstimate(args.slice(1), io);
    const options = args[0] === 'record' ? parseCostArgs(args.slice(1)) : null;
    if (options === null) {
      io.stderr.write(`${COST_USAGE}\n`);
      return 2;
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    let tokens = options.tokens === undefined ? '' : `, ${options.tokens} tokens`;
    const cost = { slice: options.slice, minutes: options.minutes, fixLoops: options.fixLoops, tokens: options.tokens };
    if (options.transcript !== undefined) {
      const home = io.env?.HOME ?? io.env?.USERPROFILE;
      const configDir = io.env?.CLAUDE_CONFIG_DIR ?? (home === undefined ? undefined : join(home, '.claude'));
      // The window of this record starts at the later of --since and the previous record of the slice, so that the
      // tokens of the records add up without counting anything twice.
      const previous = Date.parse(readCost(root).bySlice.get(options.slice)?.lastAt ?? '');
      const start = Math.max(options.since ?? 0, Number.isFinite(previous) ? previous : 0);
      const since = start > 0 ? start : undefined;
      let path = options.transcript;
      let failure = null;
      if (path === 'auto') {
        // The session lives under the folder it was started in (the worktree of a slice), not under --project.
        const sessionDir = options.sessionDir === undefined ? (io.invokedFrom ?? io.cwd) : resolve(io.invokedFrom ?? io.cwd, options.sessionDir);
        const found = findTranscripts(sessionDir, { ...(configDir === undefined ? {} : { configDir }), ...(since === undefined ? {} : { since }) });
        const when = since === undefined ? 'ever' : `since ${new Date(since).toISOString()}`;
        if (found.length === 0) failure = `no session file written ${when} for ${sessionDir}`;
        else if (found.length > 1) failure = `${found.length} sessions were written ${when}: ${found.slice(0, 5).map((f) => f.file.split(/[\\/]/).pop()).join(', ')}${found.length > 5 ? ', ...' : ''}; pass --transcript <path> to choose`;
        else path = found[0].file;
      }
      const read = failure !== null ? { ok: false, reason: failure } : readTranscriptUsage(path, since === undefined ? {} : { since });
      if (read.ok) {
        cost.tokens = read.tokens;
        cost.usage = read.rows;
        const agents = new Set(read.rows.map((r) => r.agent)).size;
        tokens = `, ${read.tokens} tokens (${plural(agents, 'agent')})`;
      } else {
        tokens = `, tokens: not recorded (${read.reason})`;
      }
    }
    try {
      recordCost(root, cost, io.now === undefined ? {} : { now: io.now });
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
    io.stdout.write(`Recorded ${options.slice}: ${options.minutes} min, ${options.fixLoops} FIX loop${options.fixLoops === 1 ? '' : 's'}${tokens}.\n`);
    return 0;
  },
  async retro(args, io) {
    const options = parseRetroArgs(args);
    if (options === null) {
      io.stderr.write(`${RETRO_USAGE}\n`);
      return 2;
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    let result;
    try {
      const step = await endStep(io, root, [`retros/${options.inc}.md`], `docs(retros): ${options.inc} written`,
        () => retro(root, options.inc, { exec: io.run ?? runCommand, base: options.base, force: options.force }));
      if (step.exit !== undefined) return step.exit;
      result = step.value;
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return err instanceof RetroInputError ? 1 : 2;
    }
    if (options.json) {
      io.stdout.write(`${JSON.stringify({ file: result.file, metrics: result.metrics, cost: { recorded: result.recorded, missing: result.missing } }, null, 2)}\n`);
      return 0;
    }
    io.stdout.write(`Wrote retros/${options.inc}.md\n`);
    for (const [name, value] of Object.entries(result.values)) io.stdout.write(`${name}: ${value}\n`);
    if (result.firstSlice !== null) io.stdout.write(`First slice: ${result.firstSlice}\n`);
    io.stdout.write(`Cost: ${result.recorded} slice${result.recorded === 1 ? '' : 's'} with a record, ${result.missing} without.\n`);
    return 0;
  },
  async quarantine(args, io) {
    const parsed = parseQuarantineArgs(args);
    if (parsed === null) {
      io.stderr.write(`${QUARANTINE_USAGE}\n`);
      return 2;
    }
    const scope = quarantineScope(io, parsed);
    if (scope.message !== undefined) {
      io.stderr.write(`${scope.message}\n`);
      return scope.exit;
    }
    const { root, dir } = scope;
    const where = scope.repo === undefined ? 'tests/quarantine.json' : `tests/quarantine.json of ${scope.repo}`;
    try {
      if (parsed.sub === 'add') {
        const entry = addQuarantine(root, parsed, { dir });
        io.stdout.write(`Quarantined "${entry.test}" (${entry.slice}, since ${entry.since}) in ${where}. Commit that file${scope.repo === undefined ? '' : ` in ${scope.repo}`}. The blocking jobs must skip the test, and CI runs it in the non-blocking quarantine job. Fix it before its increment closes.\n`);
      } else if (parsed.sub === 'remove') {
        const entry = removeQuarantine(dir, parsed.test);
        io.stdout.write(`Removed "${entry.test}" from ${where}. Commit that file${scope.repo === undefined ? '' : ` in ${scope.repo}`}.\n`);
      } else if (parsed.sub === 'list') {
        const entries = listQuarantine(dir);
        if (parsed.format === 'json') io.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
        else if (parsed.format === 'names') for (const e of entries) io.stdout.write(`${e.test}\n`);
        else if (entries.length === 0) io.stdout.write('No test is quarantined.\n');
        else for (const e of entries) io.stdout.write(`- ${e.test} (${e.slice}, since ${e.since}): ${e.reason}\n`);
      } else {
        const result = checkQuarantine(root, { inc: parsed.inc, dir });
        if (result.standalone) {
          io.stdout.write(`${plural(result.count, 'quarantined test')}. No workspace here, so no increment is judged: /retro judges them in the workspace.\n`);
          return 0;
        }
        if (!result.ok) {
          io.stderr.write(`${plural(result.expired.length, 'quarantined test')} outlive${result.expired.length === 1 ? 's' : ''} the increment. Fix each one and run recade quarantine remove, or move it with a new decision.\n`);
          for (const e of result.expired) io.stderr.write(`- ${e.test} (${e.slice}, since ${e.since}): ${e.why}\n`);
          return 1;
        }
        io.stdout.write(`${plural(result.count, 'quarantined test')}, none past its increment${result.current === null ? '' : ` (${result.current})`}.\n`);
      }
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return err instanceof QuarantineInputError ? 1 : 2;
    }
    return 0;
  },
  async 'release-notes'(args, io) {
    const options = parseReleaseNotesArgs(args);
    if (options === null) {
      io.stderr.write(`${RELEASE_NOTES_USAGE}\n`);
      return 2;
    }
    let section;
    try {
      section = releaseNotes(io.cwd, options.range, { exec: io.run ?? runCommand, version: options.version });
      if (options.write) prependChangelog(io.cwd, section);
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return err instanceof ReleaseNotesInputError ? 1 : 2;
    }
    io.stdout.write(options.write ? `Wrote CHANGELOG.md\n${section}` : section);
    return 0;
  },
  async board(args, io) {
    const [sub, ...rest] = args;
    const parsed = ['reconcile', 'cleanup'].includes(sub) ? parseBoardArgs(sub, rest) : null;
    if (parsed === null) {
      io.stderr.write(`${BOARD_USAGE}\n`);
      return 2;
    }
    const { apply, allowIgnored } = parsed;
    const exec = io.run ?? runCommand;
    if (sub === 'reconcile') {
      const root = projectRoot(io.cwd);
      if (root === null) {
        io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
        return 1;
      }
      let result;
      if (apply) {
        // Gather and write to the board first (gh calls, no lock); then the lock, STATUS.md and the commit. Refusals come
        // before the first gh write.
        // A slice across code repositories also gets `merged:` in its sheet: a read-only pass says which sheets, so that
        // the refusals cover them too.
        const plan = reconcile(root, { exec });
        const before = await preflightStep(io, root, ['slices/STATUS.md', ...plan.writes]);
        if (before.exit !== undefined) return before.exit;
        // Whether the day of the first slice can be recorded is settled here, before the first gh write: an uncommitted
        // change of the state that is not ours skips it, and never refuses the moves after the board has moved.
        const due = firstSliceDue(root);
        const free = due && await firstSliceFree(io, root, { notice: false });
        result = reconcile(root, { exec, apply, deferStatus: true });
        if (result.deferred.length > 0) {
          const sheets = [...new Set(result.deferred.map((d) => d.sheet?.file).filter((f) => f !== undefined))];
          const reaches = due && result.deferred.some((d) => d.to === 'done');
          if (reaches && !free) firstSliceSkipped(io);
          const first = reaches && free ? ['recade/state.yaml'] : [];
          const today = localDate((io.now ?? (() => new Date()))());
          const step = await endStep(io, root, ['slices/STATUS.md', ...sheets, ...first], sheets.length > 0 ? 'chore(board): reconcile slices' : 'chore(board): reconcile STATUS.md', async () => {
            // Checked again under the lock: the state may have been edited during the gh calls.
            const noteFirst = first.length > 0 && await firstSliceFree(io, root);
            return { errors: applyStatusMoves(root, result.deferred, { today, noteFirst }), noteFirst };
          }, { own: false, stage: (v) => ['slices/STATUS.md', ...sheets, ...(v.noteFirst ? first : [])] });
          if (step.exit !== undefined) return step.exit;
          result.errors.push(...step.value.errors);
        }
      } else {
        result = reconcile(root, { exec, apply });
      }
      io.stdout.write(formatReconcile(result));
      for (const e of result.errors) io.stderr.write(`${e}\n`);
      return result.errors.length > 0 ? 1 : 0;
    }
    const result = cleanup(io.cwd, { exec, apply, allowIgnored });
    if (result.errors.length > 0 && result.candidates.length === 0 && result.kept.length === 0 && result.removed.length === 0) {
      for (const e of result.errors) io.stderr.write(`${e}\n`);
      return 1;
    }
    io.stdout.write(formatCleanup(result));
    for (const e of result.errors) io.stderr.write(`${e}\n`);
    return result.errors.length > 0 ? 1 : 0;
  },
  async 'claude-md'(args, io) {
    const parsed = parseOptions(args.slice(1), { flags: ['--write'], values: ['--target', '--repo'] });
    if (args[0] !== 'refresh' || parsed.error || parsed.positional.length > 0) {
      io.stderr.write(`${CLAUDE_MD_USAGE}\n`);
      return 2;
    }
    const write = parsed.flags.has('--write');
    // The block of a code repository comes from its table of the workspace sheet; the workspace has its own shape.
    const place = harnessPlace(io, { target: parsed.values['--target'], repo: parsed.values['--repo'] });
    if (place.usage) {
      io.stderr.write(`${CLAUDE_MD_USAGE}\n`);
      return 2;
    }
    if (place.error) {
      io.stderr.write(`${place.error}\n`);
      return 1;
    }
    const root = place.root;
    if (place.target === 'code') {
      io.stdout.write('The CLAUDE.md of a code repository is the project\'s own: Recade does not write it. The commands and conventions of the repository are in the stack document of the workspace.\n');
      return 0;
    }
    let result;
    try {
      if (place.target === 'code') result = refreshClaudeMd(root, { stack: findStack(place.workspace)?.text ?? null, target: 'code', repo: basename(root) });
      else if (place.target === 'workspace') result = refreshClaudeMd(root, { stack: null, target: 'workspace' });
      else result = refreshClaudeMd(root, { state: loadState(root) });
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
    if (result.missing.length > 0) {
      io.stderr.write(`The harness tech sheet of ${place.target === 'code' ? 'the stack document of the workspace' : findStack(root)?.file ?? 'docs/STACK.md'} has no value for ${result.missing.join(', ')}: TODO lines were written. Fill the sheet, then refresh again.\n`);
    }
    if (result.diff === '') {
      io.stdout.write('CLAUDE.md is up to date.\n');
      return 0;
    }
    if (!write) {
      io.stdout.write(result.diff);
      io.stdout.write('Nothing written. Add --write to apply.\n');
      return 0;
    }
    try {
      writeFileSync(join(root, 'CLAUDE.md'), result.next);
    } catch (err) {
      io.stderr.write(`Cannot write CLAUDE.md: ${oneLine(err)}\n`);
      return 2;
    }
    io.stdout.write(result.diff);
    io.stdout.write('CLAUDE.md refreshed.\n');
    return 0;
  },
  async guard(args, io) {
    if (args[0] === 'snapshot' || args[0] === 'audit') {
      const { auditCommand } = await import('./harness/audit.js');
      return auditCommand(args, io, { pluginRoot: fileURLToPath(new URL('../', import.meta.url)) });
    }
    if (args.length > 0) {
      io.stderr.write('Usage: recade guard   (reads the PreToolUse hook JSON on stdin)\n');
      return 2;
    }
    let input = '';
    try {
      if (typeof io.readStdin === 'function') input = await io.readStdin();
      else for await (const chunk of process.stdin) input += chunk;
      const out = await handleHook(input, { cwd: io.cwd, pluginRoot: fileURLToPath(new URL('../', import.meta.url)) });
      if (out !== '') io.stdout.write(`${out}\n`);
    } catch (err) {
      logGuard(io.cwd, `guard error, call allowed: ${err.message}`);
    }
    return 0;
  },
  async inventory(args, io) {
    const parsed = parseOptions(args, { flags: ['--json'], values: [] });
    if (parsed.error || parsed.positional?.length !== 1 || parsed.positional[0] !== 'scan') {
      io.stderr.write(`${INVENTORY_USAGE}\n`);
      return 2;
    }
    try {
      const exec = io.exec ?? defaultExec;
      // At the root of a workspace every registered repository is scanned, one section each; anywhere else the folder is one repository.
      const atWorkspace = (() => {
        try {
          return loadState(io.cwd)?.kind === 'workspace';
        } catch {
          return false;
        }
      })();
      if (atWorkspace) {
        const inventory = await scanWorkspace(io.cwd, { exec });
        io.stdout.write(parsed.flags.has('--json') ? `${JSON.stringify(inventory, null, 2)}\n` : renderWorkspaceInventory(inventory));
        return 0;
      }
      const inventory = await scanInventory(io.cwd, { exec });
      io.stdout.write(parsed.flags.has('--json') ? `${JSON.stringify(inventory, null, 2)}\n` : renderInventory(inventory));
      return 0;
    } catch (err) {
      io.stderr.write(`${oneLine(err)}\n`);
      return 2;
    }
  },
  async adopt(args, io) {
    if (args[0] === 'board' || args[0] === 'from-code') return adoptPhase(args, io);
    // `--repo` and `--repo-name` come more than once: they are taken out before the other options are read.
    const repoArgs = [];
    const repoNames = [];
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      if ((args[i] === '--repo' || args[i] === '--repo-name') && args[0] === 'init') {
        if (i + 1 >= args.length) {
          io.stderr.write(`${ADOPT_USAGE}\n`);
          return 2;
        }
        (args[i] === '--repo' ? repoArgs : repoNames).push(args[++i]);
      } else rest.push(args[i]);
    }
    const parsed = parseOptions(rest, { flags: ['--full', '--json'], values: ['--default-branch', '--parent', '--name'] });
    const sub = parsed.positional?.[0];
    if (!parsed.error && sub === 'write' && parsed.positional.length === 2 && parsed.flags.size === 0 && Object.keys(parsed.values).length === 0) {
      // The one way an agent writes a file into an adopted repository: through the own-files policy, content on stdin.
      let content = '';
      try {
        if (typeof io.readStdin === 'function') content = await io.readStdin();
        else for await (const chunk of process.stdin) content += chunk;
        // The copies of the existing documents are made by `adopt from-code` only: byte for byte, with the index.
        if (/^(\.\/)?docs\/source(\/|$)/.test(parsed.positional[1].replace(/\/+/g, '/'))) {
          throw new AdoptError('Refused: docs/source/ holds the copies of the existing documents, which are only made by recade adopt from-code.');
        }
        // The documents go to the workspace, also when the command runs in one of its code repositories.
        const how = writeOwnFile(projectRoot(io.cwd) ?? io.cwd, parsed.positional[1], content);
        io.stdout.write(`${how === 'created' ? 'Created' : how === 'updated' ? 'Updated' : 'Unchanged'}: ${parsed.positional[1]}\n`);
        return 0;
      } catch (err) {
        io.stderr.write(`${oneLine(err)}\n`);
        return err instanceof AdoptError ? 1 : 2;
      }
    }
    const initOptions = sub === 'init' ? Object.keys(parsed.values).filter((k) => k !== '--default-branch') : [];
    const preflightOnly = sub === 'preflight' && (parsed.flags.has('--full') || ['--parent', '--name'].some((k) => k in parsed.values));
    if (parsed.error || !['init', 'preflight'].includes(sub) || parsed.positional.length !== 1 || preflightOnly
      || (sub === 'init' && (!('--parent' in parsed.values) || repoArgs.length === 0 || (repoNames.length > 0 && repoNames.length !== repoArgs.length)))
      || (sub === 'preflight' && (repoArgs.length > 0 || repoNames.length > 0)) || (sub === 'init' && initOptions.some((k) => !['--parent', '--name'].includes(k)))) {
      io.stderr.write(`${ADOPT_USAGE}\n`);
      return 2;
    }
    if (sub === 'preflight') {
      const check = await preflight(io.cwd, { exec: io.exec ?? defaultExec, defaultBranch: parsed.values['--default-branch'] });
      if (parsed.flags.has('--json')) io.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
      else if (check.ok) io.stdout.write(`Ready: no uncommitted work, on ${check.branch}${check.remote === null ? ', no remote' : `, everything pushed to ${check.remote}`}. Nothing was written.\n`);
      else io.stderr.write(`${check.reasons.join('\n')}\n`);
      return check.ok ? 0 : 1;
    }
    const loaded = readConfig(io);
    if (!loaded) return 2;
    const json = parsed.flags.has('--json');
    try {
      const from = io.invokedFrom ?? io.cwd;
      const exec = io.exec ?? defaultExec;
      const result = await initAdopt({
        parent: expandHome(parsed.values['--parent'], io.env), name: parsed.values['--name'], full: parsed.flags.has('--full'), defaultBranch: parsed.values['--default-branch'],
        repos: repoArgs.map((source, i) => ({ source, ...(repoNames[i] === undefined ? {} : { name: repoNames[i] }) })),
        cwd: from, exec: (cmd, cmdArgs, timeout) => exec(cmd, cmdArgs, timeout), config: loaded.config, pluginRoot: fileURLToPath(new URL('../', import.meta.url)),
      });
      if (json) {
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
      }
      io.stdout.write(`Created the workspace ${result.dir}\n`);
      for (const r of result.repos) {
        io.stdout.write(`${r.path} ${r.remote === 'none' ? 'cloned from its folder (no remote)' : `cloned from ${r.remote}`}; harness installed (${r.written} files written)\n`);
        if (r.kept.length > 0) io.stdout.write(`Kept as they are in ${r.name}: ${r.kept.join(', ')}\n`);
        for (const w of r.warnings) io.stdout.write(`Warning (${r.name}): ${w}\n`);
      }
      for (const w of result.warnings) io.stdout.write(`Warning: ${w}\n`);
      io.stdout.write(`Next action: ${normalizeState(loadState(result.dir)).next_action}\n`);
      return 0;
    } catch (err) {
      if (!(err instanceof AdoptError)) {
        io.stderr.write(`${oneLine(err)}\n`);
        return 2;
      }
      if (json) io.stdout.write(`${JSON.stringify({ ok: false, dirty: err.dirty, branch: err.branch, defaultBranch: err.defaultBranch, reasons: err.reasons, ...(err.needsDefaultBranch ? { needsDefaultBranch: true, candidates: err.candidates } : {}) }, null, 2)}\n`);
      else io.stderr.write(`${err.message}\n`);
      return 1;
    }
  },
  async github(args, io) {
    const [sub, ...rest] = args;
    let dryRun = false;
    let owner = null;
    let autoPush = false;
    const repos = [];
    const sync = sub === 'sync';
    let bad = sub !== 'init' && !sync;
    for (let i = 0; i < rest.length && !bad; i++) {
      if (rest[i] === '--dry-run') dryRun = true;
      else if (rest[i] === '--auto-push' && !sync) autoPush = true;
      else if (rest[i] === '--owner' && i + 1 < rest.length && !sync) owner = rest[++i];
      else if (rest[i] === '--repo' && i + 1 < rest.length && !rest[i + 1].startsWith('-') && !sync) repos.push(rest[++i]);
      else bad = true;
    }
    if (bad) {
      io.stderr.write(`${GITHUB_USAGE}\n`);
      return 2;
    }
    const root = projectRoot(io.cwd);
    if (root === null) {
      io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
      return 1;
    }
    if (sync) {
      // The sync keeps an existing board in line with the documents. A project that does not use GitHub has nothing to sync.
      const state = loadState(root);
      if (state?.forge !== undefined && state.forge !== 'github') {
        io.stdout.write(`This project does not use GitHub (forge: ${state.forge}), so there is nothing to sync.\n`);
        return 0;
      }
      if (typeof state?.github?.owner !== 'string' || !Number.isInteger(state?.github?.project_number)) {
        io.stderr.write('No board is recorded in recade/state.yaml. Run recade github init first.\n');
        return 1;
      }
    } else {
      const refused = localForgeRefusal(root, '`recade github init`');
      if (refused !== null) {
        io.stderr.write(`${refused}\n`);
        return 1;
      }
    }
    if (owner === null) {
      const recordedOwner = loadState(root)?.github?.owner;
      if (typeof recordedOwner === 'string' && recordedOwner !== '') owner = recordedOwner;
    }
    if (owner === null) {
      const loaded = readConfig(io);
      if (loaded === null) return 2;
      owner = loaded.config.github_owner ?? null;
    }
    if (typeof owner !== 'string' || owner === '') {
      io.stderr.write('No GitHub owner. Set it with: recade config set github_owner <name>, or pass --owner <name>.\n');
      return 2;
    }
    const exec = io.exec ?? ((cmd, cmdArgs) => defaultExec(cmd, cmdArgs, 120000));
    // gh calls take long: the refusals come first, the work runs outside the lock, then the state it recorded is committed.
    let result;
    if (dryRun || sync) result = await initGithub(root, { owner, exec, dryRun, repos, sync });
    else {
      // The owner's yes to auto-push is recorded with the workspace repository, as `recade workspace auto-push on` does.
      const step = await endStep(io, root, ['recade/state.yaml'], 'chore(recade): GitHub board recorded', async () => {
        const done = await initGithub(root, { owner, exec, dryRun, repos });
        if (autoPush && done.repo !== null && loadState(root)?.kind === 'workspace') saveState(root, withAutoPush(loadState(root), true, io));
        return done;
      }, { around: true });
      if (step.exit !== undefined) return step.exit;
      result = step.value;
    }
    if (dryRun) {
      io.stdout.write('Dry run: nothing is written. These calls would run:\n');
      for (const line of result.planned) io.stdout.write(`${line}\n`);
      if (autoPush) io.stdout.write('Then the workspace auto-push would be turned on (recade workspace auto-push on).\n');
      if (result.planned.length === 0 && result.error === null) io.stdout.write(sync ? 'Nothing to change: the board, the epics and the issues follow the documents.\n' : 'Nothing to create: the repository, the board and the issues exist.\n');
    } else {
      for (const line of result.created) io.stdout.write(`${sync ? 'Done' : 'Created'}: ${line}\n`);
    }
    for (const w of result.warnings) io.stderr.write(`Warning: ${w}\n`);
    if (result.error !== null) {
      io.stderr.write(`Stopped: ${result.error}\nRun the command again to continue where it stopped.\n`);
      return 1;
    }
    if (!dryRun && sync) io.stdout.write(`GitHub board in line with the documents: ${result.repo}, project ${result.project}. ${result.created.length} change${result.created.length === 1 ? '' : 's'}.\n`);
    else if (!dryRun) io.stdout.write(`GitHub board ready: ${result.repo}, project ${result.project}. ${result.created.length} object${result.created.length === 1 ? '' : 's'} created.\n`);
    return 0;
  },
  async index(args, io) {
    const [sub, ...rest] = args;
    if (sub !== 'build' && sub !== 'check') {
      io.stderr.write('Usage: recade index build|check [root] [--lots A,B]\n');
      return 2;
    }
    const opts = parseIndexArgs(rest);
    if (opts.error) {
      io.stderr.write(`${opts.error}\n`);
      return 2;
    }
    const root = resolve(io.cwd, opts.root ?? '.');
    let lots = opts.lots;
    if (lots === undefined) {
      try {
        lots = lotsFromState(root);
      } catch (err) {
        io.stderr.write(`${err.message}\n`);
        lots = [];
      }
    }
    let result;
    try {
      result = checkRoot(root, { lots });
    } catch (err) {
      io.stderr.write(`Cannot read ${root}: ${err.message}\n`);
      return 2;
    }
    const { index, findings } = result;
    if (sub === 'build') {
      try {
        writeFileSync(join(root, 'INDEX.md'), renderIndexMd(index.definitions));
      } catch (err) {
        io.stderr.write(`Cannot write INDEX.md: ${err.message}\n`);
        return 2;
      }
      io.stdout.write(`Wrote INDEX.md with ${index.definitions.length} IDs.\n`);
      const dups = findings.filter((f) => f.rule === 'duplicate-id');
      printFindings(dups, io);
      return dups.length > 0 ? 1 : 0;
    }
    printFindings(findings, io);
    return findings.some((f) => f.severity === 'error') ? 1 : 0;
  },
  async config(args, io) {
    const [sub, ...rest] = args;
    if (sub === 'path' && rest.length === 0) {
      try {
        io.stdout.write(`${configPath(io.env)}\n`);
      } catch (err) {
        io.stderr.write(`${err.message}\n`);
        return 1;
      }
      return 0;
    }
    if (sub === 'get' && rest.length <= 1) {
      const loaded = readConfig(io);
      if (!loaded) return 1;
      const { config, warnings } = loaded;
      for (const w of warnings) io.stderr.write(`${w}\n`);
      let value = config;
      if (rest.length === 1) {
        for (const part of rest[0].split('.')) {
          if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
            io.stderr.write(`Unknown key: ${rest[0]}\n`);
            return 2;
          }
          value = value[part];
        }
      }
      io.stdout.write(typeof value === 'object' && value !== null ? stringify(value) : `${value}\n`);
      return 0;
    }
    if (sub === 'set' && rest.length === 2) {
      const loaded = readConfig(io);
      if (!loaded) return 1;
      if (loaded.warnings.length > 0) {
        // Writing now would replace the user's file with defaults.
        io.stderr.write(`config.yaml is not valid YAML. Fix or delete ${configPath(io.env)}, then try again.\n`);
        return 1;
      }
      let next;
      try {
        next = setConfigValue(loaded.config, rest[0], rest[1]);
      } catch (err) {
        io.stderr.write(`${err.message}\n`);
        return 2;
      }
      try {
        saveConfig(next, io.env);
      } catch (err) {
        io.stderr.write(`Cannot write ${configPath(io.env)}: ${oneLine(err)}\n`);
        return 1;
      }
      return 0;
    }
    io.stderr.write('Usage: recade config path | get [key] | set <key> <value>\n');
    return 2;
  },
  async models(args, io) {
    const usage = 'Usage: recade models writer [--id] | mechanical [--effort]';
    const [which, ...flags] = args;
    if (which === 'mechanical') {
      if (flags.some((f) => f !== '--effort') || flags.length > 1) {
        io.stderr.write(`${usage}\n`);
        return 2;
      }
      // The mechanical tier of agents/models.json: the stages of MECHANICAL_STAGES run on it.
      const { mechanical } = JSON.parse(readFileSync(tiersUrl, 'utf8'));
      io.stdout.write(`${flags.length === 1 ? mechanical.effort : mechanical.model}\n`);
      return 0;
    }
    if (which !== 'writer' || flags.some((f) => f !== '--id') || flags.length > 1) {
      io.stderr.write(`${usage}\n`);
      return 2;
    }
    const loaded = readConfig(io);
    if (!loaded) return 1;
    for (const w of loaded.warnings) io.stderr.write(`${w}\n`);
    const choice = loaded.config.models?.writer;
    if (!isWriterChoice(choice)) {
      io.stderr.write(`models.writer is ${JSON.stringify(choice)} in ${configPath(io.env)}. Use ${WRITER_CHOICES.join(' or ')}: recade config set models.writer ${WRITER_CHOICES[0]}\n`);
      return 1;
    }
    io.stdout.write(`${flags.length === 1 ? WRITER_MODELS[choice] : choice}\n`);
    return 0;
  },
  async doctor(args, io) {
    if (args.some((a) => a !== '--json')) {
      io.stderr.write('Usage: recade doctor [--json]\n');
      return 2;
    }
    // `io.exec`, `io.readFile` and `io.nodeVersion` are optional test seams.
    const results = await runChecks({
      exec: io.exec ?? defaultExec,
      readFile: io.readFile ?? ((p) => readFileAsync(p, 'utf8')),
      env: io.env,
      nodeVersion: io.nodeVersion ?? process.versions.node,
    });
    if (args.includes('--json')) {
      io.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    } else {
      for (const c of results) {
        const tail = c.status !== 'ok' && c.fix ? `${c.detail ? `${c.detail}, ` : ''}fix: ${c.fix}` : c.detail;
        io.stdout.write(`${c.status.padEnd(8)}${c.id}${tail ? `  ${tail}` : ''}\n`);
      }
    }
    return results.some((c) => c.required && c.status === 'missing') ? 1 : 0;
  },
  async 'entry-mode'(args, io) {
    if (args.length > 1) {
      io.stderr.write('Usage: recade entry-mode [dir]\n');
      return 2;
    }
    io.stdout.write(`${detectEntryMode(resolve(io.cwd, args[0] ?? '.'))}\n`);
    return 0;
  },
  async render(args, io) {
    if (args[0] === 'extras') return renderExtrasCommand(args.slice(1), io);
    const opts = parseRenderArgs(args);
    if (opts.error) {
      io.stderr.write(`${opts.error}\n${RENDER_USAGE}\n`);
      return 2;
    }
    // Loaded here only: the other subcommands (and the Step 0 version probe) never touch the render dependencies.
    let pipeline;
    try {
      pipeline = await import('./render/pipeline.js');
    } catch (err) {
      io.stderr.write(`Cannot load the render engine: ${oneLine(err)}. Run: npm ci --omit=dev --prefix "${resolve(fileURLToPath(import.meta.url), '..', '..')}"\n`);
      return 1;
    }
    try {
      const { outputs, findings, stale } = await pipeline.renderFiles(opts.files, {
        formats: opts.formats, pdf: opts.formats ? false : pdfWanted(io), outDir: opts.out, check: opts.check, env: io.env, cwd: io.cwd,
        // Test seams, as for doctor.
        chromiumStatus: io.chromiumStatus ? () => io.chromiumStatus(io.env) : undefined,
        withBrowser: io.withBrowser,
      });
      printPlainFindings(findings, io);
      for (const file of outputs) io.stdout.write(`Wrote ${file}\n`);
      printLeftOver(stale, io);
      return 0;
    } catch (err) {
      printPlainFindings(err.findings ?? [], io);
      io.stderr.write(`${oneLine(err)}\n`);
      return err.exitCode ?? 1;
    }
  },
  async help(args, io) {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--markdown')) {
      io.stderr.write('Usage: recade help [--markdown]\n');
      return 2;
    }
    io.stdout.write(args[0] === '--markdown' ? renderHelpMarkdown() : renderHelp());
    return 0;
  },
  async hook(args, io) {
    if (args.length !== 1 || args[0] !== 'session-start') {
      io.stderr.write('Usage: recade hook session-start\n');
      return 2;
    }
    let text;
    try {
      text = readFileSync(configPath(io.env), 'utf8');
    } catch {
      // No config file, or unreadable: the user is not started.
    }
    const output = sessionStartOutput(text);
    if (output) io.stdout.write(`${output}\n`);
    return 0;
  },
  async 'guard-names'(args, io) {
    let listArg;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '--list') {
        listArg = args[++i];
        if (listArg === undefined) {
          io.stderr.write('Missing value for --list. Usage: recade guard-names [--list <file>]\n');
          return 2;
        }
      } else if (arg.startsWith('--list=')) {
        listArg = arg.slice('--list='.length);
      } else {
        io.stderr.write(`Unexpected argument: ${arg}. Usage: recade guard-names [--list <file>]\n`);
        return 2;
      }
    }
    let names;
    let listPath;
    if (listArg !== undefined) {
      listPath = resolve(io.cwd, expandHome(listArg, io.env));
      try {
        names = readFileSync(listPath, 'utf8').split(/\r?\n/).map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('#'));
      } catch (err) {
        io.stderr.write(`Cannot read name list ${listArg}: ${err.message}\n`);
        return 2;
      }
    } else if (io.env.RECADE_PRIVATE_NAMES) {
      names = io.env.RECADE_PRIVATE_NAMES.split(',').map((n) => n.trim()).filter(Boolean);
    }
    if (!names || names.length === 0) {
      io.stdout.write('No private name list; skipped.\n');
      return 0;
    }
    let files;
    try {
      files = listFiles(io.cwd, { exts: GUARD_EXTS })
        .filter((rel) => resolve(io.cwd, rel) !== listPath)
        .filter((rel) => !THIRD_PARTY(rel))
        .map((rel) => ({ path: rel, text: readFileSync(join(io.cwd, rel), 'utf8') }));
    } catch (err) {
      io.stderr.write(`Cannot scan ${io.cwd}: ${err.message}\n`);
      return 2;
    }
    const findings = scanForNames(files, names);
    for (const f of findings) {
      io.stdout.write(`${f.file}:${f.line}:${f.column} ${f.rule} ${f.message}\n`);
    }
    return findings.length > 0 ? 1 : 0;
  },
};

/** `recade decision team`: the register of what the team decided itself. */
async function decisionTeam(args, io, usage) {
  const [sub, ...rest] = args;
  if (!['add', 'list', 'challenge'].includes(sub)) return usage();
  const parsed = parseOptions(rest, sub === 'add' ? { flags: [], values: ['--doc', '--question', '--decided', '--why'] }
    : sub === 'challenge' ? { flags: ['--reopen'], values: ['--dec'] } : { flags: ['--json'], values: [] });
  if (parsed.error || parsed.positional.length !== (sub === 'challenge' ? 1 : 0)) return usage();
  if (sub === 'add' && ['--doc', '--question', '--decided', '--why'].some((k) => parsed.values[k] === undefined)) return usage();
  // A challenge names the DEC that replaces the line, or, for a line that closed a DEC, reopens that DEC for the owner.
  if (sub === 'challenge' && (parsed.values['--dec'] === undefined) === !parsed.flags.has('--reopen')) return usage();
  const root = projectRoot(io.cwd);
  if (root === null) {
    io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
    return 1;
  }
  const date = localDate((io.now ?? (() => new Date()))());
  try {
    if (sub === 'add') {
      const v = parsed.values;
      const step = await endStep(io, root, ['decisions/TEAM.md'], (id) => `docs(decisions): ${id} decided by the team`,
        () => addTeamDecision(root, { document: v['--doc'], question: v['--question'], decided: v['--decided'], why: v['--why'] }, { date }));
      if (step.exit !== undefined) return step.exit;
      io.stdout.write(`${step.value}\n`);
    } else if (sub === 'challenge' && parsed.flags.has('--reopen')) {
      const id = parsed.positional[0];
      const step = await endStep(io, root, ['decisions'], (r) => `docs(decisions): ${id} challenged, ${r.dec} reopens ${r.supersedes}`,
        () => reopenTeamDecision(root, id, { date }), { own: false, stage: (r) => ['decisions/TEAM.md', `decisions/${r.dec}.md`] });
      if (step.exit !== undefined) return step.exit;
      io.stdout.write(`${id} challenged: ${step.value.dec} reopens ${step.value.supersedes} for the owner.\n`);
    } else if (sub === 'challenge') {
      const id = parsed.positional[0];
      const dec = parsed.values['--dec'];
      const step = await endStep(io, root, ['decisions/TEAM.md'], `docs(decisions): ${id} challenged`,
        () => challengeTeamDecision(root, id, { dec, date }));
      if (step.exit !== undefined) return step.exit;
      io.stdout.write(`${id} challenged: ${dec} replaces it.\n`);
    } else {
      const list = listTeamDecisions(root);
      if (parsed.flags.has('--json')) io.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
      else for (const d of list) io.stdout.write(`${[d.id, d.status, d.document, d.question, d.decided, d.why, ...(d.dec === '' ? [] : [d.dec])].join('\t')}\n`);
    }
  } catch (err) {
    io.stderr.write(`${oneLine(err)}\n`);
    return 1;
  }
  return 0;
}

const DECISION_USAGE =
  'Usage: recade decision new --doc <D1|D2|D3|STACK|PLAN|BIBLE> --question <text> --why <text> --known <text> --unknown <text>'
  + ' --options <json: [{label, cost, closes, risks, calendar, repo}]> --recommendation <text> --change-mind <text> [--due YYYY-MM-DD]'
  + ' | close <DEC-nn> --choice <A|B|C|label> [--by team --why <text>] | list [--open] [--json]'
  + ' | team add --doc <document> --question <text> --decided <text> --why <text> | team list [--json] | team challenge <TD-nn> --dec <DEC-nn> | team challenge <TD-nn> --reopen'
  + ' (add --project <dir> to work on a project from another folder)';
const DOCS_USAGE = 'Usage: recade docs size [D1|D2|D3|PLAN|STACK|BIBLE ...] [--json] | budgets [--json] [--project <dir>]';
const TEAM_USAGE = 'Usage: recade team check [--project <dir>]';
const GATE_USAGE = "Usage: recade gate run '<name>' -- <command...> | recade gate check ['<name>']";
const NO_PROJECT = 'No Recade project here: recade/state.yaml not found. Run /recade:new first.';
/** A path of a threshold file as written in the settings of a repository: relative, plain characters. */
const THRESHOLD_PATH = /^[A-Za-z0-9._@+*][A-Za-z0-9._@+*/-]*$/;

/** The main repository of the git folder `dir` (a worktree gives the repository it belongs to), or null. */
function mainRepoOf(dir) {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const common = resolve(dir, r.stdout.trim());
  return basename(common) === '.git' ? dirname(common) : null;
}

/** The settings of the code repository that holds the git folder `top`: its own file, else the file of its main repository. */
function repoSettingsOf(top) {
  const own = readRepoSettings(top);
  if (own.error || own.required_gates !== undefined) return own;
  const main = mainRepoOf(top);
  return main !== null && main !== top ? readRepoSettings(main) : own;
}

/** Is the folder a workspace (`kind: workspace` in its state)? */
function isWorkspaceRoot(root) {
  try {
    return loadState(root)?.kind === 'workspace';
  } catch {
    return false;
  }
}

/**
 * Where a harness command works. `--target code` is one code repository: the one the command runs in, or `--repo <name>` of
 * the workspace. `--target workspace` is the workspace. With no target, inside a code repository of a workspace it is that
 * repository, at the root of a workspace it is the workspace target, and in a project that is not a workspace it is the
 * project as a whole (the harness of an older single-folder project).
 * @returns {{target?: 'workspace'|'code', root?: string, workspace?: string, usage?: true, error?: string}}
 */
function harnessPlace(io, { target, repo }) {
  if ((target !== undefined && !TARGET_NAMES.includes(target)) || (repo !== undefined && target !== 'code')) return { usage: true };
  // Checked: a link to another workspace, or none in a repository that belongs to one, throws (exit 1, recade repo sync).
  const found = workspaceOf(io.cwd);
  if (target === undefined && found?.via !== 'link') {
    const root = projectRoot(io.cwd);
    if (root === null) return { error: NO_PROJECT };
    // A workspace holds the project commands only: with no target it is the workspace target, never the whole harness
    // (the slice commands, the guard and the gates belong to the code repositories). A project that is not a workspace
    // (an older single-folder project) keeps the whole harness.
    return isWorkspaceRoot(root) ? { target: 'workspace', root } : { root };
  }
  if (target === 'workspace') {
    const root = projectRoot(io.cwd);
    return root === null ? { error: NO_PROJECT } : { target, root };
  }
  if (found === null) return { error: `No workspace found from here. Run it in the workspace or in a code repository linked to it (${SYNC_ADVICE}).` };
  let dir = null;
  if (repo !== undefined) {
    dir = REPO_NAME.test(repo) ? join(found.dir, 'repos', repo) : null;
    if (dir === null || !existsSync(join(dir, '.git'))) return { error: `No code repository ${repo} in ${join(found.dir, 'repos')}. Run: recade repo list` };
  } else if (found.via === 'link') {
    dir = mainRepoOf(io.cwd);
    if (dir === null) return { error: 'This folder is not in a git repository.' };
  } else return { error: 'Name the code repository: --repo <name>, or run the command from inside it.' };
  return { target: 'code', root: dir, workspace: found.dir };
}

const HARNESS_USAGE = 'Usage: recade harness models [--check] [--dir <agents folder>] [--second-opinion opus|fable] [--models <models.yaml>]'
  + ' | install [--ref <tag or commit>] [--force] [--target workspace|code] [--repo <name>]'
  + ' | verify [--target workspace|code] [--repo <name>] | cases [--run] [--agent <name>] | protect [--apply] [--branch <name>]'
  + ' | set [--required-gates <a,b>] [--threshold-files <a,b>] [--wip-limit <1-9>]'
  + ' | specialise <agent|command> <name> --file <path> [--target workspace|code] [--repo <name>]'
  + ' | migrate [--dry-run] (from the workspace: the old layout to the one entry point)'
  + ' | sync (from the workspace: update its harness to this plugin, set up this machine, and say what others pushed)'
  + ' (add --project <dir> to work on a project from another folder)';

/**
 * `recade harness migrate [--dry-run]`: move a workspace of the old layout to the one entry point (src/harness/migrate.js).
 * Run from the workspace. Exit 1 when something was refused or failed, so the owner reads the lines.
 */
/**
 * `recade harness sync`, run by the SessionStart hook of the plugin in a workspace. It never fails a session: every
 * problem is a line of its report, and the exit code is 0.
 * - The harness of the workspace follows the plugin: when the install record names another version, the workspace is
 *   installed again and the change is committed (`chore(harness): update to Recade v<x>`). Uncommitted changes of the
 *   owner in those files stop it, with a line that says so.
 * - This machine is set up: the plugin folder, the local git hooks and the exclusions, in the workspace and in each
 *   code repository, and the link of each repository to the workspace.
 * - What others pushed: each repository is fetched, and the new commits of its default branch by someone else, and
 *   its open pull requests that are not a slice, are listed.
 */
async function harnessSync(rest, io, { pluginRoot, usage }) {
  const parsed = parseOptions(rest, { flags: ['--no-fetch'], values: [] });
  if (parsed.error || parsed.positional.length > 0) return usage();
  const found = workspaceOf(io.cwd);
  if (found === null) return 0;
  const ws = found.dir;
  if (!existsSync(join(ws, INSTALL_RECORD))) return 0;
  const exec = io.run ?? runCommand;
  const lines = [];
  const version = pluginVersion(pluginRoot);
  let recorded = null;
  try {
    recorded = JSON.parse(readFileSync(join(ws, INSTALL_RECORD), 'utf8'))?.version ?? null;
  } catch { /* read as unknown */ }
  if (recorded !== version) {
    try {
      const paths = ['.claude', '.githooks', '.github', '.gitignore'];
      const changed = (r) => r.written.filter((w) => w.status !== 'unchanged' && w.status !== 'kept').map((w) => w.file);
      const step = await endStep(io, ws, paths, (r) => (changed(r).length === 0 && !readGit(ws, ['status', '--porcelain', '--', '.gitignore']) ? null : `chore(harness): update to Recade v${version}`), () => install(ws, { pluginRoot, target: 'workspace', exec, secondOpinion: projectSecondOpinion(join(ws, '.claude', 'agents'), io) }), {
        around: true,
        stage: (r) => [...changed(r), ...(existsSync(join(ws, '.gitignore')) ? ['.gitignore'] : [])],
      });
      if (step.exit !== undefined) lines.push(`The harness of the workspace was not updated to v${version}: the workspace has changes of its own in .claude, .githooks or .github. Commit them, then open a new session.`);
      else {
        lines.push(`The harness of the workspace follows Recade v${version} now${recorded === null ? '' : ` (it was v${recorded})`}.`);
        for (const w of step.value?.warnings ?? []) if (!/^No doctrine/.test(w)) lines.push(w);
      }
    } catch (err) {
      lines.push(`The harness of the workspace was not updated: ${oneLine(err)}`);
    }
  } else {
    try {
      for (const w of setupLocal(ws, { pluginRoot, target: 'workspace', exec }).warnings) lines.push(w);
    } catch (err) {
      lines.push(`This machine was not set up for the workspace: ${oneLine(err)}`);
    }
  }
  // The compact size of the project, on this machine too (a fresh clone has no local settings).
  try {
    const compact = loadState(ws)?.compact;
    if (typeof compact === 'number') {
      const done = applyCompact(ws, compact);
      if (done.error) lines.push(done.error);
    }
  } catch { /* the state is read again by the steps that need it */ }
  const repos = listRepos(ws).map((e) => String(e.name)).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n) && existsSync(join(ws, 'repos', n, '.git')));
  for (const name of repos) {
    const dir = join(ws, 'repos', name);
    try {
      for (const w of setupLocal(dir, { pluginRoot, target: 'code', exec, adopt: isAdopt(ws) }).warnings) lines.push(`${name}: ${w}`);
      linkRepo(ws, dir);
    } catch (err) {
      lines.push(`${name}: this machine was not set up: ${oneLine(err)}`);
    }
  }
  // The settings of a code repository an older install kept in it (`.claude/recade.yaml`) move to the workspace, so the
  // clean of the repository loses nothing.
  const carried = repos.filter((n) => existsSync(join(ws, 'repos', n, REPO_SETTINGS)) && !existsSync(join(ws, repoSettingsRel(n))));
  if (carried.length > 0) {
    try {
      const step = await endStep(io, ws, ['recade/repos'], 'chore(recade): settings of the code repositories kept in the workspace', () => {
        for (const n of carried) {
          mkdirSync(join(ws, 'recade', 'repos'), { recursive: true });
          writeFileSync(join(ws, repoSettingsRel(n)), readFileSync(join(ws, 'repos', n, REPO_SETTINGS), 'utf8'));
        }
      });
      if (step.exit === undefined) lines.push(`The settings of ${carried.join(', ')} (required gates, thresholds) are now kept in the workspace, in recade/repos/.`);
    } catch (err) {
      lines.push(`The settings of ${carried.join(', ')} were not moved to the workspace: ${oneLine(err)}`);
    }
  }
  if (!parsed.flags.has('--no-fetch')) lines.push(...othersWork(ws, repos));
  if (lines.length > 0) io.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

/** The output of a git command in `dir`, trimmed, or '' when it fails. */
function readGit(dir, args, timeout = 20_000) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout });
  return r.status === 0 ? String(r.stdout ?? '').trim() : '';
}

/**
 * What others pushed since the last session on this machine: for the workspace and each code repository, the new
 * commits of the default branch on origin by another author, and the open pull requests that are not slices. The last
 * commit seen is kept per machine in `.recade/seen.json`. The first run only records it.
 */
function othersWork(ws, repos) {
  const lines = [];
  const seenFile = join(ws, '.recade', 'seen.json');
  let seen = {};
  try {
    seen = JSON.parse(readFileSync(seenFile, 'utf8')) ?? {};
  } catch { /* first run */ }
  const me = readGit(ws, ['config', 'user.email']);
  for (const [label, dir] of [['workspace', ws], ...repos.map((n) => [n, join(ws, 'repos', n)])]) {
    if (readGit(dir, ['remote', 'get-url', 'origin']) === '') continue;
    readGit(dir, ['fetch', '--quiet', 'origin'], 30_000);
    const branch = (readGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) || 'origin/main').replace(/^origin\//, '');
    const head = readGit(dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]);
    if (head === '') continue;
    const last = seen[label];
    seen[label] = head;
    if (typeof last !== 'string' || last === head) continue;
    const log = readGit(dir, ['log', '--no-merges', '--format=%h%x09%ae%x09%an%x09%s', `${last}..${head}`]).split('\n').filter(Boolean)
      .map((l) => l.split('\t')).filter(([, email]) => email !== me);
    if (log.length > 0) {
      lines.push(`${label}: ${log.length} new commit${log.length === 1 ? '' : 's'} by others on ${branch}:`);
      for (const [sha, , author, subject] of log.slice(0, 5)) lines.push(`  ${sha} ${author}: ${subject}`);
      if (log.length > 5) lines.push(`  and ${log.length - 5} more.`);
    }
  }
  for (const name of repos) {
    const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,headRefName,author'], { cwd: join(ws, 'repos', name), encoding: 'utf8', timeout: 20_000 });
    if (r.status !== 0) continue;
    let prs = [];
    try {
      prs = JSON.parse(r.stdout).filter((p) => !String(p.headRefName).startsWith('slice/'));
    } catch { /* unreadable: nothing to say */ }
    if (prs.length > 0) {
      lines.push(`${name}: ${prs.length} open pull request${prs.length === 1 ? '' : 's'} that ${prs.length === 1 ? 'is' : 'are'} not a slice:`);
      for (const p of prs.slice(0, 5)) lines.push(`  #${p.number} ${p.author?.login ?? ''}: ${p.title}`);
    }
  }
  try {
    mkdirSync(join(ws, '.recade'), { recursive: true });
    writeFileSync(seenFile, `${JSON.stringify(seen, null, 2)}\n`);
  } catch { /* the next session lists again */ }
  return lines;
}

async function harnessMigrate(rest, io, { pluginRoot, usage }) {
  const parsed = parseOptions(rest, { flags: ['--dry-run'], values: ['--ref'] });
  if (parsed.error || parsed.positional.length > 0) return usage();
  const found = workspaceOf(io.cwd);
  if (found === null || found.via !== 'self') {
    io.stderr.write(`recade harness migrate runs from the workspace${found === null ? '' : ` (${found.dir})`}.\n`);
    return 1;
  }
  const { formatMigrate, migrate } = await import('./harness/migrate.js');
  let result;
  try {
    result = migrate(found.dir, { pluginRoot, dryRun: parsed.flags.has('--dry-run'), exec: io.run ?? runCommand, ref: parsed.values['--ref'], secondOpinion: projectSecondOpinion(join(found.dir, '.claude', 'agents'), io) });
  } catch (err) {
    io.stderr.write(`${oneLine(err)}\n`);
    return 2;
  }
  io.stdout.write(formatMigrate(result));
  return result.errors.length > 0 || result.moves.some((m) => m.status === 'refused') ? 1 : 0;
}

const CASES_USAGE = 'Usage: recade cases [--plugin] [--harness] [--run] [--agent <name>] [--project <dir>]';

/**
 * `recade cases` and `recade harness cases`: list the agent test cases, or replay them with `claude -p` (never in CI).
 * `tagged` prefixes each case with its set, because the two sets can both hold an agent of the same name.
 */
function casesCommand(parsed, io, { pluginRoot, sets, tagged, command }) {
  let loaded;
  try {
    loaded = loadCaseSets(pluginRoot, { sets, agent: parsed.values['--agent'] });
  } catch (err) {
    io.stderr.write(`${oneLine(err)}\n`);
    return 2;
  }
  const only = parsed.values['--agent'];
  const total = loaded.reduce((n, l) => n + l.cases.length, 0);
  if (total === 0) {
    io.stderr.write(only === undefined ? 'No agent test case found.\n' : `No test case for the agent ${only}.\n`);
    return 2;
  }
  const label = (set) => (tagged ? `[${set}] ` : '');
  if (!parsed.flags.has('--run')) {
    for (const { set, cases } of loaded) {
      for (const c of cases) io.stdout.write(`${label(set)}${c.agent}/${c.name}  expects ${c.verdict === 'none' ? 'no verdict' : c.verdict}\n`);
    }
    io.stdout.write(`${total} case${total === 1 ? '' : 's'}. Run them with: ${command} --run (it calls claude -p, outside CI).\n`);
    return 0;
  }
  if (io.env.CI) {
    io.stderr.write('The cases call claude -p, which costs tokens: they are not run in CI. Run them on your machine.\n');
    return 2;
  }
  const root = projectRoot(io.cwd);
  const installed = root === null ? null : join(root, '.claude', 'agents');
  const read = [];
  let failed = 0;
  for (const { set, cases } of loaded.filter((l) => l.cases.length > 0)) {
    // The harness agents are read from the project when the harness is installed there, so a specialised copy is tested.
    const agentsDir = set === 'harness' && installed !== null && existsSync(installed) ? installed : setPaths(pluginRoot, set).agentsDir;
    read.push(`${set} agents read from ${agentsDir}`);
    for (const r of runCases(cases, { agentsDir, exec: io.run ?? defaultRun })) {
      io.stdout.write(`${r.ok ? 'pass' : 'FAIL'} ${label(set)}${r.case.agent}/${r.case.name}${r.ok ? '' : `: ${r.reasons.join('; ')}`}\n`);
      if (!r.ok) failed++;
    }
  }
  if (tagged) io.stdout.write(`${total - failed} of ${total} cases passed.\n${read.join('\n')}\n`);
  else io.stdout.write(`${total - failed} of ${total} cases passed (${read[0].replace(/^harness a/, 'a')}).\n`);
  return failed > 0 ? 1 : 0;
}

/** The owner's second-opinion choice of the user config (`models.second_opinion`): `opus` when it is missing or not valid. */
function secondOpinionChoice(io) {
  try {
    const choice = loadConfig(io.env).config.models?.second_opinion;
    return isSecondOpinionChoice(choice) ? choice : 'opus';
  } catch {
    return 'opus';
  }
}

/**
 * The second-opinion choice of a project copy. Once installed, the copy is the source of truth, as `verify` reads it,
 * so that another machine with another user config agrees. The user config is only the default of a first install.
 */
function projectSecondOpinion(agentsDir, io) {
  return existsSync(join(agentsDir, 'second-opinion.md')) ? secondOpinionOf(agentsDir) : secondOpinionChoice(io);
}

/** `recade harness models`: write the model and effort of models.yaml into the agent files, or check them. */
function harnessModels(args, io, usage) {
  const parsed = parseOptions(args, { flags: ['--check'], values: ['--dir', '--models', '--second-opinion'] });
  if (parsed.error || parsed.positional.length > 0 || Object.values(parsed.values).some((v) => v.startsWith('--'))) return usage();
  const check = parsed.flags.has('--check');
  const given = parsed.values['--second-opinion'];
  if (given !== undefined && (!isSecondOpinionChoice(given) || check || parsed.values['--dir'] === undefined)) return usage();
  const harnessDir = fileURLToPath(new URL('../harness/', import.meta.url));
  const dir = parsed.values['--dir'] === undefined ? join(harnessDir, 'agents') : resolve(io.cwd, expandHome(parsed.values['--dir'], io.env));
  const modelsFile = parsed.values['--models'] === undefined ? join(harnessDir, 'models.yaml') : resolve(io.cwd, expandHome(parsed.values['--models'], io.env));
  let changed;
  let models;
  try {
    // A project copy (--dir) keeps its own second-opinion choice, or takes the one given; the plugin's own agents keep the table as it is.
    models = parsed.values['--dir'] === undefined ? loadModels(modelsFile) : withSecondOpinion(loadModels(modelsFile), given ?? projectSecondOpinion(dir, io));
    ({ changed } = syncAgents(dir, models, { check }));
  } catch (err) {
    io.stderr.write(`${err.message}\n`);
    return 2;
  }
  for (const w of modelWarnings(models)) io.stderr.write(`Warning: ${w}.\n`);
  // The agents /slice dispatches with other values in the sensitive lane: the same values the front matter holds.
  for (const s of sensitiveLane(models)) io.stdout.write(`Sensitive lane: ${s.agent} model ${s.model} effort ${s.effort}.\n`);
  if (changed.length === 0) {
    io.stdout.write('Agent models are in sync.\n');
    return 0;
  }
  if (check) {
    const again = parsed.values['--dir'] === undefined ? 'recade harness models' : `recade harness models --dir ${shellQuote(parsed.values['--dir'])}`;
    io.stderr.write(`Agents out of sync with models.yaml: ${changed.join(', ')}. Run: ${again}\n`);
    if (parsed.values['--dir'] !== undefined) io.stderr.write(`It keeps the second-opinion model of this project. To change it for the project, run: ${again} --second-opinion opus (or fable), then commit .claude/agents.\n`);
    return 1;
  }
  io.stdout.write(`Updated: ${changed.join(', ')}\n`);
  return 0;
}
const PARALLEL_USAGE = 'Usage: recade parallel plan [--max <n>] [--json] [--project <dir>]';
const BOARD_USAGE = 'Usage: recade board reconcile [--apply] [--project <dir>] | recade board cleanup [--apply] [--allow-ignored <path>]...';

/** `[--apply]`, and for `cleanup` any number of `--allow-ignored <path>` (a path inside the worktree). Null when the arguments do not have that shape. */
function parseBoardArgs(sub, rest) {
  const out = { apply: false, allowIgnored: [] };
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i + 1];
    if (rest[i] === '--apply' && !out.apply) out.apply = true;
    else if (sub === 'cleanup' && rest[i] === '--allow-ignored' && typeof value === 'string' && /^[^-\s][^\0]*$/.test(value) && !value.split('/').includes('..') && !value.startsWith('/')) {
      out.allowIgnored.push(value.replace(/\/$/, ''));
      i++;
    } else return null;
  }
  return out;
}
const COST_USAGE = 'Usage: recade cost record <S-nn> --minutes <n> --fix-loops <n> [--tokens <n> | --transcript <path|auto> [--since <epoch ms>] [--session-dir <dir>]] [--project <dir>]'
  + ' | recade cost estimate [--phase intake|team|docs|bible|slices|next|harness | --slice standard|sensitive] [--json] [--project <dir>]';
const COST_ESTIMATE_USAGE = 'Usage: recade cost estimate [--phase intake|team|docs|bible|slices|next|harness | --slice standard|sensitive] [--json] [--project <dir>]';

/** The plugin's two model tables: the tiers of the framing agents and the harness lanes. */
const tiersUrl = new URL('../agents/models.json', import.meta.url);
const harnessModelsUrl = new URL('../harness/models.yaml', import.meta.url);

/**
 * `recade cost estimate`: the cost of the phases not passed yet (or of one phase), or of the delivery of one slice.
 * It prints an estimate, never a measure: `recade cost record` measures a slice.
 */
function costEstimate(args, io) {
  const usage = () => {
    io.stderr.write(`${COST_ESTIMATE_USAGE}\n`);
    return 2;
  };
  const parsed = parseOptions(args, { flags: ['--json'], values: ['--phase', '--slice'] });
  if (parsed.error || parsed.positional.length > 0) return usage();
  const phase = parsed.values['--phase'];
  const lane = parsed.values['--slice'];
  if (phase !== undefined && lane !== undefined) return usage();
  if (phase !== undefined && !ESTIMATE_IDS.includes(phase)) return usage();
  if (lane !== undefined && !SLICE_LANES.includes(lane)) return usage();
  const json = parsed.flags.has('--json');
  const loaded = readConfig(io);
  if (!loaded) return 1;
  const writer = loaded.config.models?.writer;
  if (!isWriterChoice(writer)) {
    io.stderr.write(`models.writer is ${JSON.stringify(writer)} in ${configPath(io.env)}. Use ${WRITER_CHOICES.join(' or ')}: recade config set models.writer ${WRITER_CHOICES[0]}\n`);
    return 1;
  }
  const root = projectRoot(io.cwd);
  let result;
  try {
    const state = root === null ? null : normalizeState(loadState(root));
    if (lane !== undefined) {
      result = estimateSlice(lane, { harnessModels: withSecondOpinion(loadModels(fileURLToPath(harnessModelsUrl)), root === null ? loaded.config.models?.second_opinion : projectSecondOpinion(join(root, '.claude', 'agents'), io)), secondOpinion: state?.second_opinion });
    } else {
      if (root === null) {
        io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
        return 1;
      }
      const tiers = JSON.parse(readFileSync(tiersUrl, 'utf8'));
      const facts = projectFacts(root, state, loaded.config.languages);
      result = estimatePhases(facts, state, { writer, tiers, ...(phase === undefined ? {} : { phases: [phase] }) });
    }
  } catch (err) {
    io.stderr.write(`${oneLine(err)}\n`);
    return 2;
  }
  if (json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const tail = 'API prices; on a Claude subscription it counts against your usage limits instead.';
  if (lane !== undefined) {
    io.stdout.write(`Estimated cost of one ${lane} slice: ${formatRange(result)} (${tail})\n`);
    io.stdout.write(`An estimate, not a measure: ${result.prices}. recade cost record measures a slice.\n`);
    return 0;
  }
  if (result.phases.length === 0) {
    io.stdout.write('Every phase is passed: nothing to estimate. For the delivery of a slice: recade cost estimate --slice standard\n');
    return 0;
  }
  if (phase !== undefined) {
    io.stdout.write(`Estimated cost of this phase: ${formatRange(result.phases[0])} (${tail})\n`);
    // The progress line of each step reads its usual time from this line.
    if (result.phases[0].steps !== undefined) io.stdout.write(`Usual time of each step: ${formatSteps(result.phases[0].steps)}.\n`);
  } else {
    for (const p of result.phases) io.stdout.write(`${p.name}: ${formatRange(p)}\n`);
    io.stdout.write(`Total: ${formatRange(result.total)} (${tail})\n`);
  }
  io.stdout.write(`An estimate, not a measure: ${result.prices}, writing model ${writer}. The durations scale from a measured short-track framing.\n`);
  return 0;
}
const RETRO_USAGE = 'Usage: recade retro <INC-n> [--force] [--json] [--base <branch>] [--project <dir>]';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const QUARANTINE_USAGE = 'Usage: recade quarantine add <test> --reason <text> --slice <S-nn> [--since YYYY-MM-DD] | remove <test> | list [--json|--names] | check [--inc INC-n]'
  + ' [--repo <name>] [--project <dir>]  (in a code repository the list is the one of that repository, from the workspace name it with --repo)';

/**
 * Where `recade quarantine` works (spec 6.11: the list is per code repository). In a code repository, or one of its
 * worktrees, it is the `tests/quarantine.json` of that checkout, and the sheets are the ones of the workspace. From the workspace
 * a repository is named with `--repo`. In a project that is not split, it is the project folder as before. A checkout whose
 * link cannot be read (a CI run of a code repository) can still be listed and checked, with no increment judged.
 * @returns {{root: string|null, dir: string, repo?: string}|{message: string, exit: number}}
 */
function quarantineScope(io, parsed) {
  const readOnly = parsed.sub === 'list' || parsed.sub === 'check';
  const topOut = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: io.cwd, encoding: 'utf8' });
  const top = topOut.status === 0 ? topOut.stdout.trim() : null;
  let found;
  try {
    found = workspaceOf(io.cwd);
  } catch (err) {
    if (err?.code !== 'RECADE_LINK' || !readOnly || parsed.repo !== undefined) throw err;
    return { root: null, dir: top ?? io.cwd };
  }
  if (found?.via === 'self') {
    if (parsed.repo === undefined) return { message: 'Name the code repository: --repo <name>. Each code repository has its own tests/quarantine.json (recade repo list shows them).', exit: 2 };
    const dir = join(found.dir, 'repos', parsed.repo);
    if (!listRepos(found.dir).some((r) => r.name === parsed.repo) || !existsSync(join(dir, '.git'))) return { message: `No code repository ${parsed.repo} in ${join(found.dir, 'repos')}. Run: recade repo list`, exit: 1 };
    return { root: found.dir, dir, repo: parsed.repo };
  }
  if (found?.via === 'link') {
    const main = top === null ? null : mainRepoOf(top);
    if (top === null || main === null) return { message: 'This folder is not in a git repository.', exit: 1 };
    const repo = basename(main);
    if (parsed.repo !== undefined && parsed.repo !== repo) return { message: `This folder is the repository ${repo}, not ${parsed.repo}. Run the command from the workspace to name another repository.`, exit: 2 };
    return { root: found.dir, dir: top, repo };
  }
  if (parsed.repo !== undefined) return { message: '--repo names a code repository of a workspace, and this project has none.', exit: 2 };
  const root = projectRoot(io.cwd);
  if (root === null) {
    if (readOnly && top !== null) return { root: null, dir: top };
    return { message: 'No Recade project here: recade/state.yaml not found. Run /recade:new first.', exit: 1 };
  }
  return { root, dir: root };
}
const RELEASE_NOTES_USAGE = 'Usage: recade release-notes <from>..<to> [--version <v>] [--write] [--project <dir>]';
const MERGE_ORDER_USAGE = 'Usage: recade merge-order [--json] [--base <branch>] [--project <dir>]';
const CONFLICTS_USAGE = 'Usage: recade conflicts check [--base <branch>] [--branches <a,b,c>]';
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** `<S-nn> --minutes <n> --fix-loops <n> [--tokens <n>]`, or null when the arguments do not have that shape. */
function parseCostArgs(rest) {
  const [slice, ...flags] = rest;
  if (!/^S-\d{2}[a-z]?$/.test(slice ?? '')) return null;
  const out = { slice };
  const keys = { '--minutes': 'minutes', '--fix-loops': 'fixLoops', '--tokens': 'tokens' };
  for (let i = 0; i < flags.length; i += 2) {
    const value = flags[i + 1] ?? '';
    if (flags[i] === '--transcript' && out.transcript === undefined && /^[^\0\s-][^\0]*$/.test(value)) {
      out.transcript = value;
      continue;
    }
    if (flags[i] === '--session-dir' && out.sessionDir === undefined && /^[^\0\s-][^\0]*$/.test(value)) {
      out.sessionDir = value;
      continue;
    }
    if (flags[i] === '--since' && out.since === undefined && /^\d{1,15}$/.test(value)) {
      out.since = Number(value);
      continue;
    }
    const key = keys[flags[i]];
    if (key === undefined || out[key] !== undefined || !/^\d{1,9}$/.test(value)) return null;
    out[key] = Number(value);
  }
  if (out.transcript !== undefined && out.tokens !== undefined) return null;
  if ((out.since !== undefined || out.sessionDir !== undefined) && out.transcript === undefined) return null;
  return out.minutes === undefined || out.fixLoops === undefined ? null : out;
}

/** `<INC-n> [--force] [--json] [--base <branch>]`, or null when the arguments do not have that shape. */
function parseRetroArgs(rest) {
  const [inc, ...flags] = rest;
  if (!/^INC-\d{1,4}$/.test(inc ?? '')) return null;
  const out = { inc, force: false, json: false, base: undefined };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--force') out.force = true;
    else if (flags[i] === '--json') out.json = true;
    else if (flags[i] === '--base' && BRANCH_NAME.test(flags[i + 1] ?? '')) out.base = flags[++i];
    else return null;
  }
  return out;
}

/**
 * `add <test> --reason <text> --slice <S-nn> [--since <date>]`, `remove <test>`, `list [--json|--names]` or
 * `check [--inc <INC-n>]`, or null when the arguments do not have that shape. A test name that starts with a dash
 * comes after `--`.
 */
function parseQuarantineArgs(args) {
  const [sub, ...rest] = args;
  if (!['add', 'remove', 'list', 'check'].includes(sub)) return null;
  const out = { sub, format: 'text' };
  let name;
  let dashes = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = rest[i + 1];
    if (dashes) {
      if (name !== undefined) return null;
      name = arg;
    } else if (arg === '--') dashes = true;
    else if (sub === 'add' && arg === '--reason' && typeof value === 'string') {
      out.reason = value;
      i++;
    } else if (sub === 'add' && arg === '--slice' && typeof value === 'string') {
      out.slice = value;
      i++;
    } else if (sub === 'add' && arg === '--since' && typeof value === 'string') {
      out.since = value;
      i++;
    } else if (sub === 'list' && arg === '--json' && out.format === 'text') out.format = 'json';
    else if (sub === 'list' && arg === '--names' && out.format === 'text') out.format = 'names';
    else if (arg === '--repo' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value ?? '') && out.repo === undefined) {
      out.repo = value;
      i++;
    } else if (sub === 'check' && arg === '--inc' && /^INC-\d{1,4}$/.test(value ?? '')) {
      out.inc = value;
      i++;
    } else if ((sub === 'add' || sub === 'remove') && !arg.startsWith('-') && name === undefined) name = arg;
    else return null;
  }
  if (sub === 'add' || sub === 'remove') {
    if (name === undefined) return null;
    out.test = name;
  }
  if (sub === 'add' && (out.reason === undefined || out.slice === undefined)) return null;
  return out;
}

/** `<from>..<to> [--version <v>] [--write]`, or null when the arguments do not have that shape. */
function parseReleaseNotesArgs(args) {
  const [range, ...flags] = args;
  if (typeof range !== 'string' || range.startsWith('-') || !range.includes('..')) return null;
  const out = { range, write: false };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--write') out.write = true;
    else if (flags[i] === '--version' && typeof flags[i + 1] === 'string') out.version = flags[++i];
    else return null;
  }
  return out;
}

/** `[--max <n>] [--json]`, or null when the arguments do not have that shape. */
function parseParallelArgs(rest) {
  const out = { max: DEFAULT_MAX, maxGiven: false, json: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--json') out.json = true;
    else if (rest[i] === '--max' && /^\d{1,2}$/.test(rest[i + 1] ?? '') && Number(rest[i + 1]) >= 1) {
      out.max = Number(rest[++i]);
      out.maxGiven = true;
    } else return null;
  }
  return out;
}

/** `[--base <branch>] [--branches <a,b,c>]`, or null when the arguments do not have that shape. */
function parseConflictsArgs(rest) {
  const out = { base: 'main', explicitBase: false, branches: undefined };
  for (let i = 0; i < rest.length; i++) {
    const value = rest[i + 1];
    if (rest[i] === '--base' && BRANCH_NAME.test(value ?? '')) {
      out.base = rest[++i];
      out.explicitBase = true;
    } else if (rest[i] === '--branches' && value !== undefined) {
      const names = value.split(',').map((n) => n.trim()).filter(Boolean);
      if (!names.every((n) => BRANCH_NAME.test(n))) return null;
      out.branches = names;
      i++;
    } else return null;
  }
  return out;
}
const CLAUDE_MD_USAGE = 'Usage: recade claude-md refresh [--write] [--target workspace|code] [--repo <name>] [--project <dir>]';
const GITHUB_USAGE = 'Usage: recade github init [--dry-run] [--owner <name>] [--repo <code repository>]... [--auto-push] [--project <dir>]'
  + ' | recade github sync [--dry-run] [--project <dir>]';
const AMEND_USAGE = 'Usage: recade amend impact <ID...> [--project <dir>]';
/** A value in single quotes for a POSIX shell. */
const shellQuote = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;

const SPIKES_USAGE = 'Usage: recade spikes check [--spike <layer>-<option>] [--json] | clean [--spike <layer>-<option>] [--json] [--project <dir>]';

const SLICES_USAGE = 'Usage: recade slices check|graph|status [--project <dir>]'
  + ' | recade slices status --set <S-nn> <status> [--note <text>] [--project <dir>]'
  + ' | recade slices dod <S-nn> --tick <n> [--tick <n> ...] (a large sheet: --tick <task>.<n>, row n of the Definition of Done of that task) [--project <dir>]'
  + ' | recade slices merge <S-nn> [--dry-run] [--project <dir>] (local forge, the owner\'s merge)'
  + ' | recade slices open <S-nn> [--json] [--no-session|--keep-session|--tie-only] [--project <dir>] (the worktrees of the slice, under worktrees/<repo>/<S-nn>, and the slice of the session)';

/**
 * `recade slices open <S-nn>`: open the worktrees of one slice under `worktrees/<repo>/<S-nn>` of the workspace, one for
 * each repository its `touches:` name. Only the main session runs it (the guard refuses it to an agent), from the
 * workspace. Exit 1 when a repository could not be opened.
 */
async function slicesOpen(rest, io) {
  // Once every repository is open, the command ties the session that runs it to the slice (the guard reads the record).
  // `--no-session` ties nothing (/parallel opens several), `--keep-session` adds the slice to the ones the session runs
  // (/review), and `--tie-only` adds it with no worktree opened (/merge-order, for its rebase worktree).
  const flags = ['--json', '--no-session', '--keep-session', '--tie-only'];
  const json = rest.includes('--json');
  const words = rest.filter((a) => !flags.includes(a));
  const ties = ['--no-session', '--keep-session', '--tie-only'].filter((f) => rest.includes(f));
  if (words.length !== 1 || !/^S-\d{2}[a-z]?$/.test(words[0]) || ties.length > 1) {
    io.stderr.write(`${SLICES_USAGE}\n`);
    return 2;
  }
  const found = workspaceOf(io.cwd);
  if (found === null || found.via !== 'self') {
    io.stderr.write(`recade slices open runs from the workspace${found === null ? '' : ` (${found.dir})`}: the worktrees of a slice live under its worktrees/ folder.\n`);
    return 1;
  }
  let result;
  try {
    if (rest.includes('--tie-only')) {
      const row = checkSlices(found.dir).status.find((r) => r.id === words[0]);
      result = { slice: words[0], lane: row?.lane ?? '', branch: row?.branch ?? null, worktrees: [], errors: row === undefined ? [`There is no sheet for ${words[0]} in slices/. Write it first with /slice-write ${words[0]}.`] : [] };
    } else result = openSlice(found.dir, words[0], { exec: io.run ?? runCommand });
  } catch (err) {
    io.stderr.write(`${oneLine(err)}\n`);
    return 2;
  }
  // Only a slice that opened in full is tied: a failed or half-opened one leaves the session as it was.
  if (result.errors.length === 0 && !rest.includes('--no-session')) {
    result.session = tieSession(found.dir, words[0], {
      sessionId: io.env?.CLAUDE_CODE_SESSION_ID, from: io.invokedFrom ?? io.cwd, keep: rest.includes('--keep-session') || rest.includes('--tie-only'),
    });
  }
  io.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatOpen(result));
  return result.errors.length > 0 ? 1 : 0;
}

/** `<S-nn> --tick <n> [--tick <n> ...]`, or null when the arguments do not have that shape. */
function parseDodTick(rest) {
  const [id, ...more] = rest;
  if (!/^S-\d{2}[a-z]?$/.test(id ?? '') || more.length === 0 || more.length % 2 !== 0) return null;
  const rows = [];
  for (let i = 0; i < more.length; i += 2) {
    // `<n>` is row n of the Definition of Done; `<t>.<n>` is row n of the Definition of Done of task t (a large sheet).
    if (more[i] !== '--tick' || !/^(?:[1-9]\d{0,1}\.)?[1-9]\d{0,2}$/.test(more[i + 1] ?? '')) return null;
    rows.push(more[i + 1]);
  }
  const key = (r) => r.split('.').map(Number).reduce((a, b) => a * 1000 + b, 0) + (r.includes('.') ? 0 : 0);
  return { id, rows: [...new Set(rows)].sort((a, b) => key(a) - key(b)) };
}

/**
 * `recade slices dod <S-nn> --tick <n>`: tick lines of the Definition of Done in the sheet of the workspace. The edit and its
 * commit (`docs(slices): tick DoD row n of S-nn`) run under the commit lock of the workspace, and nothing is pushed: the Stop hook pushes at the end
 * of the turn. The sheet must have no change of its own that the step did not make.
 */
/**
 * `recade slices merge <S-nn> [--dry-run]`: the owner's merge of a slice on the local forge. The dry run prints the git
 * commands, one for each code repository of the slice in its merge order; without it the merges run. Only the main
 * session runs it, after the owner's yes (the guard refuses it to every agent). Exit 1 on a refusal or a failed merge.
 */
async function slicesMerge(rest, io) {
  const dryRun = rest.includes('--dry-run');
  const words = rest.filter((a) => a !== '--dry-run');
  if (words.length !== 1 || !/^S-\d{2}[a-z]?$/.test(words[0])) {
    io.stderr.write(`${SLICES_USAGE}\n`);
    return 2;
  }
  const root = projectRoot(io.cwd);
  if (root === null) {
    io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
    return 1;
  }
  const exec = io.run ?? runCommand;
  let result;
  try {
    result = dryRun ? planLocalMerge(root, words[0], { exec }) : runLocalMerge(root, words[0], { exec });
  } catch (err) {
    io.stderr.write(`${oneLine(err)}\n`);
    return 2;
  }
  if (dryRun && result.errors.length === 0) {
    io.stdout.write(`The owner's merge of ${words[0]} (review request: ${result.review}). Nothing was run. The commands, in order:\n`);
    for (const step of result.steps) io.stdout.write(step.merged === null ? `${step.command}\n` : `# ${step.repo ?? 'the project'}: already merged (${step.merged.slice(0, 7)})\n`);
    for (const w of result.waits) io.stdout.write(`Before the merge: ${w}\n`);
    io.stdout.write(`Then run /board to mark ${words[0]} done.\n`);
    return 0;
  }
  for (const label of result.done ?? []) io.stdout.write(`${label}: merged.\n`);
  for (const e of result.errors) io.stderr.write(`${e}\n`);
  if (result.errors.length > 0) return 1;
  io.stdout.write(`${words[0]} is merged in ${result.steps.length === 1 ? 'its repository' : `its ${result.steps.length} repositories`}. Run /board to mark it done.\n`);
  return 0;
}

async function slicesDod(rest, io) {
  const tick = parseDodTick(rest);
  if (tick === null) {
    io.stderr.write(`${SLICES_USAGE}\n`);
    return 2;
  }
  const root = projectRoot(io.cwd);
  if (root === null) {
    io.stderr.write('No Recade project here: recade/state.yaml not found. Run /recade:new first.\n');
    return 1;
  }
  const folder = join(root, 'slices');
  const file = existsSync(folder) ? readdirSync(folder).find((f) => f.toUpperCase().startsWith(`${tick.id}-`) && f.endsWith('.md')) : undefined;
  if (file === undefined) {
    io.stderr.write(`No sheet for ${tick.id} in ${folder}. Run /slice-write ${tick.id}.\n`);
    return 1;
  }
  const path = `slices/${file}`;
  const rows = tick.rows.join(', ');
  // A sheet with changes of its own is refused: say how to clean it.
  const hint = { ...io, stderr: { write: (m) => io.stderr.write(m.replace(/Commit or restore (it|them), then run this command again\./, `Commit it with \`recade workspace commit --paths ${path} -m '<message>'\` (or restore it), then run this command again.`)) } };
  const step = await endStep(hint, root, [path], (r) => (r.changed ? `docs(slices): tick DoD row${tick.rows.length === 1 ? '' : 's'} ${rows} of ${tick.id}` : null), () => {
    let text;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch (err) {
      return { fail: 2, message: `Cannot read ${path}: ${oneLine(err)}` };
    }
    let changed = false;
    for (const row of tick.rows) {
      const [task, n] = row.includes('.') ? row.split('.').map(Number) : [undefined, Number(row)];
      const r = tickDod(text, n, task);
      if (!r.ok) return { fail: 1, message: `${tick.id}: ${r.message}` };
      text = r.text;
      changed ||= r.changed;
    }
    if (changed) {
      try {
        writeFileSync(join(root, path), text);
      } catch (err) {
        return { fail: 2, message: `Cannot write ${path}: ${oneLine(err)}` };
      }
    }
    return { changed };
  });
  if (step.exit !== undefined) return step.exit;
  if (step.value.fail !== undefined) {
    io.stderr.write(`${step.value.message}\n`);
    return step.value.fail;
  }
  io.stdout.write(step.value.changed ? `${tick.id}: DoD row${tick.rows.length === 1 ? '' : 's'} ${rows} ticked in ${path}\n` : `${tick.id}: DoD row${tick.rows.length === 1 ? '' : 's'} ${rows} already ticked, nothing to commit\n`);
  return 0;
}

/** `<S-nn> <status> [--note <text>]`, or null when the arguments do not have that shape. */
function parseStatusSet(rest) {
  const [id, status, ...more] = rest;
  if (!/^S-\d{2}[a-z]?$/.test(id ?? '') || !status || status.startsWith('--')) return null;
  if (more.length === 0) return { id, status, note: '' };
  if (more.length !== 2 || more[0] !== '--note') return null;
  return { id, status, note: more[1] };
}
const ADOPT_USAGE = 'Usage: recade adopt init --parent <dir> --repo <path|url> [--repo <path|url> ...] [--repo-name <name> ...] [--name <project>] [--full] [--json] [--default-branch <name>]'
  + ' | preflight [--json] [--default-branch <name>] | write <path> (content on stdin)'
  + ' | from-code [--full] [--json] | board [--json] [--repo <owner/name>] [--project <number>] [--create] [--accept [<repo>#]<issue>=<slice>,...]';

/**
 * `recade adopt from-code` and `recade adopt board` (phases 2 to 4 of an adopted project). Both run in the workspace, or in
 * one of its code repositories. `from-code` copies the existing documents of every registered repository under
 * docs/source/<repo>/ and lists the targets and the gaps; `board` reads the existing GitHub repository and board and
 * proposes the matches, and writes only what the owner answered.
 */
async function adoptPhase(args, io) {
  const [sub, ...rest] = args;
  const board = sub === 'board';
  const parsed = parseOptions(rest, board
    ? { flags: ['--json', '--create'], values: ['--repo', '--project', '--accept'] }
    : { flags: ['--json', '--full'], values: [] });
  if (parsed.error || parsed.positional.length > 0) {
    io.stderr.write(`${ADOPT_USAGE}\n`);
    return 2;
  }
  const json = parsed.flags.has('--json');
  let accept;
  let project;
  if (board) {
    const raw = parsed.values['--project'];
    if (raw !== undefined) {
      if (!/^[1-9]\d{0,9}$/.test(raw)) {
        io.stderr.write(`${ADOPT_USAGE}\n`);
        return 2;
      }
      project = Number(raw);
    }
    const answers = parsed.values['--accept'];
    if (answers !== undefined) {
      // `12=S-01` is an issue of the workspace repository, `api#7=S-01` an issue of the code repository `api`.
      accept = answers.split(',').map((pair) => /^(?:([a-z0-9]+(?:-[a-z0-9]+)*)#)?([1-9]\d{0,9})=([A-Za-z0-9][A-Za-z0-9-]{0,30})$/.exec(pair.trim()));
      if (accept.includes(null)) {
        io.stderr.write(`${ADOPT_USAGE}\n`);
        return 2;
      }
      accept = accept.map((m) => ({ ...(m[1] === undefined ? {} : { repo: m[1] }), issue: Number(m[2]), slice: m[3] }));
    }
  }
  const root = projectRoot(io.cwd) ?? io.cwd;
  const state = (() => {
    try {
      return loadState(root);
    } catch {
      return null;
    }
  })();
  if (state?.mode !== 'adopt') {
    io.stderr.write('No adopted workspace here: run recade adopt init --parent <dir> --repo <path|url> first.\n');
    return 1;
  }
  const exec = io.exec ?? defaultExec;
  try {
    if (!board) {
      const r = await fromCode(root, { full: parsed.flags.has('--full'), exec });
      if (json) io.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      else {
        io.stdout.write(`Reading: ${r.reading.tier} (${r.reading.files} source files${r.reading.maxFilesPerCapability === null ? '' : `, at most ${r.reading.maxFilesPerCapability} files for each capability, the rest deferred`})\n`);
        io.stdout.write('Targets:\n');
        for (const t of r.targets) io.stdout.write(`  ${t.doc}  ${t.exists ? 'written' : 'to write'}  sections: ${t.sections.join(', ')}\n`);
        io.stdout.write(r.sources.length === 0 ? 'Existing documents: none\n' : `Existing documents, copied under docs/source/<repo>/ and cited by ID:\n${r.sources.map((x) => `  ${x.id} ${x.path}\n`).join('')}`);
        if (r.gaps.length > 0) io.stdout.write(`Gaps:\n${r.gaps.map((g) => `  - ${g}\n`).join('')}`);
      }
      return r.gaps.length > 0 ? 1 : 0;
    }
    const refused = localForgeRefusal(root, '`recade adopt board`');
    if (refused !== null) {
      io.stderr.write(`${refused}\n`);
      return 1;
    }
    // A workspace with no GitHub repository yet is matched before `github init`: the owner comes from the state or the config.
    let owner;
    if (state.kind === 'workspace' && typeof state.github?.owner !== 'string') {
      const loaded = readConfig(io);
      if (!loaded) return 2;
      owner = loaded.config.github_owner;
    }
    // The reading and the gh calls come first, then the lock for the commit of the state it recorded (the owner, the board, the links).
    const step = await endStep(io, root, ['recade/state.yaml'], 'chore(recade): adopt board recorded', () => adoptBoard(root, { exec, repoName: parsed.values['--repo'], project, create: parsed.flags.has('--create'), accept, owner }), { around: true });
    if (step.exit !== undefined) return step.exit;
    const r = step.value;
    if (json) io.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    else if (r.error !== null) io.stderr.write(`${r.error}\n`);
    else {
      io.stdout.write(r.repo === null ? 'Repository: none yet, recade github init creates it\n' : `Repository: ${r.repo}\n`);
      if (r.project_number !== null) io.stdout.write(`Board: ${r.project_number}${r.created ? ' (created now)' : ''}\n`);
      else if (r.choose.length > 0) {
        io.stdout.write(`Boards to choose from: ${r.choose.map((c) => `${c.number} ${c.title}${c.closed ? ' (closed)' : ''}`).join(', ')}. Run again with --project <number> after the owner chooses.\n`);
        if (r.suggested !== null) io.stdout.write(`Suggested: ${r.suggested}, the title Recade would use.\n`);
      }
      else io.stdout.write('Board: none. Ask the owner, then run again with --create to make one.\n');
      if (r.project_number !== null && r.choose.length > 1) io.stdout.write(`Boards of the owner: ${r.choose.map((c) => `${c.number} ${c.title}${c.closed ? ' (closed)' : ''}`).join(', ')}. Run again with --project <number> to use another one.\n`);
      if (r.matched.length > 0) {
        io.stdout.write('Proposed matches, to confirm with the owner (then run again with --accept [<repo>#]<issue>=<slice>,...):\n');
        for (const m of r.matched) io.stdout.write(`  ${m.repo === null || m.repo === undefined ? '' : m.repo}#${m.issue} "${m.title}" -> ${m.slice} (${m.by})\n`);
      }
      const linked = Object.entries(r.linked);
      const refOf = (n) => (typeof n === 'string' ? n : `#${n}`);
      if (linked.length > 0) io.stdout.write(`Linked: ${linked.map(([slice, n]) => `${slice}=${typeof n === 'string' ? n : `#${n}`}`).join(', ')}\n`);
      for (const a of r.ambiguous) io.stdout.write(`Choose one: ${a.issues.map(refOf).join(' or ')} for ${a.slices.join(' or ')}, they fit equally.\n`);
      io.stdout.write(`Open issues with no slice: ${r.unmatched.length === 0 ? 'none' : r.unmatched.map(refOf).join(', ')}\n`);
      for (const w of r.warnings) io.stdout.write(`Warning: ${w}\n`);
    }
    return r.error === null ? 0 : 1;
  } catch (err) {
    io.stderr.write(`${oneLine(err)}\n`);
    return 2;
  }
}
const INVENTORY_USAGE = 'Usage: recade inventory scan [--json]';
const INTAKE_USAGE = 'Usage: recade intake scan [--json] [--project <dir>]';
const WORKSPACE_USAGE = 'Usage: recade workspace root | auto-push on|off | push | commit --paths <path>[,<path>...] -m <message>';

/**
 * The folders and files of the workspace that `recade workspace commit` may commit: the documents, and a workflow file of
 * the project's own under `.github/workflows/` (a CI step a slice adds). Never the state, the harness (`workspace.yml` is
 * Recade's), code or an ignored folder.
 */
const COMMITTABLE = /^(slices|design|decisions|retros|team|intake|docs)(\/|$)|^(BIBLE|INDEX)\.md$|^\.github\/workflows\/(?!workspace\.ya?ml$)[\w.-]+\.ya?ml$/;

/** `--paths a,b -m <message>`, or null when the arguments do not have that shape or a path is not a document of the workspace. */
function parseWorkspaceCommit(rest) {
  if (rest.length !== 4 || rest[0] !== '--paths' || rest[2] !== '-m') return null;
  const paths = rest[1].split(',');
  const message = rest[3];
  if (paths.some((p) => !COMMITTABLE.test(p) || p.split('/').includes('..') || /[\0\r\n]/.test(p) || p.startsWith('-'))) return null;
  if (message.trim() === '' || message.length > 200 || /[\0\r\n]/.test(message)) return null;
  return { paths: [...new Set(paths.map((p) => p.replace(/\/+$/, '')))], message: message.trim() };
}
const REPO_USAGE = 'Usage: recade repo add <name> (--new | --clone <url or path>) [--role <text>] [--visibility private|public|internal] | list [--json] | check [--json] | sync | clean <name> [--apply]';
const NEW_USAGE = 'Usage: recade new <name> [--parent <dir>] [--from <dir>] [--json]';
const PROVISIONAL_USAGE =
  'Usage: recade provisional open --what <text> --why <text> --assumption <text> --owner <text> [--due YYYY-MM-DD]'
  + ' | close <PRV-nn> --value <text> [--replaced-in <text>] | list [--open] [--json]'
  + ' (add --project <dir> to work on a project from another folder)';

/**
 * Split `args` into positional arguments, boolean flags and `--name value` options.
 * Returns `{error}` on an unknown option or a missing value.
 */
function parseOptions(args, { flags, values }) {
  const out = { positional: [], flags: new Set(), values: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (flags.includes(arg)) out.flags.add(arg);
    else if (values.includes(arg)) {
      if (i + 1 >= args.length) return { error: `Missing value for ${arg}.` };
      out.values[arg] = args[++i];
    } else if (arg.startsWith('--')) return { error: `Unknown option: ${arg}` };
    else out.positional.push(arg);
  }
  return out;
}

const STATE_USAGE =
  'Usage: recade state show [--json] | can-start <phase> | pass <gate> | reset-from <gate> | set <key> <value> (keys: slicing, second_opinion, hotspots, lots, docs_step, decisions as ask or trust, track as full or short, forge as github or local, spikes as run or none, budgets as D1=12000,PLAN=8000) [--project <dir>]';

const localDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * The refusal of a command that needs GitHub, on a project whose forge is local, or null. Such a command makes no gh
 * call at all: the owner moves the project to GitHub first (docs/design.md, section 6.8).
 * @param {string} root the project folder
 * @param {string} what the command, as the owner reads it
 */
function localForgeRefusal(root, what) {
  let state;
  try {
    state = loadState(root);
  } catch {
    return null;
  }
  if (forgeOf(state) !== 'local') return null;
  return `${what} needs GitHub, and this project works on the local forge (forge: local): nothing was called and nothing changed. To move the project to GitHub, run recade state set forge github, then run it again.`;
}

function renderState(state, root, today) {
  const firstSlice = firstSliceLine(state, today);
  const phase = currentPhase(state);
  const command = phaseCommand(state, phase);
  const entry = COMMAND_MAP.find((c) => c.phase === 'plugin' && c.command === command);
  const lines = [
    `Project: ${root}`,
    `Mode: ${state.mode ?? 'unknown'}`,
    `Track: ${trackOf(state)}`,
    `Forge: ${forgeOf(state)}${forgeOf(state) === 'local' ? ' (git on this machine only, the board is slices/STATUS.md)' : ''}`,
    `Phase: ${phase.id} ${phase.name}`,
    'Gates:',
    ...gatesOf(state).map((g) => `${g.padEnd(Math.max(9, ...gatesOf(state).map((x) => x.length + 1)))} ${state.gates[g] ? `passed ${state.gates[g].passed}` : 'open'}`),
    `Command: /recade:${command}${entry?.available === false ? ' (not available in this version)' : ''}`,
    `Slicing: ${state.slicing}`,
    `Second opinion: ${state.second_opinion}`,
    `Decisions: ${decisionsOf(state)}${decisionsOf(state) === 'trust' ? ' (the team decides what is reversible and free)' : ' (every open decision comes to you)'}`,
    `Hotspots: ${state.hotspots.length ? state.hotspots.join(', ') : 'none'}`,
    `Lots: ${state.lots.length ? state.lots.join(', ') : 'none'}`,
    ...(state.docs_step ? [`Docs step: ${state.docs_step}`] : []),
    ...(state.spikes ? [`Spikes: ${state.spikes}`] : []),
    ...(firstSlice === null ? [] : [`First slice: ${firstSlice}`]),
    `Next action: ${nextAction(state)}`,
  ];
  return `${lines.join('\n')}\n`;
}

const RENDER_USAGE = 'Usage: recade render <file.md...> [--format docx,xlsx,html,pdf] [--out <dir>] [--no-check]';
const EXTRAS_USAGE = 'Usage: recade render extras [--project <dir>] [--no-check]';

/**
 * `recade render extras`: render the extra deliverables the owner chose (`deliverables.extras` of the user config)
 * into docs/deliverables, and the deck for a steering committee when `deliverables.deck` is `yes`. Exit 0 when none is chosen or a source is missing (a warning line), 1 when a check, a
 * figure, Chromium or a write fails, 2 for a usage error.
 */
async function renderExtrasCommand(args, io) {
  if (args.some((a) => a !== '--no-check')) {
    io.stderr.write(`${EXTRAS_USAGE}\n`);
    return 2;
  }
  const root = findRenderRoot(io.cwd);
  if (root === null) {
    io.stderr.write(`${io.cwd} is not a Recade project (no recade/state.yaml up from there). Use --project <dir>.\n`);
    return 2;
  }
  const loaded = readConfig(io);
  if (!loaded) return 1;
  for (const w of loaded.warnings) io.stderr.write(`${w}\n`);
  const chosen = loaded.config.deliverables?.extras;
  const fix = `Fix it with: recade config set deliverables.extras ${EXTRAS.join(',')} (or none).`;
  if (!Array.isArray(chosen)) {
    io.stderr.write(`deliverables.extras in ${configPath(io.env)} must be a list of ${EXTRAS.join(', ')}. ${fix}\n`);
    return 1;
  }
  const bad = chosen.find((e) => !isExtra(e));
  if (bad !== undefined) {
    io.stderr.write(`deliverables.extras in ${configPath(io.env)} is not valid. Unknown extra deliverable: ${String(bad)}. ${fix}\n`);
    return 1;
  }
  const deck = loaded.config.deliverables?.deck ?? 'ask';
  if (!DECK_CHOICES.includes(deck)) {
    io.stderr.write(`deliverables.deck in ${configPath(io.env)} must be ${DECK_CHOICES.join(', ')}. Fix it with: recade config set deliverables.deck yes (or no).\n`);
    return 1;
  }
  if (chosen.length === 0) io.stdout.write('No extra deliverables chosen. Choose some with: recade config set deliverables.extras stack,decisions,design,reviews\n');
  if (deck === 'ask') io.stdout.write('No deck: deliverables.deck is ask, so the owner has not said yet. /recade:docs asks it, or: recade config set deliverables.deck yes (or no).\n');
  else if (deck === 'no') io.stdout.write('No deck: deliverables.deck is no. Turn it on with: recade config set deliverables.deck yes\n');
  if (chosen.length === 0 && deck !== 'yes') return 0;
  let engine;
  try {
    engine = await import('./render/extras.js');
  } catch (err) {
    io.stderr.write(`Cannot load the render engine: ${oneLine(err)}. Run: npm ci --omit=dev --prefix "${resolve(fileURLToPath(import.meta.url), '..', '..')}"\n`);
    return 1;
  }
  const warn = (warnings) => { for (const w of warnings ?? []) io.stderr.write(`Warning: ${w}\n`); };
  try {
    const { outputs, findings, warnings, stale } = await engine.renderExtras(root, chosen, {
      check: !args.includes('--no-check'), pdf: loaded.config.deliverables?.pdf === true, deck: deck === 'yes', env: io.env,
      // Test seams, as for render.
      chromiumStatus: io.chromiumStatus ? () => io.chromiumStatus(io.env) : undefined,
      withBrowser: io.withBrowser,
    });
    printPlainFindings(findings, io);
    warn(warnings);
    for (const file of outputs) io.stdout.write(`Wrote ${file}\n`);
    printLeftOver(stale, io);
    return 0;
  } catch (err) {
    printPlainFindings(err.findings ?? [], io);
    warn(err.warnings);
    const message = oneLine(err);
    io.stderr.write(`${/^Chromium is not installed/.test(message) ? `${message} /recade:setup shows what is missing.` : message}\n`);
    return err.exitCode ?? 1;
  }
}

/** The nearest folder up from `dir` that holds `recade/state.yaml`, or null. */
function findRenderRoot(dir) {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, 'recade', 'state.yaml'))) return d;
    if (dirname(d) === d) return null;
  }
}

/** One line for each file of an older render left as it was. Recade never deletes them: the owner decides. */
function printLeftOver(files, io) {
  for (const file of files ?? []) {
    io.stdout.write(`Left as it was: ${file}. Recade no longer writes this name or this format; delete it when you no longer need it.\n`);
  }
}

/** `deliverables.pdf` of the user config: true only when the owner turned the PDF on. An unreadable config is no PDF. */
function pdfWanted(io) {
  try {
    return loadConfig(io.env).config.deliverables?.pdf === true;
  } catch {
    return false;
  }
}

function printPlainFindings(findings, io) {
  for (const f of findings) io.stdout.write(`${f.file}:${f.line}:${f.column} ${f.rule} ${f.message}\n`);
}

/** Parse `<file.md...> [--format a,b] [--out dir] [--no-check]`. Returns the options or `{error}`. */
function parseRenderArgs(args) {
  const opts = { files: [], formats: undefined, out: undefined, check: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = (name) => (arg === name ? args[++i] : arg.slice(name.length + 1));
    if (arg === '--format' || arg.startsWith('--format=')) {
      const v = value('--format');
      if (v === undefined || v === '') return { error: 'Missing value for --format. Example: --format docx,pdf' };
      opts.formats = v.split(',').map((f) => f.trim()).filter(Boolean);
      if (opts.formats.length === 0) return { error: 'Missing value for --format. Example: --format docx,pdf' };
    } else if (arg === '--out' || arg.startsWith('--out=')) {
      const v = value('--out');
      if (v === undefined || v === '') return { error: 'Missing value for --out. Example: --out build' };
      opts.out = v;
    } else if (arg === '--no-check') {
      opts.check = false;
    } else if (arg.startsWith('-')) {
      return { error: `Unknown option: ${arg}` };
    } else {
      opts.files.push(arg);
    }
  }
  if (opts.files.length === 0) return { error: 'Missing document. Example: recade render docs/D1.md' };
  return opts;
}

const oneLine = (err) => String(err.message ?? err).split('\n')[0];

/** The state with the workspace auto-push turned on (with the date of the owner's yes, kept when it was already on) or off. */
function withAutoPush(state, on, io) {
  const since = state.workspace?.auto_push === true ? state.workspace.auto_push_since : undefined;
  const workspace = { ...state.workspace };
  delete workspace.auto_push_since;
  workspace.auto_push = on;
  if (on) workspace.auto_push_since = since ?? localDate((io.now ?? (() => new Date()))());
  return { ...state, workspace };
}

/** The workspace folder when `root` is a workspace under git (`kind: workspace` and a `.git`), else null. */
function gitWorkspace(root) {
  try {
    if (loadState(root)?.kind !== 'workspace') return null;
  } catch {
    return null;
  }
  return existsSync(join(root, '.git')) ? root : null;
}

/**
 * End of a step that changes workspace files. In a workspace under git, `mutate` runs under the commit lock, only
 * `paths` are committed, and nothing is pushed: the commits leave the machine once, at the end of the turn, through the
 * Stop hook of the plugin (`recade workspace push`). Elsewhere `mutate` just runs. Returns `{value}`, or `{exit}` when the commit
 * step refuses (staged changes elsewhere, a path edited by someone else, wrong branch, lock held or stale), before
 * `mutate` ran.
 */
async function endStep(io, root, paths, message, mutate, { around = false, ...options } = {}) {
  const ws = gitWorkspace(root);
  if (ws === null) return { value: await mutate() };
  const exec = io.run ?? commitExec;
  const notify = (line) => io.stderr.write(`recade: ${line}\n`);
  let done;
  try {
    if (around) {
      // Work too long to hold the lock (clone, gh): refusals first, the work, then the lock for the commit alone.
      await checkWorkspace(ws, paths, { exec });
      const value = await mutate();
      // The paths were clean at the check: what changed in them since is the work's, and only the files the work names
      // (`stage`) are committed, so an edit the owner made meanwhile in another file of `paths` stays out of the commit.
      // With no commit yet, every file of `paths` is Recade's own first file: they are all committed.
      const born = (await exec(['git', 'rev-parse', '--verify', '-q', 'HEAD'], { cwd: ws }))?.code === 0;
      const { stage: named, ...rest } = options;
      const stage = born ? named : undefined;
      try {
        done = await commitWorkspace(ws, paths, typeof message === 'function' ? message(value) : message, {
          exec, now: io.now, notify, own: false, clean: true, ...rest, ...(stage === undefined ? {} : { stage: () => stage(value) }),
        });
      } catch (err) {
        if (err instanceof CommitError) err.after = value;
        throw err;
      }
      done = { ...done, value };
    } else {
      done = await commitWorkspace(ws, paths, message, { exec, now: io.now, notify, mutate, ...options });
    }
  } catch (err) {
    if (!(err instanceof CommitError)) throw err;
    io.stderr.write(`${oneLine(err)}\n`);
    return { exit: err.exit, ...('after' in err ? { after: err.after } : {}) };
  }
  return { value: done.value, committed: done.committed };
}

/**
 * Can the day of the first done slice be recorded in `recade/state.yaml` now? Yes outside a git workspace, in a
 * workspace with no commit yet, or when the state has no uncommitted change. A change that is not ours means no: the
 * slice moves all the same, one notice line says so (unless `notice` is false), and a later move records the day.
 */
async function firstSliceFree(io, root, { notice = true } = {}) {
  const ws = gitWorkspace(root);
  if (ws === null) return true;
  const exec = io.run ?? commitExec;
  const born = (await exec(['git', 'rev-parse', '--verify', '-q', 'HEAD'], { cwd: ws }))?.code === 0;
  if (!born) return true;
  const r = await exec(['git', 'status', '--porcelain', '--', 'recade/state.yaml'], { cwd: ws });
  const free = r?.code === 0 && String(r.stdout ?? '').trim() === '';
  if (!free && notice) firstSliceSkipped(io);
  return free;
}

/** The notice when the day of the first done slice is left for later. */
function firstSliceSkipped(io) {
  io.stderr.write('recade: notice: recade/state.yaml has uncommitted changes, so the day of the first done slice is not recorded now. A later move to done records it.\n');
}

/** The refusals of a step (wrong branch, staged changes elsewhere, a path edited by someone else), before any work. */
async function preflightStep(io, root, paths) {
  const ws = gitWorkspace(root);
  if (ws === null) return {};
  try {
    await checkWorkspace(ws, paths, { exec: io.run ?? commitExec });
  } catch (err) {
    if (!(err instanceof CommitError)) throw err;
    io.stderr.write(`${oneLine(err)}\n`);
    return { exit: err.exit };
  }
  return {};
}

/** loadConfig, with a read error turned into one line on stderr. Returns null on failure. */
function readConfig(io) {
  try {
    return loadConfig(io.env);
  } catch (err) {
    io.stderr.write(`${err.code ? `Cannot read ${configPath(io.env)}: ` : ''}${oneLine(err)}\n`);
    return null;
  }
}

/** Lot names recorded in `<root>/recade/state.yaml`, or `[]` when there are none. */
function lotsFromState(root) {
  const lots = loadState(root)?.lots;
  if (!Array.isArray(lots)) return [];
  return lots.filter((l) => typeof l === 'string' && LOT_NAME.test(l));
}

function printFindings(findings, io) {
  for (const f of findings) {
    io.stdout.write(`${f.file}:${f.line}:${f.column} ${f.severity} ${f.rule} ${f.message}\n`);
  }
}

/** Parse `[root] [--lots A,B]`. Returns `{root, lots}` or `{error}`. */
function parseIndexArgs(args) {
  let root;
  let lots;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value;
    if (arg === '--lots') {
      value = args[++i];
      if (value === undefined) return { error: 'Missing value for --lots. Example: --lots BKL,OPS' };
    } else if (arg.startsWith('--lots=')) {
      value = arg.slice('--lots='.length);
    } else if (arg.startsWith('-')) {
      return { error: `Unknown option: ${arg}` };
    } else if (root === undefined) {
      root = arg;
      continue;
    } else {
      return { error: `Unexpected argument: ${arg}` };
    }
    lots = value.split(',').map((l) => l.trim()).filter(Boolean);
    const badLot = lots.find((l) => !LOT_NAME.test(l));
    if (badLot) return { error: `Invalid lot name: ${badLot}. Use capital letters and digits.` };
  }
  return { root, lots };
}

/** Commands that work on a project folder. They accept `--project <dir>` in place of running from inside it. */
const PROJECT_SCOPED = ['state', 'provisional', 'decision', 'team', 'slices', 'spikes', 'amend', 'github', 'lint-style', 'intake', 'index', 'render', 'claude-md', 'parallel', 'board', 'merge-order', 'cost', 'retro', 'quarantine', 'release-notes', 'harness', 'cases', 'gate', 'repo', 'workspace', 'docs'];

/**
 * Run the CLI and return the exit code.
 * @param {string[]} argv
 * @param {IO} io
 * @returns {Promise<number>}
 */
export async function run(argv, io) {
  const [name, ...args] = argv;
  if (!name) {
    io.stderr.write('Missing command. Try: recade help\n');
    return 2;
  }
  if (!Object.hasOwn(commands, name)) {
    io.stderr.write(`Unknown command: ${name}. Try: recade help\n`);
    return 2;
  }
  if (PROJECT_SCOPED.includes(name)) {
    // `--project` belongs to Recade only before a `--`: after it, the words are the command a gate runs.
    const stop = args.indexOf('--');
    const at = args.slice(0, stop < 0 ? args.length : stop).indexOf('--project');
    if (at >= 0) {
      if (at + 1 >= args.length) {
        io.stderr.write('Missing value for --project. Example: --project ~/projects/fernhill-lending\n');
        return 2;
      }
      const dir = args[at + 1];
      args.splice(at, 2);
      io = { ...io, invokedFrom: io.invokedFrom ?? io.cwd, cwd: resolve(io.cwd, expandHome(dir, io.env)) };
    }
  }
  try {
    return await commands[name](args, io);
  } catch (err) {
    // A code repository whose link to its workspace is missing, stale or foreign: no command runs there (fail closed).
    if (err?.code !== 'RECADE_LINK') throw err;
    io.stderr.write(`recade: ${err.message}\n`);
    return 1;
  }
}
