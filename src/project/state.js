import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { budgetsOf } from '../budgets.js';
import { checkLink, findWorkspace, SYNC_ADVICE } from '../workspace/layout.js';

/**
 * The six phases of a project. A phase ends when its gates are passed; the next phase
 * can start once every gate of the phases before it is passed.
 * `noun` completes "to finish the ..." in the next action.
 */
export const PHASES = Object.freeze([
  { id: 0, name: 'Intake', command: 'new', noun: 'intake', gates: ['G0'] },
  { id: 1, name: 'Team', command: 'team', noun: 'team', gates: ['G1'] },
  { id: 2, name: 'Documents', command: 'docs', noun: 'documents', gates: ['G2-stack', 'G2'] },
  { id: 3, name: 'Bible', command: 'bible', noun: 'BIBLE', gates: ['G3'] },
  { id: 4, name: 'Slices', command: 'slices', noun: 'slices', gates: ['G4'] },
  { id: 5, name: 'Harness', command: 'harness', noun: 'harness', gates: ['G5'] },
].map((p) => Object.freeze({ ...p, gates: Object.freeze(p.gates) })));

/** Every gate, in the order they must be passed. */
export const GATES = Object.freeze(PHASES.flatMap((p) => p.gates));

/**
 * The phases of an adopted repository. Phase 0 is the inventory of what exists (S-00), run by `/recade:adopt`,
 * and its gate is `G0-inventory`; the other phases are the same as in a new project.
 */
export const ADOPT_PHASES = Object.freeze([
  Object.freeze({ id: 0, name: 'Inventory', command: 'adopt', noun: 'inventory', gates: Object.freeze(['G0-inventory']) }),
  ...PHASES.slice(1),
]);

/** Every gate of an adopted repository, in order. */
export const ADOPT_GATES = Object.freeze(ADOPT_PHASES.flatMap((p) => p.gates));

/** The phases that apply to `state`: those of an adopted repository when its mode is `adopt`. */
export const phasesOf = (state) => (state?.mode === 'adopt' ? ADOPT_PHASES : PHASES);

/** The gates that apply to `state`, in order. */
export const gatesOf = (state) => (state?.mode === 'adopt' ? ADOPT_GATES : GATES);

export const SLICING = Object.freeze(['mixed', 'small', 'large']);
export const SECOND_OPINION = Object.freeze(['always', 'sensitive', 'off']);
/**
 * Who settles the open questions of the framing. `ask`: every owner DEC is asked. `trust`: the team takes the
 * recommendation of a DEC that costs nothing, binds no one and can be undone, and the owner gets the rest
 * (skills/decision-sorting). A state without the key is `ask`, so an older project does not change.
 */
export const DECISIONS = Object.freeze(['ask', 'trust']);
/** The steps of `/recade:docs`, in order. `docs_step` holds the next one to do, so the command can resume. */
export const DOCS_STEPS = Object.freeze(['d1', 'direction', 'stack', 'd2', 'd3', 'plan', 'gate', 'done']);
/** How long the framing is. `full` is the default; `short` halves the budgets and trims the framing (docs/design.md, section 6.7). */
export const TRACKS = Object.freeze(['full', 'short']);
export const SETTINGS = Object.freeze(['slicing', 'second_opinion', 'hotspots', 'lots', 'docs_step', 'budgets', 'decisions', 'track']);

/**
 * The decisions mode of `state`: its `decisions` key, or `ask` when the key is missing or unknown. The key is written
 * only by `recade state set decisions`, so the state file of an older project stays as it was.
 * @param {object} state
 * @returns {'ask'|'trust'}
 */
export const decisionsOf = (state) => (DECISIONS.includes(state?.decisions) ? state.decisions : 'ask');

const LOT_NAME = /^[A-Z][A-Z0-9]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const phaseOfGate = (state, gate) => phasesOf(state).find((p) => p.gates.includes(gate));

/** Copy of `state` with every plan 3 key present. `phase` and `next_action` are not recomputed here. */
function fill(state) {
  const input = structuredClone(state ?? {});
  const gates = {};
  for (const g of gatesOf(input)) {
    const v = input.gates?.[g];
    gates[g] = v !== null && typeof v === 'object' && typeof v.passed === 'string' ? v : null;
  }
  return {
    ...input,
    phase: Number.isInteger(input.phase) ? input.phase : 0,
    gates,
    next_action: input.next_action ?? null,
    slicing: input.slicing ?? 'mixed',
    second_opinion: input.second_opinion ?? 'sensitive',
    hotspots: Array.isArray(input.hotspots) ? input.hotspots : [],
    lots: Array.isArray(input.lots) ? input.lots : [],
  };
}

/**
 * Fill a state read from disk (possibly a plan 1 state with `gates: {}`) with the plan 3 keys.
 * Existing values are kept, except `phase` and `next_action`, which always follow the gates so a
 * stale value is never written back. The input is not modified.
 * @param {object} state
 * @returns {object}
 */
export function normalizeState(state) {
  const s = fill(state);
  s.phase = currentPhase(s).id;
  s.next_action = nextAction(s);
  return s;
}

/** The first gate not passed yet, or null when all are. */
function firstOpenGate(state) {
  const { gates } = fill(state);
  return gatesOf(state).find((g) => gates[g] === null) ?? null;
}

/**
 * The phase being worked on: the phase of the first open gate, or the last phase when all gates are passed.
 * @param {object} state
 */
export function currentPhase(state) {
  const gate = firstOpenGate(state);
  const phases = phasesOf(state);
  return gate === null ? phases[phases.length - 1] : phaseOfGate(state, gate);
}

/**
 * Can `phase` start? Every gate of the earlier phases must be passed. The phases are those of the state's mode.
 * @param {object} state
 * @param {number} phase 0 to 5
 * @returns {{ok: boolean, missing: string|null}}
 */
export function canStart(state, phase) {
  const phases = phasesOf(state);
  if (!Number.isInteger(phase) || phase < 0 || phase >= phases.length) {
    throw new Error(`Invalid phase: ${phase}. Use a number from 0 to ${phases.length - 1}.`);
  }
  const { gates } = fill(state);
  const missing = phases.filter((p) => p.id < phase).flatMap((p) => p.gates).find((g) => gates[g] === null);
  return missing === undefined ? { ok: true, missing: null } : { ok: false, missing };
}

/**
 * The `/recade:<name>` command that does the work of `phase`. In adopt mode phases 0, 2 and 5 are `adopt`.
 * @param {object} state
 * @param {{id: number, command: string}} [phase] defaults to the current phase
 */
export function phaseCommand(state, phase = currentPhase(state)) {
  // An adopted project runs its inventory, its documents (the stack and plan read from the code) and its harness
  // install through /recade:adopt; the team, bible and slices phases keep their own commands.
  return state?.mode === 'adopt' && [0, 2, 5].includes(phase.id) ? 'adopt' : phase.command;
}

/** The sentence that tells the owner what to run next. */
export function nextAction(state) {
  const s = fill(state);
  const open = firstOpenGate(s);
  if (open === null) {
    return `The project is set up. Run /status in the project (G5 passed on ${s.gates.G5.passed}).`;
  }
  const phase = phaseOfGate(s, open);
  const entry = phaseCommand(s, phase);
  const gates = gatesOf(s);
  const index = gates.indexOf(open);
  if (index === 0) return `Run /recade:${entry} to finish the ${phase.noun} (${open} is open).`;
  const prev = gates[index - 1];
  const when = `${prev} passed on ${s.gates[prev].passed}`;
  const finish = phaseOfGate(s, prev) === phase ? ` to finish the ${phase.noun}` : '';
  return `Run /recade:${entry}${finish} (${when}).`;
}

/**
 * Record a gate as passed by the owner. Gates go in order. Passing a gate again keeps the first date.
 * Returns a new state with `phase` and `next_action` brought up to date.
 * @param {object} state
 * @param {string} gate
 * @param {string} date YYYY-MM-DD
 */
export function passGate(state, gate, date) {
  const gates = gatesOf(state);
  if (!gates.includes(gate)) throw new Error(`Unknown gate: ${gate}. Use ${gates.join(', ')}.`);
  if (typeof date !== 'string' || !DATE.test(date)) throw new Error(`Invalid date: ${date}. Use YYYY-MM-DD.`);
  const next = fill(state);
  if (next.gates[gate] === null) {
    const before = gates[gates.indexOf(gate) - 1];
    if (before !== undefined && next.gates[before] === null) {
      throw new Error(`Cannot pass ${gate} before ${before}.`);
    }
    next.gates[gate] = { passed: date, by: 'owner' };
  }
  next.phase = currentPhase(next).id;
  next.next_action = nextAction(next);
  return next;
}

/**
 * Take the project back to a gate: `gate` and every gate after it become null again (not passed). The
 * gates before it keep their date. Returns a new state with `phase` and `next_action` brought up to date.
 * The caller asks the owner first: this undoes approvals.
 * @param {object} state
 * @param {string} gate
 */
export function resetFrom(state, gate) {
  const gates = gatesOf(state);
  if (!gates.includes(gate)) throw new Error(`Unknown gate: ${gate}. Use ${gates.join(', ')}.`);
  const next = fill(state);
  for (const g of gates.slice(gates.indexOf(gate))) next.gates[g] = null;
  next.phase = currentPhase(next).id;
  next.next_action = nextAction(next);
  return next;
}

/**
 * Set one of the project settings from its text form. Lists are comma separated.
 * Returns a new state.
 * @param {object} state
 * @param {string} key
 * @param {string} value
 */
export function setSetting(state, key, value) {
  if (!SETTINGS.includes(key)) throw new Error(`Cannot set ${key}. Use ${SETTINGS.join(', ')}.`);
  const next = fill(state);
  if (key === 'slicing' || key === 'second_opinion' || key === 'decisions' || key === 'track') {
    const allowed = { slicing: SLICING, second_opinion: SECOND_OPINION, decisions: DECISIONS, track: TRACKS }[key];
    if (!allowed.includes(value)) throw new Error(`Invalid ${key}: ${value}. Use ${allowed.join(', ')}.`);
    next[key] = value;
    return next;
  }
  if (key === 'docs_step') {
    if (!DOCS_STEPS.includes(value)) throw new Error(`Invalid docs_step: ${value}. Use ${DOCS_STEPS.join(', ')}.`);
    next.docs_step = value;
    return next;
  }
  if (key === 'budgets') {
    // `D1=12000,PLAN=8000`: each document is merged into the budgets already set.
    const set = { ...(next.budgets ?? {}) };
    for (const item of value.split(',').map((v) => v.trim()).filter(Boolean)) {
      const m = /^([A-Za-z0-9]+)=(\d+)$/.exec(item);
      if (m === null) throw new Error(`Invalid budget: ${item}. Write DOCUMENT=WORDS, for example D1=12000.`);
      set[m[1]] = Number(m[2]);
    }
    budgetsOf({ budgets: set });
    next.budgets = set;
    return next;
  }
  const items = value.split(',').map((v) => v.trim()).filter(Boolean);
  if (key === 'lots') {
    const bad = items.find((l) => !LOT_NAME.test(l));
    if (bad) throw new Error(`Invalid lot name: ${bad}. Use capital letters and digits.`);
  }
  next[key] = items;
  return next;
}

/** The track of a project: `short` when the state says so, `full` otherwise (a state written before the track existed). */
export const trackOf = (state) => (state?.track === 'short' ? 'short' : 'full');

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
};
const isDate = (v) => typeof v === 'string' && DATE.test(v);

/**
 * When the project started and when its first slice was delivered. `started` is the date `recade new` wrote, else the
 * day the first gate was passed (a project created before the date was recorded). Null when neither is known.
 * @param {object} state
 * @param {string} today YYYY-MM-DD
 * @returns {{started: string, first: string|null, days: number}|null} `days` runs to `first`, or to `today` when no slice is done
 */
export function firstSliceTime(state, today) {
  const firstGate = gatesOf(state)[0];
  const passed = state?.gates?.[firstGate]?.passed;
  const started = isDate(state?.started) ? state.started : isDate(passed) ? passed : null;
  if (started === null) return null;
  const first = isDate(state?.first_slice_done) ? state.first_slice_done : null;
  const end = first ?? (isDate(today) ? today : started);
  return { started, first, days: Math.max(0, dayNumber(end) - dayNumber(started)) };
}

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * The one line of the metric "time to first slice", or null when the start is not known.
 * @param {object} state
 * @param {string} today YYYY-MM-DD
 */
export function firstSliceLine(state, today) {
  const t = firstSliceTime(state, today);
  if (t === null) return null;
  if (t.first === null) return `${days(t.days)} since the start, no slice delivered yet.`;
  return `Started on ${t.started}. First slice delivered on ${t.first}, ${days(t.days)} later.`;
}

/** A code repository whose link to its workspace is missing, stale or points elsewhere. `code` is `RECADE_LINK`. */
export class WorkspaceLinkError extends Error {
  constructor(reason) {
    super(`This code repository is not linked to its workspace (${reason}). Run ${SYNC_ADVICE} from the workspace, then try again.`);
    this.code = 'RECADE_LINK';
    this.reason = reason;
  }
}

/** Is `dir` the root of a workspace, read from its `recade/state.yaml`? */
function isWorkspace(dir) {
  try {
    return parse(readFileSync(join(dir, 'recade', 'state.yaml'), 'utf8'))?.kind === 'workspace';
  } catch {
    return false;
  }
}

/**
 * Does the git folder around `cwd` belong to a workspace, even without a good link? It does when a folder above it is
 * a workspace (a clone under `repos/` or one of its worktrees), or when it holds the harness settings of a code
 * repository, `.claude/recade.yaml`.
 */
function boundToWorkspace(cwd) {
  let dir = resolve(cwd);
  let top = null;
  for (;;) {
    if (top === null && existsSync(join(dir, '.git'))) {
      top = dir;
      if (existsSync(join(top, '.claude', 'recade.yaml'))) return true;
    } else if (top !== null && isWorkspace(dir)) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

const realOr = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * Does `ws` hold the main repository of `cwd` itself at `repos/<name>`, with no symbolic link on the way, and is `ws`
 * its own git checkout (not a folder planted inside another checkout)?
 */
function holdsPhysically(ws, cwd) {
  const git = (dir, args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const home = realOr(ws);
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const main = common === null || basename(common) !== '.git' ? null : realOr(dirname(common));
  if (home === null || main === null) return false;
  const lexical = join(home, 'repos', basename(main));
  try {
    if (lstatSync(join(home, 'repos')).isSymbolicLink() || lstatSync(lexical).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const top = git(home, ['rev-parse', '--show-toplevel']);
  return realOr(lexical) === main && top !== null && realOr(top) === home;
}

/**
 * The workspace of `cwd`, checked. In a code repository the link must name the workspace that holds it in `repos/`:
 * a missing, stale or foreign link throws a `WorkspaceLinkError` that names `recade repo sync` (fail closed), and the
 * workspace around the repository is never used in its place.
 * @param {string} cwd
 * @returns {{dir: string, via: 'self'|'link'}|null} null outside any workspace (a legacy project or a plain folder)
 */
export function workspaceOf(cwd) {
  const found = findWorkspace(cwd);
  if (found?.via === 'self') return found;
  const link = checkLink(cwd);
  if (link.ok && found?.via === 'link') {
    if (!holdsPhysically(found.dir, cwd)) throw new WorkspaceLinkError('link points elsewhere');
    return found;
  }
  if (link.ok) return null;
  // No link, or a git folder git cannot read (the worktree of a moved workspace): only a folder that belongs to a
  // workspace is held. A plain folder or a legacy project is not.
  if ((link.reason === 'link missing' || link.reason === 'not a git repository') && !boundToWorkspace(cwd)) return null;
  throw new WorkspaceLinkError(link.reason);
}

/**
 * The workspace of the project: the one a code repository (or one of its worktrees) is linked to, else the nearest
 * folder, from `cwd` upwards, that holds `recade/state.yaml`. Null when there is none. In a code repository whose
 * link is missing, stale or points elsewhere it throws a `WorkspaceLinkError`: it never falls back to the workspace
 * around the repository.
 * @param {string} cwd
 * @param {{exists?: (path: string) => boolean}} [fs]
 * @returns {string|null}
 */
export function projectRoot(cwd, { exists = existsSync } = {}) {
  const found = workspaceOf(cwd);
  if (found?.via === 'link') return found.dir;
  let dir = cwd;
  for (;;) {
    if (exists(join(dir, 'recade', 'state.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
