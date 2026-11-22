import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { budgetsOf } from './budgets.js';
import { dollarsOf, modelId, PRICES_SOURCE } from './pricing.js';
import { stageTier } from './models.js';

/**
 * `recade cost estimate`: what a phase, or the delivery of one slice, should cost, before it runs.
 * An estimate is a range built from the constants below, never a measure: `recade cost record` measures a slice.
 * Every assumption is a named constant, so it can be tuned against the measured cost of real projects.
 * A pair is `{ low, high }`: the low figure uses every low value, the high figure every high value.
 */

const pair = (low, high = low) => Object.freeze({ low, high });
const pick = (value, bound) => (typeof value === 'number' ? value : value[bound]);
const BOUNDS = ['low', 'high'];

// ---------------------------------------------------------------------------------------------------------
// Tokens of one run
// ---------------------------------------------------------------------------------------------------------

/** Tokens for one word of prose, in English or French. Code blocks and tables run a little higher. */
export const TOKENS_PER_WORD = 1.4;

/** The system prompt, the tool definitions, the agent file and the skills it loads: read again on every turn, from the cache. */
export const SYSTEM_TOKENS = pair(18000, 24000);

/** The prompt the dispatcher writes: stage, paths, languages, budgets, rules. */
export const PROMPT_TOKENS = 2000;

/** The output of one tool call (a Read, a Bash line, a Write header). The text a Write carries is counted apart. */
export const TOOL_CALL_TOKENS = 150;

/** Fresh input on each turn, after the last cache breakpoint. Everything before it is a cache read. */
export const UNCACHED_INPUT_PER_TURN = 300;

/** The report an agent ends with. */
export const REPORT_WORDS = 400;

/** Thinking tokens on each turn, by effort. Thinking is billed as output. */
export const THINKING_PER_TURN = Object.freeze({ high: pair(600, 1200), medium: pair(300, 600), low: pair(100, 250) });

/**
 * How a run works, by kind: its number of turns, and the new context each turn brings (tool results, files read
 * beyond the documents counted in `reads`, command output, web pages).
 */
export const PROFILES = Object.freeze({
  write: Object.freeze({ turns: pair(18, 30), toolTokens: pair(1200, 2000) }),
  edit: Object.freeze({ turns: pair(8, 15), toolTokens: pair(800, 1500) }),
  review: Object.freeze({ turns: pair(10, 20), toolTokens: pair(1000, 2000) }),
  reply: Object.freeze({ turns: pair(3, 6), toolTokens: pair(600, 1200) }),
  research: Object.freeze({ turns: pair(30, 50), toolTokens: pair(3000, 5000) }),
  spike: Object.freeze({ turns: pair(30, 60), toolTokens: pair(1500, 2500) }),
  code: Object.freeze({ turns: pair(30, 60), toolTokens: pair(2000, 3000) }),
});

// ---------------------------------------------------------------------------------------------------------
// What the runs read and write, in words, beyond the budgets of `src/budgets.js`
// ---------------------------------------------------------------------------------------------------------

/** The intake brief and the gap list the intake-analyst writes. */
export const BRIEF_WORDS = 2500;
/** The questionnaire and the client files the intake-analyst reads. */
export const INTAKE_INPUT_WORDS = pair(2000, 12000);
/** A template of `templates/`, read by the agent that fills it. */
export const TEMPLATE_WORDS = 1500;
/** One doctrine of `team/`, written by a doctrine-writer and read by its role in every run. */
export const DOCTRINE_WORDS = 2000;
/** A review note: at most 10 findings. */
export const REVIEW_NOTE_WORDS = 800;
/** The DEC files an apply-decisions stage reads. */
export const DEC_WORDS = pair(300, 1200);
/** The share of a document a revise round rewrites. */
export const REVISE_SHARE = pair(0.2, 0.4);
/** The share of a document an apply-decisions stage changes. */
export const APPLY_SHARE = pair(0.05, 0.15);
/** The words a format fix (style, index, render) changes. */
export const FIX_WORDS = 300;
/** The share of D1, D2 and their sections that the author drafts; the contributors write the rest. */
export const DRAFT_SHARE = 0.75;
/** The roles of a team when there is no roster yet: the 8 core roles, plus 1 to 3 the project needs. */
export const DEFAULT_ROLES = pair(9, 11);
/** The short track: the 8 core roles, plus a role only for payments, health data or regulated data. */
export const SHORT_ROLES = pair(8, 9);
/** The words of the recruiter's candidates and of its roster. */
export const CANDIDATES_WORDS = 600;
export const ROSTER_WORDS = 1200;
/** The doctrines that fail `recade team check` and are written again. */
export const DOCTRINE_RETRIES = pair(0, 2);
/** The art direction: boards (HTML, counted in words), then the tokens and the theme. */
export const BOARDS = pair(2, 3);
/** The short track offers exactly two directions. */
export const SHORT_BOARDS = pair(2);
export const BOARD_WORDS = 2500;
export const TOKENS_WORDS = 1500;
/** The stack: layers with spikes, finalists spiked per layer, layer stages and the layers the owner answers. */
export const SPIKE_LAYERS = pair(3, 5);
export const FINALISTS = pair(2, 3);
/**
 * The short track spikes a layer only when its two best totals are within 10 percent, which nobody knows before the
 * research: from no spike at all up to the full number.
 */
export const SHORT_SPIKES = pair(0, SPIKE_LAYERS.high * FINALISTS.high);
export const SPIKE_RESULT_WORDS = 800;
export const LAYER_STAGES = pair(6, 9);
export const OWNER_LAYERS = 5;
/** The owner's own options in the layer loop, researched with the stage `other`. */
export const OTHER_OPTIONS = pair(0, 2);
/** The slices of a PLAN, and the words of one sheet. */
export const SLICES = pair(12, 25);
export const SHEET_WORDS = 600;
/** The text each role replies with when it specialises the harness. */
export const HARNESS_REPLY_WORDS = 500;
/** What the delivery agents of a slice read and write in code, in tokens. */
export const SLICE_SPEC_WORDS = Object.freeze({ standard: 800, sensitive: 2000 });
export const SLICE_CODE_READ_TOKENS = pair(20000, 50000);
export const SLICE_TESTS_TOKENS = pair(3000, 8000);
export const SLICE_CODE_TOKENS = pair(6000, 15000);
/** The short track sends a document back to its author only for a blocker: its revise round may not run. */
export const SHORT_REVISE = pair(0, 1);
/** FIX loops of a slice: the implementer and the reviewer run again. */
export const FIX_LOOPS = pair(0, 2);

/** The phases the estimate knows, in order, with the gates that end each one. */
export const ESTIMATE_PHASES = Object.freeze([
  Object.freeze({ id: 'intake', name: 'Intake', command: 'new', gates: Object.freeze(['G0']) }),
  Object.freeze({ id: 'team', name: 'Team', command: 'team', gates: Object.freeze(['G1']) }),
  Object.freeze({ id: 'docs', name: 'Documents', command: 'docs', gates: Object.freeze(['G2-stack', 'G2']) }),
  Object.freeze({ id: 'bible', name: 'Bible', command: 'bible', gates: Object.freeze(['G3']) }),
  Object.freeze({ id: 'slices', name: 'Slices', command: 'slices', gates: Object.freeze(['G4']) }),
  Object.freeze({ id: 'harness', name: 'Harness', command: 'harness', gates: Object.freeze(['G5']) }),
]);
export const PHASE_IDS = Object.freeze(ESTIMATE_PHASES.map((p) => p.id));
export const SLICE_LANES = Object.freeze(['standard', 'sensitive']);

// ---------------------------------------------------------------------------------------------------------
// The runs of each phase, from what the commands dispatch
// ---------------------------------------------------------------------------------------------------------

/**
 * One kind of agent run. `writes` and `reads` are words, `writeTokens` and `readTokens` tokens (for code); each may be a
 * number or a pair. `count` is how many times it runs. `tier` is `writer`, `mechanical`, or `lane` for a harness agent.
 * @typedef {{agent: string, stage: string, profile: string, count: any, writes?: any, reads?: any, writeTokens?: any, readTokens?: any, tier: string}} Run
 */

const scale = (value, factor) => (typeof value === 'number' && typeof factor === 'number' ? value * factor
  : pair(pick(value, 'low') * pick(factor, 'low'), pick(value, 'high') * pick(factor, 'high')));
const sum = (...values) => pair(...BOUNDS.map((b) => values.reduce((n, v) => n + pick(v, b), 0)));

/** A framing run: its tier follows MECHANICAL_STAGES (`fix` stands for a revise sent back for a format finding). */
const framing = (agent, stage, profile, { count = 1, writes = 0, reads = 0 } = {}) =>
  ({ agent, stage, profile, count, writes, reads, tier: stageTier(agent, stage) });

/**
 * The runs around one document: draft, contributions, one review, one revise round (0 to 1 in the short track, which
 * revises only for a blocker), a second round when a blocker remains, the decisions applied, the format fixes and a
 * cut when it is over budget.
 */
function documentRuns(doc, budget, author, { draft = 'draft', reviewer, reads, contributors = [], short = false }) {
  const runs = [];
  const share = contributors.length > 0 ? DRAFT_SHARE : 1;
  runs.push(framing(author, draft, 'write', { writes: budget * share, reads: sum(reads, TEMPLATE_WORDS, DOCTRINE_WORDS) }));
  for (const c of contributors) {
    runs.push(framing(c.agent, 'contribute', 'write', { count: c.count ?? 1, writes: (budget * (1 - DRAFT_SHARE)) / contributors.length, reads: budget + DOCTRINE_WORDS }));
  }
  runs.push(framing(reviewer, 'review', 'review', { writes: REVIEW_NOTE_WORDS, reads: sum(budget, reads, DOCTRINE_WORDS) }));
  runs.push(framing(author, 'revise', 'edit', { count: short ? SHORT_REVISE : 1, writes: scale(budget, REVISE_SHARE), reads: budget + REVIEW_NOTE_WORDS + DOCTRINE_WORDS }));
  if (contributors.length > 0) runs.push(framing(contributors[0].agent, 'revise', 'edit', { count: pair(0, 1), writes: scale(budget * (1 - DRAFT_SHARE), REVISE_SHARE), reads: budget + REVIEW_NOTE_WORDS }));
  runs.push(framing(author, 'revise', 'edit', { count: pair(0, 1), writes: scale(budget, 0.1), reads: budget + REVIEW_NOTE_WORDS }));
  runs.push(framing(author, 'apply-decisions', 'edit', { writes: scale(budget, APPLY_SHARE), reads: sum(budget, DEC_WORDS) }));
  runs.push(framing(author, 'fix', 'edit', { count: pair(0, 2), writes: FIX_WORDS, reads: budget }));
  runs.push(framing(author, 'revise', 'edit', { count: pair(0, 1), writes: scale(budget, 0.3), reads: budget }));
  return runs;
}

/** The runs of one phase for the facts of a project. */
function phaseRuns(phase, facts) {
  const B = facts.budgets;
  const domain = facts.domainExpert;
  const roles = facts.roles;
  const short = facts.track === 'short';
  switch (phase) {
    case 'intake':
      return [framing('intake-analyst', 'analysis', 'write', { count: pair(1, 2), writes: BRIEF_WORDS, reads: sum(INTAKE_INPUT_WORDS, TEMPLATE_WORDS) })];
    case 'team':
      return [
        framing('recruiter', 'candidates', 'research', { writes: CANDIDATES_WORDS, reads: BRIEF_WORDS }),
        framing('recruiter', 'roster', 'research', { writes: ROSTER_WORDS, reads: BRIEF_WORDS + CANDIDATES_WORDS }),
        framing('doctrine-writer', 'doctrine', 'research', { count: sum(roles, DOCTRINE_RETRIES), writes: DOCTRINE_WORDS, reads: BRIEF_WORDS + TEMPLATE_WORDS }),
      ];
    case 'docs': {
      const t = facts.translations;
      // The short track: two boards, a revise only for a blocker, spikes only for a close layer, the architect's opinion alone.
      const boards = short ? SHORT_BOARDS : BOARDS;
      const spikes = short ? SHORT_SPIKES : scale(SPIKE_LAYERS, FINALISTS);
      const opinions = short ? 1 : 2;
      const d1Reviewer = domain.high > 0 && domain.low > 0 ? 'domain-expert' : 'architect';
      const runs = [
        ...documentRuns('D1', B.D1, 'project-lead', {
          draft: 'draft-d1', reviewer: d1Reviewer, reads: BRIEF_WORDS, short,
          contributors: [{ agent: 'ux-designer' }, { agent: 'domain-expert', count: domain }],
        }),
        framing('project-lead', 'glossary', 'edit', { writes: 200, reads: B.D1 }),
        framing('ui-designer', 'directions', 'write', { writes: scale(BOARD_WORDS, boards), reads: B.D1 + BRIEF_WORDS + DOCTRINE_WORDS }),
        framing('ux-designer', 'review', 'review', { writes: REVIEW_NOTE_WORDS, reads: scale(BOARD_WORDS, boards) }),
        framing('ui-designer', 'revise', 'edit', { count: short ? SHORT_REVISE : pair(1, 2), writes: scale(BOARD_WORDS, REVISE_SHARE), reads: scale(BOARD_WORDS, boards) }),
        framing('ui-designer', 'tokens', 'edit', { writes: TOKENS_WORDS, reads: BOARD_WORDS }),
        framing('stack-analyst', 'layers', 'reply', { writes: 300, reads: B.D1 + BRIEF_WORDS }),
        framing('stack-analyst', 'draft', 'research', { writes: B.STACK * 0.5, reads: B.D1 + BRIEF_WORDS + TEMPLATE_WORDS }),
        { agent: 'spike-runner', stage: 'spike', profile: 'spike', count: spikes, writes: SPIKE_RESULT_WORDS, reads: 500, tier: 'mechanical' },
        framing('stack-analyst', 'matrix', 'edit', { writes: B.STACK * 0.2, reads: sum(B.STACK * 0.5, scale(SPIKE_RESULT_WORDS, spikes)) }),
        framing('architect', 'review', 'review', { writes: REVIEW_NOTE_WORDS, reads: B.STACK + B.D1 + DOCTRINE_WORDS }),
        framing('devops-lead', 'review', 'review', { count: short ? 0 : 1, writes: REVIEW_NOTE_WORDS, reads: B.STACK + B.D1 + DOCTRINE_WORDS }),
        framing('stack-analyst', 'opinions', 'edit', { writes: 400, reads: B.STACK + opinions * REVIEW_NOTE_WORDS }),
        framing('stack-analyst', 'layer', 'reply', { count: LAYER_STAGES, writes: 500, reads: B.STACK }),
        framing('stack-analyst', 'decide', 'reply', { count: OWNER_LAYERS, writes: 300, reads: B.STACK }),
        framing('stack-analyst', 'other', 'research', { count: OTHER_OPTIONS, writes: 500, reads: B.STACK }),
        framing('stack-analyst', 'apply-decisions', 'edit', { count: pair(1, 2), writes: B.STACK * 0.3, reads: B.STACK }),
        framing('doctrine-writer', 'doctrine', 'research', { count: pair(0, 1), writes: DOCTRINE_WORDS, reads: TEMPLATE_WORDS }),
        ...documentRuns('D2', B.D2, 'architect', {
          reviewer: 'security-lead', reads: B.D1 + B.STACK, short,
          contributors: [{ agent: 'devops-lead' }],
        }),
        ...documentRuns('D3', B.D3, 'security-lead', { reviewer: 'architect', reads: B.D1 + B.D2, short }),
        framing('architect', 'link', 'edit', { writes: 300, reads: B.D2 + B.D3 }),
        framing('security-lead', 'contribute', 'edit', { writes: B.D2 * 0.1, reads: B.D2 + B.D3 }),
        ...documentRuns('PLAN', B.PLAN, 'project-lead', { draft: 'draft-plan', reviewer: 'architect', reads: B.D1 + B.D2 + B.D3 + B.STACK, short }),
        framing('stack-analyst', 'revise', 'edit', { count: pair(0, 1), writes: B.STACK * 0.1, reads: B.STACK + B.D2 }),
      ];
      if (t > 0) {
        runs.push(
          framing('project-lead', 'translate', 'edit', { count: 2 * t, writes: (B.D1 + B.PLAN) / 2, reads: (B.D1 + B.PLAN) / 2 }),
          framing('architect', 'translate', 'edit', { count: t, writes: B.D2, reads: B.D2 }),
          framing('security-lead', 'translate', 'edit', { count: t, writes: B.D3, reads: B.D3 }),
        );
      }
      return runs;
    }
    case 'bible': {
      const all = B.D1 + B.D2 + B.D3 + B.STACK + B.PLAN;
      const runs = [
        framing('bible-writer', 'draft', 'write', { writes: B.BIBLE, reads: all + TEMPLATE_WORDS + 2 * DOCTRINE_WORDS }),
        framing('bible-writer', 'plan', 'edit', { writes: B.PLAN * 0.3, reads: B.BIBLE + B.PLAN }),
        framing('chief-reviewer', 'review', 'review', { writes: REVIEW_NOTE_WORDS, reads: B.BIBLE + B.PLAN + DOCTRINE_WORDS }),
        framing('bible-writer', 'revise', 'edit', { count: short ? SHORT_REVISE : 1, writes: scale(B.BIBLE, REVISE_SHARE), reads: B.BIBLE + REVIEW_NOTE_WORDS }),
        framing('bible-writer', 'revise', 'edit', { count: pair(0, 1), writes: B.BIBLE * 0.1, reads: B.BIBLE + REVIEW_NOTE_WORDS }),
        framing('bible-writer', 'apply-decisions', 'edit', { count: pair(1, 2), writes: scale(B.BIBLE, APPLY_SHARE), reads: sum(B.BIBLE + B.PLAN, DEC_WORDS) }),
        framing('bible-writer', 'fix', 'edit', { count: pair(0, 2), writes: FIX_WORDS, reads: B.BIBLE }),
      ];
      if (facts.translations > 0) runs.push(framing('bible-writer', 'translate', 'edit', { count: facts.translations, writes: B.PLAN, reads: B.PLAN }));
      return runs;
    }
    case 'slices': {
      const sheets = scale(SHEET_WORDS, SLICES);
      return [
        framing('slicer', 'cut', 'write', { writes: sheets, reads: B.PLAN + B.BIBLE + B.D1 + B.D2 + B.D3 + B.STACK + TEMPLATE_WORDS }),
        framing('slicer', 'revise', 'edit', { count: pair(0, 2), writes: scale(sheets, 0.2), reads: sum(sheets, B.PLAN) }),
      ];
    }
    case 'harness': {
      const replies = 4 + (domain.low > 0 ? 1 : 0);
      return [
        framing('team', 'harness', 'edit', { count: pair(replies, 4 + domain.high), writes: HARNESS_REPLY_WORDS, reads: B.BIBLE + B.D2 + DOCTRINE_WORDS }),
        framing('team', 'harness', 'edit', { count: pair(0, 2), writes: HARNESS_REPLY_WORDS, reads: B.BIBLE + DOCTRINE_WORDS }),
      ];
    }
    default:
      throw new Error(`Unknown phase: ${phase}. Use ${PHASE_IDS.join(', ')}.`);
  }
}

/** The runs of the delivery of one slice in a lane, after the chain of `harness/protocol.md`. */
function sliceRuns(lane, secondOpinion) {
  const code = SLICE_CODE_READ_TOKENS;
  const agent = (name, profile, extra) => ({ agent: name, stage: lane, profile, count: 1, tier: 'lane', readTokens: code, ...extra });
  const screen = pair(0, 1);
  const second = secondOpinion === 'off' ? 0 : secondOpinion === 'always' || lane === 'sensitive' ? 1 : pair(0, 1);
  const implementer = lane === 'sensitive' ? 'implementer-critical' : 'implementer';
  const runs = [];
  if (lane === 'sensitive') {
    runs.push(agent('ux-designer', 'write', { count: screen, writes: 1500, readTokens: 5000 }));
    runs.push(agent('ui-designer', 'write', { count: screen, writes: 1500, readTokens: 5000 }));
  }
  runs.push(agent('spec-writer', 'review', { writes: SLICE_SPEC_WORDS[lane], readTokens: 8000 }));
  if (lane === 'sensitive') runs.push(agent('domain-reviewer', 'review', { writes: REVIEW_NOTE_WORDS, readTokens: 8000 }));
  runs.push(agent('test-engineer', 'code', { writeTokens: SLICE_TESTS_TOKENS }));
  runs.push(agent(implementer, 'code', { writeTokens: SLICE_CODE_TOKENS }));
  runs.push(agent('reviewer', 'code', { writes: REVIEW_NOTE_WORDS }));
  if (lane === 'sensitive') runs.push(agent('security-reviewer', 'code', { writes: REVIEW_NOTE_WORDS }));
  runs.push(agent('design-reviewer', 'review', { count: screen, writes: REVIEW_NOTE_WORDS }));
  runs.push(agent('product-reviewer', 'review', { count: screen, writes: REVIEW_NOTE_WORDS }));
  runs.push(agent('doc-writer', 'edit', { writes: 500, readTokens: 10000 }));
  runs.push(agent('release-manager', 'edit', { writes: 300, readTokens: 5000 }));
  runs.push(agent('second-opinion', 'code', { count: second, writes: REVIEW_NOTE_WORDS }));
  runs.push(agent(implementer, 'code', { count: FIX_LOOPS, writeTokens: scale(SLICE_CODE_TOKENS, 0.3) }));
  runs.push(agent('reviewer', 'code', { count: FIX_LOOPS, writes: REVIEW_NOTE_WORDS }));
  return runs;
}

// ---------------------------------------------------------------------------------------------------------
// Pricing the runs
// ---------------------------------------------------------------------------------------------------------

/**
 * The tokens of one run, by kind. The context builds up over the turns: each new piece (a document read, a tool
 * result, what the agent wrote) is written to the cache once and read back on every later turn.
 * @returns {{input: number, output: number, cacheWrite: number, cacheRead: number}}
 */
export function runTokens(run, effort, bound) {
  const profile = PROFILES[run.profile];
  const turns = pick(profile.turns, bound);
  const base = pick(SYSTEM_TOKENS, bound) + PROMPT_TOKENS;
  const reads = pick(run.reads ?? 0, bound) * TOKENS_PER_WORD + pick(run.readTokens ?? 0, bound);
  const written = pick(run.writes ?? 0, bound) * TOKENS_PER_WORD + pick(run.writeTokens ?? 0, bound) + REPORT_WORDS * TOKENS_PER_WORD;
  const tools = turns * pick(profile.toolTokens, bound);
  const calls = turns * TOOL_CALL_TOKENS;
  const added = reads + tools + written + calls;
  return {
    input: turns * UNCACHED_INPUT_PER_TURN,
    output: written + calls + turns * pick(THINKING_PER_TURN[effort] ?? THINKING_PER_TURN.high, bound),
    cacheWrite: base + added,
    cacheRead: turns * base + (added * turns) / 2,
  };
}

/** The model and effort a run runs on. */
function modelOf(run, ctx) {
  if (run.tier === 'lane') {
    const entry = ctx.harnessModels?.agents?.[run.agent]?.[run.stage];
    if (entry === undefined) throw new Error(`harness/models.yaml has no ${run.stage} lane for ${run.agent}.`);
    return { model: modelId(entry.model), effort: entry.effort };
  }
  if (run.tier === 'mechanical') return { model: modelId(ctx.tiers.mechanical.model), effort: ctx.tiers.mechanical.effort };
  return { model: modelId(ctx.writer), effort: ctx.tiers.writer.effort };
}

/** Price a list of runs: the number of runs and the dollars, low and high, and one line per kind of run. */
function priceRuns(runs, ctx) {
  const runsCount = { low: 0, high: 0 };
  const dollars = { low: 0, high: 0 };
  const items = [];
  for (const run of runs) {
    const { model, effort } = modelOf(run, ctx);
    const item = { agent: run.agent, stage: run.stage, model, effort, runs: {}, dollars: {} };
    for (const b of BOUNDS) {
      const count = pick(run.count, b);
      const cost = count === 0 ? 0 : count * dollarsOf(model, runTokens(run, effort, b));
      item.runs[b] = count;
      item.dollars[b] = cost;
      runsCount[b] += count;
      dollars[b] += cost;
    }
    if (item.runs.high > 0) items.push(item);
  }
  return { runs: runsCount, dollars, items };
}

/**
 * Round a figure for the owner: the low one down, the high one up, to a step that grows with the figure.
 * @param {number} value
 * @param {'down'|'up'} way
 */
export function roundDollars(value, way) {
  const step = value < 2 ? 0.1 : value < 20 ? 1 : value < 200 ? 5 : 10;
  const n = (way === 'down' ? Math.floor(value / step + 1e-9) : Math.ceil(value / step - 1e-9)) * step;
  return Math.round(n * 100) / 100;
}

const money = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
const runsText = (r) => (r.low === r.high ? `${r.low} agent run${r.low === 1 ? '' : 's'}` : `${r.low} to ${r.high} agent runs`);

/** One line: "about $12 to $30, 14 to 18 agent runs". */
export function formatRange(entry) {
  return `about ${money(entry.rounded.low)} to ${money(entry.rounded.high)}, ${runsText(entry.runs)}`;
}

const finish = (priced) => ({
  ...priced,
  dollars: { low: Math.round(priced.dollars.low * 100) / 100, high: Math.round(priced.dollars.high * 100) / 100 },
  rounded: { low: roundDollars(priced.dollars.low, 'down'), high: roundDollars(priced.dollars.high, 'up') },
});

// ---------------------------------------------------------------------------------------------------------
// Facts of a project
// ---------------------------------------------------------------------------------------------------------

/** The roles of `team/roster.md`, from the first cell of each row of its table, or null when there is no roster. */
export function rosterRoles(root) {
  const path = join(root, 'team', 'roster.md');
  if (!existsSync(path)) return null;
  const roles = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*`?([a-z0-9]+(?:-[a-z0-9]+)*)`?\s*\|(.*)$/.exec(line);
    if (m === null) continue;
    roles.push({ role: m[1], domain: m[1] === 'domain-expert' || /domain expert/i.test(m[2]) });
  }
  return roles.length > 0 ? roles : null;
}

/**
 * The facts the estimate reads from a project: track, budgets, team size, domain expert, translations, second opinion.
 * @param {string|null} root
 * @param {object|null} state
 * @param {{deliverables?: string[]}} [fallback] the languages of the user config when the state has none
 */
export function projectFacts(root, state, fallback = {}) {
  const roster = root === null ? null : rosterRoles(root);
  const deliverables = state?.languages?.deliverables ?? fallback.deliverables ?? ['en'];
  const hasDomain = roster?.some((r) => r.domain) ? 1 : 0;
  const track = state?.track === 'short' ? 'short' : 'full';
  return {
    track,
    budgets: budgetsOf(state),
    roles: roster === null ? (track === 'short' ? SHORT_ROLES : DEFAULT_ROLES) : pair(roster.length),
    domainExpert: roster === null ? pair(0, 1) : pair(hasDomain),
    translations: Math.max(0, (Array.isArray(deliverables) ? deliverables.length : 1) - 1),
    secondOpinion: state?.second_opinion ?? 'sensitive',
    fromRoster: roster !== null,
  };
}

/** True when every gate of the phase is passed in the state. */
const passed = (state, phase) => phase.gates.every((g) => typeof state?.gates?.[g]?.passed === 'string');

/**
 * Estimate phases of a project.
 * @param {object} facts from projectFacts
 * @param {object|null} state
 * @param {{writer: string, tiers: {writer: {effort: string}, mechanical: {model: string, effort: string}}, phases?: string[]}} ctx
 */
export function estimatePhases(facts, state, ctx) {
  let ids = ctx.phases;
  if (ids === undefined) {
    ids = ESTIMATE_PHASES.filter((p) => !passed(state, p) && !(p.id === 'intake' && state?.mode === 'adopt')).map((p) => p.id);
  }
  const phases = ids.map((id) => {
    const phase = ESTIMATE_PHASES.find((p) => p.id === id);
    if (phase === undefined) throw new Error(`Unknown phase: ${id}. Use ${PHASE_IDS.join(', ')}.`);
    return { phase: id, name: phase.name, ...finish(priceRuns(phaseRuns(id, facts), ctx)) };
  });
  const total = finish({
    runs: { low: phases.reduce((n, p) => n + p.runs.low, 0), high: phases.reduce((n, p) => n + p.runs.high, 0) },
    dollars: { low: phases.reduce((n, p) => n + p.dollars.low, 0), high: phases.reduce((n, p) => n + p.dollars.high, 0) },
  });
  return { estimate: true, prices: PRICES_SOURCE, writer: ctx.writer, phases, total: { runs: total.runs, dollars: total.dollars, rounded: total.rounded } };
}

/**
 * Estimate the delivery of one slice in a lane, with the models of `harness/models.yaml`.
 * @param {'standard'|'sensitive'} lane
 * @param {{harnessModels: object, secondOpinion?: string}} ctx
 */
export function estimateSlice(lane, ctx) {
  if (!SLICE_LANES.includes(lane)) throw new Error(`Unknown lane: ${lane}. Use ${SLICE_LANES.join(' or ')}.`);
  const priced = finish(priceRuns(sliceRuns(lane, ctx.secondOpinion ?? 'sensitive'), ctx));
  return { estimate: true, prices: PRICES_SOURCE, slice: lane, ...priced };
}
